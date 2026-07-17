import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ActionSequence, Manifest, ManifestEntry } from './types.js';
import { registerTemplate, registerActionSequenceTemplate } from './storage.js';

// jsDelivr mirrors the registry repo's default branch with CDN caching, for free - no
// server to run, no publish step beyond merging a PR. See apimemcp-templates' own
// README for why this is a git repo, not a hosted database.
const REGISTRY_BASE = process.env.APIMEMCP_REGISTRY_BASE ?? 'https://cdn.jsdelivr.net/gh/NeetigyaShah/APImeMCP-Templates@main/registry';

export async function fetchRegistryManifest(): Promise<Manifest> {
  const res = await fetch(`${REGISTRY_BASE}/manifest.json`);
  if (!res.ok) {
    throw new Error(`Failed to fetch registry manifest: HTTP ${res.status}`);
  }
  return (await res.json()) as Manifest;
}

export function listVerifiable(manifest: Manifest): Array<[string, ManifestEntry]> {
  return Object.entries(manifest).filter(([, entry]) => Boolean(entry.fixedTargetUrl));
}

export async function fetchRegistryTemplateSource(entry: ManifestEntry): Promise<string> {
  const extension = entry.kind === 'action-sequence' ? 'json' : 'js';
  const response = await fetch(`${REGISTRY_BASE}/${entry.templateId}.${extension}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch registry template "${entry.templateId}": HTTP ${response.status}`);
  }
  return response.text();
}

function normalizeDomain(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0];
}

/** Same longest-pattern-wins matching convention as storage.ts's findTemplateByUrl,
 *  applied to a bare domain instead of a full URL. */
export function findRegistryEntryForDomain(manifest: Manifest, domain: string): ManifestEntry | undefined {
  const hostname = normalizeDomain(domain);
  let best: ManifestEntry | undefined;
  for (const entry of Object.values(manifest)) {
    const pattern = entry.domainPattern;
    const matches = hostname === pattern || hostname.endsWith(`.${pattern}`);
    if (!matches) continue;
    if (!best || pattern.length > best.domainPattern.length) {
      best = entry;
    }
  }
  return best;
}

export interface AddFromRegistryResult {
  templateId: string;
  registered: boolean;
  error?: string;
}

