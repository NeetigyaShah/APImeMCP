import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from './types.js';

const storage = vi.hoisted(() => ({
  registerTemplate: vi.fn(),
  registerActionSequenceTemplate: vi.fn(),
}));

vi.mock('./storage.js', () => storage);

import { addFromRegistry, listVerifiable, openTemplatePr, submitTemplatePR } from './registry-client.js';

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

describe('openTemplatePr', () => {
  it('creates a local registry branch without merging into the default branch', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'apimemcp registry-pr-test-'));
    const workDir = path.join(tempDir, 'work');
    const remoteDir = path.join(tempDir, 'remote.git');
    const run = (args: string[], cwd = workDir) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const env = process.env.APIMEMCP_REGISTRY_REPO_PATH;
    const originalDefaultBranch = process.env.APIMEMCP_REGISTRY_DEFAULT_BRANCH;
    try {
      execFileSync('git', ['init', '--bare', remoteDir], { encoding: 'utf8' });
      execFileSync('git', ['clone', remoteDir, workDir], { encoding: 'utf8' });
      run(['config', 'user.name', 'Test Bot']);
      run(['config', 'user.email', 'bot@example.com']);
      await import('node:fs/promises').then(({ mkdir, writeFile }) =>
        mkdir(path.join(workDir, 'registry'), { recursive: true }).then(() => writeFile(path.join(workDir, 'registry', 'fixture.js'), '() => ({ title: "Old" })'))
      );
      run(['add', 'registry/fixture.js']);
      run(['commit', '-m', 'seed registry']);
      run(['branch', '-M', 'main']);
      run(['push', 'origin', 'main']);
      process.env.APIMEMCP_REGISTRY_REPO_PATH = process.platform === 'win32' ? remoteDir.replaceAll('/', '\\') : remoteDir;
      process.env.APIMEMCP_REGISTRY_DEFAULT_BRANCH = 'main';

      const result = await openTemplatePr(
        'fixture',
        'self-heal/fixture',
        { 'registry/fixture.js': '() => ({ title: "Fixed" })' },
        'Heal fixture',
      );

      expect(result).toMatchObject({ prUrl: expect.stringContaining('#self-heal/fixture'), branch: 'self-heal/fixture' });
      expect(execFileSync('git', ['--git-dir', remoteDir, 'show', 'main:registry/fixture.js'], { encoding: 'utf8' })).toContain('Old');
      expect(execFileSync('git', ['--git-dir', remoteDir, 'show', 'self-heal/fixture:registry/fixture.js'], { encoding: 'utf8' })).toContain('Fixed');
      await expect(readFile(path.join(workDir, 'registry', 'fixture.js'), 'utf8')).resolves.toContain('Old');
    } finally {
      if (env === undefined) delete process.env.APIMEMCP_REGISTRY_REPO_PATH;
      else process.env.APIMEMCP_REGISTRY_REPO_PATH = env;
      if (originalDefaultBranch === undefined) delete process.env.APIMEMCP_REGISTRY_DEFAULT_BRANCH;
      else process.env.APIMEMCP_REGISTRY_DEFAULT_BRANCH = originalDefaultBranch;
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
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

  it('rejects a missing generated script before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(submitTemplatePR(entry, { githubToken: 'test-token' })).rejects.toThrow(/executableScript is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates a branch with the generated script, updates the manifest, and opens an unmerged PR', async () => {
    const executableScript = '(async () => ({ price: "$42.00" }))()';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: { sha: 'base-sha' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ref: 'refs/heads/crystallize/example-title' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: Buffer.from(JSON.stringify({ existing: { templateId: 'existing' } })).toString('base64'),
        sha: 'manifest-sha',
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: { path: 'registry/example-title.js' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: { path: 'registry/manifest.json' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ html_url: 'https://github.com/NeetigyaShah/APImeMCP-Templates/pull/1' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(submitTemplatePR(entry, { githubToken: 'test-token', branch: 'crystallize/example-title', executableScript })).resolves.toEqual({
      prUrl: 'https://github.com/NeetigyaShah/APImeMCP-Templates/pull/1',
    });

    const calls = fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined }));
    expect(calls[1].body).toMatchObject({ ref: 'refs/heads/crystallize/example-title', sha: 'base-sha' });
    expect(calls[3].url).toContain('/contents/registry/example-title.js');
    expect(calls[3].body).toMatchObject({ branch: 'crystallize/example-title' });
    expect(Buffer.from(calls[3].body.content, 'base64').toString('utf8')).toBe(`${executableScript}\n`);
    expect(calls[4].body).toMatchObject({ branch: 'crystallize/example-title', sha: 'manifest-sha' });
    expect(JSON.parse(Buffer.from(calls[4].body.content, 'base64').toString('utf8'))['example-title']).toEqual({ ...entry, scriptPath: 'example-title.js' });
    expect(calls[5].url).toContain('/pulls');
    expect(calls[5].body).toMatchObject({ head: 'crystallize/example-title', base: 'main' });
    expect(calls[5].body.body).toContain('auto-generated via computer-use crystallization');
    expect(calls[5].body.body).toContain('registry/example-title.js');
    expect(calls[5].body.body).toContain(JSON.stringify({ ...entry, scriptPath: 'example-title.js' }, null, 2));
    expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('/merge'))).toBe(false);
  });
});
