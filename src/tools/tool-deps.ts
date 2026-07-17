import type { ActionTrace, Manifest, Recording, RegisterExtractionTemplateInput, ManifestEntry } from '../types.js';
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
    crystallizeRecording?: (trace: ActionTrace) => string;
    executeExtraction?: (options: import('../engine.js').ExecuteExtractionOptions) => Promise<unknown>;
  };
  extraction: { run: ExtractionRunner };
  templates: {
    register: (input: RegisterExtractionTemplateInput) => Promise<ManifestEntry>;
    loadManifest?: () => Promise<Manifest>;
    findByUrl?: (manifest: Manifest, targetUrl: string) => ManifestEntry | undefined;
  };
  recordings?: {
    save: (recording: Recording) => Promise<void>;
    load: (id: string) => Promise<Recording | null>;
    list: () => Promise<Recording[]>;
  };
  cookies: { save: (templateId: string, cookieString: string) => Promise<void> };
  scheduler: { register: (targetUrl: string, cronExpression: string, templateId?: string) => Promise<ScheduledJob> };
  metrics: { getStats: () => Promise<unknown> };
  notifications: { send: (endpointUrl: string, message: string) => Promise<void> };
  downloads: { batch: (urls: string[], outputDir: string, onProgress: (current: number, total: number) => void) => Promise<Array<{ success: boolean }>> };
  registry: {
    add: (domain: string) => Promise<{ registered: boolean; templateId?: string; error?: string }>;
    submitTemplatePR?: (entry: ManifestEntry, opts: { githubToken: string; executableScript: string; branch?: string }) => Promise<{ prUrl: string }>;
  };
  discovery: import('../discovery.js').DiscoveryDeps;
  progress: { report: (update: { tool: string; status: 'running' | 'done' | 'failed'; current: number; total: number; message: string }) => Promise<void> };
  log: (message: string) => void;
  logError: (message: string) => void;
}
