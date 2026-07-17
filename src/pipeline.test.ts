import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findPipelineById,
  listPipelineDefs,
  registerPipeline,
  resolveInputMapping,
  runPipeline,
  PipelineMappingError,
} from './pipeline.js';
import type { PipelineDef } from './types.js';

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
});
