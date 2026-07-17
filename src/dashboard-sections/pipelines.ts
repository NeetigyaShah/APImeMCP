import { listPipelineDefs, runPipeline } from '../pipeline.js';
import type { PipelineDef, PipelineStep } from '../types.js';
import type { DashboardSection, TileSummary } from './types.js';
import type { DashboardDeps } from '../dashboard.js';

export function renderPipelineChain(steps: PipelineStep[]): string {
  return steps
    .map((step) => {
      if (step.kind === 'write') {
        return `<span class="mono" style="color:var(--err)">${step.targetTemplateId} [write]</span>`;
      }
      return `<span class="mono">${step.templateId}</span>`;
    })
    .join(' &rarr; ');
}

export function renderPipelinesPanel(defs: PipelineDef[]): string {
  if (defs.length === 0) {
    return `<div class="empty">No pipelines registered. Use register_pipeline.</div>`;
  }
  const rows = defs
    .map(
      (def) => `
      <div class="row" data-pipeline-id="${def.id}">
        <div class="row-main">
          <span class="mono id">${def.id}</span>
          <span class="mono domain">${def.name}</span>
        </div>
        <div class="row-controls" style="margin-top:0.4rem">${renderPipelineChain(def.steps)}</div>
        <div class="row-controls" style="margin-top:0.5rem">
          <button class="btn run-btn" onclick="runPipelineFromPanel('${def.id}', this)">Run</button>
        </div>
        <pre class="result mono" id="pipeline-result-${def.id}"></pre>
      </div>`
    )
    .join('\n');
  return `
    <section>
      <h2>Pipelines</h2>
      <div class="panel">${rows}</div>
    </section>
    <script>
      window.init_pipelines = function () {};
      window.runPipelineFromPanel = async function (pipelineId, btn) {
        btn.disabled = true;
        const result = document.getElementById('pipeline-result-' + pipelineId);
        result.textContent = 'Running...';
        try {
          const res = await fetch('/api/pipelines/' + encodeURIComponent(pipelineId) + '/run', { method: 'POST' });
          const data = await res.json();
          result.textContent = JSON.stringify(data, null, 2);
        } catch (err) {
          result.textContent = 'Request failed: ' + err.message;
        } finally {
          btn.disabled = false;
        }
      };
    </script>`;
}

export const pipelinesSection: DashboardSection = {
  id: 'pipelines',
  label: 'Pipelines',
  registerRoutes(app, deps: DashboardDeps) {
    app.get('/api/section/pipelines', (_req, res) => {
      res.type('html').send(renderPipelinesPanel(listPipelineDefs()));
    });
    app.post('/api/pipelines/:pipelineId/run', async (req, res) => {
      try {
        const result = await runPipeline(req.params.pipelineId, req.body ?? {}, deps.pipelineDeps);
        res.json(result);
      } catch (err) {
        res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  },
  async getTileSummary(): Promise<TileSummary> {
    const count = listPipelineDefs().length;
    return { id: 'pipelines', label: 'Pipelines', glance: `${count} registered`, dotState: 'idle' };
  },
};
