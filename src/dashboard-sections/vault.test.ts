import { describe, it, expect } from 'vitest';
import { renderVaultPanel } from './vault.js';

describe('renderVaultPanel', () => {
  it('shows an empty state with no secrets', () => {
    expect(renderVaultPanel([])).toContain('No secrets stored');
  });
  it('lists a secret by id and label, never a value field', () => {
    const html = renderVaultPanel([{ id: 'amazon-login', label: 'Amazon creds', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }]);
    expect(html).toContain('amazon-login');
    expect(html).toContain('Amazon creds');
    expect(html).not.toContain('ciphertext');
    expect(html).not.toContain('authTag');
  });
});
