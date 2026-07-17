import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from './types.js';

const storage = vi.hoisted(() => ({
  registerTemplate: vi.fn(),
  registerActionSequenceTemplate: vi.fn(),
}));

vi.mock('./storage.js', () => storage);

import { addFromRegistry, listVerifiable } from './registry-client.js';

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

describe('addFromRegistry', () => {
  const outputSchema = {
    type: 'object',
    required: ['title'],
    properties: { title: { type: 'string' } },
  };

  beforeEach(() => {
    storage.registerTemplate.mockReset();
    storage.registerActionSequenceTemplate.mockReset();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        product: {
          templateId: 'product',
          domainPattern: 'example.com',
          scriptPath: 'templates/product.js',
          createdAt: '2026-07-17T00:00:00.000Z',
          updatedAt: '2026-07-17T00:00:00.000Z',
          outputSchema,
        },
      })))
      .mockResolvedValueOnce(new Response('(() => ({ title: document.title }))()')));
  });

  it('preserves the registry output schema during local registration', async () => {
    await expect(addFromRegistry('example.com')).resolves.toEqual({ templateId: 'product', registered: true });

    expect(storage.registerTemplate).toHaveBeenCalledWith(expect.objectContaining({ outputSchema }));
  });
});
