import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { renderPage } from '../engine.js';
import { isHttpUrl } from '../types.js';

export interface SynthesizeSchemaDeps {
  renderPage: typeof renderPage;
}

export const SynthesizeSchemaShape = {
  targetUrl: z.string().refine(isHttpUrl, { message: 'targetUrl must be an absolute http:// or https:// URL' }),
  cookieString: z.string().optional(),
  proxyUrl: z.string().url().optional(),
};

export function registerSynthesizeSchemaTool(server: McpServer, deps: SynthesizeSchemaDeps): void {
  server.tool(
    'synthesize_schema',
    SynthesizeSchemaShape,
    async ({ targetUrl, cookieString, proxyUrl }) => {
      const forensics = await deps.renderPage(targetUrl, { cookieString, proxyUrl });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ...forensics,
                nextStep:
                  'Write an extraction script body from this HTML, then call execute_native_extraction with { targetUrl, executableScript } to dry-run it (nothing is saved). When satisfied, call register_extraction_template to persist it.',
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
