import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findPipelineById,
  listPipelineDefs,
  registerListPipelinesTool,
  registerRegisterPipelineTool,
  registerRunPipelineTool,
  registerPipeline,
  resolveInputMapping,
  runPipeline,
  PipelineMappingError,
} from './pipeline.js';
import type { PipelineDef } from './types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const pipelinesDir = path.resolve(process.cwd(), 'templates', 'pipelines');

const twoStepPipeline: PipelineDef = {
  id: 'listing-flow',
  name: 'Listing flow',
  steps: [
    { id: 'stepA', templateId: 'listing-search' },
    { id: 'stepB', templateId: 'listing-detail', inputMapping: { targetUrl: 'stepA.items.0.url' } },
  ],
};

beforeEach(async () => {
  await fs.rm(pipelinesDir, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(pipelinesDir, { recursive: true, force: true });
});

describe('pipeline storage', () => {
  it('persists, round-trips, and rejects duplicate or invalid definitions', async () => {
    await registerPipeline(twoStepPipeline);
    expect(findPipelineById('listing-flow')).toMatchObject(twoStepPipeline);
    expect(listPipelineDefs()).toHaveLength(1);
    await expect(registerPipeline(twoStepPipeline)).rejects.toThrow('already exists');
    await expect(registerPipeline({ ...twoStepPipeline, id: 'bad', steps: [{ id: 'a', templateId: 'Not Valid' }] })).rejects.toThrow();
  });
});

describe('pipeline runner', () => {
  it('resolves initial and prior-step dot paths', () => {
    expect(resolveInputMapping({ query: '$init.query', targetUrl: 'stepA.items.0.url' }, { query: 'shoes' }, {
      stepA: { output: { items: [{ url: 'https://example.test/item' }] } },
    })).toEqual({ query: 'shoes', targetUrl: 'https://example.test/item' });
  });

  it('chains step output into the next extraction', async () => {
    await registerPipeline(twoStepPipeline);
    const calls: Array<{ targetUrl?: string; templateId?: string }> = [];
    const result = await runPipeline('listing-flow', {}, {
      runExtraction: async (targetUrl, templateId) => {
        calls.push({ targetUrl, templateId });
        return templateId === 'listing-search'
          ? { success: true, data: { items: [{ url: 'https://example.test/item' }] } }
          : { success: true, data: { title: 'Item' } };
      },
      registerPipeline,
      findPipelineById,
      listPipelineDefs,
    });
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(calls[1]).toEqual({ targetUrl: 'https://example.test/item', templateId: 'listing-detail' });
  });

  it('fails fast and records rejected steps', async () => {
    await registerPipeline({ ...twoStepPipeline, id: 'fail-flow', steps: [
      twoStepPipeline.steps[0],
      { id: 'stepB', templateId: 'listing-detail' },
      { id: 'stepC', templateId: 'never-called' },
    ] });
    const result = await runPipeline('fail-flow', {}, {
      runExtraction: async (_targetUrl, templateId) => templateId === 'listing-detail'
        ? Promise.reject(new Error('step failed'))
        : { success: true, data: {} },
      registerPipeline,
      findPipelineById,
      listPipelineDefs,
    });
    expect(result).toMatchObject({ success: false, failedStep: 'stepB' });
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].error).toBe('step failed');
  });

  it('turns an unknown mapping reference into a failed step', async () => {
    await registerPipeline({ ...twoStepPipeline, id: 'bad-map-flow', steps: [
      { id: 'stepA', templateId: 'listing-search', inputMapping: { query: 'missing.value' } },
    ] });
    const result = await runPipeline('bad-map-flow', {}, {
      runExtraction: async () => ({ success: true, data: {} }),
      registerPipeline,
      findPipelineById,
      listPipelineDefs,
    });
    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('stepA');
    expect(result.steps[0].error).toContain('missing');
  });

  it('emits exactly one pipeline measure per run', async () => {
    await registerPipeline(twoStepPipeline);
    const measures: unknown[] = [];
    await runPipeline('listing-flow', {}, {
      runExtraction: async (_targetUrl, templateId) => ({ success: true, data: templateId === 'listing-search' ? { items: [{ url: 'https://example.test/item' }] } : {} }),
      registerPipeline,
      findPipelineById,
      listPipelineDefs,
      recordMeasure: (measure) => { measures.push(measure); },
    });
    expect(measures).toHaveLength(1);
    expect(measures[0]).toMatchObject({ templateId: 'listing-flow', kind: 'pipeline', success: true });
  });

  it('exposes mapping errors as a named error', () => {
    expect(() => resolveInputMapping({ value: 'stepA.missing' }, {}, {})).toThrow(PipelineMappingError);
  });

  it('routes registered tools through injected pipeline collaborators', async () => {
    const calls: string[] = [];
    const handlers: Record<string, (input: any) => Promise<unknown>> = {};
    const server = {
      tool(name: string, _shape: unknown, handler: (input: any) => Promise<unknown>) {
        handlers[name] = handler;
      },
    } as unknown as McpServer;
    const deps = {
      runExtraction: async () => ({ success: true, data: {} }),
      registerPipeline: async () => { calls.push('register'); },
      findPipelineById: () => ({ ...twoStepPipeline }),
      listPipelineDefs: () => [twoStepPipeline],
      recordMeasure: () => { calls.push('measure'); },
    };

    registerRegisterPipelineTool(server, deps);
    registerRunPipelineTool(server, deps);
    registerListPipelinesTool(server, deps);

    await handlers.register_pipeline({ pipelineId: 'injected-flow', name: 'Injected flow', steps: twoStepPipeline.steps });
    await handlers.run_pipeline({ pipelineId: twoStepPipeline.id });
    await handlers.list_pipelines({});

    expect(calls).toEqual(['register', 'measure']);
  });
});

