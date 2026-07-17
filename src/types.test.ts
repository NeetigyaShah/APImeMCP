import { describe, it, expect } from 'vitest';
import {
  AppConnectionSchema,
  ConnectAppInputSchema,
  ExecuteNativeExtractionInputSchema,
  RegisterExtractionTemplateInputSchema,
} from './types.js';

describe('RegisterExtractionTemplateInputSchema', () => {
  it('accepts a valid kebab-case templateId and lowercases domainPattern', () => {
    const result = RegisterExtractionTemplateInputSchema.safeParse({
      templateId: 'amazon-product',
      domainPattern: 'Amazon.com',
      executableScript: '(() => document.title)()',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.domainPattern).toBe('amazon.com');
    }
  });

  it('rejects a templateId with uppercase or underscores', () => {
    const result = RegisterExtractionTemplateInputSchema.safeParse({
      templateId: 'Amazon_Product',
      domainPattern: 'amazon.com',
      executableScript: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an executableScript over the 100KB limit', () => {
    const result = RegisterExtractionTemplateInputSchema.safeParse({
      templateId: 'big',
      domainPattern: 'big.com',
      executableScript: 'a'.repeat(100_001),
    });
    expect(result.success).toBe(false);
  });

  it('accepts an optional JSON Schema output contract', () => {
    const result = RegisterExtractionTemplateInputSchema.safeParse({
      templateId: 'product-title',
      domainPattern: 'example.com',
      executableScript: '(() => ({ title: document.title }))()',
      outputSchema: {
        type: 'object',
        required: ['title'],
        properties: { title: { type: 'string' } },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.outputSchema).toEqual({
        type: 'object',
        required: ['title'],
        properties: { title: { type: 'string' } },
      });
    }
  });

  it('accepts kind being omitted (defaults to extraction at runtime)', () => {
    const result = RegisterExtractionTemplateInputSchema.safeParse({
      templateId: 'test',
      domainPattern: 'example.com',
      executableScript: 'x',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBeUndefined();
    }
  });

  it('accepts kind "static-http" with requestHeaders', () => {
    const result = RegisterExtractionTemplateInputSchema.safeParse({
      templateId: 'static-test',
      domainPattern: 'example.com',
      executableScript: '($) => ({ title: $("title").text() })',
      kind: 'static-http',
      requestHeaders: { 'User-Agent': 'Custom-Agent' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('static-http');
      expect(result.data.requestHeaders).toEqual({ 'User-Agent': 'Custom-Agent' });
    }
  });

  it('rejects static-http with readySelector', () => {
    const result = RegisterExtractionTemplateInputSchema.safeParse({
      templateId: 'bad-static',
      domainPattern: 'example.com',
      executableScript: 'x',
      kind: 'static-http',
      readySelector: '.data',
    });
    expect(result.success).toBe(false);
  });

  it('rejects static-http with waitStrategy', () => {
    const result = RegisterExtractionTemplateInputSchema.safeParse({
      templateId: 'bad-static',
      domainPattern: 'example.com',
      executableScript: 'x',
      kind: 'static-http',
      waitStrategy: 'networkidle',
    });
    expect(result.success).toBe(false);
  });
});

describe('ExecuteNativeExtractionInputSchema', () => {
  it('accepts an absolute https URL', () => {
    const result = ExecuteNativeExtractionInputSchema.safeParse({ targetUrl: 'https://example.com/page' });
    expect(result.success).toBe(true);
  });

  it('rejects a file:// URL', () => {
    const result = ExecuteNativeExtractionInputSchema.safeParse({ targetUrl: 'file:///etc/passwd' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-absolute string', () => {
    const result = ExecuteNativeExtractionInputSchema.safeParse({ targetUrl: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  it('accepts an optional proxyUrl', () => {
    const result = ExecuteNativeExtractionInputSchema.safeParse({
      targetUrl: 'https://example.com',
      proxyUrl: 'http://user:pass@proxy.example.com:8080',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a persistent app connection ID', () => {
    const result = ExecuteNativeExtractionInputSchema.safeParse({
      targetUrl: 'https://www.amazon.com/dp/123',
      templateId: 'amazon-product',
      connectionId: 'amazon',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an inline script and draft output schema for dry-runs', () => {
    const result = ExecuteNativeExtractionInputSchema.safeParse({
      targetUrl: 'https://example.com',
      executableScript: '() => ({ title: document.title })',
      outputSchema: { type: 'object' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an explicitly empty inline script instead of resolving a template', () => {
    const result = ExecuteNativeExtractionInputSchema.safeParse({
      targetUrl: 'https://example.com',
      executableScript: '',
    });

    expect(result.success).toBe(false);
  });
});

describe('ConnectAppInputSchema', () => {
  it('accepts a login URL under the declared domain', () => {
    const result = ConnectAppInputSchema.safeParse({
      connectionId: 'amazon',
      domainPattern: 'amazon.com',
      loginUrl: 'https://www.amazon.com/ap/signin',
      autoStart: true,
    });
    expect(result.success).toBe(true);
  });
});

describe('AppConnectionSchema', () => {
  const connection = {
    connectionId: 'amazon',
    domainPattern: 'amazon.com',
    loginUrl: 'https://www.amazon.com/ap/signin',
    profileDir: 'templates/app-profiles/amazon',
    autoStart: false,
    status: 'pending',
    createdAt: '2026-07-17T00:00:00.000Z',
  };

  it('accepts the frozen browser-profile shape', () => {
    expect(AppConnectionSchema.safeParse(connection).success).toBe(true);
  });

  it('rejects secret-shaped stray fields', () => {
    expect(AppConnectionSchema.safeParse({ ...connection, password: 'not-stored-here' }).success).toBe(false);
  });
});
