import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerConnectAppTool,
  registerConfirmAppConnectionTool,
  registerListAppConnectionsTool,
} from './app-connections-tools.js';
import type { AppConnectionsToolDeps } from './app-connections-tools.js';

type Registration = { name: string; shape: Record<string, unknown>; handler: (input: any) => Promise<any> };

function createHarness(): { server: McpServer; deps: AppConnectionsToolDeps; registrations: Registration[]; calls: string[] } {
  const registrations: Registration[] = [];
  const calls: string[] = [];
  const connection = {
    connectionId: 'amazon', domainPattern: 'amazon.com', loginUrl: 'https://amazon.com/login',
    profileDir: 'templates/app-profiles/amazon', autoStart: false, status: 'connected' as const,
    createdAt: '2026-07-17T00:00:00.000Z',
  };
  return {
    server: { tool: (name: string, shape: Record<string, unknown>, handler: Registration['handler']) => registrations.push({ name, shape, handler }) } as unknown as McpServer,
    deps: {
      appConnections: {
        upsert: async () => { calls.push('upsert'); return { ...connection, status: 'pending' as const }; },
        list: async () => { calls.push('list'); return [connection]; },
      },
      engine: {
        open: async () => { calls.push('open'); return connection; },
        confirm: async () => { calls.push('confirm'); return connection; },
      },
      log: () => calls.push('log'),
      logError: () => calls.push('logError'),
    },
    registrations,
    calls,
  };
}

describe('app connection tool registration', () => {
  it('registers connect_app using injected collaborators only', async () => {
    const { server, deps, registrations, calls } = createHarness();
    registerConnectAppTool(server, deps);
    expect(registrations[0].name).toBe('connect_app');
    expect(registrations[0].shape).toHaveProperty('domainPattern');
    await registrations[0].handler({ connectionId: 'amazon', domainPattern: 'amazon.com', loginUrl: 'https://amazon.com/login' });
    expect(calls).toEqual(['upsert', 'open', 'log']);
  });

  it('registers confirm_app_connection using injected collaborators only', async () => {
    const { server, deps, registrations, calls } = createHarness();
    registerConfirmAppConnectionTool(server, deps);
    expect(registrations[0].name).toBe('confirm_app_connection');
    expect(registrations[0].shape).toHaveProperty('connectionId');
    await registrations[0].handler({ connectionId: 'amazon' });
    expect(calls).toEqual(['confirm', 'log']);
  });

  it('registers list_app_connections using injected collaborators only', async () => {
    const { server, deps, registrations, calls } = createHarness();
    registerListAppConnectionsTool(server, deps);
    expect(registrations[0].name).toBe('list_app_connections');
    await registrations[0].handler({});
    expect(calls).toEqual(['list']);
  });
});
