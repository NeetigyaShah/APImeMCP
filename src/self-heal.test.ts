import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from './types.js';
import {
  captureHealForensics,
  listPendingHeals,
  openHealRegistryPr,
  readHealTicket,
  verifyHealSubmission,
  writeHealTicket,
} from './self-heal.js';

const outputSchema = {
  type: 'object',
  required: ['title'],
  properties: { title: { type: 'string' } },
};

describe('self-heal core', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'apimemcp-self-heal-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createDeps(overrides: Record<string, unknown> = {}) {
    const manifest: Manifest = {
      fixture: {
        templateId: 'fixture',
        domainPattern: 'example.com',
        fixedTargetUrl: 'https://example.com/product',
        scriptPath: 'templates/fixture.js',
        outputSchema,
        createdAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z',
      },
    };
    return {
      loadManifest: vi.fn(async () => manifest),
      findTemplateById: vi.fn((loaded: Manifest, templateId: string) => loaded[templateId]),
      readFile: vi.fn(async () => '() => ({ title: document.title })'),
      readdir: vi.fn(async () => []),
      resolvePath: (...parts: string[]) => path.resolve(...parts),
      ticketDir: path.join(tempDir, 'templates', 'heal-tickets'),
      captureForensics: vi.fn(async () => ({
        capturedAt: '2026-07-17T12:00:00.000Z',
        domSnapshotPath: path.join(tempDir, 'output', 'dom.html'),
        screenshotPath: path.join(tempDir, 'output', 'shot.png'),
        consoleErrors: ['missing selector'],
      })),
      runExtraction: vi.fn(async () => ({
        success: true,
        data: { category: 'Books' },
        drift: {
          templateId: 'fixture',
          timestamp: '2026-07-17T12:00:01.000Z',
          hasDrift: true,
          entries: [{ path: 'title', kind: 'field_removed', expected: 'present' }],
        },
      })),
      atomicWriteFile: vi.fn(async (filePath: string, data: string) => {
        await import('node:fs/promises').then(({ mkdir, writeFile }) =>
          mkdir(path.dirname(filePath), { recursive: true }).then(() => writeFile(filePath, data, 'utf8'))
        );
      }),
      withLock: async <T>(_key: string, fn: () => Promise<T>) => fn(),
      openTemplatePr: vi.fn(async () => ({ prUrl: 'file:///registry#self-heal/fixture', branch: 'self-heal/fixture' })),
      ...overrides,
    };
  }

  it('captures forensics with old script text and a drift diff', async () => {
    const deps = createDeps();

    const forensics = await captureHealForensics('fixture', deps);

    expect(deps.captureForensics).toHaveBeenCalledWith('https://example.com/product');
    expect(deps.runExtraction).toHaveBeenCalledWith('https://example.com/product', 'fixture');
    expect(forensics).toMatchObject({
      templateId: 'fixture',
      targetUrl: 'https://example.com/product',
      oldScript: '() => ({ title: document.title })',
      consoleErrors: ['missing selector'],
      driftDiff: { hasDrift: true, entries: [{ path: 'title' }] },
      outputSchema,
    });
  });

  it('round-trips pending heal tickets in the file store', async () => {
    const deps = createDeps();
    const forensics = await captureHealForensics('fixture', deps);
    const ticket = await writeHealTicket(forensics, deps);

    await expect(readHealTicket(ticket.id, deps)).resolves.toMatchObject({ id: ticket.id, status: 'pending' });
    await expect(listPendingHeals(deps)).resolves.toEqual([expect.objectContaining({ id: ticket.id, templateId: 'fixture' })]);

    const written = JSON.parse(await readFile(path.join(deps.ticketDir, `${ticket.id}.json`), 'utf8'));
    expect(written.forensics.oldScript).toContain('document.title');
  });

  it('validates a passing dry-run without opening a PR', async () => {
    const deps = createDeps({
      runExtraction: vi.fn(async () => ({ success: true, data: { title: 'Fixed' } })),
    });
    const ticket = await writeHealTicket(await captureHealForensics('fixture', createDeps()), deps);

    const result = await verifyHealSubmission(ticket, '() => ({ title: "Fixed" })', deps);

    expect(result).toMatchObject({ valid: true, dryRunOutput: { title: 'Fixed' } });
    expect(deps.openTemplatePr).not.toHaveBeenCalled();
  });

  it('rejects schema-failing dry-runs without opening a PR', async () => {
    const deps = createDeps({
      runExtraction: vi.fn(async () => ({ success: true, data: { title: 42 } })),
    });
    const ticket = await writeHealTicket(await captureHealForensics('fixture', createDeps()), deps);

    const result = await verifyHealSubmission(ticket, '() => ({ title: 42 })', deps);

    expect(result.valid).toBe(false);
    expect(result.rejectedReason).toContain('schema validation failed');
    expect(deps.openTemplatePr).not.toHaveBeenCalled();
    await expect(readHealTicket(ticket.id, deps)).resolves.toMatchObject({ status: 'pending' });
  });

  it('delegates PR creation and exposes no merge helper', async () => {
    const deps = createDeps();
    const ticket = await writeHealTicket(await captureHealForensics('fixture', deps), deps);

    const result = await openHealRegistryPr('fixture', '() => ({ title: "Fixed" })', ticket, { title: 'Fixed' }, deps);

    expect(result).toEqual({ prUrl: 'file:///registry#self-heal/fixture', branch: 'self-heal/fixture' });
    expect(deps.openTemplatePr).toHaveBeenCalledWith(
      'fixture',
      expect.stringMatching(/^self-heal\/fixture-/),
      expect.objectContaining({ 'registry/fixture.js': '() => ({ title: "Fixed" })' }),
      expect.stringContaining(ticket.id),
    );
    expect('mergeTemplatePr' in deps).toBe(false);
  });

  it('minimizes dry-run output in PR bodies to avoid leaking sensitive values', async () => {
    const deps = createDeps();
    const ticket = await writeHealTicket(await captureHealForensics('fixture', deps), deps);

    await openHealRegistryPr('fixture', '() => ({ title: "Fixed" })', ticket, {
      title: 'Fixed',
      secretToken: 'REDACT_ME_TOKEN_VALUE',
      nested: { cookie: 'REDACT_ME_COOKIE_VALUE' },
      longText: 'private-page-data'.repeat(100),
    }, deps);

    const body = vi.mocked(deps.openTemplatePr).mock.calls[0][3];
    expect(body).toContain('Dry-run output summary:');
    expect(body).toContain('Full dry-run output omitted');
    expect(body).not.toContain('```json');
    expect(body).not.toContain('"title": "Fixed"');
    expect(body).not.toContain('REDACT_ME_TOKEN_VALUE');
    expect(body).not.toContain('REDACT_ME_COOKIE_VALUE');
    expect(body).not.toContain('private-page-data');
  });
});
