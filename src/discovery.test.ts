import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerDiscoverTemplatesTool,
  scoreCandidate,
  searchTemplates,
  tokenize,
} from './discovery.js';
import type { DiscoveryCandidate, DiscoveryDeps } from './discovery.js';

const secFilings: DiscoveryCandidate = {
  templateId: 'sec-filings',
  name: 'SEC filings',
  description: 'SEC EDGAR company filings',
  tags: ['edgar', 'filings'],
  targetUrl: 'https://www.sec.gov/edgar',
  source: 'local',
};

function createDeps(overrides: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
  return {
    listLocalTemplates: async () => [secFilings],
    listRegistryTemplates: async () => [],
    ...overrides,
  };
}

describe('tokenize', () => {
  it('lowercases, strips punctuation, and removes short and stopword tokens', () => {
    expect(tokenize('The SEC, API & filings!')).toEqual(['sec', 'filings']);
  });
});

describe('scoreCandidate', () => {
  it('scores overlapping terms case-insensitively and ignores non-matches', () => {
    const match = scoreCandidate(tokenize('SEC FILINGS'), secFilings);
    const noMatch = scoreCandidate(tokenize('restaurant reservations'), secFilings);

    expect(match.score).toBeGreaterThan(noMatch.score);
    expect(match.matchedOn).toContain('name:sec');
    expect(noMatch).toEqual({ score: 0, matchedOn: [] });
  });

  it('adds a hostname bonus and reports its match', () => {
    const result = scoreCandidate(tokenize('sec reports'), {
      ...secFilings,
      name: 'company reports',
      description: undefined,
      tags: undefined,
    });

    expect(result.score).toBe(0.8);
    expect(result.matchedOn).toContain('targetUrl-host:sec.gov');
  });
});

describe('searchTemplates', () => {
  it('merges, keeps local collisions, sorts descending, and limits results', async () => {
    const result = await searchTemplates(
      { domain: 'sec filings', limit: 1 },
      createDeps({
        listRegistryTemplates: async () => [
          { ...secFilings, name: 'registry duplicate', source: 'registry' },
          {
            templateId: 'sec-reports',
            name: 'SEC reports',
            source: 'registry',
            targetUrl: 'https://sec.gov/reports',
          },
        ],
      }),
    );

    expect(result.query).toBe('sec filings');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ templateId: 'sec-filings', source: 'local' });
  });

  it('does not invoke the unused registry dependency for local searches', async () => {
    const listRegistryTemplates = vi.fn(async () => {
      throw new Error('registry must not be called');
    });

    const result = await searchTemplates({ domain: 'sec filings', source: 'local' }, createDeps({ listRegistryTemplates }));

    expect(result.hits).toHaveLength(1);
    expect(listRegistryTemplates).not.toHaveBeenCalled();
  });

  it('does not invoke the unused local dependency for registry searches', async () => {
    const listLocalTemplates = vi.fn(async () => {
      throw new Error('local storage must not be called');
    });

    const result = await searchTemplates(
      { domain: 'registry filing', source: 'registry' },
      createDeps({
        listLocalTemplates,
        listRegistryTemplates: async () => [{ ...secFilings, name: 'registry filing', source: 'registry' }],
      }),
    );

    expect(result.hits).toHaveLength(1);
    expect(listLocalTemplates).not.toHaveBeenCalled();
  });

  it('returns an empty hit list when nothing matches', async () => {
    await expect(searchTemplates({ domain: 'restaurant reservations' }, createDeps())).resolves.toEqual({
      query: 'restaurant reservations',
      hits: [],
    });
  });
});

describe('registerDiscoverTemplatesTool', () => {
  it('registers a JSON-returning discover_templates handler with validated input', async () => {
    const registrations: Array<{ name: string; shape: Record<string, { safeParse: (value: unknown) => { success: boolean } }>; handler: (input: { domain: string; limit?: number; source?: 'local' | 'registry' | 'both' }) => Promise<{ content: Array<{ text: string }> }> }> = [];
    const server = {
      tool: (name: string, shape: typeof registrations[number]['shape'], handler: typeof registrations[number]['handler']) => {
        registrations.push({ name, shape, handler });
      },
    } as unknown as McpServer;

    registerDiscoverTemplatesTool(server, createDeps());

    expect(registrations[0].name).toBe('discover_templates');
    expect(registrations[0].shape.domain.safeParse('').success).toBe(false);
    const response = await registrations[0].handler({ domain: 'sec filings' });
    expect(JSON.parse(response.content[0].text)).toMatchObject({ query: 'sec filings' });
  });
});
