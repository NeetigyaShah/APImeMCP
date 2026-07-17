import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export interface DiscoveryQuery {
  domain: string;
  limit?: number;
  source?: 'local' | 'registry' | 'both';
}

export interface DiscoveryCandidate {
  templateId: string;
  name: string;
  description?: string;
  tags?: string[];
  targetUrl?: string;
  source: 'local' | 'registry';
}

export interface DiscoveryHit extends DiscoveryCandidate {
  score: number;
  matchedOn: string[];
}

export interface DiscoveryResult {
  query: string;
  hits: DiscoveryHit[];
}

export interface DiscoveryDeps {
  listLocalTemplates: () => Promise<DiscoveryCandidate[]>;
  listRegistryTemplates: () => Promise<DiscoveryCandidate[]>;
}

const STOP_WORDS = new Set(['and', 'api', 'app', 'can', 'com', 'for', 'from', 'net', 'org', 'the', 'this', 'what', 'with', 'www']);

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function hostname(targetUrl?: string): string | undefined {
  if (!targetUrl) return undefined;

  try {
    return new URL(targetUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

export function scoreCandidate(queryTokens: string[], candidate: DiscoveryCandidate): { score: number; matchedOn: string[] } {
  if (queryTokens.length === 0) return { score: 0, matchedOn: [] };

  const fields = [
    ['name', candidate.name],
    ['description', candidate.description],
    ...(candidate.tags ?? []).map((tag) => ['tag', tag] as const),
  ] as const;
  const matchedOn: string[] = [];
  const matchedTokens = new Set<string>();

  for (const queryToken of queryTokens) {
    for (const [field, value] of fields) {
      if (value && tokenize(value).includes(queryToken)) {
        matchedTokens.add(queryToken);
        matchedOn.push(`${field}:${queryToken}`);
        break;
      }
    }
  }

  let score = matchedTokens.size / queryTokens.length;
  const targetHostname = hostname(candidate.targetUrl);
  if (targetHostname) {
    const matchingHostnameToken = queryTokens.find((token) => targetHostname.includes(token));
    if (matchingHostnameToken) {
      score += 0.3;
      matchedOn.push(`targetUrl-host:${targetHostname}`);
    }
  }

  return { score: Math.min(score, 1), matchedOn };
}

export async function searchTemplates(query: DiscoveryQuery, deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const source = query.source ?? 'both';
  const candidates: DiscoveryCandidate[] = [];

  if (source === 'local' || source === 'both') candidates.push(...await deps.listLocalTemplates());
  if (source === 'registry' || source === 'both') candidates.push(...await deps.listRegistryTemplates());

  const uniqueCandidates = new Map<string, DiscoveryCandidate>();
  for (const candidate of candidates) {
    if (!uniqueCandidates.has(candidate.templateId)) uniqueCandidates.set(candidate.templateId, candidate);
  }

  const queryTokens = tokenize(query.domain);
  const hits = [...uniqueCandidates.values()]
    .map((candidate) => ({ ...candidate, ...scoreCandidate(queryTokens, candidate) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.templateId.localeCompare(right.templateId))
    .slice(0, Math.min(query.limit ?? 10, 50));

  return { query: query.domain, hits };
}

export function registerDiscoverTemplatesTool(server: McpServer, deps: DiscoveryDeps): void {
  server.tool(
    'discover_templates',
    {
      domain: z.string().min(1).describe('natural-language description of the target site or task'),
      limit: z.number().int().positive().max(50).optional().default(10),
      source: z.enum(['local', 'registry', 'both']).optional().default('both'),
    },
    async ({ domain, limit, source }) => {
      const result = await searchTemplates({ domain, limit, source }, deps);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );
}
