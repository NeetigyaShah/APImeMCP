import { z } from 'zod';
import type { ValidationResult } from './schema.js';
import type { DriftEntry, DriftReport } from './drift.js';
import type { ProvenanceReceipt } from './provenance.js';
import { TransformSpecSchema } from './transform.js';
import type { TransformSpec } from './transform.js';

export type { ValidationResult } from './schema.js';

// Vault types (F13)
export const VaultEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  algo: z.literal('aes-256-gcm'),
  iv: z.string(),
  authTag: z.string(),
  ciphertext: z.string(),
  keyId: z.string(),
});
export type VaultEntry = z.infer<typeof VaultEntrySchema>;

export const VaultStoreSchema = z.object({
  version: z.literal(1),
  entries: z.record(VaultEntrySchema),
});
export type VaultStore = z.infer<typeof VaultStoreSchema>;

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

const WaitStrategySchema = z.enum(['domcontentloaded', 'load', 'networkidle']);
export type WaitStrategy = z.infer<typeof WaitStrategySchema>;

const TemplateKindSchema = z.enum(['extraction', 'action-sequence', 'static-http']);
export type TemplateKind = z.infer<typeof TemplateKindSchema>;

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
  // How long to wait after navigation before running the script. 'networkidle' (the old
  // hardcoded default) requires a 500ms window of zero network activity - pathological on
  // pages with persistent polling/analytics/ads, often adding seconds or timing out
  // outright. Templates without this set fall back to 'domcontentloaded' at run time
  // (see engine.ts) - explicitly opt into 'networkidle' only if a template actually needs
  // content that loads after DOMContentLoaded and isn't covered by readySelector.
  waitStrategy: WaitStrategySchema.optional(),
  // If set, wait for this selector to appear (in addition to waitStrategy) before running
  // the script - the precise way to wait for "the data I need" without paying networkidle's
  // blanket cost.
  readySelector: z.string().optional(),
  outputSchema: z.record(z.unknown()).optional(),
  transform: TransformSpecSchema.optional(),
  // F13: maps script-visible field names to vault entry ids or subkeys (e.g.,
  // { username: "vault-id.username", password: "vault-id.password" }). Resolved and
  // injected at run time, never persisted or logged in cleartext (see engine.ts).
  secretInputs: z.record(z.string()).optional(),
  // Template kind: 'extraction' (Playwright browser), 'action-sequence' (interactive steps),
  // or 'static-http' (HTTP fetch + cheerio for initial HTML). Defaults to 'extraction'.
  kind: TemplateKindSchema.optional(),
  // Optional request headers for static-http kind (User-Agent overrides, etc.)
  requestHeaders: z.record(z.string()).optional(),
  // F09: template kind discriminant ('read' is default for back-compat)
  templateKind: z.enum(['read', 'write']).default('read').optional(),
  // F09: write template only - Playwright script that fills + submits a form from input data
  writeScript: z.string().min(1, 'writeScript must not be empty').max(100_000, 'writeScript exceeds the 100KB limit').optional(),
  // F09: write template optional pre-submit schema check
  writeInputSchema: z.record(z.unknown()).optional(),
};

export const RegisterExtractionTemplateInputSchema = z
  .object(RegisterExtractionTemplateShape)
  .superRefine((entry, ctx) => {
    // Playwright-only fields rejected on static-http entries
    if (entry.kind === 'static-http') {
      if (entry.readySelector) {
        ctx.addIssue({
          code: 'custom',
          message: 'readySelector is Playwright-only; omit it for kind:"static-http"',
          path: ['readySelector'],
        });
      }
      if (entry.waitStrategy) {
        ctx.addIssue({
          code: 'custom',
          message: 'waitStrategy is Playwright-only; omit it for kind:"static-http"',
          path: ['waitStrategy'],
        });
      }
    }
  });
export type RegisterExtractionTemplateInput = z.infer<typeof RegisterExtractionTemplateInputSchema>;

