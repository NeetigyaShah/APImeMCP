import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureAppConnectionsInitialized,
  getAppConnection,
  getAppProfilePath,
  listAppConnections,
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
    expect((await getAppConnection('amazon'))?.autoStart).toBe(true);
    expect((await listAppConnections()).map((item) => item.connectionId)).toEqual(['amazon']);
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
});
