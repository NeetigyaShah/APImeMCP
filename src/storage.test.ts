import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureStorageInitialized,
  loadManifest,
  saveManifest,
  registerTemplate,
  findTemplateById,
  findTemplateByUrl,
} from './storage.js';
import type { Manifest } from './types.js';

let originalCwd: string;
let tmpDir: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-compiler-test-'));
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('ensureStorageInitialized', () => {
  it('creates templates dir and an empty manifest.json when missing', async () => {
    await ensureStorageInitialized();
    const raw = await fs.readFile(path.join(tmpDir, 'templates', 'manifest.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual({});
  });

  it('does not overwrite an existing manifest.json', async () => {
    await ensureStorageInitialized();
    await saveManifest({
      foo: { templateId: 'foo', domainPattern: 'foo.com', scriptPath: 'templates/foo.js', createdAt: 'x', updatedAt: 'x' },
    });
    await ensureStorageInitialized();
    const manifest = await loadManifest();
    expect(manifest.foo).toBeDefined();
  });
});

describe('saveManifest / loadManifest', () => {
  it('round-trips a manifest through an atomic write', async () => {
    const manifest: Manifest = {
      example: { templateId: 'example', domainPattern: 'example.com', scriptPath: 'templates/example.js', createdAt: 'a', updatedAt: 'b' },
    };
    await saveManifest(manifest);
    expect(await loadManifest()).toEqual(manifest);
  });

  it('leaves no leftover temp files after a save', async () => {
    await saveManifest({});
    const files = await fs.readdir(path.join(tmpDir, 'templates'));
    expect(files.every((f) => !f.includes('.tmp-'))).toBe(true);
  });
});

describe('registerTemplate', () => {
  it('writes the script file and creates a manifest entry', async () => {
    const entry = await registerTemplate({
      templateId: 'amazon-product',
      domainPattern: 'amazon.com',
      executableScript: '(() => document.title)()',
    });
    expect(entry.templateId).toBe('amazon-product');
    const scriptContent = await fs.readFile(path.join(tmpDir, 'templates', 'amazon-product.js'), 'utf8');
    expect(scriptContent).toBe('(() => document.title)()');
  });

  it('upserts by templateId, preserving createdAt but bumping updatedAt', async () => {
    const first = await registerTemplate({ templateId: 'a', domainPattern: 'a.com', executableScript: 'v1' });
    const second = await registerTemplate({ templateId: 'a', domainPattern: 'a.com', executableScript: 'v2' });
    expect(second.createdAt).toBe(first.createdAt);
    const scriptContent = await fs.readFile(path.join(tmpDir, 'templates', 'a.js'), 'utf8');
    expect(scriptContent).toBe('v2');
  });

  it('persists an optional outputSchema unchanged', async () => {
    const outputSchema = {
      type: 'object',
      required: ['title'],
      properties: { title: { type: 'string' } },
    };

    await registerTemplate({
      templateId: 'schema-contract',
      domainPattern: 'example.com',
      executableScript: '(() => ({ title: document.title }))()',
      outputSchema,
    });

    expect((await loadManifest())['schema-contract'].outputSchema).toEqual(outputSchema);
  });

  it('keeps both entries when they share a domainPattern (N:1 domain-to-template support)', async () => {
    await registerTemplate({ templateId: 'old', domainPattern: 'shared.com', executableScript: 'old' });
    await registerTemplate({ templateId: 'new', domainPattern: 'shared.com', executableScript: 'new' });
    const manifest = await loadManifest();
    expect(manifest.old).toBeDefined();
    expect(manifest.new).toBeDefined();
    expect(manifest.old.domainPattern).toBe('shared.com');
    expect(manifest.new.domainPattern).toBe('shared.com');
  });
});

describe('findTemplateById', () => {
  it('returns the matching entry or undefined', () => {
    const manifest: Manifest = {
      a: { templateId: 'a', domainPattern: 'a.com', scriptPath: 'templates/a.js', createdAt: 'x', updatedAt: 'x' },
    };
    expect(findTemplateById(manifest, 'a')?.templateId).toBe('a');
    expect(findTemplateById(manifest, 'missing')).toBeUndefined();
  });
});

describe('findTemplateByUrl', () => {
  const manifest: Manifest = {
    root: { templateId: 'root', domainPattern: 'amazon.com', scriptPath: 'templates/root.js', createdAt: 'x', updatedAt: 'x' },
    sub: { templateId: 'sub', domainPattern: 'smile.amazon.com', scriptPath: 'templates/sub.js', createdAt: 'x', updatedAt: 'x' },
  };

  it('matches an exact hostname', () => {
    expect(findTemplateByUrl(manifest, 'https://amazon.com/dp/123')?.templateId).toBe('root');
  });

  it('matches a subdomain against the root domainPattern', () => {
    expect(findTemplateByUrl({ root: manifest.root }, 'https://www.amazon.com/dp/123')?.templateId).toBe('root');
  });

  it('prefers the most specific domainPattern when multiple match', () => {
    expect(findTemplateByUrl(manifest, 'https://smile.amazon.com/dp/123')?.templateId).toBe('sub');
  });

  it('rejects lookalike domains that merely share a suffix string', () => {
    expect(findTemplateByUrl(manifest, 'https://amazon.com.evil.net/x')).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    expect(findTemplateByUrl(manifest, 'https://unrelated.org')).toBeUndefined();
  });

  it('breaks a tie between identical domainPatterns by most-recently-updated', () => {
    const collidingManifest: Manifest = {
      first: {
        templateId: 'first',
        domainPattern: 'bernhardt.com',
        scriptPath: 'templates/first.js',
        createdAt: 'x',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      second: {
        templateId: 'second',
        domainPattern: 'bernhardt.com',
        scriptPath: 'templates/second.js',
        createdAt: 'x',
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
    };
    expect(findTemplateByUrl(collidingManifest, 'https://bernhardt.com/shop')?.templateId).toBe('second');
  });
});