export const ExecuteNativeExtractionShape = {
  // Optional: omit it entirely for a fixed-target template (registered with
  // fixedTargetUrl) - the registered URL is used automatically.
  targetUrl: z.string().refine(isHttpUrl, { message: 'targetUrl must be an absolute http:// or https:// URL' }).optional(),
  templateId: TemplateIdSchema.optional(),
  // Optional persistent browser profile created by connect_app. When supplied,
  // the run uses the profile's local browser session instead of cookieString.
  connectionId: TemplateIdSchema.optional(),
  proxyUrl: z.string().url().optional(),
  // Session cookies ("name=value; name2=value2") to run as a logged-in user. When
  // supplied, they're also saved for this template so the dashboard can offer to reuse
  // them. Point only at accounts/domains you control.
  cookieString: z.string().optional(),
  executableScript: z.string().min(1, 'executableScript must not be empty').optional(),
  outputSchema: z.record(z.unknown()).optional(),
};

export const ExecuteNativeExtractionInputSchema = z.object(ExecuteNativeExtractionShape);
export type ExecuteNativeExtractionInput = z.infer<typeof ExecuteNativeExtractionInputSchema>;

export const ConnectAppShape = {
  connectionId: TemplateIdSchema,
  domainPattern: DomainPatternSchema,
  loginUrl: z.string().refine(isHttpUrl, { message: 'loginUrl must be an absolute http:// or https:// URL' }),
  autoStart: z.boolean().optional(),
};

export const ConnectAppInputSchema = z.object(ConnectAppShape);
export type ConnectAppInput = z.infer<typeof ConnectAppInputSchema>;

export const AppConnectionStatusSchema = z.enum(['pending', 'connected', 'expired', 'error']);

export const AppConnectionSchema = z
  .object({
    connectionId: z.string(),
    domainPattern: DomainPatternSchema,
    loginUrl: z.string().refine(isHttpUrl, { message: 'loginUrl must be an absolute http:// or https:// URL' }),
    profileDir: z.string().regex(/^templates[\\/]app-profiles[\\/][a-z0-9]+(?:-[a-z0-9]+)*$/, 'profileDir must be a managed app profile'),
    autoStart: z.boolean().default(false),
    status: AppConnectionStatusSchema,
    createdAt: z.string().datetime(),
    lastUsedAt: z.string().datetime().optional(),
  })
  .strict();
export type AppConnection = z.infer<typeof AppConnectionSchema>;

export const AppConnectionIdShape = {
  connectionId: TemplateIdSchema,
};

export const AppConnectionIdInputSchema = z.object(AppConnectionIdShape);
export type AppConnectionIdInput = z.infer<typeof AppConnectionIdInputSchema>;

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

export const SaveTemplateCookiesShape = {
  templateId: TemplateIdSchema,
  cookieString: z.string().min(1, 'cookieString must not be empty'),
};

export const SaveTemplateCookiesInputSchema = z.object(SaveTemplateCookiesShape);
export type SaveTemplateCookiesInput = z.infer<typeof SaveTemplateCookiesInputSchema>;

export const AddCommunityTemplateShape = {
  domain: z.string().min(1, 'domain must not be empty'),
};

export const AddCommunityTemplateInputSchema = z.object(AddCommunityTemplateShape);
export type AddCommunityTemplateInput = z.infer<typeof AddCommunityTemplateInputSchema>;

export const ActionStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('goto'), url: z.string().refine(isHttpUrl, { message: 'url must be an absolute http:// or https:// URL' }) }),
  z.object({ kind: z.literal('click'), selector: z.string().min(1), label: z.string().optional() }),
  z.object({ kind: z.literal('fill'), selector: z.string().min(1), value: z.string(), label: z.string().optional() }),
  z.object({ kind: z.literal('waitFor'), selector: z.string().min(1) }),
  z.object({
    kind: z.literal('extract'),
    selector: z.string().min(1),
    field: z.string().min(1),
    attr: z.enum(['text', 'href', 'src']).default('text'),
  }),
]);
export type CrystallizedActionStep = z.infer<typeof ActionStepSchema>;

export const ActionTraceSchema = z.object({
  targetUrl: z.string().refine(isHttpUrl, { message: 'targetUrl must be an absolute http:// or https:// URL' }),
  steps: z.array(ActionStepSchema).min(1),
  outputSchema: z.record(z.unknown()).optional(),
});
export type ActionTrace = z.infer<typeof ActionTraceSchema>;

