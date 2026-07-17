import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerExecuteNativeExtractionTool } from './execute-native-extraction-tool.js';
import { registerRegisterExtractionTemplateTool } from './register-extraction-template-tool.js';
import type { ToolDeps } from './tool-deps.js';

type Registration = { name: string; handler: (input: any) => Promise<any> };

function createHarness(): { server: McpServer; deps: ToolDeps; registrations: Registration[]; calls: string[] } {
  const registrations: Registration[] = [];
  const calls: string[] = [];
  return {
    server: { tool: (name: string, _shape: Record<string, unknown>, handler: Registration['handler']) => registrations.push({ name, handler }) } as unknown as McpServer,
    deps: {
      appConnections: {
        upsert: async () => ({ connectionId: 'example', domainPattern: 'example.com', loginUrl: 'https://example.com/login', profileDir: 'templates/app-profiles/example', autoStart: false, status: 'connected' as const, createdAt: '2026-07-17T00:00:00.000Z' }),
        list: async () => [],
      },
      engine: {
        open: async () => ({ connectionId: 'example', domainPattern: 'example.com', loginUrl: 'https://example.com/login', profileDir: 'templates/app-profiles/example', autoStart: false, status: 'connected' as const, createdAt: '2026-07-17T00:00:00.000Z' }),
        confirm: async () => ({ connectionId: 'example', domainPattern: 'example.com', loginUrl: 'https://example.com/login', profileDir: 'templates/app-profiles/example', autoStart: false, status: 'connected' as const, createdAt: '2026-07-17T00:00:00.000Z' }),
      },
      extraction: {
        run: async () => {
          calls.push('run');
          return {
            success: true,
            data: { title: 'Example' },
            schemaValidation: { valid: true },
            meta: { url: 'https://example.com', templateId: 'example', domainMatched: 'example.com', durationMs: 1, timestamp: '2026-07-17T00:00:00.000Z' },
          };
        },
      },
      templates: {
        register: async (input) => {
          calls.push('register');
          return { ...input, scriptPath: 'templates/example.js', createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z' };
        },
      },
      cookies: { save: async () => {} },
      scheduler: { register: async () => ({ jobId: 'job', targetUrl: 'https://example.com', cronExpression: '* * * * *' }) },
      metrics: { getStats: async () => ({}) },
      notifications: { send: async () => {} },
      downloads: { batch: async () => [] },
      registry: { add: async () => ({ registered: true, templateId: 'example' }) },
      progress: { report: async () => {} },
      log: () => calls.push('log'),
      logError: () => calls.push('logError'),
    },
    registrations,
    calls,
  };
}

describe('extraction tool registration', () => {
  it('registers template and execution tools with injected dependencies', async () => {
    const { server, deps, registrations, calls } = createHarness();
    registerRegisterExtractionTemplateTool(server, deps);
    registerExecuteNativeExtractionTool(server, deps);

    await registrations[0].handler({ templateId: 'example', domainPattern: 'example.com', executableScript: 'return {}', outputSchema: { type: 'object' } });
    const result = await registrations[1].handler({ templateId: 'example' });

    expect(registrations.map(({ name }) => name)).toEqual(['register_extraction_template', 'execute_native_extraction']);
    expect(calls).toEqual(['register', 'log', 'run']);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ schemaValidation: { valid: true } });
  });
});
