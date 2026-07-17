import type { ManifestEntry } from './types.js';

export interface LintResult {
  templateId: string;
  errors: string[];
  warnings: string[];
}

export function isDomainAllowed(domain: string, allowlist: string[] | undefined): boolean {
  if (!allowlist?.length) return false;
  const normalizedDomain = domain.toLowerCase();
  return allowlist.some((allowedDomain) => {
    const normalizedAllowedDomain = allowedDomain.toLowerCase();
    return normalizedAllowedDomain === '*' || normalizedDomain === normalizedAllowedDomain || normalizedDomain.endsWith(`.${normalizedAllowedDomain}`);
  });
}

export function lintManifestEntry(entry: ManifestEntry, rawScript: string): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!entry.allowedDomains?.length) errors.push('missing/empty network allowlist');
  if (entry.allowedDomains?.includes('*')) warnings.push("wildcard '*' allowlist defeats sandboxing");
  for (const pattern of ['child_process', 'eval(', 'fs.unlink', 'fs.writeFile']) {
    if (rawScript.includes(pattern)) errors.push(`disallowed pattern in template script: ${pattern}`);
  }
  return { templateId: entry.templateId, errors, warnings };
}
