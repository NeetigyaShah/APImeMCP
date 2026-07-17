#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  RegisterExtractionTemplateShape,
  ExecuteNativeExtractionShape,
  BatchDownloadShape,
  ScheduleStockCheckShape,
  SendNotificationShape,
  SaveTemplateCookiesShape,
  AddCommunityTemplateShape,
} from './types.js';
import type { ExtractionResult, ActionSequence } from './types.js';
import {
  ensureStorageInitialized,
  loadManifest,
  registerTemplate,
  findTemplateById,
  findTemplateByUrl,
} from './storage.js';
import {
  initBrowser,
  closeBrowser,
  executeExtraction,
  executeActionSequence,
  createSuccessfulExtractionResult,
  isBrowserReady,
  REGISTRY_CDN_ALLOWLIST,
  openAppConnection,
  confirmOpenAppConnection,
  startConfiguredAppConnections,
  renderPage,
} from './engine.js';
import { saveCookies, getSavedCookies } from './cookie-store.js';
import { addFromRegistry } from './registry-client.js';
import { batchDownload } from './downloader.js';
import { logExtractionMetric, getExtractionStats } from './metrics.js';
import { sendNotification } from './notifier.js';
import { Scheduler } from './scheduler.js';
import { reportProgress } from './progress.js';
import { checkForUpdates } from './updater.js';
import type { UpdateStatus } from './updater.js';
import { startDashboard } from './dashboard.js';
import { getAppConnection, listAppConnections, upsertAppConnection } from './app-connections.js';
import {
  registerConnectAppTool,
  registerConfirmAppConnectionTool,
  registerListAppConnectionsTool,
} from './tools/app-connections-tools.js';
import { registerSynthesizeSchemaTool } from './tools/synthesize-schema.js';

type ValidateOutput = (value: unknown, schema: Record<string, unknown>) => unknown;
const executeNativeExtractionDeps: { validateOutput?: ValidateOutput } = {};

let updateStatus: UpdateStatus = { updateAvailable: false, latestCommit: null };

const RECENT_LOGS_LIMIT = 5;
const recentLogs: string[] = [];

function record(line: string): void {
  recentLogs.push(line);
  if (recentLogs.length > RECENT_LOGS_LIMIT) recentLogs.shift();
}

function log(message: string): void {
  record(message);
  process.stderr.write(`[APImeMCP] ${message}\n`);
}

function logError(message: string): void {
  record(`ERROR: ${message}`);
  process.stderr.write(`[APImeMCP] ERROR: ${message}\n`);
}

