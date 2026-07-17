import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAllSla, getTemplateSla, migrateLegacyCsvIfPresent, recordMeasure } from './metrics.js';

let originalCwd: string;
let tempDir: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apimemcp-metrics-'));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('metrics SLA store', () => {
  it('appends validated measure records as JSON Lines', async () => {
    const record = {
      templateId: 'sample-template',
      kind: 'extraction' as const,
      success: true,
      durationMs: 42,
      timestamp: '2026-07-17T08:00:00.000Z',
    };

    await recordMeasure(record);

    const raw = await fs.readFile(path.join(tempDir, 'templates', 'extraction_metrics.jsonl'), 'utf8');
    expect(JSON.parse(raw.trim())).toEqual(record);
  });

  it('aggregates success rate and nearest-rank latency percentiles', async () => {
    const durations = [10, 20, 30, 40, 100];
    for (const [index, durationMs] of durations.entries()) {
      await recordMeasure({
        templateId: 't1',
        kind: 'extraction',
        success: index !== 1 && index !== 3,
        durationMs,
        timestamp: `2026-07-17T08:00:0${index}.000Z`,
        ...(index === 1 ? { error: 'first failure' } : {}),
        ...(index === 3 ? { error: 'latest failure' } : {}),
      });
    }

    const sla = await getTemplateSla('t1');

    expect(sla).toMatchObject({
      templateId: 't1',
      runs: 5,
      successCount: 3,
      successRate: 0.6,
      avgDurationMs: 40,
      p50DurationMs: 30,
      p95DurationMs: 100,
      lastRunAt: '2026-07-17T08:00:04.000Z',
      lastError: 'latest failure',
    });
  });

  it('returns undefined for templates without measures', async () => {
    expect(await getTemplateSla('missing')).toBeUndefined();
  });

  it('rejects an error on a successful measure', async () => {
    await expect(
      recordMeasure({
        templateId: 't1',
        kind: 'extraction',
        success: true,
        durationMs: 1,
        timestamp: '2026-07-17T08:00:00.000Z',
        error: 'unexpected',
      })
    ).rejects.toThrow('error must be absent when success is true');
  });

  it('migrates legacy CSV rows once without duplicating them', async () => {
    await fs.mkdir(path.join(tempDir, 'templates'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'templates', 'extraction_metrics.csv'),
      'timestamp,templateId,url,imageCount\n2026-07-17T08:00:00.000Z,legacy-template,https://example.com,2\n',
      'utf8'
    );

    await migrateLegacyCsvIfPresent();
    await migrateLegacyCsvIfPresent();

    expect(await getAllSla()).toEqual([
      {
        templateId: 'legacy-template',
        runs: 1,
        successCount: 1,
        successRate: 1,
        avgDurationMs: 0,
        p50DurationMs: 0,
        p95DurationMs: 0,
        lastRunAt: '2026-07-17T08:00:00.000Z',
      },
    ]);
  });
});
