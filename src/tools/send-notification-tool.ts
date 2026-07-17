import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SendNotificationShape } from '../types.js';
import type { ToolDeps } from './tool-deps.js';

export function registerSendNotificationTool(server: McpServer, deps: ToolDeps): void {
  server.tool('send_notification', SendNotificationShape, async (input) => {
    try {
      await deps.notifications.send(input.endpointUrl, input.message);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logError(`send_notification failed: ${message}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }], isError: true };
    }
  });
}
