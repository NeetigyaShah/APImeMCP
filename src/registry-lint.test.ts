import { describe, expect, it } from 'vitest';
import { isDomainAllowed, lintManifestEntry } from './registry-lint.js';
import type { ManifestEntry } from './types.js';

const entry: ManifestEntry = {
  templateId: 'example-template',
  domainPattern: 'example.com',
  scriptPath: 'templates/example-template.js',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('isDomainAllowed', () => {
  it('allows exact domains and subdomains, but fails closed without an allowlist', () => {
    expect(isDomainAllowed('api.example.com', ['example.com'])).toBe(true);
    expect(isDomainAllowed('unrelated.example', ['example.com'])).toBe(false);
    expect(isDomainAllowed('example.com', undefined)).toBe(false);
    expect(isDomainAllowed('example.com', [])).toBe(false);
    expect(isDomainAllowed('anything.example', ['*'])).toBe(true);
  });
});

describe('lintManifestEntry', () => {
  it('reports missing declarations and disallowed script patterns', () => {
    expect(lintManifestEntry(entry, 'eval("unsafe")')).toEqual({
      templateId: 'example-template',
      errors: ['missing/empty network allowlist', 'disallowed pattern in template script: eval('],
      warnings: [],
    });
  });

  it('warns about wildcards and accepts a clean declared template', () => {
    expect(lintManifestEntry({ ...entry, allowedDomains: ['*'] }, '')).toMatchObject({ warnings: ["wildcard '*' allowlist defeats sandboxing"] });
    expect(lintManifestEntry({ ...entry, allowedDomains: ['example.com'] }, '() => document.title')).toEqual({
      templateId: 'example-template', errors: [], warnings: [],
    });
  });
});
