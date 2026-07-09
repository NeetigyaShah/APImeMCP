import { z } from 'zod';

const TEMPLATE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const TemplateIdSchema = z
  .string()
  .regex(TEMPLATE_ID_PATTERN, 'templateId must be lowercase kebab-case alphanumeric (e.g. "amazon-product")');

const DomainPatternSchema = z
  .string()
  .min(1, 'domainPattern must not be empty')
  .transform((value) => value.toLowerCase());

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export const RegisterExtractionTemplateShape = {
  templateId: TemplateIdSchema,
  domainPattern: DomainPatternSchema,
  executableScript: z
    .string()
    .min(1, 'executableScript must not be empty')
    .max(100_000, 'executableScript exceeds the 100KB limit'),
};

export const RegisterExtractionTemplateInputSchema = z.object(RegisterExtractionTemplateShape);
export type RegisterExtractionTemplateInput = z.infer<typeof RegisterExtractionTemplateInputSchema>;

export const ExecuteNativeExtractionShape = {
  targetUrl: z.string().refine(isHttpUrl, { message: 'targetUrl must be an absolute http:// or https:// URL' }),
  templateId: TemplateIdSchema.optional(),
  proxyUrl: z.string().url().optional(),
};

export const ExecuteNativeExtractionInputSchema = z.object(ExecuteNativeExtractionShape);
export type ExecuteNativeExtractionInput = z.infer<typeof ExecuteNativeExtractionInputSchema>;

export interface ManifestEntry {
  templateId: string;
  domainPattern: string;
  scriptPath: string;
  createdAt: string;
  updatedAt: string;
}

export type Manifest = Record<string, ManifestEntry>;

export interface ExtractionMeta {
  url: string;
  templateId: string;
  domainMatched: string;
  durationMs: number;
  timestamp: string;
}

export interface ExtractionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  meta: ExtractionMeta;
}
