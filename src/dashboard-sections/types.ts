import type { Express } from 'express';
import type { DashboardDeps } from '../dashboard.js';

export interface TileSummary {
  id: string;
  label: string;
  glance: string;
  dotState: 'idle' | 'ok' | 'alert' | 'pulse';
}

export interface DashboardSection {
  id: string;
  label: string;
  registerRoutes(app: Express, deps: DashboardDeps): void;
  getTileSummary(deps: DashboardDeps): Promise<TileSummary>;
}
