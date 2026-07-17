import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DriftReport } from './drift.js';
import { checkDrift } from './drift.js';
import type { HealForensics, HealResult, HealStatus, HealTicket, Manifest, ManifestEntry } from './types.js';
import { validateOutput } from './schema.js';

export interface HealCaptureResult {
  capturedAt?: string;
  domPath?: string;
  domSnapshotPath?: string;
  screenshotPath?: string;
  consoleErrors?: string[];
}

export interface HealRunResult {
  success: boolean;
  data?: unknown;
  error?: string;
  drift?: DriftReport;
}

export interface HealCoreDeps {
  loadManifest?: () => Promise<Manifest>;
  findTemplateById?: (manifest: Manifest, templateId: string) => ManifestEntry | undefined;
  readFile?: (filePath: string, encoding: 'utf8') => Promise<string>;
  resolvePath?: (...paths: string[]) => string;
  ticketDir?: string;
  captureForensics?: (targetUrl: string) => Promise<HealCaptureResult>;
  runExtraction?: (targetUrl: string, templateId?: string, executableScript?: string) => Promise<HealRunResult>;
  atomicWriteFile?: (filePath: string, data: string) => Promise<void>;
  withLock?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  openTemplatePr?: (templateId: string, branch: string, files: Record<string, string>, body: string) => Promise<{ prUrl: string; branch: string }>;
}

function requireDep<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`self-heal dependency missing: ${name}`);
  return value;
}

function defaultTicketDir(): string {
  return path.resolve(process.cwd(), 'templates', 'heal-tickets');
}

function ticketPath(ticketId: string, deps: Pick<HealCoreDeps, 'ticketDir'>): string {
  assertSafeTicketId(ticketId);
  return path.join(deps.ticketDir ?? defaultTicketDir(), `${ticketId}.json`);
}

function assertSafeTicketId(ticketId: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(ticketId)) throw new Error('ticketId contains invalid characters');
}

function createTicketId(templateId: string, capturedAt: string): string {
  return `${templateId}-${capturedAt.replace(/[:.]/g, '-')}`;
}

function emptyDriftReport(templateId: string): DriftReport {
  return { templateId, timestamp: new Date().toISOString(), hasDrift: false, entries: [] };
}

async function writeTicketObject(ticket: HealTicket, deps: HealCoreDeps): Promise<HealTicket> {
  const atomicWriteFile = requireDep(deps.atomicWriteFile, 'atomicWriteFile');
  const withLock = requireDep(deps.withLock, 'withLock');
  await withLock('heal-tickets', async () => {
    await atomicWriteFile(ticketPath(ticket.id, deps), `${JSON.stringify(ticket, null, 2)}\n`);
  });
  return ticket;
}

export async function captureHealForensics(templateId: string, deps: HealCoreDeps): Promise<HealForensics> {
  const loadManifest = requireDep(deps.loadManifest, 'loadManifest');
  const findTemplateById = requireDep(deps.findTemplateById, 'findTemplateById');
  const readFile = requireDep(deps.readFile, 'readFile');
  const resolvePath = deps.resolvePath ?? path.resolve;
  const captureForensics = requireDep(deps.captureForensics, 'captureForensics');
  const runExtraction = requireDep(deps.runExtraction, 'runExtraction');

  const manifest = await loadManifest();
  const entry = findTemplateById(manifest, templateId);
  if (!entry) throw new Error(`No registered template with templateId "${templateId}"`);
  if (!entry.fixedTargetUrl) throw new Error(`Template "${templateId}" has no fixedTargetUrl; request_template_heal needs a stable target URL`);

  const oldScript = await readFile(resolvePath(process.cwd(), entry.scriptPath), 'utf8');
  const capture = await captureForensics(entry.fixedTargetUrl);
  const domSnapshotPath = capture.domSnapshotPath ?? capture.domPath;
  if (!domSnapshotPath) throw new Error('Forensic capture did not return a DOM snapshot path');
  if (!capture.screenshotPath) throw new Error('Forensic capture did not return a screenshot path');

  const run = await runExtraction(entry.fixedTargetUrl, templateId);
  const driftDiff = run.drift ?? (entry.outputSchema && run.success ? checkDrift(templateId, entry.outputSchema, run.data) : emptyDriftReport(templateId));

  return {
    templateId,
    capturedAt: capture.capturedAt ?? new Date().toISOString(),
    targetUrl: entry.fixedTargetUrl,
    domSnapshotPath,
    screenshotPath: capture.screenshotPath,
    consoleErrors: capture.consoleErrors ?? [],
    oldScript,
    driftDiff,
    ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : {}),
  };
}

