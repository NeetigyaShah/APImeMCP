import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RegisterExtractionTemplateShape } from '../types.js';
import type { ToolDeps } from './tool-deps.js';

export function registerRegisterExtractionTemplateTool(server: McpServer, deps: ToolDeps): void {
  server.tool('register_extraction_template', RegisterExtractionTemplateShape, async (input) => {
    await deps.progress.report({ tool: 'register_extraction_template', status: 'running', current: 0, total: 1, message: input.templateId });
    try {
      const entry = await deps.templates.register(input);
      deps.log(`Registered template "${entry.templateId}" for domain "${entry.domainPattern}"`);
      await deps.progress.report({ tool: 'register_extraction_template', status: 'done', current: 1, total: 1, message: entry.templateId });
      return { content: [{ type: 'text' as const, text: JSON.stringify(entry, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logError(`register_extraction_template failed: ${message}`);
      await deps.progress.report({ tool: 'register_extraction_template', status: 'failed', current: 0, total: 1, message });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }], isError: true };
    }
  });
}
