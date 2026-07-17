import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SubscribeMonitorInputSchema } from '../types.js';
import type { ToolDeps } from './tool-deps.js';

export function registerMonitorTool(server: McpServer, deps: ToolDeps): void {
  server.tool('subscribe_monitor', SubscribeMonitorInputSchema.shape, async (input) => {
    try {
      const monitor = await deps.scheduler.subscribeMonitor(input);
      deps.log(`Subscribed monitor "${monitor.id}" (${input.cronExpression}) for template ${input.templateId}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ monitorId: monitor.id, templateId: monitor.templateId, createdAt: monitor.createdAt }, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logError(`subscribe_monitor failed: ${message}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
        isError: true,
      };
    }
  });

  server.tool('list_monitors', {}, async () => {
    try {
      const monitors = deps.scheduler.listMonitors();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ monitors, count: monitors.length }, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logError(`list_monitors failed: ${message}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
        isError: true,
      };
    }
  });

  server.tool('unsubscribe_monitor', { monitorId: z.string().min(1) }, async ({ monitorId }) => {
    try {
      const ok = await deps.scheduler.cancelMonitor(monitorId);
      deps.log(`Unsubscribed monitor "${monitorId}"`);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok }) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logError(`unsubscribe_monitor failed: ${message}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
        isError: true,
      };
    }
  });
}
