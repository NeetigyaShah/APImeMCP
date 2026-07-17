import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

function runRegistryHelper(expression: string): unknown {
  const source = `
    import { computeBadge, parseArgs, verifyEntries } from './scripts/verify-registry-core.js';
    const value = await (${expression});
    process.stdout.write(JSON.stringify(value));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8' }));
}

describe('verify-registry helpers', () => {
  it('marks successful verification as passing', () => {
    expect(runRegistryHelper("computeBadge([{ templateId: 'good', ok: true, durationMs: 1, timestamp: '2026-01-01T00:00:00.000Z' }])"))
      .toEqual({ schemaVersion: 1, label: 'apimemcp', message: 'passing', color: 'brightgreen' });
  });

  it('marks any failed verification as failing', () => {
    expect(runRegistryHelper("computeBadge([{ templateId: 'bad', ok: false, durationMs: 1, timestamp: '2026-01-01T00:00:00.000Z', error: 'missing selector' }])"))
      .toEqual({ schemaVersion: 1, label: 'apimemcp', message: 'failing', color: 'red' });
  });

  it('marks skipped templates as unverified', () => {
    expect(runRegistryHelper("computeBadge([{ templateId: 'input', ok: false, durationMs: 0, timestamp: '2026-01-01T00:00:00.000Z', skipped: 'no-fixed-target' }])"))
      .toEqual({ schemaVersion: 1, label: 'apimemcp', message: 'unverified', color: 'lightgrey' });
  });
  it('uses documented defaults and parses supported flags', () => {
    expect(runRegistryHelper('parseArgs([])')).toMatchObject({ concurrency: 4, out: '.verify-badges', dryRun: false });
    expect(runRegistryHelper("parseArgs(['--only', 'fixed-template', '--concurrency', '2', '--out', 'tmp', '--dry-run'])"))
      .toMatchObject({ only: 'fixed-template', concurrency: 2, out: 'tmp', dryRun: true });
  });
  it('uses the in-process run result metadata without timing the runner', async () => {
    const records = runRegistryHelper(`verifyEntries({
      fixed: { templateId: 'fixed', domainPattern: 'example.com', fixedTargetUrl: 'https://example.com' },
    }, { runEntry: async () => ({ success: false, error: 'missing selector', meta: { durationMs: 123, timestamp: '2026-07-17T08:00:00.000Z' } }) })`);

    expect(records).toEqual([{
      templateId: 'fixed', ok: false, error: 'missing selector', durationMs: 123, timestamp: '2026-07-17T08:00:00.000Z',
    }]);
  });

  it('records request domains outside a declared allowlist as drift', async () => {
    const records = runRegistryHelper(`verifyEntries({
      fixed: { templateId: 'fixed', domainPattern: 'example.com', fixedTargetUrl: 'https://example.com', allowedDomains: ['example.com'] },
    }, {
      isDomainAllowed: (domain, allowlist) => allowlist.includes(domain),
      runEntry: async () => ({ success: true, observedDomains: ['example.com', 'evil.example'], meta: { durationMs: 1, timestamp: '2026-07-17T08:00:00.000Z' } }),
    })`);

    expect(records[0]).toMatchObject({
      ok: false,
      network: { verdict: 'drift', observedDomains: ['evil.example', 'example.com'], undeclaredDomains: ['evil.example'] },
    });
  });
});
