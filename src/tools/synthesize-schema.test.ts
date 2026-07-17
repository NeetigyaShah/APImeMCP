import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerSynthesizeSchemaTool, SynthesizeSchemaShape } from './synthesize-schema.js';
import type { SynthesizeSchemaDeps } from './synthesize-schema.js';

type Registration = { name: string; handler: (input: Record<string, unknown>) => Promise<any> };

function createHarness(): { deps: SynthesizeSchemaDeps; registrations: Registration[]; calls: unknown[] } {
  const registrations: Registration[] = [];
  const calls: unknown[] = [];
  const manifest = {};
  return {
    deps: {
      renderPage: async (targetUrl, options) => {
        calls.push([targetUrl, options]);
        return { html: '<html>fixture</html>', screenshotPath: 'output/page.png', url: targetUrl, capturedAt: '2026-07-17T00:00:00.000Z' };
      },
      crystallizeRecording: (recording) => {
        calls.push(['crystallizeRecording', recording.targetUrl]);
        return '() => ({ price: document.querySelector("[data-price]").textContent.trim() })';
      },
      executeExtraction: async (options) => {
        calls.push(['executeExtraction', options]);
        return { price: '$42.00' };
      },
      registerTemplate: async (input) => {
        calls.push(['registerTemplate', input]);
        return {
          templateId: input.templateId,
          domainPattern: input.domainPattern,
          scriptPath: `templates/${input.templateId}.js`,
          fixedTargetUrl: input.fixedTargetUrl,
          outputSchema: input.outputSchema,
          createdAt: '2026-07-17T00:00:00.000Z',
          updatedAt: '2026-07-17T00:00:00.000Z',
        };
      },
      loadManifest: async () => manifest,
      findTemplateByUrl: () => undefined,
      saveRecording: async (recording) => calls.push(['saveRecording', recording]),
      submitTemplatePR: vi.fn(async () => ({ prUrl: 'https://github.com/NeetigyaShah/APImeMCP-Templates/pull/1' })),
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

  it('dry-runs and registers a supplied script without opening a PR by default', async () => {
    const { deps, registrations, calls } = createHarness();
    registerSynthesizeSchemaTool({ tool: (name: string, _shape: unknown, handler: Registration['handler']) => registrations.push({ name, handler }) } as unknown as McpServer, deps);

    const result = await registrations[0].handler({
      targetUrl: 'https://example.com/product',
      templateId: 'example-product',
      script: '() => ({ price: "$42.00" })',
      outputSchema: { type: 'object' },
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({ success: true, templateId: 'example-product', registered: true, data: { price: '$42.00' } });
    expect(calls).toEqual([
      ['executeExtraction', expect.objectContaining({ targetUrl: 'https://example.com/product', executableScript: '() => ({ price: "$42.00" })' })],
      ['registerTemplate', expect.objectContaining({ templateId: 'example-product', domainPattern: 'example.com', outputSchema: { type: 'object' } })],
    ]);
    expect(deps.submitTemplatePR).not.toHaveBeenCalled();
  });

  it('crystallizes a recording, persists forensics, and opens an opt-in PR', async () => {
    const { deps, registrations, calls } = createHarness();
    registerSynthesizeSchemaTool({ tool: (name: string, _shape: unknown, handler: Registration['handler']) => registrations.push({ name, handler }) } as unknown as McpServer, deps);

    const result = await registrations[0].handler({
      targetUrl: 'https://example.com/product',
      templateId: 'example-product',
      recording: { targetUrl: 'https://example.com/product', steps: [{ kind: 'extract', selector: '[data-price]', field: 'price' }] },
      autoPr: true,
      githubToken: 'test-token',
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({ success: true, templateId: 'example-product', prUrl: 'https://github.com/NeetigyaShah/APImeMCP-Templates/pull/1' });
    expect(calls.map((call) => Array.isArray(call) ? call[0] : call)).toEqual([
      'saveRecording',
      'crystallizeRecording',
      'executeExtraction',
      'registerTemplate',
      'saveRecording',
    ]);
    expect(deps.submitTemplatePR).toHaveBeenCalledWith(expect.objectContaining({ templateId: 'example-product' }), {
      githubToken: 'test-token',
      executableScript: '() => ({ price: document.querySelector("[data-price]").textContent.trim() })',
    });
  });

  it('preserves a recording outputSchema when no top-level outputSchema is supplied', async () => {
    const { deps, registrations, calls } = createHarness();
    registerSynthesizeSchemaTool({ tool: (name: string, _shape: unknown, handler: Registration['handler']) => registrations.push({ name, handler }) } as unknown as McpServer, deps);
    const outputSchema = {
      type: 'object',
      required: ['price'],
      properties: { price: { type: 'string' } },
    };

    await registrations[0].handler({
      targetUrl: 'https://example.com/product',
      templateId: 'example-product',
      recording: {
        targetUrl: 'https://example.com/product',
        steps: [{ kind: 'extract', selector: '[data-price]', field: 'price' }],
        outputSchema,
      },
    });

    expect(calls).toContainEqual([
      'registerTemplate',
      expect.objectContaining({ templateId: 'example-product', outputSchema }),
    ]);
  });

  it('short-circuits when the target URL already has a template', async () => {
    const { deps, registrations, calls } = createHarness();
    deps.findTemplateByUrl = () => ({ templateId: 'existing', domainPattern: 'example.com', scriptPath: 'templates/existing.js', createdAt: 'x', updatedAt: 'x' });
    registerSynthesizeSchemaTool({ tool: (name: string, _shape: unknown, handler: Registration['handler']) => registrations.push({ name, handler }) } as unknown as McpServer, deps);

    const result = await registrations[0].handler({ targetUrl: 'https://example.com/product', script: '() => ({})' });
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({ success: false, templateId: 'existing' });
    expect(payload.message).toContain('template exists');
    expect(calls).toEqual([]);
  });

  it('rejects ambiguous script and recording input', async () => {
    const { deps, registrations } = createHarness();
    registerSynthesizeSchemaTool({ tool: (name: string, _shape: unknown, handler: Registration['handler']) => registrations.push({ name, handler }) } as unknown as McpServer, deps);

    await expect(registrations[0].handler({
      targetUrl: 'https://example.com',
      script: '() => ({})',
      recording: { targetUrl: 'https://example.com', steps: [{ kind: 'extract', selector: 'h1', field: 'title' }] },
    })).rejects.toThrow(/only one of script or recording/i);
  });
});
