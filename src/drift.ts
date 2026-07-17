export type DriftKind = 'field_added' | 'field_removed' | 'type_changed';

export interface DriftEntry {
  path: string;
  kind: DriftKind;
  expected?: string;
  actual?: string;
}

export interface DriftReport {
  templateId: string;
  timestamp: string;
  hasDrift: boolean;
  entries: DriftEntry[];
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function propertyPath(basePath: string, key: string): string {
  return basePath ? `${basePath}.${key}` : key;
}

function indexPath(basePath: string, index: number): string {
  return `${basePath}[${index}]`;
}

function diffValues(before: unknown, after: unknown, basePath: string, entries: DriftEntry[]): void {
  const beforeType = jsonType(before);
  const afterType = jsonType(after);
  if (beforeType !== afterType) {
    entries.push({ path: basePath, kind: 'type_changed', expected: beforeType, actual: afterType });
    return;
  }

  if (beforeType === 'object') {
    const beforeObject = before as Record<string, unknown>;
    const afterObject = after as Record<string, unknown>;
    const keys = new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)]);
    for (const key of keys) {
      const path = propertyPath(basePath, key);
      if (!(key in beforeObject)) {
        entries.push({ path, kind: 'field_added', actual: jsonType(afterObject[key]) });
      } else if (!(key in afterObject)) {
        entries.push({ path, kind: 'field_removed', expected: jsonType(beforeObject[key]) });
      } else {
        diffValues(beforeObject[key], afterObject[key], path, entries);
      }
    }
  } else if (beforeType === 'array') {
    const beforeArray = before as unknown[];
    const afterArray = after as unknown[];
    const commonLength = Math.min(beforeArray.length, afterArray.length);
    for (let index = 0; index < commonLength; index++) {
      diffValues(beforeArray[index], afterArray[index], indexPath(basePath, index), entries);
    }
    for (let index = commonLength; index < afterArray.length; index++) {
      entries.push({ path: indexPath(basePath, index), kind: 'field_added', actual: jsonType(afterArray[index]) });
    }
    for (let index = commonLength; index < beforeArray.length; index++) {
      entries.push({ path: indexPath(basePath, index), kind: 'field_removed', expected: jsonType(beforeArray[index]) });
    }
  }
}

export function diffJson(before: unknown, after: unknown, basePath = ''): DriftEntry[] {
  try {
    const entries: DriftEntry[] = [];
    diffValues(before, after, basePath, entries);
    return entries;
  } catch {
    return [];
  }
}

function schemaTypeMatches(value: unknown, expected: string): boolean {
  if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return jsonType(value) === expected;
}

function diffSchemaNode(schema: Record<string, any>, sample: unknown, basePath: string, entries: DriftEntry[]): void {
  if (schema.type && !schemaTypeMatches(sample, schema.type)) {
    entries.push({ path: basePath, kind: 'type_changed', expected: schema.type, actual: jsonType(sample) });
    return;
  }

  if (schema.type === 'object' || schema.properties) {
    if (jsonType(sample) !== 'object') return;
    const sampleObject = sample as Record<string, unknown>;
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const key of Object.keys(properties)) {
      const path = propertyPath(basePath, key);
      if (!(key in sampleObject)) {
        if (required.has(key)) entries.push({ path, kind: 'field_removed', expected: 'present' });
        continue;
      }
      if (properties[key] && typeof properties[key] === 'object') {
        diffSchemaNode(properties[key], sampleObject[key], path, entries);
      }
    }
    for (const key of Object.keys(sampleObject)) {
      if (!(key in properties)) entries.push({ path: propertyPath(basePath, key), kind: 'field_added', actual: jsonType(sampleObject[key]) });
    }
  } else if (schema.type === 'array' && Array.isArray(sample)) {
    if (schema.items && typeof schema.items === 'object') {
      sample.forEach((item, index) => diffSchemaNode(schema.items, item, indexPath(basePath, index), entries));
    }
  }
}

export function diffAgainstSchema(schema: Record<string, any>, sample: unknown): DriftEntry[] {
  try {
    const entries: DriftEntry[] = [];
    diffSchemaNode(schema ?? {}, sample, '', entries);
    return entries;
  } catch {
    return [];
  }
}

export function checkDrift(templateId: string, schema: Record<string, any>, sample: unknown): DriftReport {
  const entries = diffAgainstSchema(schema, sample);
  return { templateId, timestamp: new Date().toISOString(), hasDrift: entries.length > 0, entries };
}

export interface DiffResult {
  changed: boolean;
  summary: string;
  entries?: DriftEntry[];
}

export function diffContent(before: unknown, after: unknown): DiffResult {
  const entries = diffJson(before, after);
  const changed = entries.length > 0;
  const summary = changed ? `${entries.length} change(s) detected` : 'no changes';
  return { changed, summary, entries };
}
