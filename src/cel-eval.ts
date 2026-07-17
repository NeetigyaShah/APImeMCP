import type { CelContext } from './types.js';

export class CelSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CelSyntaxError';
  }
}

type CelSyntaxErrorConstructor = new (message: string) => Error;

/** Evaluate the intentionally small CEL subset used by executable templates. */
export function evaluateCel(
  expression: string,
  ctx: CelContext,
  SyntaxErrorType: CelSyntaxErrorConstructor = CelSyntaxError,
): boolean {
  type Token = { type: 'identifier' | 'number' | 'string' | 'operator' | 'punctuation' | 'eof'; value: string };
  type Expression =
    | { kind: 'literal'; value: unknown }
    | { kind: 'path'; path: string[] }
    | { kind: 'unary'; operator: '!'; value: Expression }
    | { kind: 'binary'; operator: string; left: Expression; right: Expression }
    | { kind: 'has'; value: Expression };

  const syntaxError = (message: string): never => {
    throw new SyntaxErrorType(message);
  };
  const tokens: Token[] = [];
  let cursor = 0;

  while (cursor < expression.length) {
    const character = expression[cursor];
    if (/\s/.test(character)) {
      cursor += 1;
    } else if (/[A-Za-z_]/.test(character)) {
      const start = cursor++;
      while (/[A-Za-z0-9_]/.test(expression[cursor] ?? '')) cursor += 1;
      tokens.push({ type: 'identifier', value: expression.slice(start, cursor) });
    } else if (/[0-9]/.test(character)) {
      const start = cursor++;
      while (/[0-9.]/.test(expression[cursor] ?? '')) cursor += 1;
      const value = expression.slice(start, cursor);
      if (!Number.isFinite(Number(value))) syntaxError(`Invalid number at position ${start}`);
      tokens.push({ type: 'number', value });
    } else if (character === '"' || character === "'") {
      const quote = character;
      let value = '';
      cursor += 1;
      while (cursor < expression.length && expression[cursor] !== quote) {
        if (expression[cursor] === '\\') {
          cursor += 1;
          if (cursor >= expression.length) syntaxError('Unterminated string literal');
        }
        value += expression[cursor++];
      }
      if (expression[cursor] !== quote) syntaxError('Unterminated string literal');
      cursor += 1;
      tokens.push({ type: 'string', value });
    } else {
      const operator = expression.slice(cursor, cursor + 2);
      if (['==', '!=', '<=', '>=', '&&', '||'].includes(operator)) {
        tokens.push({ type: 'operator', value: operator });
        cursor += 2;
      } else if (['<', '>', '!'].includes(character)) {
        tokens.push({ type: 'operator', value: character });
        cursor += 1;
      } else if (['(', ')', '.'].includes(character)) {
        tokens.push({ type: 'punctuation', value: character });
        cursor += 1;
      } else {
        syntaxError(`Unexpected character "${character}" at position ${cursor}`);
      }
    }
  }
  tokens.push({ type: 'eof', value: '' });

  let tokenIndex = 0;
  const current = () => tokens[tokenIndex];
  const consume = (value?: string) => {
    const token = current();
    if (value !== undefined && token.value !== value) syntaxError(`Expected "${value}" but found "${token.value || 'end of expression'}"`);
    tokenIndex += 1;
    return token;
  };

  const parsePrimary = (): Expression => {
    const token = current();
    if (token.type === 'number') {
      consume();
      return { kind: 'literal', value: Number(token.value) };
    }
    if (token.type === 'string') {
      consume();
      return { kind: 'literal', value: token.value };
    }
    if (token.value === '(') {
      consume('(');
      const value = parseOr();
      consume(')');
      return value;
    }
    if (token.type !== 'identifier') syntaxError(`Expected a value but found "${token.value || 'end of expression'}"`);
    if (token.value === 'true' || token.value === 'false' || token.value === 'null') {
      consume();
      return { kind: 'literal', value: token.value === 'true' ? true : token.value === 'false' ? false : null };
    }
    if (token.value === 'has') {
      consume('has');
      consume('(');
      const value = parsePrimary();
      if (value.kind !== 'path') syntaxError('has() requires an identifier path');
      consume(')');
      return { kind: 'has', value };
    }
    const path = [consume().value];
    while (current().value === '.') {
      consume('.');
      if (current().type !== 'identifier') syntaxError('Expected an identifier after "."');
      path.push(consume().value);
    }
    return { kind: 'path', path };
  };
  const parseUnary = (): Expression => current().value === '!' ? (consume('!'), { kind: 'unary', operator: '!', value: parseUnary() }) : parsePrimary();
  const parseComparison = (): Expression => {
    let value = parseUnary();
    if (['==', '!=', '<', '<=', '>', '>=', 'in'].includes(current().value)) {
      const operator = consume().value;
      value = { kind: 'binary', operator, left: value, right: parseUnary() };
    }
    return value;
  };
  const parseAnd = (): Expression => {
    let value = parseComparison();
    while (current().value === '&&') value = { kind: 'binary', operator: consume().value, left: value, right: parseComparison() };
    return value;
  };
  const parseOr = (): Expression => {
    let value = parseAnd();
    while (current().value === '||') value = { kind: 'binary', operator: consume().value, left: value, right: parseAnd() };
    return value;
  };

  const ast = parseOr();
  if (current().type !== 'eof') syntaxError(`Unexpected token "${current().value}"`);

  const resolvePath = (path: string[]): unknown => path.reduce<unknown>((value, segment) => {
    if (value === null || value === undefined || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[segment];
  }, ctx);
  const evaluate = (node: Expression): unknown => {
    if (node.kind === 'literal') return node.value;
    if (node.kind === 'path') return resolvePath(node.path);
    if (node.kind === 'has') {
      const value = evaluate(node.value);
      return value !== null && value !== undefined;
    }
    if (node.kind === 'unary') return !evaluate(node.value);
    if (node.operator === '&&') return Boolean(evaluate(node.left)) && Boolean(evaluate(node.right));
    if (node.operator === '||') return Boolean(evaluate(node.left)) || Boolean(evaluate(node.right));
    const left = evaluate(node.left);
    const right = evaluate(node.right);
    if (node.operator === '==') return left == right;
    if (node.operator === '!=') return left != right;
    if (node.operator === '<') return typeof left === 'number' && typeof right === 'number' && left < right;
    if (node.operator === '<=') return typeof left === 'number' && typeof right === 'number' && left <= right;
    if (node.operator === '>') return typeof left === 'number' && typeof right === 'number' && left > right;
    if (node.operator === '>=') return typeof left === 'number' && typeof right === 'number' && left >= right;
    if (node.operator === 'in') {
      if (Array.isArray(right) || typeof right === 'string') return right.includes(left as never);
      return right !== null && typeof right === 'object' && typeof left === 'string' && left in right;
    }
    syntaxError(`Unsupported operator "${node.operator}"`);
  };

  return Boolean(evaluate(ast));
}
