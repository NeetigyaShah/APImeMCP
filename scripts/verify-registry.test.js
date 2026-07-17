import { describe, expect, it } from 'vitest';
import { computeBadge, parseArgs } from './verify-registry.mjs';

describe('computeBadge', () => {
  it('marks successful verification as passing', () => {
    expect(computeBadge([{ templateId: 'good', ok: true, durationMs: 1, timestamp: '2026-01-01T00:00:00.000Z' }]))
      .toEqual({ schemaVersion: 1, label: 'apimemcp', message: 'passing', color: 'brightgreen' });
  });

  it('marks any failed verification as failing', () => {
    expect(computeBadge([{ templateId: 'bad', ok: false, durationMs: 1, timestamp: '2026-01-01T00:00:00.000Z', error: 'missing selector' }]))
      .toEqual({ schemaVersion: 1, label: 'apimemcp', message: 'failing', color: 'red' });
  });

  it('marks skipped templates as unverified', () => {
    expect(computeBadge([{ templateId: 'input', ok: false, durationMs: 0, timestamp: '2026-01-01T00:00:00.000Z', skipped: 'no-fixed-target' }]))
      .toEqual({ schemaVersion: 1, label: 'apimemcp', message: 'unverified', color: 'lightgrey' });
  });
});

describe('parseArgs', () => {
  it('uses documented defaults and parses supported flags', () => {
    expect(parseArgs([])).toMatchObject({ concurrency: 4, out: '.verify-badges', dryRun: false });
    expect(parseArgs(['--only', 'fixed-template', '--concurrency', '2', '--out', 'tmp', '--dry-run']))
      .toMatchObject({ only: 'fixed-template', concurrency: 2, out: 'tmp', dryRun: true });
  });
});

