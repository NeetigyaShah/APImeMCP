import { listVaultSecrets, setVaultSecret, deleteVaultSecret } from '../vault.js';
import type { VaultEntry } from '../types.js';
import type { DashboardSection, TileSummary } from './types.js';

type VaultListItem = Pick<VaultEntry, 'id' | 'label' | 'createdAt' | 'updatedAt'>;

export function renderVaultPanel(secrets: VaultListItem[]): string {
  const rows = secrets.length
    ? secrets
        .map(
          (s) => `
      <div class="row" data-secret-id="${s.id}">
        <div class="row-main">
          <span class="mono id">${s.id}</span>
          <span class="mono domain">${s.label ?? ''}</span>
          <span class="mono ts dim">${s.updatedAt}</span>
        </div>
        <div class="row-controls" style="margin-top:0.4rem">
          <button class="btn" onclick="deleteVaultSecretFromPanel('${s.id}', this)">Delete</button>
        </div>
      </div>`
        )
        .join('\n')
    : `<div class="empty">No secrets stored.</div>`;
  return `
    <section>
      <h2>Vault</h2>
      <div class="panel">${rows}</div>
      <form class="job-form" id="vault-form" style="margin-top:0.75rem">
        <input type="text" name="id" placeholder="secret id" required />
        <input type="text" name="label" placeholder="label (optional)" />
        <input type="password" name="value" placeholder="value (or JSON for multi-field)" required />
        <button type="submit" class="btn">Store</button>
      </form>
      <div class="form-status" id="vault-form-status"></div>
    </section>
    <script>
      window.init_vault = function () {
        document.getElementById('vault-form').addEventListener('submit', async function (e) {
          e.preventDefault();
          const form = e.target;
          const status = document.getElementById('vault-form-status');
          status.textContent = 'Storing...';
          try {
            const res = await fetch('/api/vault', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: form.id.value.trim(), label: form.label.value.trim() || undefined, value: form.value.value }),
            });
            const data = await res.json();
            if (!res.ok) { status.textContent = 'Error: ' + (data.error || 'could not store'); return; }
            status.textContent = 'Stored ' + data.id;
            selectSection('vault');
          } catch (err) { status.textContent = 'Request failed: ' + err.message; }
        });
      };
      window.deleteVaultSecretFromPanel = async function (id, btn) {
        btn.disabled = true;
        try { await fetch('/api/vault/' + encodeURIComponent(id), { method: 'DELETE' }); selectSection('vault'); }
        finally { btn.disabled = false; }
      };
    </script>`;
}

export const vaultSection: DashboardSection = {
  id: 'vault',
  label: 'Vault',
  registerRoutes(app) {
    app.get('/api/section/vault', async (_req, res) => {
      res.type('html').send(renderVaultPanel(await listVaultSecrets()));
    });
    app.post('/api/vault', async (req, res) => {
      try {
        const body = req.body ?? {};
        const result = await setVaultSecret(String(body.id ?? ''), body.value, body.label ? String(body.label) : undefined);
        res.json(result);
      } catch (err) {
        res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    app.delete('/api/vault/:id', async (req, res) => {
      res.json(await deleteVaultSecret(req.params.id));
    });
  },
  async getTileSummary(): Promise<TileSummary> {
    const count = (await listVaultSecrets()).length;
    return { id: 'vault', label: 'Vault', glance: `${count} secrets`, dotState: 'idle' };
  },
};