export async function registerRegistryEntry(entry: ManifestEntry): Promise<AddFromRegistryResult> {
  let contents: string;
  try {
    contents = await fetchRegistryTemplateSource(entry);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { templateId: entry.templateId, registered: false, error: message };
  }

  try {
    if (entry.kind === 'action-sequence') {
      await registerActionSequenceTemplate({
        templateId: entry.templateId,
        sequence: JSON.parse(contents) as ActionSequence,
        source: 'registry',
        contributedBy: entry.contributedBy,
        allowedDomains: entry.allowedDomains,
      });
    } else {
      await registerTemplate({
        templateId: entry.templateId,
        domainPattern: entry.domainPattern,
        executableScript: contents,
        fixedTargetUrl: entry.fixedTargetUrl,
        waitStrategy: entry.waitStrategy,
        readySelector: entry.readySelector,
        outputSchema: entry.outputSchema,
        source: 'registry',
        contributedBy: entry.contributedBy,
        allowedDomains: entry.allowedDomains,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { templateId: entry.templateId, registered: false, error: `Failed to register locally: ${message}` };
  }

  return { templateId: entry.templateId, registered: true };
}

/**
 * Finds a registry entry matching `domain`, downloads its script file, and registers it
 * locally via the SAME storage functions register_extraction_template/the extension use -
 * no separate registration path to keep in sync. Marks the entry source: 'registry' so
 * engine.ts enforces a network allowlist on it by default (see types.ts's
 * ManifestEntry.source comment) - registry templates are community-contributed, not
 * authored by this operator, so they don't get the same unrestricted trust.
 */
export async function addFromRegistry(domain: string): Promise<AddFromRegistryResult> {
  const manifest = await fetchRegistryManifest();
  const entry = findRegistryEntryForDomain(manifest, domain);
  if (!entry) {
    return { templateId: '', registered: false, error: `No registry template found for domain "${domain}"` };
  }

  return registerRegistryEntry(entry);
}

export interface OpenTemplatePrResult {
  prUrl: string;
  branch: string;
}

function assertSafeBranch(branch: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) {
    throw new Error(`Unsafe registry branch name: ${branch}`);
  }
}

function assertSafeFilePath(filePath: string): void {
  if (
    path.isAbsolute(filePath) ||
    filePath.split(/[\\/]+/).some((part) => part === '..') ||
    filePath.includes('\\') ||
    !filePath.startsWith('registry/')
  ) {
    throw new Error(`Unsafe registry file path: ${filePath}`);
  }
}

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function openLocalTemplatePr(
  templateId: string,
  branch: string,
  files: Record<string, string>,
  body: string,
): Promise<OpenTemplatePrResult> {
  const repoPath = process.env.APIMEMCP_REGISTRY_REPO_PATH;
  if (!repoPath) throw new Error('APIMEMCP_REGISTRY_REPO_PATH is required for local registry PR creation');
  const defaultBranch = process.env.APIMEMCP_REGISTRY_DEFAULT_BRANCH ?? 'main';
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apimemcp-registry-pr-'));
  try {
    runGit(['clone', repoPath, workDir], process.cwd());
    runGit(['config', 'user.name', 'apimemcp-self-heal[bot]'], workDir);
    runGit(['config', 'user.email', 'apimemcp-self-heal[bot]@users.noreply.github.com'], workDir);
    runGit(['checkout', '-B', branch, `origin/${defaultBranch}`], workDir);
    for (const [filePath, contents] of Object.entries(files)) {
      assertSafeFilePath(filePath);
      const destination = path.join(workDir, filePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, contents, 'utf8');
    }
    const filePaths = Object.keys(files);
    runGit(['add', ...filePaths], workDir);
    let hasChanges = false;
    try {
      execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: workDir, encoding: 'utf8' });
    } catch (error) {
      if (error instanceof Error && 'status' in error && (error as { status?: number }).status === 1) {
        hasChanges = true;
      } else {
        throw error;
      }
    }
    if (hasChanges) runGit(['commit', '-m', `self-heal: update ${templateId}`, '-m', body], workDir);
    runGit(['push', 'origin', `HEAD:refs/heads/${branch}`], workDir);
    return { prUrl: `${pathToFileURL(repoPath).href}#${branch}`, branch };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function githubRequest<T>(pathName: string, init: RequestInit = {}): Promise<T> {
  const token = process.env.APIMEMCP_REGISTRY_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('GitHub token missing; set APIMEMCP_REGISTRY_GITHUB_TOKEN, GITHUB_TOKEN, or GH_TOKEN');
  const response = await fetch(`https://api.github.com${pathName}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': '@neetigyashah/apimemcp self-heal',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${pathName} failed: HTTP ${response.status} ${text}`);
  }
  return (await response.json()) as T;
}

async function githubRequestOptional<T>(pathName: string): Promise<T | undefined> {
  try {
    return await githubRequest<T>(pathName);
  } catch (error) {
    if (error instanceof Error && error.message.includes('HTTP 404')) return undefined;
    throw error;
  }
}

function encodeRepoPath(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

function encodeGitRef(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

async function openGithubTemplatePr(
  templateId: string,
  branch: string,
  files: Record<string, string>,
  body: string,
): Promise<OpenTemplatePrResult> {
  const repo = process.env.APIMEMCP_REGISTRY_GITHUB_REPO ?? 'NeetigyaShah/APImeMCP-Templates';
  const base = process.env.APIMEMCP_REGISTRY_DEFAULT_BRANCH ?? 'main';
  const baseRef = await githubRequest<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${encodeGitRef(base)}`);
  const branchRef = await githubRequestOptional<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${encodeGitRef(branch)}`);
  if (!branchRef) {
    await githubRequest(`/repos/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }),
    });
  }

  for (const [filePath, contents] of Object.entries(files)) {
    assertSafeFilePath(filePath);
    const contentPath = encodeRepoPath(filePath);
    const existing = await githubRequestOptional<{ sha: string }>(`/repos/${repo}/contents/${contentPath}?ref=${encodeURIComponent(branch)}`);
    await githubRequest(`/repos/${repo}/contents/${contentPath}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `self-heal: update ${templateId}`,
        content: Buffer.from(contents, 'utf8').toString('base64'),
        branch,
        ...(existing?.sha ? { sha: existing.sha } : {}),
      }),
    });
  }

  const pull = await githubRequest<{ html_url: string }>(`/repos/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: `Self-heal ${templateId}`,
      head: branch,
      base,
      body,
    }),
  });
  return { prUrl: pull.html_url, branch };
}

export async function openTemplatePr(
  templateId: string,
  branch: string,
  files: Record<string, string>,
  body: string,
): Promise<OpenTemplatePrResult> {
  assertSafeBranch(branch);
  Object.keys(files).forEach(assertSafeFilePath);
  if (process.env.APIMEMCP_REGISTRY_REPO_PATH) return openLocalTemplatePr(templateId, branch, files, body);
  return openGithubTemplatePr(templateId, branch, files, body);
}
