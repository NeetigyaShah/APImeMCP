import { promises as fs } from 'node:fs';

export type PolicyBlockReason = 'robots' | 'rate-limit' | 'tos';

export class PolicyBlockedError extends Error {
  constructor(
    public reason: PolicyBlockReason,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'PolicyBlockedError';
  }
}

export interface PolicyConfig {
  respectRobotsTxt: boolean;
  minIntervalMsPerTemplate: number;
  userAgent: string;
  robotsCacheTtlMs: number;
  tosRestrictedDomains: string[];
}

const DEFAULT_CONFIG: PolicyConfig = {
  respectRobotsTxt: true,
  minIntervalMsPerTemplate: 3000,
  userAgent: 'APImeMCP-bot/1.0 (+https://github.com/neetigyashah/apimemcp)',
  robotsCacheTtlMs: 3_600_000, // 1 hour
  tosRestrictedDomains: [],
};

let memoizedConfig: PolicyConfig | undefined;

export function getPolicyConfig(): PolicyConfig {
  if (memoizedConfig !== undefined) return memoizedConfig;

  const cfg = { ...DEFAULT_CONFIG };

  const minIntervalEnv = process.env.APIMEMCP_POLICY_MIN_INTERVAL_MS;
  if (minIntervalEnv) {
    const parsed = parseInt(minIntervalEnv, 10);
    if (!isNaN(parsed)) cfg.minIntervalMsPerTemplate = parsed;
  }

  const respectRobotsEnv = process.env.APIMEMCP_POLICY_RESPECT_ROBOTS;
  if (respectRobotsEnv) {
    cfg.respectRobotsTxt = respectRobotsEnv.toLowerCase() !== 'false';
  }

  memoizedConfig = cfg;
  return cfg;
}

export function configurePolicy(overrides: Partial<PolicyConfig>): void {
  memoizedConfig = { ...(memoizedConfig ?? DEFAULT_CONFIG), ...overrides };
}

// ponytail: test-only reset so getPolicyConfig() re-reads env vars between tests.
export function _resetMemoizedConfig(): void {
  memoizedConfig = undefined;
}

// In-memory state for rate limiting and caching
const lastRunAt = new Map<string, number>();
const robotsCache = new Map<string, { disallow: string[]; fetchedAt: number }>();

function checkRateLimit(templateId: string, cfg: PolicyConfig): void {
  if (!templateId) return; // Skip rate limit check for dry-runs or missing ID
  const last = lastRunAt.get(templateId);
  if (last !== undefined) {
    const elapsed = Date.now() - last;
    if (elapsed < cfg.minIntervalMsPerTemplate) {
      const retryAfterMs = cfg.minIntervalMsPerTemplate - elapsed;
      throw new PolicyBlockedError(
        'rate-limit',
        `policy:rate-limit: Template "${templateId}" rate limited. Retry after ${retryAfterMs}ms`,
        retryAfterMs,
      );
    }
  }
}

function isPathDisallowed(pathname: string, disallow: string[]): boolean {
  // Simple prefix matching: a rule "disallow: /x" blocks "/x", "/x/", "/x-y", etc.
  for (const rule of disallow) {
    if (pathname === rule || pathname.startsWith(rule)) {
      return true;
    }
  }
  return false;
}

async function fetchRobotsTxt(
  origin: string,
  cfg: PolicyConfig,
): Promise<{ disallow: string[] }> {
  const cacheEntry = robotsCache.get(origin);
  if (cacheEntry && Date.now() - cacheEntry.fetchedAt < cfg.robotsCacheTtlMs) {
    return cacheEntry;
  }

  const robotsUrl = `${origin}/robots.txt`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    try {
      const response = await fetch(robotsUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': cfg.userAgent },
      });

      clearTimeout(timeoutId);

      if (response.status === 404 || (response.status >= 400 && response.status < 500)) {
        // 404 and 4xx = no restriction, allow all (standard convention)
        const result = { disallow: [], fetchedAt: Date.now() };
        robotsCache.set(origin, result);
        return result;
      }

      if (!response.ok) {
        // 5xx or other error = fail closed
        throw new PolicyBlockedError(
          'robots',
          `policy:robots: Failed to fetch robots.txt from ${origin}: HTTP ${response.status}`,
        );
      }

      const text = await response.text();
      const lines = text.split('\n');
      const disallow: string[] = [];
      let currentUserAgent = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        if (trimmed.toLowerCase().startsWith('user-agent:')) {
          const ua = trimmed.substring('user-agent:'.length).trim();
          // Match either '*' or the exact configured User-Agent
          currentUserAgent = ua === '*' || ua === cfg.userAgent;
          continue;
        }

        if (currentUserAgent && trimmed.toLowerCase().startsWith('disallow:')) {
          const path = trimmed.substring('disallow:'.length).trim();
          if (path) disallow.push(path);
        }
      }

      const result = { disallow, fetchedAt: Date.now() };
      robotsCache.set(origin, result);
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    if (error instanceof PolicyBlockedError) throw error;
    // Network error, timeout, or abort = fail closed
    throw new PolicyBlockedError(
      'robots',
      `policy:robots: Cannot verify robots.txt for ${origin}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function checkRobotsAndTos(url: string, cfg: PolicyConfig): Promise<void> {
  const urlObj = new URL(url);
  const origin = `${urlObj.protocol}//${urlObj.host}`;
  const pathname = urlObj.pathname || '/';

  // Check ToS denylist first (cheap, in-memory)
  const hostname = urlObj.hostname.toLowerCase();
  for (const blockedDomain of cfg.tosRestrictedDomains) {
    if (hostname === blockedDomain.toLowerCase() || hostname.endsWith(`.${blockedDomain.toLowerCase()}`)) {
      throw new PolicyBlockedError(
        'tos',
        `policy:tos: Domain "${hostname}" is restricted by terms of service`,
      );
    }
  }

  // Check robots.txt if enabled
  if (!cfg.respectRobotsTxt) return;

  const robotsTxt = await fetchRobotsTxt(origin, cfg);
  if (isPathDisallowed(pathname, robotsTxt.disallow)) {
    throw new PolicyBlockedError(
      'robots',
      `policy:robots: Path "${pathname}" is disallowed by robots.txt for ${origin}`,
    );
  }
}

export async function enforcePolicy(templateId: string | undefined, url: string): Promise<void> {
  const cfg = getPolicyConfig();

  // Rate limit check first (cheapest, in-memory)
  checkRateLimit(templateId ?? '', cfg);

  // ToS and robots.txt checks
  await checkRobotsAndTos(url, cfg);

  // Record the attempt on success (throttles future attempts regardless of outcome)
  if (templateId) {
    lastRunAt.set(templateId, Date.now());
  }
}

export function clearRateLimitState(): void {
  lastRunAt.clear();
}

export function clearRobotsCache(): void {
  robotsCache.clear();
}
