import { Ajv, type ErrorObject } from 'ajv';

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

export function validateOutput(
  value: unknown,
  schema: Record<string, unknown> | undefined,
): ValidationResult {
  if (!schema) return { valid: true };

  try {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    if (validate(value)) return { valid: true };

    return {
      valid: false,
      errors: (validate.errors ?? []).map((error: ErrorObject) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`),
    };
  } catch (error) {
    return { valid: false, errors: [`invalid outputSchema: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
