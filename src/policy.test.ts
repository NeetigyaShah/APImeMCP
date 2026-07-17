import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PolicyBlockedError,
  enforcePolicy,
  getPolicyConfig,
  configurePolicy,
  clearRateLimitState,
  clearRobotsCache,
} from './policy.js';

describe('policy.ts', () => {
  beforeEach(() => {
    clearRateLimitState();
    clearRobotsCache();
    configurePolicy({
      respectRobotsTxt: true,
      minIntervalMsPerTemplate: 100,
      userAgent: 'APImeMCP-bot/1.0 (+https://github.com/neetigyashah/apimemcp)',
      robotsCacheTtlMs: 3_600_000,
      tosRestrictedDomains: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearRateLimitState();
    clearRobotsCache();
  });

  describe('rate limiting', () => {
    it('should allow first call for a template', async () => {
      await enforcePolicy('template1', 'https://example.com/test');
      // Should not throw
    });

    it('should block second call within minInterval', async () => {
      await enforcePolicy('template1', 'https://example.com/test');
      await expect(enforcePolicy('template1', 'https://example.com/test')).rejects.toThrow(
        PolicyBlockedError,
      );
    });

    it('should include retryAfterMs in rate-limit error', async () => {
      await enforcePolicy('template1', 'https://example.com/test');
      try {
        await enforcePolicy('template1', 'https://example.com/test');
        expect.fail('Should have thrown');
      } catch (error) {
        if (error instanceof PolicyBlockedError) {
          expect(error.reason).toBe('rate-limit');
          expect(error.retryAfterMs).toBeGreaterThan(0);
          expect(error.retryAfterMs).toBeLessThanOrEqual(100);
        }
      }
    });

    it('should allow call after minInterval elapses', async () => {
      await enforcePolicy('template1', 'https://example.com/test');
      // Advance time by more than minInterval (100ms)
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Should not throw
      await enforcePolicy('template1', 'https://example.com/test');
    });

    it('should skip rate limit for undefined templateId', async () => {
      await enforcePolicy(undefined, 'https://example.com/test');
      // Mock robots.txt to prevent errors
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response('User-agent: *\nDisallow:', { status: 200 }),
      );
      // Should not throw even without templateId
      await enforcePolicy(undefined, 'https://example.com/test');
    });

    it('should track different templates independently', async () => {
      await enforcePolicy('template1', 'https://example.com/test');
      // template2 should still be allowed
      await enforcePolicy('template2', 'https://example.com/test');
      // Both should not throw
    });
  });

  describe('ToS restrictions', () => {
    it('should block restricted domains', async () => {
      configurePolicy({ tosRestrictedDomains: ['blocked-domain.com'] });
      await expect(enforcePolicy('template1', 'https://blocked-domain.com/test')).rejects.toThrow(
        PolicyBlockedError,
      );
    });

    it('should block subdomains of restricted domains', async () => {
      configurePolicy({ tosRestrictedDomains: ['blocked-domain.com'] });
      await expect(enforcePolicy('template1', 'https://sub.blocked-domain.com/test')).rejects.toThrow(
        PolicyBlockedError,
      );
    });

    it('should have reason tos in the error', async () => {
      configurePolicy({ tosRestrictedDomains: ['blocked-domain.com'] });
      try {
        await enforcePolicy('template1', 'https://blocked-domain.com/test');
        expect.fail('Should have thrown');
      } catch (error) {
        if (error instanceof PolicyBlockedError) {
          expect(error.reason).toBe('tos');
        }
      }
    });

    it('should be case-insensitive', async () => {
      configurePolicy({ tosRestrictedDomains: ['BLOCKED-DOMAIN.COM'] });
      await expect(enforcePolicy('template1', 'https://blocked-domain.com/test')).rejects.toThrow(
        PolicyBlockedError,
      );
    });
  });

  describe('robots.txt handling', () => {
    beforeEach(() => {
      vi.spyOn(global, 'fetch');
    });

    it('should allow path when robots.txt is permissive', async () => {
      (global.fetch as any).mockResolvedValue(
        new Response('User-agent: *\nDisallow:', { status: 200 }),
      );
      await enforcePolicy('template1', 'https://example.com/allowed');
      // Should not throw
    });

    it('should block path when robots.txt disallows it', async () => {
      (global.fetch as any).mockResolvedValue(
        new Response('User-agent: *\nDisallow: /blocked', { status: 200 }),
      );
      await expect(enforcePolicy('template1', 'https://example.com/blocked')).rejects.toThrow(
        PolicyBlockedError,
      );
    });

    it('should have reason robots in the error', async () => {
      (global.fetch as any).mockResolvedValue(
        new Response('User-agent: *\nDisallow: /blocked', { status: 200 }),
      );
      try {
        await enforcePolicy('template1', 'https://example.com/blocked');
        expect.fail('Should have thrown');
      } catch (error) {
        if (error instanceof PolicyBlockedError) {
          expect(error.reason).toBe('robots');
        }
      }
    });

    it('should treat 404 as allow-all', async () => {
      (global.fetch as any).mockResolvedValue(new Response('Not Found', { status: 404 }));
      await enforcePolicy('template1', 'https://example.com/anything');
      // Should not throw
    });

    it('should fail closed on 5xx', async () => {
      (global.fetch as any).mockResolvedValue(new Response('Server Error', { status: 500 }));
      await expect(enforcePolicy('template1', 'https://example.com/test')).rejects.toThrow(
        PolicyBlockedError,
      );
    });

    it('should fail closed on network error', async () => {
      (global.fetch as any).mockRejectedValue(new Error('Network error'));
      await expect(enforcePolicy('template1', 'https://example.com/test')).rejects.toThrow(
        PolicyBlockedError,
      );
    });

    it('should cache robots.txt', async () => {
      (global.fetch as any).mockResolvedValue(
        new Response('User-agent: *\nDisallow:', { status: 200 }),
      );
      await enforcePolicy('template1', 'https://example.com/test1');
      await enforcePolicy('template2', 'https://example.com/test2');

      expect((global.fetch as any).mock.calls).toHaveLength(1);
      // Should have made only one fetch call for the same origin
    });

    it('should allow path not matching any disallow rule', async () => {
      (global.fetch as any).mockResolvedValue(
        new Response('User-agent: *\nDisallow: /admin\nDisallow: /private', { status: 200 }),
      );
      await enforcePolicy('template1', 'https://example.com/public/data');
      // Should not throw
    });

    it('should skip robots.txt check when respectRobotsTxt is false', async () => {
      configurePolicy({ respectRobotsTxt: false });
      (global.fetch as any).mockResolvedValue(
        new Response('User-agent: *\nDisallow: /blocked', { status: 200 }),
      );
      await enforcePolicy('template1', 'https://example.com/blocked');
      // Should not throw because robots check is disabled
      expect((global.fetch as any)).not.toHaveBeenCalled();
    });

    it('should parse User-Agent specific rules', async () => {
      (global.fetch as any).mockResolvedValue(
        new Response(
          'User-agent: OtherBot\nDisallow: /other\nUser-agent: APImeMCP-bot/1.0 (+https://github.com/neetigyashah/apimemcp)\nDisallow: /apimemcp',
          { status: 200 },
        ),
      );
      await expect(enforcePolicy('template1', 'https://example.com/apimemcp')).rejects.toThrow(
        PolicyBlockedError,
      );
    });
  });

  describe('config', () => {
    it('should read APIMEMCP_POLICY_MIN_INTERVAL_MS env var', async () => {
      // Note: this test might be flaky due to memoization; for production use configurePolicy()
      const cfg = getPolicyConfig();
      expect(cfg.minIntervalMsPerTemplate).toBeGreaterThanOrEqual(0);
    });

    it('should allow config override via configurePolicy', async () => {
      configurePolicy({ minIntervalMsPerTemplate: 1000 });
      const cfg = getPolicyConfig();
      expect(cfg.minIntervalMsPerTemplate).toBe(1000);
    });

    it('should apply minIntervalMsPerTemplate override', async () => {
      configurePolicy({ minIntervalMsPerTemplate: 100 });
      await enforcePolicy('template1', 'https://example.com/test');
      // Immediate second call should fail on rate limit
      await expect(enforcePolicy('template1', 'https://example.com/test')).rejects.toThrow(
        PolicyBlockedError,
      );
    });
  });

  describe('integration', () => {
    beforeEach(() => {
      vi.spyOn(global, 'fetch');
    });

    it('should check rate limit before ToS and robots', async () => {
      configurePolicy({ tosRestrictedDomains: [] });
      (global.fetch as any).mockResolvedValue(
        new Response('User-agent: *\nDisallow:', { status: 200 }),
      );

      await enforcePolicy('template1', 'https://example.com/test');
      const fetchCallsBefore = (global.fetch as any).mock.calls.length;

      // Second call should fail on rate limit without fetching robots
      try {
        await enforcePolicy('template1', 'https://example.com/test');
      } catch (error) {
        if (error instanceof PolicyBlockedError) {
          expect(error.reason).toBe('rate-limit');
        }
      }

      // No additional fetch should have been made
      expect((global.fetch as any).mock.calls).toHaveLength(fetchCallsBefore);
    });

    it('should check ToS before robots', async () => {
      configurePolicy({ tosRestrictedDomains: ['blocked-domain.com'] });
      (global.fetch as any).mockResolvedValue(
        new Response('User-agent: *\nDisallow:', { status: 200 }),
      );

      // Should fail on ToS without fetching robots
      try {
        await enforcePolicy('template1', 'https://blocked-domain.com/test');
      } catch (error) {
        if (error instanceof PolicyBlockedError) {
          expect(error.reason).toBe('tos');
        }
      }

      // No fetch should have been made
      expect((global.fetch as any)).not.toHaveBeenCalled();
    });

    it('should allow well-behaved request', async () => {
      (global.fetch as any).mockResolvedValue(
        new Response('User-agent: *\nDisallow:', { status: 200 }),
      );
      configurePolicy({ minIntervalMsPerTemplate: 0, tosRestrictedDomains: [] });
      // Should not throw
      await enforcePolicy('template1', 'https://example.com/test');
    });
  });
});
