import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  scryptSync,
} from 'node:crypto';
import { withLock } from './lock.js';
import { atomicWriteFile } from './storage.js';
import type { VaultEntry, VaultStore } from './types.js';

function getTemplatesDir(): string {
  return path.resolve(process.cwd(), 'templates');
}

function getVaultPath(): string {
  return path.join(getTemplatesDir(), 'vault.json');
}

function getKeyPath(): string {
  return path.join(getTemplatesDir(), '.vault-key');
}

// Master key: environment variable (base64, 32 bytes) or auto-generated once in .vault-key
async function getMasterKey(): Promise<Buffer> {
  // Try env var first
  const envKey = process.env.APIMEMCP_VAULT_KEY;
  if (envKey) {
    return Buffer.from(envKey, 'base64');
  }

  // Try reading from disk
  const keyPath = getKeyPath();
  try {
    const keyData = await fs.readFile(keyPath, 'utf8');
    return Buffer.from(keyData.trim(), 'base64');
  } catch {
    // Key doesn't exist - generate one and save it
    const newKey = randomBytes(32);
    const templatesDir = getTemplatesDir();
    await fs.mkdir(templatesDir, { recursive: true });
    await fs.writeFile(keyPath, newKey.toString('base64'), 'utf8');
    // Set restrictive permissions (0600)
    await fs.chmod(keyPath, 0o600);
    return newKey;
  }
}

// Derive key fingerprint for rotation support
function getKeyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

async function loadVaultStore(): Promise<VaultStore> {
  try {
    const data = await fs.readFile(getVaultPath(), 'utf8');
    return JSON.parse(data) as VaultStore;
  } catch {
    return { version: 1, entries: {} };
  }
}

async function saveVaultStore(store: VaultStore): Promise<void> {
  await atomicWriteFile(getVaultPath(), JSON.stringify(store, null, 2));
}

async function encrypt(plaintext: string | Record<string, string>, key: Buffer): Promise<{ iv: string; ciphertext: string; authTag: string }> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const jsonText = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);
  let encrypted = cipher.update(jsonText, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    ciphertext: encrypted,
    authTag: authTag.toString('base64'),
  };
}

async function decrypt(encrypted: { iv: string; ciphertext: string; authTag: string }, key: Buffer): Promise<string> {
  const iv = Buffer.from(encrypted.iv, 'base64');
  const authTag = Buffer.from(encrypted.authTag, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted.ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

export async function setVaultSecret(id: string, value: string | Record<string, string>, label?: string): Promise<{ id: string }> {
  return withLock(async () => {
    const key = await getMasterKey();
    const keyId = getKeyFingerprint(key);
    const store = await loadVaultStore();

    const { iv, ciphertext, authTag } = await encrypt(value, key);
    const now = new Date().toISOString();

    store.entries[id] = {
      id,
      label: label ?? '',
      createdAt: store.entries[id]?.createdAt ?? now,
      updatedAt: now,
      algo: 'aes-256-gcm',
      iv,
      authTag,
      ciphertext,
      keyId,
    };

    await saveVaultStore(store);
    return { id };
  });
}

export async function listVaultSecrets(): Promise<Array<Pick<VaultEntry, 'id' | 'label' | 'createdAt' | 'updatedAt'>>> {
  const store = await loadVaultStore();
  return Object.values(store.entries).map((entry) => ({
    id: entry.id,
    label: entry.label,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }));
}

export async function deleteVaultSecret(id: string): Promise<{ id: string; deleted: boolean }> {
  return withLock(async () => {
    const store = await loadVaultStore();
    const deleted = id in store.entries;
    if (deleted) {
      delete store.entries[id];
      await saveVaultStore(store);
    }
    return { id, deleted };
  });
}

export async function resolveSecretsForRun(secretInputs: Record<string, string>): Promise<Record<string, string>> {
  const key = await getMasterKey();
  const store = await loadVaultStore();
  const resolved: Record<string, string> = {};

  for (const [fieldName, ref] of Object.entries(secretInputs)) {
    const [vaultId, ...subkeyParts] = ref.split('.');
    const subkey = subkeyParts.join('.');

    const entry = store.entries[vaultId];
    if (!entry) {
      throw new Error(`vault secret not found: "${vaultId}" (referenced by field "${fieldName}")`);
    }

    let plaintext: string;
    try {
      plaintext = await decrypt(
        {
          iv: entry.iv,
          ciphertext: entry.ciphertext,
          authTag: entry.authTag,
        },
        key
      );
    } catch (err) {
      throw new Error(`failed to decrypt vault secret "${vaultId}": ${err instanceof Error ? err.message : String(err)}`);
    }

    let value: string;
    if (subkey) {
      const parsed = JSON.parse(plaintext) as Record<string, string>;
      if (!(subkey in parsed)) {
        throw new Error(`vault secret "${vaultId}" has no subkey "${subkey}" (referenced by field "${fieldName}")`);
      }
      value = parsed[subkey];
    } else {
      value = plaintext;
    }

    resolved[fieldName] = value;
  }

  return resolved;
}

export function redactSecrets(text: string, resolvedValues: Record<string, string>): string {
  let result = text;
  for (const value of Object.values(resolvedValues)) {
    // Escape special regex characters and replace all occurrences
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'g'), '[REDACTED]');
  }
  return result;
}

// MCP tool registrations (follow ADR-02)

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolDeps } from './tools/tool-deps.js';

const SetVaultSecretShape = {
  id: z.string().min(1),
  label: z.string().optional(),
  value: z.union([z.string(), z.record(z.string())]),
};

const DeleteVaultSecretShape = {
  id: z.string().min(1),
};

export function registerSetVaultSecretTool(server: McpServer, deps: ToolDeps): void {
  server.tool('set_vault_secret', SetVaultSecretShape, async (input) => {
    try {
      const value = typeof input.value === 'string' ? input.value : input.value;
      await setVaultSecret(input.id, value, input.label);
      deps.log(`Set vault secret "${input.id}"`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, id: input.id }, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logError(`set_vault_secret failed: ${message}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
        isError: true,
      };
    }
  });
}

export function registerListVaultSecretsTool(server: McpServer, deps: ToolDeps): void {
  server.tool('list_vault_secrets', {}, async () => {
    try {
      const secrets = await listVaultSecrets();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(secrets, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logError(`list_vault_secrets failed: ${message}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
        isError: true,
      };
    }
  });
}

export function registerDeleteVaultSecretTool(server: McpServer, deps: ToolDeps): void {
  server.tool('delete_vault_secret', DeleteVaultSecretShape, async (input) => {
    try {
      const result = await deleteVaultSecret(input.id);
      deps.log(`Deleted vault secret "${input.id}"`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, deleted: result.deleted }, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logError(`delete_vault_secret failed: ${message}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
        isError: true,
      };
    }
  });
}
