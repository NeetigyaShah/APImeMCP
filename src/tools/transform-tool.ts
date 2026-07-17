import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TransformError, TransformSpecSchema, applyTransform } from '../transform.js';

export function registerPreviewTransformTool(server: McpServer, _deps: Record<string, never>): void {
  server.tool('preview_transform', { sampleData: z.unknown(), spec: TransformSpecSchema }, async ({ sampleData, spec }) => {
    try {
      const result = applyTransform(sampleData, spec);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof TransformError ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Transform error: ${message}` }], isError: true };
    }
  });
}
