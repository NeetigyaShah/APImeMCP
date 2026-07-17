import { describe, expect, it } from 'vitest';
import { CelSyntaxError, evaluateCel } from './cel-eval.js';

const context = {
  vars: { count: 5, tags: ['gold', 'silver'], a: 0, b: 2 },
  page: { url: 'https://example.test/products', status: 200, title: 'Sold Out' },
  lastResult: { ok: true },
};

describe('evaluateCel', () => {
  it('compares equality and unknown paths', () => {
    expect(evaluateCel('vars.count == 5', context)).toBe(true);
    expect(evaluateCel('vars.count == 3', context)).toBe(false);
    expect(evaluateCel('vars.missing == 1', context)).toBe(false);
  });

  it('evaluates numeric, string, and nested-path comparisons', () => {
    expect(evaluateCel('vars.count > 0 && vars.count < 10', context)).toBe(true);
    expect(evaluateCel("page.title == 'Sold Out'", context)).toBe(true);
    expect(evaluateCel('page.status == 200', context)).toBe(true);
  });

  it('supports logical operators, membership, and presence checks', () => {
    expect(evaluateCel('!(vars.a == 1) || vars.b == 3', context)).toBe(true);
    expect(evaluateCel('"gold" in vars.tags', context)).toBe(true);
    expect(evaluateCel('has(lastResult.ok)', context)).toBe(true);
    expect(evaluateCel('has(vars.missing)', context)).toBe(false);
  });

  it('handles boolean and null literals', () => {
    expect(evaluateCel('true && !false', context)).toBe(true);
    expect(evaluateCel('vars.missing == null', context)).toBe(true);
  });

  it('rejects malformed expressions', () => {
    expect(() => evaluateCel('vars.. ==', context)).toThrow(CelSyntaxError);
  });
});
