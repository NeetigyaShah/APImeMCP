#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @typedef {{ templateId: string; ok: boolean; durationMs: number; timestamp: string; error?: string; skipped?: 'no-fixed-target' }} VerificationRecord */
/** @typedef {{ schemaVersion: 1; label: 'apimemcp'; message: 'passing' | 'failing' | 'unverified'; color: 'brightgreen' | 'red' | 'lightgrey' }} ShieldsEndpointBadge */

export function parseArgs(args) {
  const options = { concurrency: 4, out: '.verify-badges', dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--only' || argument === '--concurrency' || argument === '--out') {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--only') options.only = value;
      if (argument === '--out') options.out = value;
      if (argument === '--concurrency') {
        const concurrency = Number(value);
        if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer');
        options.concurrency = concurrency;
      }
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

/** @param {VerificationRecord[]} records @returns {ShieldsEndpointBadge} */
export function computeBadge(records) {
  if (records.some((record) => !record.skipped && !record.ok)) {
    return { schemaVersion: 1, label: 'apimemcp', message: 'failing', color: 'red' };
  }
  if (records.some((record) => record.ok)) {
    return { schemaVersion: 1, label: 'apimemcp', message: 'passing', color: 'brightgreen' };
  }
  return { schemaVersion: 1, label: 'apimemcp', message: 'unverified', color: 'lightgrey' };
}

export async function verifyEntries(manifest, { only, concurrency = 4, runEntry }) {
  const entries = Object.entries(manifest).filter(([templateId]) => !only || templateId === only);
  if (only && entries.length === 0) throw new Error(`Registry template "${only}" was not found`);
  const records = new Array(entries.length);
  let cursor = 0;

  async function worker() {
    while (cursor < entries.length) {
      const index = cursor++;
      const [templateId, entry] = entries[index];
      if (!entry.fixedTargetUrl) {
        records[index] = { templateId, ok: false, durationMs: 0, timestamp: new Date().toISOString(), skipped: 'no-fixed-target' };
        continue;
      }
      const result = await runEntry(templateId, entry);
      records[index] = {
        templateId,
        ok: result.success,
        durationMs: result.meta.durationMs,
        timestamp: result.meta.timestamp,
        ...(result.error ? { error: result.error } : {}),
      };
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return records;
}

export async function writeBadgeFiles(records, { out, dryRun, atomicWriteFile, notifyTransition }) {
  if (dryRun) return;
  for (const record of records) {
    const badge = computeBadge([record]);
    const destination = path.join(out, `${record.templateId}.json`);
    let previous;
    try {
      previous = JSON.parse(await fs.readFile(destination, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await atomicWriteFile(destination, `${JSON.stringify(badge, null, 2)}\n`);
    if (previous?.message && previous.message !== badge.message) {
      await notifyTransition?.(record, previous.message, badge.message);
    }
  }
}

export async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDirectory = path.resolve(options.out);
  const [{ fetchRegistryManifest, listVerifiable, registerRegistryEntry }, { initBrowser, closeBrowser }, { runExtraction }, { ensureStorageInitialized, atomicWriteFile }, { withLock }, { sendNotification }] =
    await Promise.all([
      import('../dist/registry-client.js'),
      import('../dist/engine.js'),
      import('../dist/index.js'),
      import('../dist/storage.js'),
      import('../dist/lock.js'),
      import('../dist/notifier.js'),
    ]);
  const manifest = await fetchRegistryManifest();
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apimemcp-registry-verify-'));

  try {
    process.chdir(scratchDir);
    await ensureStorageInitialized();
    for (const [, entry] of listVerifiable(manifest)) {
      const registration = await registerRegistryEntry(entry);
      if (!registration.registered) throw new Error(registration.error);
    }
    await initBrowser();
    const records = await withLock(() => verifyEntries(manifest, {
      only: options.only,
      concurrency: options.concurrency,
      runEntry: async (templateId, entry) => {
        return runExtraction(entry.fixedTargetUrl, templateId, undefined, undefined, true);
      },
    }));
    await writeBadgeFiles(records, {
      out: outputDirectory,
      dryRun: options.dryRun,
      atomicWriteFile,
      notifyTransition: process.env.VERIFY_NOTIFY_URL
        ? (record, previous, current) => sendNotification(process.env.VERIFY_NOTIFY_URL, `Registry verification changed for ${record.templateId}: ${previous} -> ${current}`)
        : undefined,
    });
    for (const record of records) console.log(`${record.templateId}: ${computeBadge([record]).message}`);
  } finally {
    if (process.cwd() === scratchDir) await closeBrowser();
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

