import { getPolicyConfig } from '../policy.js';
import type { PolicyConfig } from '../policy.js';
import type { DashboardSection, TileSummary } from './types.js';

export function renderPolicyPanel(cfg: PolicyConfig): string {
  return `
    <section>
      <h2>Policy</h2>
      <div class="printout">
        <div><div class="stat-label">Rate limit</div><div class="stat-value">${cfg.minIntervalMsPerTemplate} ms / template</div></div>
        <div><div class="stat-label">Robots.txt</div><div class="stat-value">${cfg.respectRobotsTxt ? 'robots.txt: respected' : 'robots.txt: ignored'}</div></div>
        <div><div class="stat-label">User-Agent</div><div class="stat-value" style="font-size:0.9rem">${cfg.userAgent}</div></div>
        <div class="domains"><div class="stat-label">ToS-restricted domains</div>${cfg.tosRestrictedDomains.length ? cfg.tosRestrictedDomains.join(', ') : 'none'}</div>
      </div>
    </section>`;
}

export const policySection: DashboardSection = {
  id: 'policy',
  label: 'Policy',
  registerRoutes(app) {
    app.get('/api/section/policy', (_req, res) => {
      res.type('html').send(renderPolicyPanel(getPolicyConfig()));
    });
  },
  async getTileSummary(): Promise<TileSummary> {
    const cfg = getPolicyConfig();
    const n = cfg.tosRestrictedDomains.length;
    return { id: 'policy', label: 'Policy', glance: n ? `${n} domains restricted` : 'no restrictions', dotState: 'idle' };
  },
};
