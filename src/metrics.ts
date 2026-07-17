import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withLock } from './lock.js';
import { MeasureRecordSchema } from './types.js';
import type { MeasureRecord, RunKind, TemplateSla } from './types.js';

function getMetricsDirectory(): string {
  return path.join(path.resolve(process.cwd()), 'templates');
}

function getMetricsPath(): string {
  return path.join(getMetricsDirectory(), 'extraction_metrics.jsonl');
}

function getLegacyCsvPath(): string {
  return path.join(getMetricsDirectory(), 'extraction_metrics.csv');
}

function getMigrationMarkerPath(): string {
  return path.join(getMetricsDirectory(), '.extraction_metrics_csv_migrated');
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (inQuotes) {
      if (character === '"' && line[index + 1] === '"') {
        current += '"';
        index++;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        current += character;
      }
    } else if (character === '"') {
      inQuotes = true;
    } else if (character === ',') {
      fields.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  fields.push(current);
  return fields;
}

async function appendRecords(records: MeasureRecord[]): Promise<void> {
  if (records.length === 0) return;
  await fs.mkdir(getMetricsDirectory(), { recursive: true });
  await fs.appendFile(getMetricsPath(), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

async function migrateLegacyCsvIfPresentLocked(): Promise<void> {
  const markerPath = getMigrationMarkerPath();
  const migrated = await fs.access(markerPath).then(() => true, () => false);
  if (migrated) return;

  let raw: string;
  try {
    raw = await fs.readFile(getLegacyCsvPath(), 'utf8');
  } catch {
    return;
  }

  const records = raw
    .trim()
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map(parseCsvLine)
    .map(([timestamp, templateId]) =>
      MeasureRecordSchema.parse({ templateId, kind: 'extraction', success: true, durationMs: 0, timestamp })
    );
  await appendRecords(records);
  await fs.writeFile(markerPath, '', 'utf8');
}

export async function migrateLegacyCsvIfPresent(): Promise<void> {
  await withLock(migrateLegacyCsvIfPresentLocked);
}

export function preExecutionMeasure(
  templateId?: string,
  targetUrl?: string
): { templateId: string; kind: RunKind } {
  return {
    templateId: templateId ?? (targetUrl ? 'unmatched-domain' : 'no-input'),
    kind: 'extraction',
  };
}

export async function recordMeasure(record: MeasureRecord): Promise<void> {
  const validated = MeasureRecordSchema.parse(record);
  await withLock(async () => {
    await migrateLegacyCsvIfPresentLocked();
    await appendRecords([validated]);
  });
}

async function readMeasures(): Promise<MeasureRecord[]> {
  await migrateLegacyCsvIfPresent();
  let raw: string;
  try {
    raw = await fs.readFile(getMetricsPath(), 'utf8');
  } catch {
    return [];
  }

  return raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = MeasureRecordSchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
}

function nearestRank(sortedDurations: number[], percentile: number): number {
  return sortedDurations[Math.max(0, Math.ceil((percentile / 100) * sortedDurations.length) - 1)] ?? 0;
}

function toSla(templateId: string, records: MeasureRecord[]): TemplateSla {
  const sortedByTimestamp = [...records].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const durations = records.map((record) => record.durationMs).sort((left, right) => left - right);
  const successCount = records.filter((record) => record.success).length;
  const latestFailure = [...sortedByTimestamp].reverse().find((record) => !record.success);
  const driftRecords = sortedByTimestamp.filter((record) => record.driftDetected === true);
  const driftEntries = driftRecords.flatMap((record) => record.driftEntries ?? []);
  return {
    templateId,
    runs: records.length,
    successCount,
    successRate: successCount / records.length,
    avgDurationMs: durations.reduce((total, duration) => total + duration, 0) / records.length,
    p50DurationMs: nearestRank(durations, 50),
    p95DurationMs: nearestRank(durations, 95),
    lastRunAt: sortedByTimestamp.at(-1)?.timestamp ?? '',
    ...(latestFailure?.error ? { lastError: latestFailure.error } : {}),
    driftCount: driftRecords.length,
    ...(driftRecords.at(-1) ? { lastDriftAt: driftRecords.at(-1)!.timestamp } : {}),
    driftEntries,
  };
}

export async function getAllSla(): Promise<TemplateSla[]> {
  const byTemplate = new Map<string, MeasureRecord[]>();
  for (const record of await readMeasures()) {
    const records = byTemplate.get(record.templateId) ?? [];
    records.push(record);
    byTemplate.set(record.templateId, records);
  }
  return [...byTemplate.entries()]
    .map(([templateId, records]) => toSla(templateId, records))
    .sort((left, right) => left.templateId.localeCompare(right.templateId));
}

export async function getTemplateSla(templateId: string): Promise<TemplateSla | undefined> {
  return (await getAllSla()).find((sla) => sla.templateId === templateId);
}
