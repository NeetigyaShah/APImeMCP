import { describe, expect, it } from 'vitest';
import { listVerifiable } from './registry-client.js';
import type { Manifest } from './types.js';

describe('listVerifiable', () => {
  it('returns only registry entries with fixed targets without changing entries', () => {
    const fixedEntry = {
      templateId: 'fixed-template', domainPattern: 'example.com', scriptPath: 'fixed-template.js', fixedTargetUrl: 'https://example.com/live', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const manifest: Manifest = {
      'fixed-template': fixedEntry,
      'input-template': { templateId: 'input-template', domainPattern: 'example.org', scriptPath: 'input-template.js', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    };
    expect(listVerifiable(manifest)).toEqual([['fixed-template', fixedEntry]]);
  });
});