export async function runExtraction(
  targetUrl?: string,
  templateId?: string,
  proxyUrl?: string,
  cookieString?: string,
  simulateLowBandwidth?: boolean,
  headful?: boolean,
  useSavedCookies?: boolean,
  connectionId?: string,
  executableScript?: string,
  kind = 'extraction'
): Promise<ExtractionResult> {
  const isDryRun = executableScript !== undefined;
  const startedAt = Date.now();
  const buildMeta = (id: string, domainMatched: string, resolvedUrl: string) => ({
    url: resolvedUrl,
    templateId: id,
    domainMatched,
    durationMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  });

  if (!isDryRun) {
    await reportProgress({
      tool: 'execute_native_extraction',
      status: 'running',
      current: 0,
      total: 1,
      message: targetUrl ?? templateId ?? '',
    });
  }

  try {
    if (isDryRun) {
      if (!targetUrl) {
        const error = 'targetUrl is required when executableScript is provided';
        return { success: false, error, meta: buildMeta('', '', '') };
      }
      const data = await executeExtraction({
        targetUrl,
        executableScript,
        proxyUrl,
        cookieString,
        simulateLowBandwidth: simulateLowBandwidth ?? true,
        captureForensicsOnError: false,
      });
      return { success: true, data, meta: buildMeta('', '', targetUrl) };
    }
    const manifest = await loadManifest();
    const entry = templateId
      ? findTemplateById(manifest, templateId)
      : targetUrl
        ? findTemplateByUrl(manifest, targetUrl)
        : undefined;

    if (!entry) {
      const error = templateId
        ? `No registered template with templateId "${templateId}"`
        : targetUrl
          ? `No registered template matches the domain for ${targetUrl}`
          : 'targetUrl or templateId is required';
      await reportProgress({ tool: 'execute_native_extraction', status: 'failed', current: 0, total: 1, message: error });
      return { success: false, error, meta: buildMeta(templateId ?? '', '', targetUrl ?? '') };
    }

    const resolvedUrl = targetUrl ?? entry.fixedTargetUrl;
    if (!resolvedUrl) {
      const error = `Template "${entry.templateId}" has no fixedTargetUrl registered; targetUrl is required`;
      await reportProgress({ tool: 'execute_native_extraction', status: 'failed', current: 0, total: 1, message: error });
      return { success: false, error, meta: buildMeta(entry.templateId, entry.domainPattern, '') };
    }

    if (connectionId) {
      if (cookieString || useSavedCookies) {
        throw new Error('connectionId cannot be combined with cookieString or useSavedCookies');
      }
      const connection = await getAppConnection(connectionId);
      if (!connection) throw new Error(`No app connection configured for "${connectionId}"`);
      if (connection.status !== 'connected') {
        throw new Error(`App connection "${connectionId}" is not connected; log in and call confirm_app_connection first`);
      }
      const targetHostname = new URL(resolvedUrl).hostname.toLowerCase();
      const matchesConnection =
        targetHostname === connection.domainPattern || targetHostname.endsWith(`.${connection.domainPattern}`);
      if (!matchesConnection) {
        throw new Error(
          `targetUrl hostname "${targetHostname}" does not match app connection "${connectionId}" (${connection.domainPattern})`
        );
      }
    }

    if (entry.kind === 'action-sequence') {
      const raw = await fs.readFile(path.resolve(process.cwd(), entry.scriptPath), 'utf8');
      const sequence = JSON.parse(raw) as ActionSequence;
      await executeActionSequence({
        sequence,
        proxyUrl,
        simulateLowBandwidth,
        headful,
        connectionId,
        networkAllowlist: entry.source === 'registry' ? [entry.domainPattern, ...REGISTRY_CDN_ALLOWLIST] : undefined,
      });
      await logExtractionMetric(entry.templateId, resolvedUrl, 0);
      await reportProgress({ tool: 'execute_native_extraction', status: 'done', current: 1, total: 1, message: resolvedUrl });
      const data = { completedSteps: sequence.steps.length };
      return createSuccessfulExtractionResult(
        data,
        buildMeta(entry.templateId, entry.domainPattern, resolvedUrl),
        entry.outputSchema,
      );
    }

    // Auto-store any cookies the caller supplied so the dashboard can offer to reuse
    // them later; if none supplied and the caller asked, fall back to the saved ones.
    if (!connectionId && cookieString) await saveCookies(entry.templateId, cookieString);
    const effectiveCookies = connectionId ? undefined : cookieString || (useSavedCookies ? await getSavedCookies(entry.templateId) : undefined);

    const data = await executeExtraction({
      targetUrl: resolvedUrl,
      scriptPath: entry.scriptPath,
      proxyUrl,
      cookieString: effectiveCookies,
      connectionId,
      // Extraction is pure data, no visual dependency - block images/media/fonts/CSS by
      // default to cut load time, unless the caller explicitly asked otherwise. (Only
      // reached for non-action-sequence templates - see the early-return above - so no
      // kind check needed here; action-sequence's own simulateLowBandwidth stays
      // caller-controlled with no implicit default, since layout matters for selectors.)
      simulateLowBandwidth: simulateLowBandwidth ?? true,
      waitStrategy: entry.waitStrategy,
      readySelector: entry.readySelector,
      // Registry-sourced templates are community-contributed, not authored by the
      // operator - restrict them to their own domain + a curated CDN allowlist so a
      // malicious/careless one can't exfiltrate scraped data (or ride a cookieString's
      // session) to an arbitrary endpoint. Locally-authored templates (source absent)
      // stay unrestricted - trusted by definition, same as before this existed.
      networkAllowlist: entry.source === 'registry' ? [entry.domainPattern, ...REGISTRY_CDN_ALLOWLIST] : undefined,
    });
    const imageCount = Array.isArray(data) ? data.length : data ? 1 : 0;
    await logExtractionMetric(entry.templateId, resolvedUrl, imageCount);
    await reportProgress({ tool: 'execute_native_extraction', status: 'done', current: 1, total: 1, message: resolvedUrl });
    return createSuccessfulExtractionResult(
      data,
      buildMeta(entry.templateId, entry.domainPattern, resolvedUrl),
      entry.outputSchema,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`execute_native_extraction failed: ${message}`);
    if (!isDryRun) {
      await reportProgress({ tool: 'execute_native_extraction', status: 'failed', current: 0, total: 1, message });
    }
    return { success: false, error: message, meta: buildMeta(templateId ?? '', '', targetUrl ?? '') };
  }
}

