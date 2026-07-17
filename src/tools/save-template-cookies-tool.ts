import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SaveTemplateCookiesShape } from '../types.js';
import type { ToolDeps } from './tool-deps.js';

export function registerSaveTemplateCookiesTool(server: McpServer, deps: ToolDeps): void {
  server.tool('save_template_cookies', SaveTemplateCookiesShape, async (input) => {
    try {
      await deps.cookies.save(input.templateId, input.cookieString);
      deps.log(`Saved cookies for template "${input.templateId}"`);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, templateId: input.templateId, savedForDashboard: true }, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logError(`save_template_cookies failed: ${message}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }], isError: true };
    }
  });
}
