import { getOtelStatus } from '../otel-adapter.js';
import type { OtelAdapterStatus } from '../otel-adapter.js';
import type { DashboardSection, TileSummary } from './types.js';

export function renderObservabilityPanel(status: OtelAdapterStatus): string {
  if (!status.enabled) {
    return `
      <section>
        <h2>Observability</h2>
        <div class="printout"><div><div class="stat-label">OTel export</div><div class="stat-value">disabled</div></div></div>
      </section>`;
  }
  return `
    <section>
      <h2>Observability</h2>
      <div class="printout">
        <div><div class="stat-label">Exporter</div><div class="stat-value">${status.exporter}</div></div>
        <div><div class="stat-label">Records exported</div><div class="stat-value">${status.recordsExported}</div></div>
        <div><div class="stat-label">Last export</div><div class="stat-value" style="font-size:0.9rem">${status.lastExportAt ? new Date(status.lastExportAt).toLocaleString() : 'never'}</div></div>
        ${status.lastError ? `<div class="domains"><div class="stat-label">Last error</div>${status.lastError}</div>` : ''}
      </div>
    </section>`;
}

export const observabilitySection: DashboardSection = {
  id: 'observability',
  label: 'Observability',
  registerRoutes(app) {
    app.get('/api/section/observability', (_req, res) => {
      res.type('html').send(renderObservabilityPanel(getOtelStatus()));
    });
  },
  async getTileSummary(): Promise<TileSummary> {
    const status = getOtelStatus();
    return { id: 'observability', label: 'Observability', glance: status.enabled ? 'on' : 'off', dotState: status.enabled ? 'ok' : 'idle' };
  },
};
