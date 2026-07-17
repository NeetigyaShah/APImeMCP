import { describe, it, expect } from 'vitest';
import { renderPolicyPanel } from './policy.js';

describe('renderPolicyPanel', () => {
  it('shows rate limit, robots, and restricted domains', () => {
    const html = renderPolicyPanel({
      respectRobotsTxt: true, minIntervalMsPerTemplate: 3000,
      userAgent: 'APImeMCP-bot/1.0', robotsCacheTtlMs: 3600000,
      tosRestrictedDomains: ['blocked.example.com'],
    });
    expect(html).toContain('3000');
    expect(html).toContain('robots.txt: respected');
    expect(html).toContain('blocked.example.com');
  });
  it('shows "none" when no domains are restricted', () => {
    const html = renderPolicyPanel({
      respectRobotsTxt: false, minIntervalMsPerTemplate: 0,
      userAgent: 'x', robotsCacheTtlMs: 0, tosRestrictedDomains: [],
    });
    expect(html).toContain('robots.txt: ignored');
    expect(html).toContain('none');
  });
});
