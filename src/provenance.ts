import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withLock } from './lock.js';
import { validateOutput } from './schema.js';
import { atomicWriteFile } from './storage.js';

export const ProvenanceReceiptShape = {
  receiptVersion: z.literal(1),
  templateId: z.string(),
  templateVersion: z.string().optional(),
  templateSourceHash: z.string(),
  targetUrl: z.string(),
  ranAt: z.string().datetime(),
  contentHash: z.string(),
  hashAlgo: z.literal('sha256'),
  schemaValid: z.boolean().nullable(),
  schemaErrors: z.array(z.string()).optional(),
  keyId: z.string(),
  signAlgo: z.literal('ed25519'),
  signature: z.string(),
};

export const ProvenanceReceipt = z.object(ProvenanceReceiptShape);
export type ProvenanceReceipt = z.infer<typeof ProvenanceReceipt>;

interface StoredKeypair { privateKey: string; publicKey: string; }

function defaultKeyPath(): string {
  return path.resolve(process.cwd(), 'templates', 'provenance-key.json');
}

function canonicalizeValue(value: unknown, seen: Set<object>): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value === 'bigint') throw new TypeError('Cannot canonicalize bigint values');
  const jsonValue = typeof (value as { toJSON?: unknown }).toJSON === 'function'
    ? (value as { toJSON: () => unknown }).toJSON()
    : value;
  if (jsonValue !== value) return canonicalizeValue(jsonValue, seen);
  if (seen.has(value as object)) throw new TypeError('Cannot canonicalize circular structures');
  seen.add(value as object);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalizeValue(item, seen) ?? 'null').join(',')}]`;
    const entries = Object.keys(value as Record<string, unknown>).sort().flatMap((key) => {
      const serialized = canonicalizeValue((value as Record<string, unknown>)[key], seen);
      return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`];
    });
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value as object);
  }
}

export function canonicalize(value: unknown): string {
  const serialized = canonicalizeValue(value, new Set());
  if (serialized === undefined) throw new TypeError('Cannot canonicalize a non-JSON value');
  return serialized;
}

export function hashContent(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function getKeyId(publicKey: KeyObject): string {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

function toKeypair(stored: StoredKeypair): { privateKey: KeyObject; publicKey: KeyObject; keyId: string } {
  const privateKey = createPrivateKey(stored.privateKey);
  const publicKey = createPublicKey(stored.publicKey);
  return { privateKey, publicKey, keyId: getKeyId(publicKey) };
}

export async function getOrCreateSigningKeypair(keyPath = defaultKeyPath()): Promise<{ privateKey: KeyObject; publicKey: KeyObject; keyId: string }> {
  return withLock(`provenance-key:${keyPath}`, async () => {
    try {
      return toKeypair(JSON.parse(await fs.readFile(keyPath, 'utf8')) as StoredKeypair);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    await atomicWriteFile(keyPath, JSON.stringify({
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    } satisfies StoredKeypair));
    await fs.chmod(keyPath, 0o600).catch(() => undefined);
    return { privateKey, publicKey, keyId: getKeyId(publicKey) };
  });
}

export async function exportPublicKey(keyPath = defaultKeyPath()): Promise<{ keyId: string; publicKey: string; algo: 'ed25519' }> {
  const { publicKey, keyId } = await getOrCreateSigningKeypair(keyPath);
  return { keyId, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), algo: 'ed25519' };
}

export async function buildReceipt(input: {
  templateId: string; templateVersion?: string; templateSource: string; targetUrl: string; data: unknown; outputSchema?: Record<string, unknown>; keyPath?: string;
}): Promise<ProvenanceReceipt> {
  const validation = input.outputSchema ? validateOutput(input.data, input.outputSchema) : undefined;
  const { privateKey, keyId } = await getOrCreateSigningKeypair(input.keyPath);
  const unsigned = {
    receiptVersion: 1 as const, templateId: input.templateId,
    ...(input.templateVersion ? { templateVersion: input.templateVersion } : {}),
    templateSourceHash: hashContent(input.templateSource), targetUrl: input.targetUrl, ranAt: new Date().toISOString(),
    contentHash: hashContent(input.data), hashAlgo: 'sha256' as const, schemaValid: validation ? validation.valid : null,
    ...(validation?.errors?.length ? { schemaErrors: validation.errors } : {}), keyId, signAlgo: 'ed25519' as const,
  };
  return ProvenanceReceipt.parse({ ...unsigned, signature: sign(null, Buffer.from(canonicalize(unsigned)), privateKey).toString('base64') });
}

export function verifyReceipt(receipt: ProvenanceReceipt, publicKeyPem: string): { valid: boolean; reasons?: string[] } {
  const parsed = ProvenanceReceipt.safeParse(receipt);
  if (!parsed.success) return { valid: false, reasons: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'receipt'} ${issue.message}`) };
  try {
    const publicKey = createPublicKey(publicKeyPem);
    const { signature, ...unsigned } = parsed.data;
    const reasons: string[] = [];
    if (getKeyId(publicKey) !== unsigned.keyId) reasons.push('keyId does not match the supplied public key');
    if (!verify(null, Buffer.from(canonicalize(unsigned)), publicKey, Buffer.from(signature, 'base64'))) reasons.push('signature does not match receipt contents');
    return reasons.length ? { valid: false, reasons } : { valid: true };
  } catch (error) {
    return { valid: false, reasons: [`unable to verify receipt: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export interface GetPublicKeyToolDeps { exportPublicKey: typeof exportPublicKey; }
export function registerGetPublicKeyTool(server: McpServer, deps: GetPublicKeyToolDeps): void {
  server.tool('get_provenance_public_key', {}, async () => ({ content: [{ type: 'text' as const, text: JSON.stringify(await deps.exportPublicKey(), null, 2) }] }));
}

export interface VerifyReceiptToolDeps { exportPublicKey: typeof exportPublicKey; verifyReceipt: typeof verifyReceipt; }
export function registerVerifyReceiptTool(server: McpServer, deps: VerifyReceiptToolDeps): void {
  server.tool('verify_provenance_receipt', { receipt: ProvenanceReceipt }, async ({ receipt }) => {
    const { publicKey } = await deps.exportPublicKey();
    const result = deps.verifyReceipt(receipt, publicKey);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });
}