export interface Recording {
  id: string;
  trace: ActionTrace;
  createdAt: string;
  crystallizedTemplateId?: string;
  prUrl?: string;
}

export interface ReplayActionStep {
  type: 'click' | 'fill' | 'select' | 'navigate' | 'waitForNavigation';
  selectors?: string[]; // ordered fallback candidates, e.g. ["[data-testid=submit]", "button:has-text('Submit')"]
  value?: string; // for fill/select
  url?: string; // for navigate
}
export type ActionStep = ReplayActionStep | CrystallizedActionStep;

export interface ActionSequence {
  startUrl: string;
  steps: ReplayActionStep[];
  // Raw chrome.cookies.getAll() shape (name, value, domain, path, secure, httpOnly, sameSite,
  // expirationDate, ...) - NOT yet mapped to Playwright's addCookies shape. The server maps
  // chrome cookie fields -> Playwright's shape (expirationDate -> expires; sameSite
  // 'no_restriction'|'lax'|'strict'|undefined -> 'None'|'Lax'|'Strict', default 'Lax').
  cookies?: Array<Record<string, unknown>>;
}

export interface CelContext {
  vars: Record<string, unknown>;
  page: { url: string; status?: number; title?: string };
  lastResult?: unknown;
}

export interface ManifestEntry {
  templateId: string;
  domainPattern: string;
  scriptPath: string;
  fixedTargetUrl?: string;
  createdAt: string;
  updatedAt: string;
  kind?: TemplateKind;
  lastVerified?: { success: boolean; error?: string; timestamp: string };
  // Absent = falls back to 'domcontentloaded' at run time (see engine.ts). Existing
  // templates registered before this field existed all take that fallback.
  waitStrategy?: WaitStrategy;
  readySelector?: string;
  outputSchema?: Record<string, unknown>;
  transform?: TransformSpec;
  // F13: Vault secret references. Maps field names to vault entry ids or subkeys (e.g.,
  // { username: "vault-id.username", password: "vault-id.password" }). Absent means no
  // vault involvement for this template.
  secretInputs?: Record<string, string>;
  // Optional request headers for static-http kind (User-Agent overrides, etc.)
  requestHeaders?: Record<string, string>;
  // F09: template kind discriminant ('read' is default for back-compat)
  templateKind?: 'read' | 'write';
  // F09: write template only - Playwright script that fills + submits a form from input data
  writeScript?: string;
  // F09: write template optional pre-submit schema check
  writeInputSchema?: Record<string, unknown>;
  // System-assigned, NOT part of the public register_extraction_template tool's input
  // schema (a caller can't just claim 'local' to escape the sandbox) - set only by
  // registry-client.ts's addFromRegistry(). 'registry' templates get a network
  // allowlist enforced at run time by default (see engine.ts); locally-authored
  // templates (source absent) are trusted by definition, matching the existing
  // self-host power-user experience.
  source?: 'registry' | 'local';
  contributedBy?: string;
  // Registry templates declare every hostname their page and script may contact. The
  // field is optional for backward compatibility with manifests published before F19;
  // registry CI rejects newly contributed entries without it.
  allowedDomains?: string[];
}

export function isStaticHttpEntry(entry: ManifestEntry): entry is ManifestEntry & { kind: 'static-http' } {
  return entry.kind === 'static-http';
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
  schemaValidation?: ValidationResult;
  drift?: DriftReport;
  provenance?: ProvenanceReceipt;
}

export interface HealForensics {
  templateId: string;
  capturedAt: string;
  targetUrl: string;
  domSnapshotPath: string;
  screenshotPath: string;
  consoleErrors: string[];
  oldScript: string;
  driftDiff: DriftReport;
  outputSchema?: Record<string, unknown>;
}

export type HealStatus = 'pending' | 'submitted' | 'pr-opened' | 'rejected';

export interface HealTicket {
  id: string;
  templateId: string;
  status: HealStatus;
  forensics: HealForensics;
  createdAt: string;
  updatedAt: string;
}

export interface HealResult {
  valid: boolean;
  validationErrors?: ValidationResult['errors'];
  dryRunOutput?: unknown;
  prUrl?: string;
  branch?: string;
  rejectedReason?: string;
}

export const RunKindSchema = z.enum(['extraction', 'action-sequence', 'static-http', 'pipeline']);
export type RunKind = z.infer<typeof RunKindSchema>;

