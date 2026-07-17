import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ExecuteNativeExtractionShape } from '../types.js';
import { SnapshotModeSchema } from '../snapshot.js';
import type { ToolDeps } from './tool-deps.js';

export function registerExecuteNativeExtractionTool(server: McpServer, deps: ToolDeps): void {
  server.tool('execute_native_extraction', { ...ExecuteNativeExtractionShape, snapshot: SnapshotModeSchema.optional().default('off') }, async (input) => {
    const result = await deps.extraction.run(
      input.targetUrl,
      input.templateId,
      input.proxyUrl,
      input.cookieString,
      undefined,
      undefined,
      undefined,
      input.connectionId,
      input.executableScript,
      input.executableScript !== undefined ? 'synthesize-dry-run' : undefined,
      undefined,
      input.snapshot,
    );
    const response = input.executableScript !== undefined ? { ...result, dryRun: true } : result;
    return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }], isError: !result.success };
  });
}
