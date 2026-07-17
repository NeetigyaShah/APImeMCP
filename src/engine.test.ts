import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createSuccessfulExtractionResult, executeStaticHttpExtraction } from './engine.js';
import type { ManifestEntry } from './types.js';

const meta = {
  url: 'https://example.com/products',
  templateId: 'products',
  domainMatched: 'example.com',
  durationMs: 10,
  timestamp: '2026-07-17T00:00:00.000Z',
};

describe('createSuccessfulExtractionResult', () => {
  it('omits validation when no output schema is declared', () => {
    const result = createSuccessfulExtractionResult({ title: 'Example' }, meta);

    expect(result).toEqual({ success: true, data: { title: 'Example' }, meta });
  });

  it('validates declared output schemas in the engine boundary', () => {
    const result = createSuccessfulExtractionResult(
      { title: 42 },
      meta,
      { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
    );

    expect(result.schemaValidation).toEqual({ valid: false, errors: expect.any(Array) });
    expect(result.schemaValidation?.errors).not.toHaveLength(0);
  });
});

// executeStaticHttpExtraction integration tests are in scripts/verify-F15.mjs
// Unit tests for executeStaticHttpExtraction require fs mocking which is tested in verify-F15
