import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BatchDownloadShape } from '../types.js';
import type { ToolDeps } from './tool-deps.js';

export function registerBatchDownloadAssetsTool(server: McpServer, deps: ToolDeps): void {
  server.tool('batch_download_assets', BatchDownloadShape, async (input) => {
    try {
      await deps.progress.report({ tool: 'batch_download_assets', status: 'running', current: 0, total: input.urls.length, message: input.outputDir });
      const results = await deps.downloads.batch(input.urls, input.outputDir, (current, total) => {
        void deps.progress.report({ tool: 'batch_download_assets', status: 'running', current, total, message: input.outputDir });
      });
      const succeeded = results.filter((result) => result.success).length;
      const failed = results.length - succeeded;
      deps.log(`batch_download_assets: saved ${succeeded}/${results.length} files to "${input.outputDir}"`);
      await deps.progress.report({ tool: 'batch_download_assets', status: failed === 0 ? 'done' : 'failed', current: succeeded, total: results.length, message: input.outputDir });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: failed === 0, savedCount: succeeded, failedCount: failed, outputDir: input.outputDir, results }, null, 2) }], isError: failed > 0 && succeeded === 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logError(`batch_download_assets failed: ${message}`);
      await deps.progress.report({ tool: 'batch_download_assets', status: 'failed', current: 0, total: input.urls.length, message });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }], isError: true };
    }
  });
}
