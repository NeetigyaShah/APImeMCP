import { describe, it, expect } from 'vitest';
import { RegisterExtractionTemplateInputSchema, ExecuteNativeExtractionInputSchema } from './types.js';

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
});
