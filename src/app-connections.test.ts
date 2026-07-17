import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureAppConnectionsInitialized,
  getAppConnection,
  getAppProfilePath,
  listAppConnections,
  resolveProfileDir,
  updateConnectionStatus,
  upsertAppConnection,
} from './app-connections.js';

let originalCwd: string;
let tmpDir: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apimemcp-app-connections-'));
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('app connections', () => {
  it('initializes, persists, and resolves a connection profile', async () => {
    await ensureAppConnectionsInitialized();
    const connection = await upsertAppConnection({
      connectionId: 'amazon',
      domainPattern: 'amazon.com',
      loginUrl: 'https://www.amazon.com/ap/signin',
      autoStart: true,
    });

    expect(connection.profileDir).toBe(path.join('templates', 'app-profiles', 'amazon'));
    expect(getAppProfilePath(connection)).toBe(path.join(tmpDir, 'templates', 'app-profiles', 'amazon'));
    expect(connection.status).toBe('pending');
    expect((await getAppConnection('amazon'))?.autoStart).toBe(true);
    expect((await listAppConnections()).map((item) => item.connectionId)).toEqual(['amazon']);
    expect(await resolveProfileDir('amazon')).toBe(path.join(tmpDir, 'templates', 'app-profiles', 'amazon'));
  });

  it('marks a connection connected and records its last use', async () => {
    await upsertAppConnection({
      connectionId: 'amazon',
      domainPattern: 'amazon.com',
      loginUrl: 'https://www.amazon.com/ap/signin',
    });

    const connection = await updateConnectionStatus('amazon', 'connected');

    expect(connection.status).toBe('connected');
    expect(connection.lastUsedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects a login URL outside the declared domain', async () => {
    await expect(
      upsertAppConnection({
        connectionId: 'amazon',
        domainPattern: 'amazon.com',
        loginUrl: 'https://example.com/login',
      })
    ).rejects.toThrow('does not match domainPattern');
  });

  it('rejects credentials embedded in a login URL', async () => {
    await expect(
      upsertAppConnection({
        connectionId: 'amazon',
        domainPattern: 'amazon.com',
        loginUrl: 'https://user:password@amazon.com/login',
      })
    ).rejects.toThrow('loginUrl must contain a valid hostname');
  });
});
