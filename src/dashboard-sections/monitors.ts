import type { MonitorSubscription } from '../types.js';
import type { DashboardSection, TileSummary } from './types.js';
import type { DashboardDeps } from '../dashboard.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

export function computeMonitorsDotState(monitors: MonitorSubscription[]): TileSummary['dotState'] {
  const now = Date.now();
  const recentlyChanged = monitors.some((m) => m.lastChange && now - new Date(m.lastChange.at).getTime() < ONE_HOUR_MS);
  if (recentlyChanged) return 'pulse';
  if (monitors.some((m) => m.active)) return 'ok';
  return 'idle';
}

export function renderMonitorsPanel(monitors: MonitorSubscription[]): string {
  const rows = monitors.length
    ? monitors
        .map(
          (m) => `
      <div class="row" data-monitor-id="${m.id}">
        <div class="row-main">
          <span class="mono id">${m.id}</span>
          <span class="mono domain">${m.templateId}</span>
          <span class="mono dim">${m.cronExpression}</span>
          <span class="mono ts dim">${m.lastChange ? m.lastChange.summary + ' @ ' + m.lastChange.at : 'no changes yet'}</span>
        </div>
        <div class="row-controls" style="margin-top:0.4rem">
          <button class="btn" onclick="unsubscribeMonitor('${m.id}', this)">Unsubscribe</button>
        </div>
      </div>`
        )
        .join('\n')
    : `<div class="empty">No monitors active. Subscribe one below.</div>`;

  return `
    <section>
      <h2>Monitors</h2>
      <div class="panel">${rows}</div>
      <form class="job-form" id="monitor-form" style="margin-top:0.75rem">
        <input type="text" name="templateId" placeholder="templateId" required />
        <input type="text" name="cronExpression" placeholder="* * * * * (min hr dom mon dow)" required />
        <input type="text" name="notifyEndpointUrl" placeholder="https://your-webhook.example.com" required />
        <button type="submit" class="btn">Subscribe</button>
      </form>
      <div class="form-status" id="monitor-form-status"></div>
    </section>
    <script>
      window.init_monitors = function () {
        document.getElementById('monitor-form').addEventListener('submit', async function (e) {
          e.preventDefault();
          const form = e.target;
          const status = document.getElementById('monitor-form-status');
          status.textContent = 'Subscribing...';
          try {
            const res = await fetch('/api/monitors', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                templateId: form.templateId.value.trim(),
                cronExpression: form.cronExpression.value.trim(),
                notifyEndpointUrl: form.notifyEndpointUrl.value.trim(),
              }),
            });
            const data = await res.json();
            if (!res.ok) { status.textContent = 'Error: ' + (data.error || 'could not subscribe'); return; }
            status.textContent = 'Subscribed ' + data.id;
            selectSection('monitors');
          } catch (err) { status.textContent = 'Request failed: ' + err.message; }
        });
      };
      window.unsubscribeMonitor = async function (id, btn) {
        btn.disabled = true;
        try { await fetch('/api/monitors/' + encodeURIComponent(id), { method: 'DELETE' }); selectSection('monitors'); }
        finally { btn.disabled = false; }
      };
    </script>`;
}

export const monitorsSection: DashboardSection = {
  id: 'monitors',
  label: 'Monitors',
  registerRoutes(app, deps: DashboardDeps) {
    app.get('/api/section/monitors', (_req, res) => {
      res.type('html').send(renderMonitorsPanel(deps.scheduler.listMonitors()));
    });
    app.post('/api/monitors', async (req, res) => {
      try {
        const body = req.body ?? {};
        const sub = await deps.scheduler.subscribeMonitor({
          templateId: String(body.templateId ?? ''),
          cronExpression: String(body.cronExpression ?? ''),
          notifyEndpointUrl: String(body.notifyEndpointUrl ?? ''),
        });
        res.json(sub);
      } catch (err) {
        res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    app.delete('/api/monitors/:id', async (req, res) => {
      const ok = await deps.scheduler.cancelMonitor(req.params.id);
      res.json({ ok });
    });
  },
  async getTileSummary(deps: DashboardDeps): Promise<TileSummary> {
    const monitors = deps.scheduler.listMonitors();
    const active = monitors.filter((m) => m.active).length;
    return { id: 'monitors', label: 'Monitors', glance: `${active} active`, dotState: computeMonitorsDotState(monitors) };
  },
};
