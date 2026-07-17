import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerSynthesizeSchemaTool, SynthesizeSchemaShape } from './synthesize-schema.js';
import type { SynthesizeSchemaDeps } from './synthesize-schema.js';

type Registration = { name: string; handler: (input: Record<string, string | undefined>) => Promise<any> };

function createHarness(): { deps: SynthesizeSchemaDeps; registrations: Registration[]; calls: unknown[] } {
  const registrations: Registration[] = [];
  const calls: unknown[] = [];
  return {
    deps: {
      renderPage: async (targetUrl, options) => {
        calls.push([targetUrl, options]);
        return { html: '<html>fixture</html>', screenshotPath: 'output/page.png', url: targetUrl, capturedAt: '2026-07-17T00:00:00.000Z' };
      },
    },
    registrations,
    calls,
  };
}

describe('synthesize_schema tool', () => {
  it('rejects non-HTTP target URLs before renderPage is invoked', () => {
    expect(z.object(SynthesizeSchemaShape).safeParse({ targetUrl: 'file:///etc/passwd' }).success).toBe(false);
  });

  it('returns supplied forensics and the dry-run next step', async () => {
    const { deps, registrations, calls } = createHarness();
    registerSynthesizeSchemaTool({ tool: (name: string, _shape: unknown, handler: Registration['handler']) => registrations.push({ name, handler }) } as unknown as McpServer, deps);

    const result = await registrations[0].handler({ targetUrl: 'https://example.com/page' });
    const payload = JSON.parse(result.content[0].text);

    expect(registrations[0].name).toBe('synthesize_schema');
    expect(calls).toEqual([['https://example.com/page', { cookieString: undefined, proxyUrl: undefined }]]);
    expect(payload).toMatchObject({ html: '<html>fixture</html>', screenshotPath: 'output/page.png', url: 'https://example.com/page' });
    expect(payload.nextStep).toContain('execute_native_extraction');
  });

  it('passes cookie and proxy values through unchanged', async () => {
    const { deps, registrations, calls } = createHarness();
    registerSynthesizeSchemaTool({ tool: (name: string, _shape: unknown, handler: Registration['handler']) => registrations.push({ name, handler }) } as unknown as McpServer, deps);

    await registrations[0].handler({ targetUrl: 'https://example.com', cookieString: 'session=abc', proxyUrl: 'http://proxy.example:8080' });

    expect(calls[0]).toEqual(['https://example.com', { cookieString: 'session=abc', proxyUrl: 'http://proxy.example:8080' }]);
  });
});
