import { describe, expect, it, vi } from 'vitest';
import { createSuccessfulExtractionResult, crystallizeRecording } from './engine.js';

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

describe('crystallizeRecording', () => {
  it('emits deterministic DOM actions in trace order', () => {
    const script = crystallizeRecording({
      targetUrl: 'https://example.com/catalog',
      steps: [
        { kind: 'goto', url: 'https://example.com/catalog' },
        { kind: 'fill', selector: '#part', value: 'ABC-123', label: 'Part number' },
        { kind: 'click', selector: '#search', label: 'Search' },
        { kind: 'waitFor', selector: '[data-price]' },
        { kind: 'extract', selector: '[data-price]', field: 'price' },
        { kind: 'extract', selector: 'a.details', field: 'detailsUrl', attr: 'href' },
      ],
    });

    expect(script.indexOf('assertCurrentUrl("https://example.com/catalog")')).toBeLessThan(script.indexOf('fillSelector("#part"'));
    expect(script.indexOf('fillSelector("#part"')).toBeLessThan(script.indexOf('clickSelector("#search"'));
    expect(script.indexOf('clickSelector("#search"')).toBeLessThan(script.indexOf('waitForSelector("[data-price]"'));
    expect(script.indexOf('result["price"]')).toBeLessThan(script.indexOf('result["detailsUrl"]'));
    expect(script).toContain('return result;');
  });

  it('lets later duplicate extract fields win and logs a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const script = crystallizeRecording({
      targetUrl: 'https://example.com',
      steps: [
        { kind: 'extract', selector: '.old-price', field: 'price' },
        { kind: 'extract', selector: '.new-price', field: 'price' },
      ],
    });

    expect(script.indexOf('".old-price"')).toBeLessThan(script.indexOf('".new-price"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Duplicate extract field "price"'));
    warn.mockRestore();
  });

  it('rejects secret-like fill values before generating a reusable template', () => {
    expect(() => crystallizeRecording({
      targetUrl: 'https://example.com/login',
      steps: [{ kind: 'fill', selector: 'input[type=password]', value: 'super-secret', label: 'Password' }],
    })).toThrow(/secret-like field/i);
  });

  it('rejects secret-looking fill values even when selector hints are generic', () => {
    const fakeSecret = ['sk', 'live', '1234567890abcdef1234567890abcdef'].join('_');

    expect(() => crystallizeRecording({
      targetUrl: 'https://example.com/search',
      steps: [{ kind: 'fill', selector: '#query', value: fakeSecret, label: 'Search' }],
    })).toThrow(/secret-like fill value/i);
  });
});
