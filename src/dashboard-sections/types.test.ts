import { describe, it, expect } from 'vitest';
import type { TileSummary } from './types.js';

describe('dashboard-sections types', () => {
  it('TileSummary shape accepts the four dot states', () => {
    const states: TileSummary['dotState'][] = ['idle', 'ok', 'alert', 'pulse'];
    for (const dotState of states) {
      const tile: TileSummary = { id: 'x', label: 'X', glance: '0', dotState };
      expect(tile.dotState).toBe(dotState);
    }
  });
});
