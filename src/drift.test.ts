import { describe, expect, it } from 'vitest';
import { checkDrift, diffAgainstSchema, diffJson } from './drift.js';

describe('diffJson', () => {
  it('returns no entries for equal values', () => expect(diffJson({ x: 1 }, { x: 1 })).toEqual([]));
  it('reports added, removed, and changed fields', () => {
    expect(diffJson({ x: 1 }, { x: 1, y: 2 })).toEqual([{ path: 'y', kind: 'field_added', actual: 'number' }]);
    expect(diffJson({ x: 1, y: 2 }, { x: 1 })).toEqual([{ path: 'y', kind: 'field_removed', expected: 'number' }]);
    expect(diffJson({ x: 'a' }, { x: 1 })).toEqual([{ path: 'x', kind: 'type_changed', expected: 'string', actual: 'number' }]);
  });
  it('walks arrays by index', () => {
    expect(diffJson({ items: [{ sku: 'a' }] }, { items: [{ sku: 1 }] })).toEqual([
      { path: 'items[0].sku', kind: 'type_changed', expected: 'string', actual: 'number' },
    ]);
  });
});

describe('diffAgainstSchema', () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' }, count: { type: 'integer' } },
    required: ['name'],
  };

  it('returns no entries for a matching sample', () => expect(diffAgainstSchema(schema, { name: 'x', count: 1 })).toEqual([]));
  it('reports extra, missing, and mismatched fields', () => {
    expect(diffAgainstSchema(schema, { name: 'x', extra: true })).toEqual([
      { path: 'extra', kind: 'field_added', actual: 'boolean' },
    ]);
    expect(diffAgainstSchema(schema, { count: 1 })).toEqual([{ path: 'name', kind: 'field_removed', expected: 'present' }]);
    expect(diffAgainstSchema(schema, { name: 1 })).toEqual([{ path: 'name', kind: 'type_changed', expected: 'string', actual: 'number' }]);
  });
});

it('stamps a drift report', () => {
  const report = checkDrift('template-1', { type: 'string' }, 1);
  expect(report).toMatchObject({ templateId: 'template-1', hasDrift: true, entries: [{ kind: 'type_changed' }] });
  expect(Number.isNaN(Date.parse(report.timestamp))).toBe(false);
});
