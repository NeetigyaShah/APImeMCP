import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ScheduleStockCheckShape } from '../types.js';
import type { ToolDeps } from './tool-deps.js';

export function registerScheduleStockCheckTool(server: McpServer, deps: ToolDeps): void {
  server.tool('schedule_stock_check', ScheduleStockCheckShape, async (input) => {
    try {
      const job = await deps.scheduler.register(input.targetUrl, input.cronExpression, input.templateId);
      deps.log(`Scheduled job "${job.jobId}" (${input.cronExpression}) for ${input.targetUrl}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(job, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logError(`schedule_stock_check failed: ${message}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }], isError: true };
    }
  });
}
