import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AddCommunityTemplateShape } from '../types.js';
import type { AddFromRegistryResult } from '../registry-client.js';

export interface AddCommunityTemplateDeps {
  addFromRegistry: (domain: string) => Promise<AddFromRegistryResult>;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

export async function addCommunityTemplateCore(
  deps: AddCommunityTemplateDeps,
  args: { domain: string }
): Promise<AddFromRegistryResult> {
  return deps.addFromRegistry(args.domain);
}

export function registerAddCommunityTemplateTool(server: McpServer, deps: AddCommunityTemplateDeps): void {
  server.tool('add_community_template', AddCommunityTemplateShape, async (input) => {
    try {
      const result = await addCommunityTemplateCore(deps, input);
      if (result.registered) deps.log?.(`Added community template "${result.templateId}" for domain "${input.domain}"`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], isError: !result.registered };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logError?.(`add_community_template failed: ${message}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }], isError: true };
    }
  });
}
