import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExecuteExtractionOptions, renderPage } from '../engine.js';
import { ActionTraceSchema, isHttpUrl, RegisterExtractionTemplateShape } from '../types.js';
import type { ActionTrace, Manifest, ManifestEntry, Recording, RegisterExtractionTemplateInput } from '../types.js';

export interface SynthesizeSchemaDeps {
  renderPage: typeof renderPage;
  crystallizeRecording: (trace: ActionTrace) => string;
  executeExtraction: (options: ExecuteExtractionOptions) => Promise<unknown>;
  registerTemplate: (input: RegisterExtractionTemplateInput) => Promise<ManifestEntry>;
  loadManifest: () => Promise<Manifest>;
  findTemplateByUrl: (manifest: Manifest, targetUrl: string) => ManifestEntry | undefined;
  saveRecording: (recording: Recording) => Promise<void>;
  submitTemplatePR: (entry: ManifestEntry, opts: { githubToken: string; executableScript: string; branch?: string }) => Promise<{ prUrl: string }>;
}

export const SynthesizeSchemaShape = {
  targetUrl: z.string().refine(isHttpUrl, { message: 'targetUrl must be an absolute http:// or https:// URL' }),
  cookieString: z.string().optional(),
  proxyUrl: z.string().url().optional(),
  script: RegisterExtractionTemplateShape.executableScript.optional(),
  recording: ActionTraceSchema.optional(),
  templateId: RegisterExtractionTemplateShape.templateId.optional(),
  domainPattern: RegisterExtractionTemplateShape.domainPattern.optional(),
  outputSchema: RegisterExtractionTemplateShape.outputSchema,
  register: z.boolean().default(true).optional(),
  autoPr: z.boolean().default(false).optional(),
  githubToken: z.string().optional(),
};

function toolResponse(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function normalizeUrl(value: string): string {
  return new URL(value).href;
}

function domainFromUrl(targetUrl: string): string {
  return new URL(targetUrl).hostname.toLowerCase().replace(/^www\./, '');
}

function deriveTemplateId(targetUrl: string): string {
  const url = new URL(targetUrl);
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-');
  const pathParts = url.pathname.split('/').filter(Boolean).slice(0, 2).join('-');
  const slug = `${host}${pathParts ? `-${pathParts}` : ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || 'crystallized-template';
}

export function registerSynthesizeSchemaTool(server: McpServer, deps: SynthesizeSchemaDeps): void {
  server.tool(
    'synthesize_schema',
    SynthesizeSchemaShape,
    async ({ targetUrl, cookieString, proxyUrl, script, recording, templateId, domainPattern, outputSchema, register, autoPr, githubToken }) => {
      if (script && recording) {
        throw new Error('Provide only one of script or recording.');
      }

      if (!script && !recording) {
        const forensics = await deps.renderPage(targetUrl, { cookieString, proxyUrl });
        return toolResponse({
          ...forensics,
          nextStep:
            'Write an extraction script body from this HTML, then call execute_native_extraction with { targetUrl, executableScript } to dry-run it (nothing is saved). When satisfied, call register_extraction_template to persist it.',
        });
      }

      const manifest = await deps.loadManifest();
      const existing = deps.findTemplateByUrl(manifest, targetUrl);
      if (existing) {
        return toolResponse({
          success: false,
          templateId: existing.templateId,
          message: 'template exists — consider F04 self-heal instead of registering a duplicate',
        });
      }

      const parsedRecording = recording ? ActionTraceSchema.parse(recording) : undefined;
      if (parsedRecording && normalizeUrl(parsedRecording.targetUrl) !== normalizeUrl(targetUrl)) {
        throw new Error('recording.targetUrl must match targetUrl.');
      }
      const effectiveOutputSchema = (outputSchema ?? parsedRecording?.outputSchema) as Record<string, unknown> | undefined;

      let recordingRecord: Recording | undefined;
      if (parsedRecording) {
        recordingRecord = { id: randomUUID(), trace: parsedRecording, createdAt: new Date().toISOString() };
        await deps.saveRecording(recordingRecord);
      }

      const executableScript = parsedRecording ? deps.crystallizeRecording(parsedRecording) : script!;
      let data: unknown;
      try {
        data = await deps.executeExtraction({ targetUrl, executableScript, cookieString, proxyUrl });
      } catch (err) {
        return toolResponse({
          success: false,
          recordingId: recordingRecord?.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (register === false) {
        return toolResponse({ success: true, registered: false, data, executableScript, recordingId: recordingRecord?.id });
      }

      const entry = await deps.registerTemplate({
        templateId: templateId ?? deriveTemplateId(targetUrl),
        domainPattern: domainPattern ?? domainFromUrl(targetUrl),
        executableScript,
        fixedTargetUrl: targetUrl,
        outputSchema: effectiveOutputSchema,
      });

      let prUrl: string | undefined;
      if (autoPr === true) {
        if (!githubToken) throw new Error('githubToken is required when autoPr is true.');
        prUrl = (await deps.submitTemplatePR(entry, { githubToken, executableScript })).prUrl;
      }

      if (recordingRecord) {
        await deps.saveRecording({ ...recordingRecord, crystallizedTemplateId: entry.templateId, ...(prUrl ? { prUrl } : {}) });
      }

      return toolResponse({
        success: true,
        registered: true,
        templateId: entry.templateId,
        data,
        recordingId: recordingRecord?.id,
        ...(prUrl ? { prUrl } : {}),
      });
    }
  );
}
