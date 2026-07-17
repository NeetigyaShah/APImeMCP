import { describe, it, expect } from 'vitest';
import { renderSelfHealPanel, computeSelfHealDotState } from './self-heal.js';
import type { HealTicket } from '../types.js';

const ticket: HealTicket = {
  id: 'amazon-price-2026-01-01T00-00-00Z', templateId: 'amazon-price', status: 'pending',
  forensics: {
    templateId: 'amazon-price', capturedAt: '2026-01-01T00:00:00Z', targetUrl: 'https://amazon.com/x',
    domSnapshotPath: '/logs/x-dom.html', screenshotPath: '/logs/x-screenshot.png', consoleErrors: [],
    oldScript: 'old', driftDiff: { templateId: 'amazon-price', timestamp: '2026-01-01T00:00:00Z', hasDrift: true, entries: [] },
  },
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

describe('renderSelfHealPanel', () => {
  it('shows an empty state with no tickets', () => {
    expect(renderSelfHealPanel([])).toContain('No pending heal tickets');
  });
  it('lists a ticket with its status and forensics links', () => {
    const html = renderSelfHealPanel([ticket]);
    expect(html).toContain('amazon-price');
    expect(html).toContain('pending');
    expect(html).toContain('/logs/x-screenshot.png');
  });
});

describe('computeSelfHealDotState', () => {
  it('is idle with no tickets', () => { expect(computeSelfHealDotState([])).toBe('idle'); });
  it('is alert with a pending ticket', () => { expect(computeSelfHealDotState([ticket])).toBe('alert'); });
});
