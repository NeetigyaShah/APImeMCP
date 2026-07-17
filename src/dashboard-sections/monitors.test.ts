import { describe, it, expect } from 'vitest';
import { renderMonitorsPanel, computeMonitorsDotState } from './monitors.js';
import type { MonitorSubscription } from '../types.js';

describe('renderMonitorsPanel', () => {
  it('shows an empty state with no monitors', () => {
    expect(renderMonitorsPanel([])).toContain('No monitors');
  });

  it('lists a monitor with its cron and last-changed time', () => {
    const sub: MonitorSubscription = {
      id: 'mon_1', templateId: 'amazon-price', cronExpression: '* * * * *',
      notifyEndpointUrl: 'http://example.com/hook', active: true, createdAt: '2026-01-01T00:00:00Z',
      lastChange: { at: '2026-01-01T00:05:00Z', summary: '1 change(s) detected' },
    };
    const html = renderMonitorsPanel([sub]);
    expect(html).toContain('amazon-price');
    expect(html).toContain('* * * * *');
    expect(html).toContain('1 change(s) detected');
  });
});

describe('computeMonitorsDotState', () => {
  it('is idle with no monitors', () => {
    expect(computeMonitorsDotState([])).toBe('idle');
  });

  it('is pulse when a monitor changed within the last hour', () => {
    const recentIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const sub = { active: true, lastChange: { at: recentIso, summary: 'x' } } as any;
    expect(computeMonitorsDotState([sub])).toBe('pulse');
  });

  it('is ok when active but nothing changed recently', () => {
    const oldIso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const sub = { active: true, lastChange: { at: oldIso, summary: 'x' } } as any;
    expect(computeMonitorsDotState([sub])).toBe('ok');
  });
});