// F09: Write step for bidirectional flows (declared first, before use in union)
export const WriteStepSchema = z.object({
  kind: z.literal('write'),
  id: z.string().min(1),
  fromStepId: z.string().min(1),
  targetTemplateId: TemplateIdSchema,
  transform: TransformSpecSchema,
  perItem: z.boolean().optional(),
  onError: z.enum(['stop', 'continue', 'collect']).optional(),
  dryRun: z.boolean().optional(),
});
export type WriteStep = z.infer<typeof WriteStepSchema>;

// F07: Basic extraction/read step
const ReadPipelineStepSchema = z.object({
  kind: z.literal('read').optional(), // default 'read' for back-compat
  id: z.string().min(1),
  templateId: TemplateIdSchema,
  targetUrl: z.string().url().optional(),
  cookieString: z.string().optional(),
  proxyUrl: z.string().url().optional(),
  inputMapping: z.record(z.string()).optional(),
});
export type ReadPipelineStep = z.infer<typeof ReadPipelineStepSchema>;

// Union of all step kinds (F07 read + F09 write)
export const PipelineStepSchema = z.union([ReadPipelineStepSchema, WriteStepSchema]);
export type PipelineStep = ReadPipelineStep | WriteStep;

export const PipelineDefSchema = z.object({
  id: TemplateIdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(PipelineStepSchema).min(1),
  createdAt: z.string().optional(),
});
export type PipelineDef = z.infer<typeof PipelineDefSchema>;

export interface PipelineStepResult {
  stepId: string;
  templateId: string;
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface PipelineRunResult {
  pipelineId: string;
  success: boolean;
  steps: PipelineStepResult[];
  failedStep?: string;
  totalDurationMs: number;
}

export interface WriteResult {
  templateId: string;
  input: unknown;
  success: boolean;
  dryRun: boolean;
  submittedAt: string;
  durationMs: number;
  error?: string;
  forensicsPath?: string;
}

export const MeasureRecordSchema = z
  .object({
    templateId: z.string().min(1),
    kind: RunKindSchema,
    success: z.boolean(),
    durationMs: z.number().finite().nonnegative(),
    timestamp: z.string().datetime(),
    error: z.string().optional(),
    driftDetected: z.boolean().optional(),
    driftEntryCount: z.number().int().nonnegative().optional(),
    driftEntries: z.array(z.object({
      path: z.string(),
      kind: z.enum(['field_added', 'field_removed', 'type_changed']),
      expected: z.string().optional(),
      actual: z.string().optional(),
    })).optional(),
  })
  .refine((record) => (record.success ? record.error === undefined : record.error !== undefined), {
    message: 'error must be absent when success is true and required when success is false',
    path: ['error'],
  });
export type MeasureRecord = z.infer<typeof MeasureRecordSchema>;

export interface TemplateSla {
  templateId: string;
  runs: number;
  successCount: number;
  successRate: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  lastRunAt: string;
  lastError?: string;
  driftCount: number;
  lastDriftAt?: string;
  driftEntries: DriftEntry[];
}

// F20: Change-monitoring mesh
export interface MonitorSubscription {
  id: string;
  templateId: string;
  targetUrl?: string;
  inputs?: Record<string, unknown>;
  cronExpression: string;
  notifyEndpointUrl: string;
  active: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastResultHash?: string;
  lastResult?: unknown;
  lastChange?: { at: string; summary: string };
}

export interface MonitorEvent {
  monitorId: string;
  templateId: string;
  changed: boolean;
  summary: string;
  before?: unknown;
  after?: unknown;
  at: string;
}

export const SubscribeMonitorShape = {
  templateId: TemplateIdSchema,
  targetUrl: z.string().url().optional(),
  inputs: z.record(z.unknown()).optional(),
  cronExpression: z.string().min(1, 'cronExpression must not be empty'),
  notifyEndpointUrl: z.string().refine(isHttpUrl, { message: 'notifyEndpointUrl must be an absolute http:// or https:// URL' }),
};

export const SubscribeMonitorInputSchema = z.object(SubscribeMonitorShape);
export type SubscribeMonitorInput = z.infer<typeof SubscribeMonitorInputSchema>;
