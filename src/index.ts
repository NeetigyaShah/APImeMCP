#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RegisterExtractionTemplateShape, ExecuteNativeExtractionShape, BatchDownloadShape } from './types.js';
import type { ExtractionResult } from './types.js';
import {
  ensureStorageInitialized,
  loadManifest,
  registerTemplate,
  findTemplateById,
  findTemplateByUrl,
} from './storage.js';
import { initBrowser, closeBrowser, executeExtraction } from './engine.js';
import { batchDownload } from './downloader.js';

function log(message: string): void {
  process.stderr.write(`[mcp-compiler-server] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[mcp-compiler-server] ERROR: ${message}\n`);
}

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
  const startedAt = Date.now();
  const buildMeta = (templateId: string, domainMatched: string) => ({
    url: input.targetUrl,
    templateId,
    domainMatched,
    durationMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  });

  try {
    const manifest = await loadManifest();
    const entry = input.templateId
      ? findTemplateById(manifest, input.templateId)
      : findTemplateByUrl(manifest, input.targetUrl);

    if (!entry) {
      const result: ExtractionResult = {
        success: false,
        error: input.templateId
          ? `No registered template with templateId "${input.templateId}"`
          : `No registered template matches the domain for ${input.targetUrl}`,
        meta: buildMeta(input.templateId ?? '', ''),
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], isError: true };
    }

    const data = await executeExtraction({
      targetUrl: input.targetUrl,
      scriptPath: entry.scriptPath,
      proxyUrl: input.proxyUrl,
    });
    const result: ExtractionResult = {
      success: true,
      data,
      meta: buildMeta(entry.templateId, entry.domainPattern),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`execute_native_extraction failed: ${message}`);
    const result: ExtractionResult = {
      success: false,
      error: message,
      meta: buildMeta(input.templateId ?? '', ''),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], isError: true };
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

async function main(): Promise<void> {
  await ensureStorageInitialized();
  await initBrowser();
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
