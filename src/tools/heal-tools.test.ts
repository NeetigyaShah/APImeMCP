import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HealTicket } from '../types.js';
import {
  registerListPendingHealsTool,
  registerRequestTemplateHealTool,
  registerSubmitTemplateHealTool,
} from './heal-tools.js';
import type { HealToolsDeps } from './heal-tools.js';

type Registration = { name: string; handler: (input: any) => Promise<any> };

function createHarness() {
  const registrations: Registration[] = [];
  const calls: string[] = [];
  const ticket: HealTicket = {
    id: 'fixture-2026-07-17T12-00-00-000Z',
    templateId: 'fixture',
    status: 'pending',
    createdAt: '2026-07-17T12:00:00.000Z',
    updatedAt: '2026-07-17T12:00:00.000Z',
    forensics: {
      templateId: 'fixture',
      capturedAt: '2026-07-17T12:00:00.000Z',
      targetUrl: 'https://example.com/product',
      domSnapshotPath: 'output/dom.html',
      screenshotPath: 'output/shot.png',
      consoleErrors: [],
      oldScript: '() => ({})',
      driftDiff: { templateId: 'fixture', timestamp: '2026-07-17T12:00:00.000Z', hasDrift: true, entries: [] },
    },
  };
  const deps: HealToolsDeps = {
    captureHealForensics: vi.fn(async () => {
      calls.push('capture');
      return ticket.forensics;
    }),
    writeHealTicket: vi.fn(async () => {
      calls.push('write');
      return ticket;
    }),
    readHealTicket: vi.fn(async () => {
      calls.push('read');
      return ticket;
    }),
    verifyHealSubmission: vi.fn(async () => {
      calls.push('verify');
      return { valid: true, dryRunOutput: { title: 'Fixed' } };
    }),
    openHealRegistryPr: vi.fn(async () => {
      calls.push('open-pr');
      return { prUrl: 'file:///registry#self-heal/fixture', branch: 'self-heal/fixture' };
    }),
    updateHealTicketStatus: vi.fn(async () => {
      calls.push('status');
      return { ...ticket, status: 'pr-opened' };
    }),
    listPendingHeals: vi.fn(async () => {
      calls.push('list');
      return [ticket];
    }),
    log: () => calls.push('log'),
    logError: () => calls.push('logError'),
  };
  const server = { tool: (name: string, _shape: Record<string, unknown>, handler: Registration['handler']) => registrations.push({ name, handler }) } as unknown as McpServer;
  return { server, deps, registrations, calls };
}

describe('heal tool registration', () => {
  it('requests a heal by capturing forensics and writing one ticket', async () => {
    const { server, deps, registrations, calls } = createHarness();
    registerRequestTemplateHealTool(server, deps);

    const result = await registrations[0].handler({ templateId: 'fixture' });
    const payload = JSON.parse(result.content[0].text);

    expect(registrations[0].name).toBe('request_template_heal');
    expect(payload).toMatchObject({ ticketId: 'fixture-2026-07-17T12-00-00-000Z', forensics: { templateId: 'fixture' } });
    expect(calls).toEqual(['capture', 'write', 'log']);
  });

  it('submits a valid heal by opening a PR and marking the ticket pr-opened', async () => {
    const { server, deps, registrations, calls } = createHarness();
    registerSubmitTemplateHealTool(server, deps);

    const result = await registrations[0].handler({ templateId: 'fixture', ticketId: 'fixture-2026-07-17T12-00-00-000Z', newScript: '() => ({ title: "Fixed" })' });
    const payload = JSON.parse(result.content[0].text);

    expect(registrations[0].name).toBe('submit_template_heal');
    expect(payload).toMatchObject({ valid: true, prUrl: 'file:///registry#self-heal/fixture', branch: 'self-heal/fixture' });
    expect(calls).toEqual(['read', 'verify', 'open-pr', 'status', 'log']);
  });

  it('keeps invalid heal submissions pending and skips PR creation', async () => {
    const { server, deps, registrations, calls } = createHarness();
    deps.verifyHealSubmission = vi.fn(async () => {
      calls.push('verify');
      return { valid: false, rejectedReason: 'schema validation failed: /title must be string' };
    });
    registerSubmitTemplateHealTool(server, deps);

    const result = await registrations[0].handler({ templateId: 'fixture', ticketId: 'fixture-2026-07-17T12-00-00-000Z', newScript: '() => ({ title: 42 })' });
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({ valid: false, rejectedReason: expect.stringContaining('schema validation failed') });
    expect(deps.openHealRegistryPr).not.toHaveBeenCalled();
    expect(deps.updateHealTicketStatus).not.toHaveBeenCalled();
    expect(calls).toEqual(['read', 'verify']);
  });

  it('lists pending heals without forensic blobs', async () => {
    const { server, deps, registrations } = createHarness();
    registerListPendingHealsTool(server, deps);

    const result = await registrations[0].handler({});
    const payload = JSON.parse(result.content[0].text);

    expect(registrations[0].name).toBe('list_pending_heals');
    expect(payload).toEqual([{ id: 'fixture-2026-07-17T12-00-00-000Z', templateId: 'fixture', status: 'pending', createdAt: '2026-07-17T12:00:00.000Z' }]);
    expect(payload[0].forensics).toBeUndefined();
  });
});