const scheduler = new Scheduler(async (targetUrl, templateId) => {
  await runExtraction(targetUrl, templateId);
});

const server = new McpServer({ name: 'APImeMCP', version: '1.5.0' });

server.tool('register_extraction_template', RegisterExtractionTemplateShape, async (input) => {
  await reportProgress({
    tool: 'register_extraction_template',
    status: 'running',
    current: 0,
    total: 1,
    message: input.templateId,
  });
  try {
    const entry = await registerTemplate(input);
    log(`Registered template "${entry.templateId}" for domain "${entry.domainPattern}"`);
    await reportProgress({
      tool: 'register_extraction_template',
      status: 'done',
      current: 1,
      total: 1,
      message: entry.templateId,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(entry, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`register_extraction_template failed: ${message}`);
    await reportProgress({
      tool: 'register_extraction_template',
      status: 'failed',
      current: 0,
      total: 1,
      message,
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
      isError: true,
    };
  }
});

server.tool('execute_native_extraction', ExecuteNativeExtractionShape, async (input) => {
  const result = await runExtraction(
    input.targetUrl,
    input.templateId,
    input.proxyUrl,
    input.cookieString,
    undefined,
    undefined,
    undefined,
    input.connectionId,
    input.executableScript,
    input.executableScript !== undefined ? 'synthesize-dry-run' : undefined
  );
  const schemaValidation =
    input.outputSchema && executeNativeExtractionDeps.validateOutput && result.success
      ? executeNativeExtractionDeps.validateOutput(result.data, input.outputSchema)
      : undefined;
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(input.executableScript !== undefined ? { ...result, dryRun: true, ...(schemaValidation === undefined ? {} : { schemaValidation }) } : result, null, 2),
      },
    ],
    isError: !result.success,
  };
});

const appConnectionsToolDeps = {
  appConnections: { upsert: upsertAppConnection, list: listAppConnections },
  engine: { open: openAppConnection, confirm: confirmOpenAppConnection },
  log,
  logError,
};

registerConnectAppTool(server, appConnectionsToolDeps);
registerConfirmAppConnectionTool(server, appConnectionsToolDeps);
registerListAppConnectionsTool(server, appConnectionsToolDeps);
registerSynthesizeSchemaTool(server, { renderPage });

// Persist session cookies for a template WITHOUT running it, so a cookie mentioned in a
// chat lands in the dashboard's saved-cookies store (badge + "Use saved cookies" button).
server.tool('save_template_cookies', SaveTemplateCookiesShape, async (input) => {
  try {
    await saveCookies(input.templateId, input.cookieString);
    log(`Saved cookies for template "${input.templateId}"`);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: true, templateId: input.templateId, savedForDashboard: true }, null, 2),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`save_template_cookies failed: ${message}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
      isError: true,
    };
  }
});

server.tool('schedule_stock_check', ScheduleStockCheckShape, async (input) => {
  try {
    const job = await scheduler.register(input.targetUrl, input.cronExpression, input.templateId);
    log(`Scheduled job "${job.jobId}" (${job.cronExpression}) for ${job.targetUrl}`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(job, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`schedule_stock_check failed: ${message}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
      isError: true,
    };
  }
});

server.tool('get_extraction_stats', {}, async () => {
  const stats = await getExtractionStats();
  return { content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }] };
});