// F09: Bidirectional flows - write step tests
describe('F09 - Write steps in pipelines', () => {
  it('dispatches write steps and applies transforms', async () => {
    const writeStepPipeline: PipelineDef = {
      id: 'bidirectional-flow',
      name: 'Read and write',
      steps: [
        { kind: 'read' as const, id: 'stepA', templateId: 'extract-data' },
        {
          kind: 'write' as const,
          id: 'stepB',
          fromStepId: 'stepA',
          targetTemplateId: 'submit-form',
          transform: { version: 1, ops: [{ op: 'pick' as const, fields: ['name', 'email'] }] },
        },
      ],
    };

    await registerPipeline(writeStepPipeline);

    const writeFlowCalls: any[] = [];
    const mockManifest = {
      'submit-form': {
        templateId: 'submit-form',
        domainPattern: 'example.com',
        scriptPath: 'test.js',
        templateKind: 'write' as const,
        writeScript: 'async (input) => ({ submitted: true })',
        createdAt: '2026-07-17T00:00:00Z',
        updatedAt: '2026-07-17T00:00:00Z',
      },
    };

    const result = await runPipeline('bidirectional-flow', {}, {
      runExtraction: async (_targetUrl, templateId) => ({
        success: true,
        data: templateId === 'extract-data' ? { name: 'John', email: 'john@example.com', _extra: 'dropped' } : undefined,
      }),
      registerPipeline,
      findPipelineById,
      listPipelineDefs,
      executeWriteFlow: async (opts) => {
        writeFlowCalls.push(opts);
        return { success: true, input: opts.input, dryRun: opts.dryRun ?? false };
      },
      loadManifest: async () => mockManifest as any,
      findTemplateById: (manifest: any, id: string) => manifest[id],
    });

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(writeFlowCalls).toHaveLength(1);
    // Transform should have picked only name and email
    expect(writeFlowCalls[0].input).toEqual({ name: 'John', email: 'john@example.com' });
  });

  it('handles dry-run mode for write steps', async () => {
    const dryRunPipeline: PipelineDef = {
      id: 'dryrun-flow',
      name: 'Dry run test',
      steps: [
        { kind: 'read' as const, id: 'stepA', templateId: 'extract' },
        {
          kind: 'write' as const,
          id: 'stepB',
          fromStepId: 'stepA',
          targetTemplateId: 'submit',
          transform: { version: 1, ops: [] },
          dryRun: true,
        },
      ],
    };

    await registerPipeline(dryRunPipeline);

    const writeFlowCalls: any[] = [];
    const mockManifest = {
      submit: {
        templateId: 'submit',
        domainPattern: 'example.com',
        scriptPath: 'test.js',
        templateKind: 'write' as const,
        writeScript: 'async (input) => ({})',
        createdAt: '2026-07-17T00:00:00Z',
        updatedAt: '2026-07-17T00:00:00Z',
      },
    };

    const result = await runPipeline('dryrun-flow', {}, {
      runExtraction: async (url, templateId) => ({ success: true, data: templateId === 'extract' ? { value: 123 } : undefined }),
      registerPipeline,
      findPipelineById,
      listPipelineDefs,
      executeWriteFlow: async (opts) => {
        writeFlowCalls.push(opts);
        return { success: true, input: opts.input, dryRun: opts.dryRun ?? false };
      },
      loadManifest: async () => mockManifest as any,
      findTemplateById: (manifest: any, id: string) => manifest[id],
    });

    expect(result.success).toBe(true);
    expect(writeFlowCalls[0].dryRun).toBe(true);
  });
});
