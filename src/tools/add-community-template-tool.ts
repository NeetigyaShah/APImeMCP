import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AddCommunityTemplateShape } from '../types.js';
import { addCommunityTemplateCore } from './add-community-template.js';
import type { ToolDeps } from './tool-deps.js';

export function registerAddCommunityTemplateTool(server: McpServer, deps: ToolDeps): void {
  server.tool('add_community_template', AddCommunityTemplateShape, async (input) => {
    try {
      const result = await addCommunityTemplateCore({ addFromRegistry: deps.registry.add }, input);
      if (result.registered) deps.log(`Added community template "${result.templateId}" for domain "${input.domain}"`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], isError: !result.registered };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logError(`add_community_template failed: ${message}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }], isError: true };
    }
  });
}
