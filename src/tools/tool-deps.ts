import type { RegisterExtractionTemplateInput, ManifestEntry, MonitorSubscription } from '../types.js';
import type { SnapshotExtractionResult } from './extraction-runner.js';
import type { AppConnection, ConnectAppInput } from '../types.js';
import type { ScheduledJob } from '../scheduler.js';

export type ExtractionRunner = (
  targetUrl?: string,
  templateId?: string,
  proxyUrl?: string,
  cookieString?: string,
  simulateLowBandwidth?: boolean,
  headful?: boolean,
  useSavedCookies?: boolean,
  connectionId?: string,
  executableScript?: string,
  kind?: string,
  onNetworkRequest?: (url: string) => void,
  snapshotMode?: import('../snapshot.js').SnapshotMode,
) => Promise<SnapshotExtractionResult>;

export interface ToolDeps {
  appConnections: {
    upsert: (input: ConnectAppInput) => Promise<AppConnection>;
    list: () => Promise<AppConnection[]>;
  };
  engine: {
    open: (connectionId: string) => Promise<AppConnection>;
    confirm: (connectionId: string) => Promise<AppConnection>;
    renderPage: typeof import('../engine.js').renderPage;
  };
  extraction: { run: ExtractionRunner };
  templates: { register: (input: RegisterExtractionTemplateInput) => Promise<ManifestEntry> };
  cookies: { save: (templateId: string, cookieString: string) => Promise<void> };
  scheduler: {
    register: (targetUrl: string, cronExpression: string, templateId?: string) => Promise<ScheduledJob>;
    subscribeMonitor: (input: Omit<MonitorSubscription, 'id' | 'active' | 'createdAt' | 'lastRunAt' | 'lastResultHash' | 'lastResult' | 'lastChange'>) => Promise<MonitorSubscription>;
    cancelMonitor: (id: string) => Promise<boolean>;
    listMonitors: () => MonitorSubscription[];
  };
  metrics: { getStats: () => Promise<unknown> };
  notifications: { send: (endpointUrl: string, message: string) => Promise<void> };
  downloads: { batch: (urls: string[], outputDir: string, onProgress: (current: number, total: number) => void) => Promise<Array<{ success: boolean }>> };
  registry: { add: (domain: string) => Promise<{ registered: boolean; templateId?: string; error?: string }> };
  discovery: import('../discovery.js').DiscoveryDeps;
  progress: { report: (update: { tool: string; status: 'running' | 'done' | 'failed'; current: number; total: number; message: string }) => Promise<void> };
  log: (message: string) => void;
  logError: (message: string) => void;
}
