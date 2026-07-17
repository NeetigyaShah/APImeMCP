#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureStorageInitialized, findTemplateById, findTemplateByUrl, loadManifest, registerTemplate } from './storage.js';
import { closeBrowser, confirmOpenAppConnection, createSuccessfulExtractionResult, executeActionSequence, executeExtraction, executeMeasured, initBrowser, isBrowserReady, openAppConnection, REGISTRY_CDN_ALLOWLIST, renderPage, startConfiguredAppConnections } from './engine.js';
import { getSavedCookies, saveCookies } from './cookie-store.js';
import { addFromRegistry, fetchRegistryManifest } from './registry-client.js';
import { addCommunityTemplateCore } from './tools/add-community-template.js';
import { batchDownload } from './downloader.js';
import { getAllSla, preExecutionMeasure, recordMeasure } from './metrics.js';
import { sendNotification } from './notifier.js';
import { Scheduler } from './scheduler.js';
import { reportProgress } from './progress.js';
import { checkForUpdates } from './updater.js';
import type { UpdateStatus } from './updater.js';
import { startDashboard } from './dashboard.js';
import { getAppConnection, listAppConnections, upsertAppConnection } from './app-connections.js';
import { createExtractionRunner } from './tools/extraction-runner.js';
import type { ToolDeps } from './tools/tool-deps.js';
import { registerRegisterExtractionTemplateTool } from './tools/register-extraction-template-tool.js';
import { registerExecuteNativeExtractionTool } from './tools/execute-native-extraction-tool.js';
import { registerSaveTemplateCookiesTool } from './tools/save-template-cookies-tool.js';
import { registerScheduleStockCheckTool } from './tools/schedule-stock-check-tool.js';
import { registerGetExtractionStatsTool } from './tools/get-extraction-stats-tool.js';
import { registerSendNotificationTool } from './tools/send-notification-tool.js';
import { registerBatchDownloadAssetsTool } from './tools/batch-download-assets-tool.js';
import { registerAddCommunityTemplateTool } from './tools/add-community-template-tool.js';
import { registerConnectAppTool, registerConfirmAppConnectionTool, registerListAppConnectionsTool } from './tools/app-connections-tools.js';
import { registerSynthesizeSchemaTool } from './tools/synthesize-schema.js';
import { registerPreviewTransformTool } from './tools/transform-tool.js';
import { registerDiscoverTemplatesTool } from './discovery.js';
import { findPipelineById, listPipelineDefs, registerPipeline, registerRegisterPipelineTool, registerRunPipelineTool, registerListPipelinesTool } from './pipeline.js';

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

export const runExtraction = createExtractionRunner({
  loadManifest,
  findTemplateById,
  findTemplateByUrl,
  readFile: fs.readFile,
  resolvePath: path.resolve,
  executeExtraction,
  executeActionSequence,
  createSuccessfulResult: createSuccessfulExtractionResult,
  registryCdnAllowlist: REGISTRY_CDN_ALLOWLIST,
  getAppConnection,
  saveCookies,
  getSavedCookies,
  executeMeasured,
  preExecutionMeasure,
  reportProgress,
  logError,
});

const scheduler = new Scheduler(async (targetUrl, templateId) => {
  await runExtraction(targetUrl, templateId);
});

const server = new McpServer({ name: 'APImeMCP', version: '1.5.0' });
const deps: ToolDeps = {
  appConnections: { upsert: upsertAppConnection, list: listAppConnections },
  engine: { open: openAppConnection, confirm: confirmOpenAppConnection, renderPage },
  extraction: { run: runExtraction },
  templates: { register: registerTemplate },
  cookies: { save: saveCookies },
  scheduler,
  metrics: { getStats: getAllSla },
  notifications: { send: sendNotification },
  downloads: { batch: batchDownload },
  registry: { add: addFromRegistry },
  discovery: {
    listLocalTemplates: async () => Object.values(await loadManifest()).map((entry) => ({
      templateId: entry.templateId,
      name: entry.templateId,
      tags: [entry.domainPattern],
      targetUrl: entry.fixedTargetUrl ?? `https://${entry.domainPattern}`,
      source: 'local' as const,
    })),
    listRegistryTemplates: async () => Object.values(await fetchRegistryManifest()).map((entry) => ({
      templateId: entry.templateId,
      name: entry.templateId,
      tags: [entry.domainPattern],
      targetUrl: entry.fixedTargetUrl ?? `https://${entry.domainPattern}`,
      source: 'registry' as const,
    })),
  },
  progress: { report: reportProgress },
  log,
  logError,
};

registerRegisterExtractionTemplateTool(server, deps);
registerExecuteNativeExtractionTool(server, deps);
registerConnectAppTool(server, deps);
registerConfirmAppConnectionTool(server, deps);
registerListAppConnectionsTool(server, deps);
registerSaveTemplateCookiesTool(server, deps);
registerScheduleStockCheckTool(server, deps);
registerGetExtractionStatsTool(server, deps);
registerSendNotificationTool(server, deps);
registerBatchDownloadAssetsTool(server, deps);
registerAddCommunityTemplateTool(server, deps);
registerSynthesizeSchemaTool(server, deps.engine);
registerPreviewTransformTool(server, {});
registerDiscoverTemplatesTool(server, deps.discovery);

const pipelineDeps = { runExtraction, registerPipeline, findPipelineById, listPipelineDefs, recordMeasure };
registerRegisterPipelineTool(server, pipelineDeps);
registerRunPipelineTool(server, pipelineDeps);
registerListPipelinesTool(server, pipelineDeps);

server.registerPrompt('get_environment_context', {
  title: 'Environment Context',
  description: 'Local architecture/environment notes from ENVIRONMENT_CONTEXT.md, if present.',
}, async () => {
  const filePath = path.resolve(process.cwd(), 'ENVIRONMENT_CONTEXT.md');
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    text = 'Architecture notes are uninitialized (ENVIRONMENT_CONTEXT.md not found).';
  }
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
});

server.registerResource('server_status', 'status://server', {
  title: 'Server Status',
  description: 'Browser readiness and the last 5 log lines, for debugging a failed extraction.',
  mimeType: 'application/json',
}, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ browserReady: isBrowserReady(), recentLogs, updateAvailable: updateStatus.updateAvailable }, null, 2) }],
}));

async function main(): Promise<void> {
  await ensureStorageInitialized();
  await initBrowser();
  await startConfiguredAppConnections();
  await scheduler.loadPersisted();
  startDashboard({ runExtraction, scheduler, isBrowserReady, log, logError });
  void checkForUpdates().then((status) => {
    updateStatus = status;
    if (status.updateAvailable) log('UPDATE AVAILABLE: A newer version of the server is available on GitHub. Please pull the latest changes.');
  });
  await server.connect(new StdioServerTransport());
  log('MCP compiler server running on stdio');
}

async function shutdown(signal: string): Promise<void> {
  log(`Received ${signal}, shutting down`);
  await closeBrowser();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

async function runCliAddCommand(domain: string): Promise<void> {
  await ensureStorageInitialized();
  const result = await addCommunityTemplateCore({ addFromRegistry }, { domain });
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
      runCliAddCommand(cliArg).catch((error) => {
        console.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      });
    }
  } else {
    main().catch((error) => {
      logError(`Fatal startup error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
  }
}
