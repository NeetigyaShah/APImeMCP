import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from './types.js';

const storage = vi.hoisted(() => ({
  registerTemplate: vi.fn(),
  registerActionSequenceTemplate: vi.fn(),
}));

vi.mock('./storage.js', () => storage);

import { addFromRegistry, listVerifiable, submitTemplatePR } from './registry-client.js';

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

describe('submitTemplatePR', () => {
  const entry = {
    templateId: 'example-title',
    domainPattern: 'example.com',
    scriptPath: 'templates/example-title.js',
    fixedTargetUrl: 'https://example.com/product',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
  };

  it('rejects a missing GitHub token before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(submitTemplatePR(entry, { githubToken: '' })).rejects.toThrow(/githubToken is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates a branch, updates the manifest, and opens an unmerged PR', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: { sha: 'base-sha' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ref: 'refs/heads/crystallize/example-title' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: Buffer.from(JSON.stringify({ existing: { templateId: 'existing' } })).toString('base64'),
        sha: 'manifest-sha',
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: { path: 'registry/manifest.json' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ html_url: 'https://github.com/NeetigyaShah/APImeMCP-Templates/pull/1' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(submitTemplatePR(entry, { githubToken: 'test-token', branch: 'crystallize/example-title' })).resolves.toEqual({
      prUrl: 'https://github.com/NeetigyaShah/APImeMCP-Templates/pull/1',
    });

    const calls = fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined }));
    expect(calls[1].body).toMatchObject({ ref: 'refs/heads/crystallize/example-title', sha: 'base-sha' });
    expect(calls[3].body).toMatchObject({ branch: 'crystallize/example-title', sha: 'manifest-sha' });
    expect(JSON.parse(Buffer.from(calls[3].body.content, 'base64').toString('utf8'))['example-title']).toEqual(entry);
    expect(calls[4].url).toContain('/pulls');
    expect(calls[4].body).toMatchObject({ head: 'crystallize/example-title', base: 'main' });
    expect(calls[4].body.body).toContain('auto-generated via computer-use crystallization');
    expect(calls[4].body.body).toContain(JSON.stringify(entry, null, 2));
    expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('/merge'))).toBe(false);
  });
});
