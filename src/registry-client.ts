import type { ActionSequence, Manifest, ManifestEntry } from './types.js';
import { registerTemplate, registerActionSequenceTemplate } from './storage.js';

// jsDelivr mirrors the registry repo's default branch with CDN caching, for free - no
// server to run, no publish step beyond merging a PR. See apimemcp-templates' own
// README for why this is a git repo, not a hosted database.
const REGISTRY_BASE = 'https://cdn.jsdelivr.net/gh/NeetigyaShah/APImeMCP-Templates@main/registry';

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

  let contents: string;
  try {
    contents = await fetchRegistryTemplateSource(entry);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { templateId: entry.templateId, registered: false, error: message };
  }

  const isAction = entry.kind === 'action-sequence';

  try {
    if (isAction) {
      const sequence = JSON.parse(contents) as ActionSequence;
      await registerActionSequenceTemplate({
        templateId: entry.templateId,
        sequence,
        source: 'registry',
        contributedBy: entry.contributedBy,
      });
    } else {
      await registerTemplate({
        templateId: entry.templateId,
        domainPattern: entry.domainPattern,
        executableScript: contents,
        fixedTargetUrl: entry.fixedTargetUrl,
        waitStrategy: entry.waitStrategy,
        readySelector: entry.readySelector,
        source: 'registry',
        contributedBy: entry.contributedBy,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { templateId: entry.templateId, registered: false, error: `Failed to register locally: ${message}` };
  }

  return { templateId: entry.templateId, registered: true };
}
