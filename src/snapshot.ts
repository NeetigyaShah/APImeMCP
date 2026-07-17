import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateOutput } from './schema.js';
import { withLock } from './lock.js';
import { atomicWriteFile } from './storage.js';
import { z } from 'zod';

export const SnapshotModeSchema = z.enum(['off', 'record', 'check']);
export type SnapshotMode = z.infer<typeof SnapshotModeSchema>;

export interface GoldenSnapshot {
  templateId: string;
  capturedAt: string;
  targetUrl?: string;
  outputHash: string;
  data: unknown;
  schemaValid?: boolean;
}

export interface SnapshotDiffEntry {
  path: string;
  expected?: unknown;
  actual?: unknown;
}

export type SnapshotComparison =
  | { status: 'no-baseline'; templateId: string }
  | { status: 'match'; templateId: string }
  | { status: 'regression'; templateId: string; diff: SnapshotDiffEntry[] };

export function snapshotPath(templateId: string): string {
  return path.join('templates', 'snapshots', `${templateId}.json`);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function diffValues(expected: unknown, actual: unknown, currentPath = '$'): SnapshotDiffEntry[] {
  if (expected === actual || (Number.isNaN(expected) && Number.isNaN(actual))) return [];

  if (Array.isArray(expected) && Array.isArray(actual)) {
    const diff: SnapshotDiffEntry[] = [];
    for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
      const itemPath = `${currentPath === '$' ? '' : currentPath}[${index}]` || `[${index}]`;
      if (index >= expected.length) diff.push({ path: itemPath, actual: actual[index] });
      else if (index >= actual.length) diff.push({ path: itemPath, expected: expected[index] });
      else diff.push(...diffValues(expected[index], actual[index], itemPath));
    }
    return diff;
  }

  if (isObject(expected) && isObject(actual)) {
    const diff: SnapshotDiffEntry[] = [];
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      const keyPath = currentPath === '$' ? key : `${currentPath}.${key}`;
      const expectedHasKey = hasOwn(expected, key);
      const actualHasKey = hasOwn(actual, key);
      if (!expectedHasKey) diff.push({ path: keyPath, actual: actual[key] });
      else if (!actualHasKey) diff.push({ path: keyPath, expected: expected[key] });
      else diff.push(...diffValues(expected[key], actual[key], keyPath));
    }
    return diff;
  }

  return [{ path: currentPath, expected, actual }];
}

export async function saveSnapshot(
  templateId: string,
  data: unknown,
  opts: { targetUrl?: string; outputSchema?: unknown } = {},
): Promise<GoldenSnapshot> {
  const record: GoldenSnapshot = {
    templateId,
    capturedAt: new Date().toISOString(),
    ...(opts.targetUrl ? { targetUrl: opts.targetUrl } : {}),
    outputHash: createHash('sha256').update(stableStringify(data)).digest('hex'),
    data,
    ...(opts.outputSchema !== undefined ? { schemaValid: validateOutput(data, opts.outputSchema as Record<string, unknown>).valid } : {}),
  };
  await withLock(async () => atomicWriteFile(snapshotPath(templateId), JSON.stringify(record, null, 2)));
  return record;
}

export async function loadSnapshot(templateId: string): Promise<GoldenSnapshot | null> {
  try {
    return JSON.parse(await fs.readFile(snapshotPath(templateId), 'utf8')) as GoldenSnapshot;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function compareSnapshot(templateId: string, liveData: unknown): Promise<SnapshotComparison> {
  const baseline = await loadSnapshot(templateId);
  if (!baseline) return { status: 'no-baseline', templateId };
  if (stableStringify(baseline.data) === stableStringify(liveData)) return { status: 'match', templateId };
  return { status: 'regression', templateId, diff: diffValues(baseline.data, liveData) };
}
