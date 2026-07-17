import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withLock } from './lock.js';
import { atomicWriteFile } from './storage.js';
import { PipelineDefSchema } from './types.js';
import type { MeasureRecord, PipelineDef, PipelineRunResult, PipelineStepResult, WriteResult } from './types.js';
import type { ExtractionRunner } from './tools/tool-deps.js';
import { applyTransform } from './transform.js';
import type { ExecuteWriteFlowOptions } from './engine.js';
import { findTemplateById, loadManifest } from './storage.js';
import { validateOutput } from './schema.js';

const pipelineIdPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function pipelinesDirectory(): string {
  return path.resolve(process.cwd(), 'templates', 'pipelines');
}

function pipelinePath(id: string): string {
  return path.join(pipelinesDirectory(), `${id}.json`);
}

export class PipelineMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineMappingError';
  }
}

export async function registerPipeline(definition: PipelineDef): Promise<void> {
  const definitionWithTimestamp = PipelineDefSchema.parse({
    ...definition,
    createdAt: definition.createdAt ?? new Date().toISOString(),
  });
  await withLock(async () => {
    if (findPipelineById(definitionWithTimestamp.id)) {
      throw new Error(`Pipeline "${definitionWithTimestamp.id}" already exists`);
    }
    await atomicWriteFile(pipelinePath(definitionWithTimestamp.id), JSON.stringify(definitionWithTimestamp, null, 2));
  });
}

export function findPipelineById(id: string): PipelineDef | null {
  if (!pipelineIdPattern.test(id)) return null;
  try {
    return PipelineDefSchema.parse(JSON.parse(readFileSync(pipelinePath(id), 'utf8')));
  } catch {
    return null;
  }
}

