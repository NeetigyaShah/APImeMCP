import { describe, it, expect } from 'vitest';
import { renderPipelinesPanel, renderPipelineChain } from './pipelines.js';
import type { PipelineDef } from '../types.js';

describe('renderPipelineChain', () => {
  it('renders read -> write with an arrow and marks write steps', () => {
    const steps: PipelineDef['steps'] = [
      { kind: 'read', id: 'r1', templateId: 'amazon-price' },
      { kind: 'write', id: 'w1', fromStepId: 'r1', targetTemplateId: 'contact-form', transform: { version: 1, ops: [] } },
    ];
    const html = renderPipelineChain(steps);
    expect(html).toContain('amazon-price');
    expect(html).toContain('contact-form');
    expect(html).toContain('&rarr;');
    expect(html).toContain('write');
  });
});

describe('renderPipelinesPanel', () => {
  it('shows an empty state with no pipelines', () => {
    const html = renderPipelinesPanel([]);
    expect(html).toContain('No pipelines registered');
  });

  it('lists a pipeline by id and name', () => {
    const def: PipelineDef = {
      id: 'checkout-flow', name: 'Checkout Flow',
      steps: [{ kind: 'read', id: 'r1', templateId: 'amazon-price' }],
    };
    const html = renderPipelinesPanel([def]);
    expect(html).toContain('checkout-flow');
    expect(html).toContain('Checkout Flow');
  });
});
