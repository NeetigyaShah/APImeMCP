import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildReceipt, canonicalize, exportPublicKey, getOrCreateSigningKeypair, hashContent, registerGetPublicKeyTool, registerVerifyReceiptTool, verifyReceipt } from './provenance.js';

type Registration = { name: string; handler: (input: any) => Promise<any> };

async function withKeyPath<T>(callback: (keyPath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'apimemcp-provenance-'));
  try {
    return await callback(path.join(directory, 'provenance-key.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('provenance receipts', () => {
  it('canonicalizes object keys while preserving array order', () => {
    expect(canonicalize({ b: [{ z: 1, a: 2 }], a: true })).toBe(canonicalize({ a: true, b: [{ a: 2, z: 1 }] }));
    expect(canonicalize(['first', 'second'])).not.toBe(canonicalize(['second', 'first']));
  });

  it('hashes content deterministically and detects changes', () => {
    expect(hashContent({ a: 1, b: 2 })).toBe(hashContent({ b: 2, a: 1 }));
    expect(hashContent({ a: 1 })).not.toBe(hashContent({ a: 2 }));
  });

  it('persists one signing keypair', async () => {
    await withKeyPath(async (keyPath) => {
      const first = await getOrCreateSigningKeypair(keyPath);
      const second = await getOrCreateSigningKeypair(keyPath);
      expect(first.keyId).toBe(second.keyId);
    });
  });

  it('signs valid, invalid, and absent output schemas correctly', async () => {
    await withKeyPath(async (keyPath) => {
      const valid = await buildReceipt({ templateId: 'fixture', templateSource: '() => ({ title: "ok" })', targetUrl: 'https://example.com', data: { title: 'ok' }, outputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } }, keyPath });
      const invalid = await buildReceipt({ templateId: 'fixture', templateSource: '() => ({ title: 1 })', targetUrl: 'https://example.com', data: { title: 1 }, outputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } }, keyPath });
      const absent = await buildReceipt({ templateId: 'fixture', templateSource: '() => ({ title: "ok" })', targetUrl: 'https://example.com', data: { title: 'ok' }, keyPath });
      const { publicKey } = await exportPublicKey(keyPath);

      expect(valid.schemaValid).toBe(true);
      expect(invalid).toMatchObject({ schemaValid: false, schemaErrors: expect.any(Array) });
      expect(absent.schemaValid).toBeNull();
      expect(verifyReceipt(valid, publicKey)).toEqual({ valid: true });
      expect(verifyReceipt({ ...valid, contentHash: `0${valid.contentHash.slice(1)}` }, publicKey)).toMatchObject({ valid: false, reasons: expect.any(Array) });
      expect(verifyReceipt({ ...valid, schemaValid: false }, publicKey)).toMatchObject({ valid: false, reasons: expect.any(Array) });
      expect(verifyReceipt({ ...valid, templateId: 'changed' }, publicKey)).toMatchObject({ valid: false, reasons: expect.any(Array) });
      expect(verifyReceipt({ ...valid, signature: `A${valid.signature.slice(1)}` }, publicKey)).toMatchObject({ valid: false, reasons: expect.any(Array) });
    });
  });

  it('registers safe public-key and verification handlers', async () => {
    const registrations: Registration[] = [];
    const server = { tool: (name: string, _shape: unknown, handler: Registration['handler']) => registrations.push({ name, handler }) } as unknown as McpServer;
    const receipt = await withKeyPath((keyPath) => buildReceipt({ templateId: 'fixture', templateSource: 'source', targetUrl: 'https://example.com', data: { value: 1 }, keyPath }));
    registerGetPublicKeyTool(server, { exportPublicKey: async () => ({ keyId: receipt.keyId, publicKey: 'public-key', algo: 'ed25519' }) });
    registerVerifyReceiptTool(server, { exportPublicKey: async () => ({ keyId: receipt.keyId, publicKey: 'public-key', algo: 'ed25519' }), verifyReceipt: (candidate) => ({ valid: candidate.signature === receipt.signature && candidate.contentHash === receipt.contentHash }) });

    const keyResponse = JSON.parse((await registrations[0].handler({})).content[0].text);
    const verification = JSON.parse((await registrations[1].handler({ receipt: { ...receipt, contentHash: 'tampered' } })).content[0].text);
    expect(keyResponse).toEqual({ keyId: receipt.keyId, publicKey: 'public-key', algo: 'ed25519' });
    expect(keyResponse).not.toHaveProperty('privateKey');
    expect(verification).toEqual({ valid: false });
  });
});