export function listPipelineDefs(): PipelineDef[] {
  let files: string[];
  try {
    files = readdirSync(pipelinesDirectory()).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  return files.flatMap((file) => {
    try {
      return [PipelineDefSchema.parse(JSON.parse(readFileSync(path.join(pipelinesDirectory(), file), 'utf8')))];
    } catch {
      return [];
    }
  });
}

function getPathValue(value: unknown, pathParts: string[], reference: string): unknown {
  let current = value;
  for (const part of pathParts) {
    if ((typeof current !== 'object' || current === null) && !Array.isArray(current)) {
      throw new PipelineMappingError(`Unable to resolve mapping "${reference}" at "${part}"`);
    }
    if (!(part in (current as object))) {
      throw new PipelineMappingError(`Unable to resolve mapping "${reference}" at "${part}"`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function resolveInputMapping(
  mapping: Record<string, string> | undefined,
  initialInput: Record<string, unknown>,
  stepResults: Record<string, { output?: unknown }>,
): Record<string, unknown> {
  if (!mapping) return {};
  return Object.fromEntries(Object.entries(mapping).map(([parameter, reference]) => {
    const separator = reference.indexOf('.');
    const root = separator === -1 ? reference : reference.slice(0, separator);
    const pathParts = (separator === -1 ? '' : reference.slice(separator + 1)).split('.').filter(Boolean);
    if (root === '$init') return [parameter, getPathValue(initialInput, pathParts, reference)];
    const step = stepResults[root];
    if (!step) throw new PipelineMappingError(`Mapping "${reference}" references unknown or unavailable step "${root}"`);
    return [parameter, getPathValue(step.output, pathParts, reference)];
  }));
}

export interface PipelineDeps {
  runExtraction: ExtractionRunner;
  registerPipeline: typeof registerPipeline;
  findPipelineById: typeof findPipelineById;
  listPipelineDefs: typeof listPipelineDefs;
  recordMeasure?: (measure: MeasureRecord) => void | Promise<void>;
  executeWriteFlow?: (opts: ExecuteWriteFlowOptions) => Promise<{ success: boolean; input: unknown; dryRun: boolean; error?: string; forensicsPath?: string }>;
  loadManifest?: typeof loadManifest;
  findTemplateById?: typeof findTemplateById;
}

export async function runPipeline(
  pipelineId: string,
  initialInput: Record<string, unknown> = {},
  deps: PipelineDeps,
): Promise<PipelineRunResult> {
  const definition = deps.findPipelineById(pipelineId);
  if (!definition) throw new Error(`No registered pipeline with pipelineId "${pipelineId}"`);
  const startedAt = Date.now();
  const results: PipelineStepResult[] = [];
  const stepResults: Record<string, { output?: unknown }> = {};
  let failedStep: string | undefined;

  for (const step of definition.steps) {
    const stepStartedAt = Date.now();
    try {
      // F07: Read steps (default kind)
      if (step.kind !== 'write') {
        const resolved = resolveInputMapping(step.inputMapping, initialInput, stepResults);
        const result = await deps.runExtraction(
          (resolved.targetUrl ?? (step as any).targetUrl) as string | undefined,
          (step as any).templateId,
          (resolved.proxyUrl ?? (step as any).proxyUrl) as string | undefined,
          (resolved.cookieString ?? (step as any).cookieString) as string | undefined,
        );
        const stepResult: PipelineStepResult = {
          stepId: step.id,
          templateId: (step as any).templateId,
          success: result.success,
          ...(result.data !== undefined ? { output: result.data } : {}),
          ...(result.error ? { error: result.error } : {}),
          durationMs: Date.now() - stepStartedAt,
        };
        results.push(stepResult);
        if (!result.success) {
          failedStep = step.id;
          break;
        }
        stepResults[step.id] = { output: result.data };
      } else {
        // F09: Write steps
        if (!deps.executeWriteFlow) {
          throw new Error('Write steps require executeWriteFlow in deps');
        }

        const writeStep = step;
        const upstreamOutput = stepResults[writeStep.fromStepId]?.output;
        if (!upstreamOutput) {
          throw new Error(`Write step references unknown or unavailable step "${writeStep.fromStepId}"`);
        }

        // Load the write template (use injected or direct import)
        const loadManifestFn = deps.loadManifest || loadManifest;
        const findTemplateByIdFn = deps.findTemplateById || findTemplateById;
        const manifest = await loadManifestFn();
        const writeTemplate = findTemplateByIdFn(manifest, writeStep.targetTemplateId);
        if (!writeTemplate) {
          throw new Error(`Write template "${writeStep.targetTemplateId}" not found`);
        }
        if (writeTemplate.templateKind !== 'write' || !writeTemplate.writeScript) {
          throw new Error(`Template "${writeStep.targetTemplateId}" is not a write template`);
        }

        // Determine if we need to fan out over items
        const perItem = writeStep.perItem ?? Array.isArray(upstreamOutput);
        const items = perItem && Array.isArray(upstreamOutput) ? upstreamOutput : [upstreamOutput];
        const onError = writeStep.onError ?? 'collect';
        const writeResults: WriteResult[] = [];
        let hadError = false;

        for (const item of items) {
          try {
            // Apply transform to the item
            const transformedInput = applyTransform(item, writeStep.transform);

            // Execute the write flow
            const writeResult = await deps.executeWriteFlow({
              targetUrl: writeTemplate.fixedTargetUrl || '',
              templateId: writeStep.targetTemplateId,
              writeScript: writeTemplate.writeScript,
              input: transformedInput,
              writeInputSchema: writeTemplate.writeInputSchema,
              dryRun: writeStep.dryRun,
              waitStrategy: writeTemplate.waitStrategy,
              readySelector: writeTemplate.readySelector,
            });

            writeResults.push({
              templateId: writeStep.targetTemplateId,
              input: transformedInput,
              success: writeResult.success,
              dryRun: writeResult.dryRun,
              submittedAt: new Date().toISOString(),
              durationMs: 0, // TODO: track individual write durations
              error: writeResult.error,
              forensicsPath: writeResult.forensicsPath,
            });

            if (!writeResult.success) {
              hadError = true;
              if (onError === 'stop') {
                throw new Error(writeResult.error || 'Write failed');
              }
            }
          } catch (error) {
            hadError = true;
            const message = error instanceof Error ? error.message : String(error);
            writeResults.push({
              templateId: writeStep.targetTemplateId,
              input: item,
              success: false,
              dryRun: writeStep.dryRun ?? false,
              submittedAt: new Date().toISOString(),
              durationMs: 0,
              error: message,
            });
            if (onError === 'stop') {
              throw error;
            }
          }
        }

        const success = !hadError || onError === 'continue';
        const stepResult: PipelineStepResult = {
          stepId: step.id,
          templateId: writeStep.targetTemplateId,
          success,
          output: { results: writeResults, succeeded: writeResults.filter(r => r.success).length, failed: writeResults.filter(r => !r.success).length },
          ...(hadError && onError === 'collect' ? { error: `${writeResults.filter(r => !r.success).length} write(s) failed` } : {}),
          durationMs: Date.now() - stepStartedAt,
        };
        results.push(stepResult);

        if (hadError && onError === 'collect') {
          failedStep = step.id;
          break;
        }

        stepResults[step.id] = { output: writeResults };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ stepId: step.id, templateId: (step as any).templateId || (step as any).targetTemplateId, success: false, error: message, durationMs: Date.now() - stepStartedAt });
      failedStep = step.id;
      break;
    }
  }

  const success = failedStep === undefined;
  const totalDurationMs = Date.now() - startedAt;
  await deps.recordMeasure?.({
    templateId: pipelineId,
    kind: 'pipeline',
    success,
    durationMs: totalDurationMs,
    timestamp: new Date().toISOString(),
    ...(failedStep ? { error: results.at(-1)?.error ?? `Pipeline failed at step "${failedStep}"` } : {}),
  });
  return { pipelineId, success, steps: results, ...(failedStep ? { failedStep } : {}), totalDurationMs };
}

const RegisterPipelineShape = {
  pipelineId: z.string().regex(pipelineIdPattern),
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(PipelineDefSchema.shape.steps.element).min(1),
};

export function registerRegisterPipelineTool(server: McpServer, deps: PipelineDeps): void {
  server.tool('register_pipeline', RegisterPipelineShape, async (input) => {
    try {
      await deps.registerPipeline({ id: input.pipelineId, name: input.name, description: input.description, steps: input.steps });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, pipelineId: input.pipelineId }) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) }], isError: true };
    }
  });
}

export function registerRunPipelineTool(server: McpServer, deps: PipelineDeps): void {
  server.tool('run_pipeline', { pipelineId: z.string().regex(pipelineIdPattern), initialInput: z.record(z.unknown()).optional() }, async (input) => {
    try {
      const result = await runPipeline(input.pipelineId, input.initialInput ?? {}, deps);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], isError: !result.success };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }) }], isError: true };
    }
  });
}

export function registerListPipelinesTool(server: McpServer, deps: PipelineDeps): void {
  server.tool('list_pipelines', {}, async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ pipelines: deps.listPipelineDefs().map((pipeline) => ({ id: pipeline.id, name: pipeline.name, ...(pipeline.description ? { description: pipeline.description } : {}), stepCount: pipeline.steps.length })) }, null, 2) }],
  }));
}
