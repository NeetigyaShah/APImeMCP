import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from './types.js';

const storage = vi.hoisted(() => ({
  registerTemplate: vi.fn(),
  registerActionSequenceTemplate: vi.fn(),
}));

vi.mock('./storage.js', () => storage);

import { addFromRegistry, listVerifiable, openTemplatePr } from './registry-client.js';

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
