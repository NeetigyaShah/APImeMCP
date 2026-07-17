import { searchTemplates } from '../discovery.js';
import type { DiscoveryHit, DiscoveryDeps } from '../discovery.js';
import type { DashboardSection, TileSummary } from './types.js';

export function renderDiscoverResults(hits: DiscoveryHit[]): string {
  if (hits.length === 0) return `<div class="empty">No matches.</div>`;
  return hits
    .map(
      (h) => `
    <div class="row">
      <div class="row-main">
        <span class="mono id">${h.templateId}</span>
        <span class="mono domain">${h.source}</span>
        <span class="mono ts dim">score ${h.score}</span>
      </div>
    </div>`
    )
    .join('\n');
}

export function renderDiscoverPanel(): string {
  return `
    <section>
      <h2>Discover</h2>
      <div class="panel" style="padding:0.85rem 1rem">
        <input type="text" class="url-input mono" id="discover-query" placeholder="domain, e.g. amazon.com" />
        <button class="btn" style="margin-top:0.5rem" onclick="runDiscoverSearch()">Search</button>
      </div>
      <div class="panel" id="discover-results" style="margin-top:0.6rem"></div>
    </section>
    <script>
      window.init_discover = function () {};
      window.runDiscoverSearch = async function () {
        const domain = document.getElementById('discover-query').value.trim();
        const results = document.getElementById('discover-results');
        if (!domain) { results.innerHTML = '<div class="empty">Enter a domain first.</div>'; return; }
        results.innerHTML = '<div class="empty">Searching…</div>';
        try {
          const res = await fetch('/api/discover?domain=' + encodeURIComponent(domain));
          results.innerHTML = await res.text();
        } catch (err) {
          results.innerHTML = '<div class="empty">Search failed: ' + err.message + '</div>';
        }
      };
    </script>`;
}

export const discoverSection: DashboardSection = {
  id: 'discover',
  label: 'Discover',
  registerRoutes(app, deps) {
    const discoveryDeps = deps.discovery;
    app.get('/api/section/discover', (_req, res) => {
      res.type('html').send(renderDiscoverPanel());
    });
    app.get('/api/discover', async (req, res) => {
      const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
      if (!domain) {
        res.type('html').send(renderDiscoverResults([]));
        return;
      }
      const result = await searchTemplates({ domain, source: 'both' }, discoveryDeps);
      res.type('html').send(renderDiscoverResults(result.hits));
    });
  },
  async getTileSummary(): Promise<TileSummary> {
    return { id: 'discover', label: 'Discover', glance: 'search', dotState: 'idle' };
  },
};
