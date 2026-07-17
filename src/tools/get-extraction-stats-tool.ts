import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './tool-deps.js';

export function registerGetExtractionStatsTool(server: McpServer, deps: ToolDeps): void {
  server.tool('get_extraction_stats', {}, async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify(await deps.metrics.getStats(), null, 2) }],
  }));
}