server.tool('send_notification', SendNotificationShape, async (input) => {
  try {
    await sendNotification(input.endpointUrl, input.message);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`send_notification failed: ${message}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
      isError: true,
    };
  }
});

server.tool('batch_download_assets', BatchDownloadShape, async (input) => {
  try {
    await reportProgress({
      tool: 'batch_download_assets',
      status: 'running',
      current: 0,
      total: input.urls.length,
      message: input.outputDir,
    });
    const results = await batchDownload(input.urls, input.outputDir, (current, total) => {
      void reportProgress({ tool: 'batch_download_assets', status: 'running', current, total, message: input.outputDir });
    });
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.length - succeeded;
    log(`batch_download_assets: saved ${succeeded}/${results.length} files to "${input.outputDir}"`);
    await reportProgress({
      tool: 'batch_download_assets',
      status: failed === 0 ? 'done' : 'failed',
      current: succeeded,
      total: results.length,
      message: input.outputDir,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: failed === 0,
              savedCount: succeeded,
              failedCount: failed,
              outputDir: input.outputDir,
              results,
            },
            null,
            2
          ),
        },
      ],
      isError: failed > 0 && succeeded === 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`batch_download_assets failed: ${message}`);
    await reportProgress({
      tool: 'batch_download_assets',
      status: 'failed',
      current: 0,
      total: input.urls.length,
      message,
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
      isError: true,
    };
  }
});

// Pulls a pre-verified template from the public apimemcp-templates registry (a git repo,
// mirrored free via jsDelivr - no server to run) and registers it locally, so an agent
// can pull a community template mid-conversation without shelling out to `apimemcp add`.
server.tool('add_community_template', AddCommunityTemplateShape, async (input) => {
  try {
    const result = await addFromRegistry(input.domain);
    if (result.registered) {
      log(`Added community template "${result.templateId}" for domain "${input.domain}"`);
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      isError: !result.registered,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`add_community_template failed: ${message}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
      isError: true,
    };
  }
});

server.registerPrompt(
  'get_environment_context',
  {
    title: 'Environment Context',
    description: 'Local architecture/environment notes from ENVIRONMENT_CONTEXT.md, if present.',
  },
  async () => {
    const filePath = path.resolve(process.cwd(), 'ENVIRONMENT_CONTEXT.md');
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch {
      text = 'Architecture notes are uninitialized (ENVIRONMENT_CONTEXT.md not found).';
    }
    return {
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text },
        },
      ],
    };
  }
);

server.registerResource(
  'server_status',
  'status://server',
  {
    title: 'Server Status',
    description: 'Browser readiness and the last 5 log lines, for debugging a failed extraction.',
    mimeType: 'application/json',
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(
          { browserReady: isBrowserReady(), recentLogs, updateAvailable: updateStatus.updateAvailable },
          null,
          2
        ),
      },
    ],
  })
);

async function main(): Promise<void> {
  await ensureStorageInitialized();
  await initBrowser();
  await startConfiguredAppConnections();
  await scheduler.loadPersisted();
  startDashboard({ runExtraction, scheduler, isBrowserReady, log, logError });
  void checkForUpdates().then((status) => {
    updateStatus = status;
    if (status.updateAvailable) {
      log('UPDATE AVAILABLE: A newer version of the server is available on GitHub. Please pull the latest changes.');
    }
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP compiler server running on stdio');
}

async function shutdown(signal: string): Promise<void> {
  log(`Received ${signal}, shutting down`);
  await closeBrowser();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// `apimemcp add <domain>` - CLI shortcut for add_community_template, no browser/dashboard
// needed for this (just a fetch + local registration), so it deliberately does NOT call
// main() at all.
async function runCliAddCommand(domain: string): Promise<void> {
  await ensureStorageInitialized();
  const result = await addFromRegistry(domain);
  if (result.registered) {
    console.log(`Registered "${result.templateId}" from the community registry for domain "${domain}".`);
  } else {
    console.error(`Could not add a template for "${domain}": ${result.error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , cliCommand, cliArg] = process.argv;
  if (cliCommand === 'add') {
    if (!cliArg) {
      console.error('Usage: apimemcp add <domain>');
      process.exitCode = 1;
    } else {
      runCliAddCommand(cliArg).catch((err) => {
        console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      });
    }
  } else {
    main().catch((err) => {
      logError(`Fatal startup error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
  }
}
