#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  RegisterExtractionTemplateShape,
  ExecuteNativeExtractionShape,
  BatchDownloadShape,
  ScheduleStockCheckShape,
  SendNotificationShape,
} from './types.js';
import type { ExtractionResult } from './types.js';
import {
  ensureStorageInitialized,
  loadManifest,
  registerTemplate,
  findTemplateById,
  findTemplateByUrl,
} from './storage.js';
import { initBrowser, closeBrowser, executeExtraction, isBrowserReady } from './engine.js';
import { batchDownload } from './downloader.js';
import { logExtractionMetric, getExtractionStats } from './metrics.js';
import { sendNotification } from './notifier.js';
import { Scheduler } from './scheduler.js';

const RECENT_LOGS_LIMIT = 5;
const recentLogs: string[] = [];

function record(line: string): void {
  recentLogs.push(line);
  if (recentLogs.length > RECENT_LOGS_LIMIT) recentLogs.shift();
}

function log(message: string): void {
  record(message);
  process.stderr.write(`[mcp-compiler-server] ${message}\n`);
}

function logError(message: string): void {
  record(`ERROR: ${message}`);
  process.stderr.write(`[mcp-compiler-server] ERROR: ${message}\n`);
}

async function runExtraction(targetUrl: string, templateId?: string, proxyUrl?: string): Promise<ExtractionResult> {
  const startedAt = Date.now();
  const buildMeta = (id: string, domainMatched: string) => ({
    url: targetUrl,
    templateId: id,
    domainMatched,
    durationMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  });

  try {
    const manifest = await loadManifest();
    const entry = templateId ? findTemplateById(manifest, templateId) : findTemplateByUrl(manifest, targetUrl);

    if (!entry) {
      return {
        success: false,
        error: templateId
          ? `No registered template with templateId "${templateId}"`
          : `No registered template matches the domain for ${targetUrl}`,
        meta: buildMeta(templateId ?? '', ''),
      };
    }

    const data = await executeExtraction({ targetUrl, scriptPath: entry.scriptPath, proxyUrl });
    const imageCount = Array.isArray(data) ? data.length : data ? 1 : 0;
    await logExtractionMetric(entry.templateId, targetUrl, imageCount);
    return { success: true, data, meta: buildMeta(entry.templateId, entry.domainPattern) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`execute_native_extraction failed: ${message}`);
    return { success: false, error: message, meta: buildMeta(templateId ?? '', '') };
  }
}

const scheduler = new Scheduler(async (targetUrl, templateId) => {
  await runExtraction(targetUrl, templateId);
});

const server = new McpServer({ name: 'mcp-compiler-server', version: '1.0.0' });

server.tool('register_extraction_template', RegisterExtractionTemplateShape, async (input) => {
  try {
    const entry = await registerTemplate(input);
    log(`Registered template "${entry.templateId}" for domain "${entry.domainPattern}"`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(entry, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`register_extraction_template failed: ${message}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
      isError: true,
    };
  }
});

server.tool('execute_native_extraction', ExecuteNativeExtractionShape, async (input) => {
  const result = await runExtraction(input.targetUrl, input.templateId, input.proxyUrl);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    isError: !result.success,
  };
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
    const results = await batchDownload(input.urls, input.outputDir);
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.length - succeeded;
    log(`batch_download_assets: saved ${succeeded}/${results.length} files to "${input.outputDir}"`);
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
        text: JSON.stringify({ browserReady: isBrowserReady(), recentLogs }, null, 2),
      },
    ],
  })
);

async function main(): Promise<void> {
  await ensureStorageInitialized();
  await initBrowser();
  await scheduler.loadPersisted();
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

main().catch((err) => {
  logError(`Fatal startup error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
