import { describe, expect, it } from 'vitest';
import { validateOutput } from './schema.js';

describe('validateOutput', () => {
  const schema = {
    type: 'object',
    required: ['title'],
    properties: {
      title: { type: 'string' },
    },
  };

  it('skips validation when the schema is absent', () => {
    expect(validateOutput({ anything: true }, undefined)).toEqual({ valid: true });
  });

  it('accepts a value matching the schema', () => {
    expect(validateOutput({ title: 'Example' }, schema)).toEqual({ valid: true });
  });

  it('validates independently with reloaded schema objects', () => {
    const reloadedSchema = JSON.parse(JSON.stringify(schema));

    expect(validateOutput({ title: 'Example' }, reloadedSchema)).toEqual({ valid: true });
  });

  it('reports human-readable errors for a value that violates the schema', () => {
    const result = validateOutput({ title: 42 }, schema);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.any(String)]));
  });

  it('returns an invalid result instead of throwing for a malformed schema', () => {
    expect(() => validateOutput({ title: 'Example' }, { type: 'not-a-json-schema-type' })).not.toThrow();

    const result = validateOutput({ title: 'Example' }, { type: 'not-a-json-schema-type' });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('invalid outputSchema')]));
  });
});
