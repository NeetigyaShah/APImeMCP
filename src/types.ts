import { z } from 'zod';

const TEMPLATE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const TemplateIdSchema = z
  .string()
  .regex(TEMPLATE_ID_PATTERN, 'templateId must be lowercase kebab-case alphanumeric (e.g. "amazon-product")');

const DomainPatternSchema = z
  .string()
  .min(1, 'domainPattern must not be empty')
  .transform((value) => value.toLowerCase());

export function isHttpUrl(value: string): boolean {
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
  // Set when the template always targets the same page (e.g. "today's deals").
  // Callers can then omit targetUrl entirely at execution time.
  fixedTargetUrl: z.string().refine(isHttpUrl, { message: 'fixedTargetUrl must be an absolute http:// or https:// URL' }).optional(),
};

export const RegisterExtractionTemplateInputSchema = z.object(RegisterExtractionTemplateShape);
export type RegisterExtractionTemplateInput = z.infer<typeof RegisterExtractionTemplateInputSchema>;

export const ExecuteNativeExtractionShape = {
  // Optional: omit it entirely for a fixed-target template (registered with
  // fixedTargetUrl) - the registered URL is used automatically.
  targetUrl: z.string().refine(isHttpUrl, { message: 'targetUrl must be an absolute http:// or https:// URL' }).optional(),
  templateId: TemplateIdSchema.optional(),
  proxyUrl: z.string().url().optional(),
};

export const ExecuteNativeExtractionInputSchema = z.object(ExecuteNativeExtractionShape);
export type ExecuteNativeExtractionInput = z.infer<typeof ExecuteNativeExtractionInputSchema>;

export const BatchDownloadShape = {
  urls: z.array(z.string().refine(isHttpUrl, { message: 'each url must be an absolute http:// or https:// URL' })),
  outputDir: z.string().min(1, 'outputDir must not be empty'),
};

export const BatchDownloadInputSchema = z.object(BatchDownloadShape);
export type BatchDownloadInput = z.infer<typeof BatchDownloadInputSchema>;

export const ScheduleStockCheckShape = {
  // Required (unlike execute_native_extraction's targetUrl): scheduling a fixed-target
  // template on a cron is unaffected by this feature - use execute_native_extraction
  // directly to run those without a URL.
  targetUrl: z.string().refine(isHttpUrl, { message: 'targetUrl must be an absolute http:// or https:// URL' }),
  templateId: ExecuteNativeExtractionShape.templateId,
  cronExpression: z
    .string()
    .min(1, 'cronExpression must not be empty')
    .refine((value) => value.trim().split(/\s+/).length === 5, {
      message: 'cronExpression must be standard 5-field cron (minute-level granularity, no seconds field)',
    }),
};

export const ScheduleStockCheckInputSchema = z.object(ScheduleStockCheckShape);
export type ScheduleStockCheckInput = z.infer<typeof ScheduleStockCheckInputSchema>;

export const SendNotificationShape = {
  endpointUrl: z.string().refine(isHttpUrl, { message: 'endpointUrl must be an absolute http:// or https:// URL' }),
  message: z.string().min(1, 'message must not be empty'),
};

export const SendNotificationInputSchema = z.object(SendNotificationShape);
export type SendNotificationInput = z.infer<typeof SendNotificationInputSchema>;

export interface ManifestEntry {
  templateId: string;
  domainPattern: string;
  scriptPath: string;
  fixedTargetUrl?: string;
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
