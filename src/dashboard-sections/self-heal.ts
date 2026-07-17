import { listPendingHeals } from '../self-heal.js';
import type { HealTicket } from '../types.js';
import type { DashboardSection, TileSummary } from './types.js';

export function computeSelfHealDotState(tickets: HealTicket[]): TileSummary['dotState'] {
  return tickets.some((t) => t.status === 'pending') ? 'alert' : 'idle';
}

export function renderSelfHealPanel(tickets: HealTicket[]): string {
  const rows = tickets.length
    ? tickets
        .map(
          (t) => `
      <div class="row" data-ticket-id="${t.id}">
        <div class="row-main">
          <span class="mono id">${t.templateId}</span>
          <span class="mono domain">${t.status}</span>
          <span class="mono ts dim">${t.createdAt}</span>
        </div>
        <div class="row-controls" style="margin-top:0.4rem">
          <a class="btn docs-btn" href="${t.forensics.screenshotPath}" target="_blank">Screenshot</a>
          <a class="btn docs-btn" href="${t.forensics.domSnapshotPath}" target="_blank">DOM</a>
        </div>
      </div>`
        )
        .join('\n')
    : `<div class="empty">No pending heal tickets — nothing has drifted.</div>`;
  return `<section><h2>Self-Heal Queue</h2><div class="panel">${rows}</div></section>`;
}

export const selfHealSection: DashboardSection = {
  id: 'self-heal',
  label: 'Self-Heal',
  registerRoutes(app) {
    app.get('/api/section/self-heal', async (_req, res) => {
      res.type('html').send(renderSelfHealPanel(await listPendingHeals()));
    });
  },
  async getTileSummary(): Promise<TileSummary> {
    const tickets = await listPendingHeals();
    const pending = tickets.filter((t) => t.status === 'pending').length;
    return { id: 'self-heal', label: 'Self-Heal', glance: `${pending} pending`, dotState: computeSelfHealDotState(tickets) };
  },
};
