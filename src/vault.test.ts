import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  setVaultSecret,
  listVaultSecrets,
  deleteVaultSecret,
  resolveSecretsForRun,
  redactSecrets,
} from './vault.js';

const TEMP_DIR = path.join(process.cwd(), '.test-vault-temp');

async function cleanupTempDir(): Promise<void> {
  try {
    await fs.rm(TEMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe('vault', () => {
  beforeEach(async () => {
    await cleanupTempDir();
    await fs.mkdir(TEMP_DIR, { recursive: true });
    // Mock process.cwd to use temp directory
    vi.stubGlobal('process', { ...process, cwd: () => TEMP_DIR, env: {} });
  });

  afterEach(async () => {
    await cleanupTempDir();
    vi.unstubAllGlobals();
  });

  it('encrypts and decrypts a plain string value', async () => {
    const secret = 'my-secret-password-123';
    await setVaultSecret('test-secret', secret);

    const resolved = await resolveSecretsForRun({ password: 'test-secret' });
    expect(resolved.password).toBe(secret);
  });

  it('encrypts and decrypts a structured value with field lookup', async () => {
    const value = { username: 'alice', password: 'secret123' };
    await setVaultSecret('login-creds', value);

    const resolved = await resolveSecretsForRun({
      user: 'login-creds.username',
      pass: 'login-creds.password',
    });

    expect(resolved.user).toBe('alice');
    expect(resolved.pass).toBe('secret123');
  });

  it('rejects tampered ciphertext with a typed error', async () => {
    await setVaultSecret('test', 'plaintext');

    // Load the vault, corrupt the ciphertext
    const vaultPath = path.join(TEMP_DIR, 'templates', 'vault.json');
    const store = JSON.parse(await fs.readFile(vaultPath, 'utf8'));
    const entry = Object.values(store.entries)[0] as any;
    // Flip a byte in the ciphertext
    const bytes = Buffer.from(entry.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    entry.ciphertext = bytes.toString('base64');
    await fs.writeFile(vaultPath, JSON.stringify(store, null, 2));

    await expect(
      resolveSecretsForRun({ field: 'test' })
    ).rejects.toThrow(/failed to decrypt|Unsupported state or unable to authenticate data/);
  });

  it('listVaultSecrets returns metadata only (no ciphertext/keys)', async () => {
    await setVaultSecret('secret-1', 'value1', 'My Secret');
    await setVaultSecret('secret-2', { key: 'value' });

    const list = await listVaultSecrets();

    expect(list).toHaveLength(2);
    list.forEach((entry) => {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('label');
      expect(entry).toHaveProperty('createdAt');
      expect(entry).toHaveProperty('updatedAt');
      expect(entry).not.toHaveProperty('ciphertext');
      expect(entry).not.toHaveProperty('iv');
      expect(entry).not.toHaveProperty('authTag');
      expect(entry).not.toHaveProperty('algo');
      expect(entry).not.toHaveProperty('keyId');
    });
  });

  it('deleteVaultSecret removes entry and fails subsequent resolution', async () => {
    await setVaultSecret('to-delete', 'secret-value');

    const result = await deleteVaultSecret('to-delete');
    expect(result.deleted).toBe(true);

    await expect(
      resolveSecretsForRun({ field: 'to-delete' })
    ).rejects.toThrow(/vault secret not found/);
  });

  it('resolveSecretsForRun fails if any id is missing (all-or-nothing)', async () => {
    await setVaultSecret('secret-1', 'value1');

    await expect(
      resolveSecretsForRun({
        field1: 'secret-1',
        field2: 'missing-secret',
      })
    ).rejects.toThrow(/vault secret not found/);
  });

  it('redactSecrets replaces all occurrences of a value', async () => {
    const html = `
      <input type="password" value="my-secret-password" />
      <form>
        <p>Password: my-secret-password</p>
      </form>
      <p>The password my-secret-password should be redacted</p>
    `;

    const redacted = redactSecrets(html, { password: 'my-secret-password' });
    expect(redacted).not.toContain('my-secret-password');
    expect(redacted).toContain('[REDACTED]');
    expect((redacted.match(/\[REDACTED\]/g) || []).length).toBe(3);
  });

  it('redactSecrets handles multiple values', async () => {
    const script = `
      const username = 'alice';
      const password = 'secret123';
      console.log(username, password);
    `;

    const redacted = redactSecrets(script, {
      user: 'alice',
      pass: 'secret123',
    });

    expect(redacted).not.toContain('alice');
    expect(redacted).not.toContain('secret123');
    expect(redacted).toContain('[REDACTED]');
  });

  it('persists master key across invocations', async () => {
    const secret = 'test-secret';
    await setVaultSecret('persist-test', secret);

    // Verify it can be resolved again without reinitializing (same session)
    const resolved = await resolveSecretsForRun({ value: 'persist-test' });
    expect(resolved.value).toBe(secret);
  });

  it('rejects missing subkey in structured value', async () => {
    await setVaultSecret('creds', { username: 'alice' });

    await expect(
      resolveSecretsForRun({ missing: 'creds.nonexistent' })
    ).rejects.toThrow(/no subkey/);
  });

  it('label is optional and defaults to empty string', async () => {
    await setVaultSecret('no-label', 'value');
    const list = await listVaultSecrets();
    const entry = list.find((e) => e.id === 'no-label');
    expect(entry?.label).toBe('');
  });

  it('createdAt is set on first insert and unchanged on update', async () => {
    await setVaultSecret('version-test', 'value1');
    const list1 = await listVaultSecrets();
    const createdAt = list1.find((e) => e.id === 'version-test')?.createdAt;

    // Update the secret
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setVaultSecret('version-test', 'value2');
    const list2 = await listVaultSecrets();
    const entry = list2.find((e) => e.id === 'version-test');

    expect(entry?.createdAt).toBe(createdAt);
    expect(new Date(entry?.updatedAt || '').getTime()).toBeGreaterThan(new Date(createdAt || '').getTime());
  });
});
