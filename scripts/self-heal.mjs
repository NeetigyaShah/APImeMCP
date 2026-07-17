#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { captureHealForensics, writeHealTicket } from '../dist/self-heal.js';
import { initBrowser, closeBrowser, renderPage } from '../dist/engine.js';
import { fetchRegistryManifest, fetchRegistryTemplateSource } from '../dist/registry-client.js';
import { runExtraction } from '../dist/index.js';
import { atomicWriteFile, findTemplateById } from '../dist/storage.js';
import { checkDrift } from '../dist/drift.js';
import { withLock } from '../dist/lock.js';
import { sendNotification } from '../dist/notifier.js';

function parseArgs(args) {
  const options = { badges: '.verify-badges' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--badges' || arg === '--manifest' || arg === '--only') {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function failingTemplateIds(badgesDir, only) {
  let names;
  try {
    names = await fs.readdir(badgesDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const ids = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const badge = JSON.parse(await fs.readFile(path.join(badgesDir, name), 'utf8'));
    const id = path.basename(name, '.json');
    if (badge.message === 'failing' && (!only || only === id)) ids.push(id);
  }
  return ids.sort();
}

async function loadRegistry(options) {
  if (!options.manifest) {
    const manifest = await fetchRegistryManifest();
    const scripts = new Map();
    for (const entry of Object.values(manifest)) {
      if (entry.kind !== 'action-sequence') scripts.set(entry.templateId, await fetchRegistryTemplateSource(entry));
    }
    return { manifest, scripts };
  }

  const manifestPath = path.resolve(options.manifest);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const registryDir = path.dirname(manifestPath);
  const scripts = new Map();
  for (const entry of Object.values(manifest)) {
    if (entry.kind === 'action-sequence') continue;
    const sourcePath = path.join(registryDir, `${entry.templateId}.js`);
    scripts.set(entry.templateId, await fs.readFile(sourcePath, 'utf8'));
  }
  return { manifest, scripts };
}

function createCoreDeps(manifest, scripts) {
  return {
    loadManifest: async () => manifest,
    findTemplateById,
    readFile: async (filePath) => {
      const templateId = path.basename(filePath, path.extname(filePath));
      const script = scripts.get(templateId);
      if (script === undefined) throw new Error(`No registry script loaded for "${templateId}"`);
      return script;
    },
    resolvePath: path.resolve,
    captureForensics: async (targetUrl) => {
      const page = await renderPage(targetUrl);
      return {
        capturedAt: page.capturedAt,
        domSnapshotPath: page.domSnapshotPath,
        screenshotPath: page.screenshotPath,
        consoleErrors: page.consoleErrors,
      };
    },
    runExtraction: async (targetUrl, templateId, executableScript) => {
      const script = executableScript ?? scripts.get(templateId);
      if (!script) throw new Error(`No extraction script available for "${templateId ?? 'dry-run'}"`);
      const result = await runExtraction(targetUrl, undefined, undefined, undefined, true, undefined, undefined, undefined, script);
      const entry = templateId ? manifest[templateId] : undefined;
      return {
        success: result.success,
        data: result.data,
        error: result.error,
        ...(entry?.outputSchema && result.success ? { drift: checkDrift(entry.templateId, entry.outputSchema, result.data) } : {}),
      };
    },
    atomicWriteFile,
    withLock,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ids = await failingTemplateIds(path.resolve(options.badges), options.only);
  if (ids.length === 0) {
    console.log('No failing verification badges found; no heal tickets created.');
    return;
  }

  const { manifest, scripts } = await loadRegistry(options);
  const coreDeps = createCoreDeps(manifest, scripts);
  const tickets = [];
  await initBrowser();
  try {
    for (const id of ids) {
      if (!manifest[id]) {
        console.warn(`Skipping "${id}": not found in registry manifest.`);
        continue;
      }
      if (!manifest[id].fixedTargetUrl) {
        console.warn(`Skipping "${id}": no fixedTargetUrl for unattended healing.`);
        continue;
      }
      const forensics = await captureHealForensics(id, coreDeps);
      tickets.push(await writeHealTicket(forensics, coreDeps));
    }
  } finally {
    await closeBrowser();
  }

  if (tickets.length && process.env.SELF_HEAL_NOTIFY_URL) {
    await sendNotification(process.env.SELF_HEAL_NOTIFY_URL, `${tickets.length} template(s) need healing — call list_pending_heals.`);
  }
  for (const ticket of tickets) {
    console.log(`${ticket.templateId}: heal ticket ${ticket.id}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
