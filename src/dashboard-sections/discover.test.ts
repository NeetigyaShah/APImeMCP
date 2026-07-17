import { describe, it, expect } from 'vitest';
import { renderDiscoverPanel, renderDiscoverResults } from './discover.js';
import type { DiscoveryHit } from '../discovery.js';

describe('renderDiscoverPanel', () => {
  it('renders a search box with no results yet', () => {
    const html = renderDiscoverPanel();
    expect(html).toContain('discover-query');
  });
});

describe('renderDiscoverResults', () => {
  it('shows an empty state with no hits', () => {
    expect(renderDiscoverResults([])).toContain('No matches');
  });
  it('lists a hit with its score and source', () => {
    const hit: DiscoveryHit = { templateId: 'amazon-price', name: 'amazon-price', source: 'local', score: 3, matchedOn: ['name'] };
    const html = renderDiscoverResults([hit]);
    expect(html).toContain('amazon-price');
    expect(html).toContain('local');
  });
});
