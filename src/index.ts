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
  isHttpUrl,
} from './types.js';
import type { ExtractionResult, Manifest } from './types.js';
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
import { reportProgress } from './progress.js';
import express from 'express';

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

  await reportProgress({ tool: 'execute_native_extraction', status: 'running', current: 0, total: 1, message: targetUrl });

  try {
    const manifest = await loadManifest();
    const entry = templateId ? findTemplateById(manifest, templateId) : findTemplateByUrl(manifest, targetUrl);

    if (!entry) {
      const error = templateId
        ? `No registered template with templateId "${templateId}"`
        : `No registered template matches the domain for ${targetUrl}`;
      await reportProgress({ tool: 'execute_native_extraction', status: 'failed', current: 0, total: 1, message: error });
      return { success: false, error, meta: buildMeta(templateId ?? '', '') };
    }

    const data = await executeExtraction({ targetUrl, scriptPath: entry.scriptPath, proxyUrl });
    const imageCount = Array.isArray(data) ? data.length : data ? 1 : 0;
    await logExtractionMetric(entry.templateId, targetUrl, imageCount);
    await reportProgress({ tool: 'execute_native_extraction', status: 'done', current: 1, total: 1, message: targetUrl });
    return { success: true, data, meta: buildMeta(entry.templateId, entry.domainPattern) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`execute_native_extraction failed: ${message}`);
    await reportProgress({ tool: 'execute_native_extraction', status: 'failed', current: 0, total: 1, message });
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

const DASHBOARD_PORT = 3000;

function renderDashboard(manifest: Manifest): string {
  const cards = Object.values(manifest)
    .map(
      (entry) => `
        <div class="card">
          <h2>${entry.templateId}</h2>
          <p class="domain">${entry.domainPattern}</p>
          <p class="updated">Updated: ${entry.updatedAt}</p>
          <input type="text" placeholder="https://example.com/page" class="url-input" />
          <button onclick="runTemplate('${entry.templateId}', this)">Run Now</button>
          <pre class="result"></pre>
        </div>`
    )
    .join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>mcp-compiler-server dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
  h1 { color: #38bdf8; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
  .card { background: #1e293b; border-radius: 8px; padding: 1rem; }
  .card h2 { margin: 0 0 0.25rem; font-size: 1.1rem; color: #f1f5f9; }
  .domain { color: #94a3b8; margin: 0 0 0.25rem; }
  .updated { color: #64748b; font-size: 0.8rem; margin: 0 0 0.75rem; }
  .url-input { width: 100%; box-sizing: border-box; padding: 0.4rem; margin-bottom: 0.5rem; border-radius: 4px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; }
  button { background: #38bdf8; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; font-weight: 600; }
  button:hover { background: #0ea5e9; }
  button:disabled { opacity: 0.5; cursor: default; }
  .result { background: #0f172a; padding: 0.5rem; border-radius: 4px; max-height: 200px; overflow: auto; font-size: 0.75rem; white-space: pre-wrap; word-break: break-all; }
</style>
</head>
<body>
<h1>mcp-compiler-server</h1>
<div class="grid">
${cards}
</div>
<script>
async function runTemplate(templateId, btn) {
  const card = btn.closest('.card');
  const input = card.querySelector('.url-input');
  const result = card.querySelector('.result');
  const url = input.value.trim();
  if (!url) { result.textContent = 'Enter a URL first'; return; }
  btn.disabled = true;
  result.textContent = 'Running...';
  try {
    const res = await fetch('/api/run/' + encodeURIComponent(templateId) + '?url=' + encodeURIComponent(url));
    const data = await res.json();
    result.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    result.textContent = 'Request failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}
</script>
</body>
</html>`;
}

function startDashboard(): void {
  const app = express();

  app.get('/', async (_req, res) => {
    const manifest = await loadManifest();
    res.type('html').send(renderDashboard(manifest));
  });

  app.get('/api/run/:templateId', async (req, res) => {
    const { templateId } = req.params;
    const targetUrl = typeof req.query.url === 'string' ? req.query.url : '';

    if (!RegisterExtractionTemplateShape.templateId.safeParse(templateId).success) {
      res.status(400).json({ success: false, error: 'invalid templateId' });
      return;
    }
    if (!isHttpUrl(targetUrl)) {
      res.status(400).json({ success: false, error: 'url query param must be an absolute http:// or https:// URL' });
      return;
    }

    const result = await runExtraction(targetUrl, templateId);
    res.json(result);
  });

  const httpServer = app.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    log(`Dashboard listening on http://127.0.0.1:${DASHBOARD_PORT}`);
  });
  httpServer.on('error', (err) => {
    logError(`Dashboard failed to start: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function main(): Promise<void> {
  await ensureStorageInitialized();
  await initBrowser();
  await scheduler.loadPersisted();
  startDashboard();
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
