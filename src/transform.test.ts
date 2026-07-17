import { describe, expect, it } from 'vitest';
import { TransformError, TransformSpecSchema, applyTransform } from './transform.js';

describe('applyTransform', () => {
  it('applies the worked object pipeline', () => {
    const data = { prod_name: 'Widget', raw_price: '19.99', sku_internal_code: 'X1', _debug: 'x' };
    const spec = {
      version: 1 as const,
      ops: [
        { op: 'rename' as const, from: 'raw_price', to: 'price' },
        { op: 'coerce' as const, field: 'price', to: 'number' as const },
        { op: 'pick' as const, fields: ['prod_name', 'price'] },
        { op: 'rename' as const, from: 'prod_name', to: 'name' },
      ],
    };

    expect(applyTransform(data, spec)).toEqual({ name: 'Widget', price: 19.99 });
    expect(data).toEqual({ prod_name: 'Widget', raw_price: '19.99', sku_internal_code: 'X1', _debug: 'x' });
  });

  it('applies map operations to every array element without mutation', () => {
    const data = [{ prod_name: 'A', raw_price: '1' }, { prod_name: 'B', raw_price: '2' }];
    const spec = {
      version: 1 as const,
      ops: [{
        op: 'map' as const,
        ops: [
          { op: 'rename' as const, from: 'raw_price', to: 'price' },
          { op: 'coerce' as const, field: 'price', to: 'number' as const },
        ],
      }],
    };

    const result = applyTransform(data, spec);

    expect(result).toEqual([{ prod_name: 'A', price: 1 }, { prod_name: 'B', price: 2 }]);
    expect(result).not.toBe(data);
    expect(data).toEqual([{ prod_name: 'A', raw_price: '1' }, { prod_name: 'B', raw_price: '2' }]);
  });

  it('supports each coercion target', () => {
    expect(applyTransform({ value: 42 }, { version: 1, ops: [{ op: 'coerce', field: 'value', to: 'string' }] })).toEqual({ value: '42' });
    expect(applyTransform({ value: '42' }, { version: 1, ops: [{ op: 'coerce', field: 'value', to: 'number' }] })).toEqual({ value: 42 });
    expect(applyTransform({ value: 'true' }, { version: 1, ops: [{ op: 'coerce', field: 'value', to: 'boolean' }] })).toEqual({ value: true });
    expect(applyTransform({ value: '2026-07-17' }, { version: 1, ops: [{ op: 'coerce', field: 'value', to: 'date' }] })).toEqual({ value: '2026-07-17T00:00:00.000Z' });
  });

  it('returns identity for an empty operation list', () => {
    const data = { name: 'Widget' };
    expect(applyTransform(data, { version: 1, ops: [] })).toEqual(data);
  });

  it('rejects invalid operation input and coercions', () => {
    expect(() => applyTransform(['value'], { version: 1, ops: [{ op: 'pick', fields: ['value'] }] })).toThrow(TransformError);
    expect(() => applyTransform({ value: 'abc' }, { version: 1, ops: [{ op: 'coerce', field: 'value', to: 'number' }] })).toThrow('cannot coerce field "value" to number');
    expect(() => applyTransform({ value: 'not-an-array' }, { version: 1, ops: [{ op: 'map', ops: [] }] })).toThrow(TransformError);
  });
});

describe('TransformSpecSchema', () => {
  it('rejects malformed specs', () => {
    expect(() => TransformSpecSchema.parse({ version: 2, ops: [] })).toThrow();
    expect(() => TransformSpecSchema.parse({ version: 1, ops: [{ op: 'unknown' }] })).toThrow();
    expect(() => TransformSpecSchema.parse({ version: 1, ops: [{ op: 'pick', fields: [] }] })).toThrow();
    expect(() => TransformSpecSchema.parse({ version: 1, ops: [{ op: 'map', ops: [{ op: 'map', ops: [] }] }] })).toThrow();
  });
});
