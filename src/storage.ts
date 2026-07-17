import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ActionSequence, Manifest, ManifestEntry, Recording, RegisterExtractionTemplateInput } from './types.js';
import { withLock } from './lock.js';
import { writeUsageReadme } from './usage.js';

function getTemplatesDir(): string {
  return path.resolve(process.cwd(), 'templates');
}

function getManifestPath(): string {
  return path.join(getTemplatesDir(), 'manifest.json');
}

function getRecordingsDir(): string {
  return path.join(getTemplatesDir(), 'recordings');
}

function getRecordingPath(id: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new Error('recording id must contain only letters, numbers, dot, underscore, or dash');
  }
  return path.join(getRecordingsDir(), `${id}.json`);
}

export async function ensureStorageInitialized(): Promise<void> {
  await fs.mkdir(getTemplatesDir(), { recursive: true });
  try {
    await fs.access(getManifestPath());
  } catch {
    await saveManifest({});
  }
}

export async function loadManifest(): Promise<Manifest> {
  await ensureStorageInitialized();
  const raw = await fs.readFile(getManifestPath(), 'utf8');
  return JSON.parse(raw) as Manifest;
}

export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${randomUUID()}`);
  await fs.writeFile(tmpPath, data, 'utf8');
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    throw err;
  }
}

export async function saveManifest(manifest: Manifest): Promise<void> {
  await atomicWriteFile(getManifestPath(), JSON.stringify(manifest, null, 2));
}

export async function registerTemplate(
  // source/contributedBy are NOT part of RegisterExtractionTemplateInput (the Zod-validated
  // shape the public register_extraction_template MCP tool uses) - only registry-client.ts
  // calls this function directly in TS with them set, so a template can't self-declare
  // 'local' to escape the registry sandbox (see types.ts's ManifestEntry.source comment).
  input: RegisterExtractionTemplateInput & { source?: 'registry' | 'local'; contributedBy?: string; allowedDomains?: string[] }
): Promise<ManifestEntry> {
  return withLock(async () => {
    const manifest = await loadManifest();
    const now = new Date().toISOString();

    const templatesDir = getTemplatesDir();
    const scriptFileName = `${input.templateId}.js`;
    await fs.writeFile(path.join(templatesDir, scriptFileName), input.executableScript, 'utf8');

    const existing = manifest[input.templateId];
    const entry: ManifestEntry = {
      templateId: input.templateId,
      domainPattern: input.domainPattern,
      scriptPath: path.join('templates', scriptFileName),
      ...(input.fixedTargetUrl ? { fixedTargetUrl: input.fixedTargetUrl } : {}),
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      ...(input.transform ? { transform: input.transform } : {}),
      ...(input.waitStrategy ? { waitStrategy: input.waitStrategy } : {}),
      ...(input.readySelector ? { readySelector: input.readySelector } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.contributedBy ? { contributedBy: input.contributedBy } : {}),
      ...(input.allowedDomains ? { allowedDomains: input.allowedDomains } : {}),
      ...(input.secretInputs ? { secretInputs: input.secretInputs } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.requestHeaders ? { requestHeaders: input.requestHeaders } : {}),
      ...(input.templateKind ? { templateKind: input.templateKind } : {}),
      ...(input.writeScript ? { writeScript: input.writeScript } : {}),
      ...(input.writeInputSchema ? { writeInputSchema: input.writeInputSchema } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    manifest[input.templateId] = entry;
    await saveManifest(manifest);
    await writeUsageReadme(entry, entry.fixedTargetUrl, input.executableScript);
    return entry;
  });
}

export async function registerActionSequenceTemplate(input: {
  templateId: string;
  sequence: ActionSequence;
  source?: 'registry' | 'local';
  contributedBy?: string;
  allowedDomains?: string[];
}): Promise<ManifestEntry> {
  return withLock(async () => {
    const manifest = await loadManifest();
    const now = new Date().toISOString();

    const templatesDir = getTemplatesDir();
    const scriptFileName = `${input.templateId}.json`;
    await fs.writeFile(path.join(templatesDir, scriptFileName), JSON.stringify(input.sequence, null, 2), 'utf8');

    const existing = manifest[input.templateId];
    const entry: ManifestEntry = {
      templateId: input.templateId,
      domainPattern: new URL(input.sequence.startUrl).hostname.toLowerCase(),
      scriptPath: path.join('templates', scriptFileName),
      fixedTargetUrl: input.sequence.startUrl,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      kind: 'action-sequence',
      ...(input.source ? { source: input.source } : {}),
      ...(input.contributedBy ? { contributedBy: input.contributedBy } : {}),
      ...(input.allowedDomains ? { allowedDomains: input.allowedDomains } : {}),
    };
    manifest[input.templateId] = entry;
    await saveManifest(manifest);
    await writeUsageReadme(entry, entry.fixedTargetUrl, JSON.stringify(input.sequence));
    return entry;
  });
}

export async function updateVerificationStatus(
  templateId: string,
  result: { success: boolean; error?: string }
): Promise<void> {
  return withLock(async () => {
    const manifest = await loadManifest();
    const entry = manifest[templateId];
    if (!entry) return;
    entry.lastVerified = { ...result, timestamp: new Date().toISOString() };
    await saveManifest(manifest);
  });
}

export async function saveRecording(recording: Recording): Promise<void> {
  await withLock('recordings', async () => {
    await atomicWriteFile(getRecordingPath(recording.id), JSON.stringify(recording, null, 2));
  });
}

export async function loadRecording(id: string): Promise<Recording | null> {
  try {
    const raw = await fs.readFile(getRecordingPath(id), 'utf8');
    return JSON.parse(raw) as Recording;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function listRecordings(): Promise<Recording[]> {
  return withLock('recordings', async () => {
    await fs.mkdir(getRecordingsDir(), { recursive: true });
    const files = await fs.readdir(getRecordingsDir());
    const recordings = await Promise.all(
      files
        .filter((file) => file.endsWith('.json'))
        .map(async (file) => JSON.parse(await fs.readFile(path.join(getRecordingsDir(), file), 'utf8')) as Recording)
    );
    return recordings.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });
}

export function findTemplateById(manifest: Manifest, templateId: string): ManifestEntry | undefined {
  return manifest[templateId];
}

export function findTemplateByUrl(manifest: Manifest, targetUrl: string): ManifestEntry | undefined {
  const hostname = new URL(targetUrl).hostname.toLowerCase();
  let best: ManifestEntry | undefined;
  for (const entry of Object.values(manifest)) {
    const pattern = entry.domainPattern;
    const matches = hostname === pattern || hostname.endsWith(`.${pattern}`);
    if (!matches) continue;
    if (
      !best ||
      pattern.length > best.domainPattern.length ||
      (pattern.length === best.domainPattern.length && entry.updatedAt > best.updatedAt)
    ) {
      best = entry;
    }
  }
  return best;
}
