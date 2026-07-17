import { z } from 'zod';

const SimpleTransformOpSchema = z.union([
  z.object({ op: z.literal('pick'), fields: z.array(z.string()).min(1) }),
  z.object({ op: z.literal('rename'), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('coerce'), field: z.string(), to: z.enum(['string', 'number', 'boolean', 'date']) }),
]);

export const TransformOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('pick'), fields: z.array(z.string()).min(1) }),
  z.object({ op: z.literal('rename'), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('coerce'), field: z.string(), to: z.enum(['string', 'number', 'boolean', 'date']) }),
  z.object({ op: z.literal('map'), ops: z.array(SimpleTransformOpSchema) }),
]);
export type TransformOp = z.infer<typeof TransformOpSchema>;

export const TransformSpecSchema = z.object({
  version: z.literal(1),
  ops: z.array(TransformOpSchema),
});
export type TransformSpec = z.infer<typeof TransformSpecSchema>;

export class TransformError extends Error {}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireObject(value: unknown, operation: string): PlainObject {
  if (!isPlainObject(value)) throw new TransformError(`${operation} requires a plain object`);
  return value;
}

function coerceValue(value: unknown, field: string, target: 'string' | 'number' | 'boolean' | 'date'): unknown {
  try {
    if (target === 'string' && value !== null && value !== undefined) return String(value);
    if (target === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim() !== '') {
        const number = Number(value);
        if (Number.isFinite(number)) return number;
      }
    }
    if (target === 'boolean') {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
    }
    if (target === 'date') {
      const date = new Date(value as string | number);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  } catch {
    // Normalize all conversion failures into the public transform error type.
  }
  throw new TransformError(`cannot coerce field "${field}" to ${target}`);
}

function applyOperation(value: unknown, operation: TransformOp | Exclude<TransformOp, { op: 'map' }>): unknown {
  if (operation.op === 'map') {
    if (!Array.isArray(value)) throw new TransformError('map requires an array');
    return value.map((item) => operation.ops.reduce((current, nested) => applyOperation(current, nested), item));
  }

  const object = requireObject(value, operation.op);
  if (operation.op === 'pick') {
    return Object.fromEntries(operation.fields.filter((field) => Object.hasOwn(object, field)).map((field) => [field, object[field]]));
  }
  if (operation.op === 'rename') {
    const result = { ...object };
    if (Object.hasOwn(result, operation.from)) {
      result[operation.to] = result[operation.from];
      delete result[operation.from];
    }
    return result;
  }
  return { ...object, [operation.field]: coerceValue(object[operation.field], operation.field, operation.to) };
}

export function applyTransform(data: unknown, spec: TransformSpec): unknown {
  return spec.ops.reduce((current, operation) => applyOperation(current, operation), data);
}