export async function writeHealTicket(forensics: HealForensics, deps: HealCoreDeps): Promise<HealTicket> {
  const ticket: HealTicket = {
    id: createTicketId(forensics.templateId, forensics.capturedAt),
    templateId: forensics.templateId,
    status: 'pending',
    forensics,
    createdAt: forensics.capturedAt,
    updatedAt: forensics.capturedAt,
  };
  return writeTicketObject(ticket, deps);
}

export async function readHealTicket(ticketId: string, deps: HealCoreDeps = {}): Promise<HealTicket> {
  return JSON.parse(await fs.readFile(ticketPath(ticketId, deps), 'utf8')) as HealTicket;
}

export async function listPendingHeals(deps: HealCoreDeps = {}): Promise<HealTicket[]> {
  const dir = deps.ticketDir ?? defaultTicketDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const tickets = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as HealTicket)
  );
  return tickets
    .filter((ticket) => ticket.status !== 'rejected')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function updateHealTicketStatus(ticketId: string, status: HealStatus, deps: HealCoreDeps): Promise<HealTicket> {
  const ticket = await readHealTicket(ticketId, deps);
  const updated = { ...ticket, status, updatedAt: new Date().toISOString() };
  return writeTicketObject(updated, deps);
}

export async function verifyHealSubmission(ticket: HealTicket, newScript: string, deps: HealCoreDeps): Promise<HealResult> {
  const runExtraction = requireDep(deps.runExtraction, 'runExtraction');
  const result = await runExtraction(ticket.forensics.targetUrl, undefined, newScript);
  if (!result.success) {
    return {
      valid: false,
      dryRunOutput: result.data,
      rejectedReason: `dry-run failed: ${result.error ?? 'unknown error'}`,
    };
  }

  const validation = validateOutput(result.data, ticket.forensics.outputSchema);
  if (!validation.valid) {
    return {
      valid: false,
      validationErrors: validation.errors,
      dryRunOutput: result.data,
      rejectedReason: `schema validation failed: ${(validation.errors ?? []).join('; ') || 'invalid output'}`,
    };
  }

  return { valid: true, dryRunOutput: result.data };
}

function safeBranchSuffix(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildPrBody(ticket: HealTicket, dryRunOutput: unknown): string {
  return [
    `Self-heal submission for \`${ticket.templateId}\`.`,
    '',
    `Ticket: \`${ticket.id}\``,
    `Target URL: ${ticket.forensics.targetUrl}`,
    `Captured at: ${ticket.forensics.capturedAt}`,
    '',
    'Validation: dry-run passed and output schema validation passed.',
    '',
    'Forensic artifacts are local to the reporter and are not committed:',
    `- DOM snapshot: ${ticket.forensics.domSnapshotPath}`,
    `- Screenshot: ${ticket.forensics.screenshotPath}`,
    '',
    'Dry-run output preview:',
    '```json',
    JSON.stringify(dryRunOutput, null, 2),
    '```',
  ].join('\n');
}

export async function openHealRegistryPr(
  templateId: string,
  newScript: string,
  ticket: HealTicket,
  dryRunOutput: unknown,
  deps: HealCoreDeps,
): Promise<{ prUrl: string; branch: string }> {
  if (ticket.templateId !== templateId) throw new Error(`Ticket "${ticket.id}" belongs to "${ticket.templateId}", not "${templateId}"`);
  const openTemplatePr = requireDep(deps.openTemplatePr, 'openTemplatePr');
  const branch = `self-heal/${templateId}-${safeBranchSuffix(ticket.id)}`;
  const files = { [`registry/${templateId}.js`]: newScript };
  return openTemplatePr(templateId, branch, files, buildPrBody(ticket, dryRunOutput));
}
