import cron from 'node-cron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import { atomicWriteFile } from './storage.js';
import { withLock } from './lock.js';
import type { MonitorSubscription, ManifestEntry } from './types.js';
import type { DiffResult } from './drift.js';

export interface ScheduledJob {
  jobId: string;
  targetUrl: string;
  templateId?: string;
  cronExpression: string;
  createdAt: string;
}

function getJobsPath(): string {
  return path.join(path.resolve(process.cwd(), 'templates'), 'jobs.json');
}

function getMonitorsPath(): string {
  return path.join(path.resolve(process.cwd(), 'templates'), 'monitors.json');
}

type ExtractionRunner = (targetUrl: string, templateId?: string) => Promise<void>;

export interface MonitorDeps {
  runExtraction: (targetUrl: string | undefined, templateId?: string) => Promise<unknown>;
  diff: (prev: unknown, curr: unknown) => DiffResult;
  notify: (endpointUrl: string, event: any) => Promise<void>;
  loadTemplate: (manifest: any, templateId: string) => ManifestEntry | undefined;
}

export class Scheduler {
  private jobs = new Map<string, ScheduledJob>();
  private tasks = new Map<string, ReturnType<typeof cron.schedule>>();
  private monitors = new Map<string, MonitorSubscription>();
  private monitorTasks = new Map<string, ReturnType<typeof cron.schedule>>();
  private monitorDeps?: MonitorDeps;

  constructor(private runExtraction: ExtractionRunner) {}

  async loadPersisted(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(getJobsPath(), 'utf8');
    } catch {
      return;
    }
    const jobs = JSON.parse(raw) as ScheduledJob[];
    for (const job of jobs) {
      this.start(job);
    }

    // Load monitors
    if (this.monitorDeps) {
      try {
        const monitorRaw = await fs.readFile(getMonitorsPath(), 'utf8');
        const monitors = JSON.parse(monitorRaw) as MonitorSubscription[];
        for (const monitor of monitors) {
          if (monitor.active) {
            this.startMonitor(monitor);
          }
        }
      } catch {
        // monitors.json not yet created
      }
    }
  }

  setMonitorDeps(deps: MonitorDeps): void {
    this.monitorDeps = deps;
  }

  async register(targetUrl: string, cronExpression: string, templateId?: string): Promise<ScheduledJob> {
    if (!cron.validate(cronExpression)) {
      throw new Error(`Invalid cron expression: "${cronExpression}"`);
    }
    const job: ScheduledJob = {
      jobId: randomUUID(),
      targetUrl,
      templateId,
      cronExpression,
      createdAt: new Date().toISOString(),
    };
    this.start(job);
    await this.persist();
    return job;
  }

  private start(job: ScheduledJob): void {
    this.jobs.set(job.jobId, job);
    const task = cron.schedule(job.cronExpression, () => {
      void this.runExtraction(job.targetUrl, job.templateId);
    });
    this.tasks.set(job.jobId, task);
  }

  private async persist(): Promise<void> {
    await atomicWriteFile(getJobsPath(), JSON.stringify(Array.from(this.jobs.values()), null, 2));
  }

  list(): ScheduledJob[] {
    return Array.from(this.jobs.values());
  }

  async subscribeMonitor(input: Omit<MonitorSubscription, 'id' | 'active' | 'createdAt' | 'lastRunAt' | 'lastResultHash' | 'lastResult' | 'lastChange'>): Promise<MonitorSubscription> {
    if (!this.monitorDeps) {
      throw new Error('Monitor support not initialized');
    }
    if (!cron.validate(input.cronExpression)) {
      throw new Error(`Invalid cron expression: "${input.cronExpression}"`);
    }
    const monitor: MonitorSubscription = {
      id: `mon_${randomUUID()}`,
      templateId: input.templateId,
      targetUrl: input.targetUrl,
      inputs: input.inputs,
      cronExpression: input.cronExpression,
      notifyEndpointUrl: input.notifyEndpointUrl,
      active: true,
      createdAt: new Date().toISOString(),
    };
    this.startMonitor(monitor);
    await this.persistMonitors();
    return monitor;
  }

  async cancelMonitor(id: string): Promise<boolean> {
    const monitor = this.monitors.get(id);
    if (!monitor) return false;
    monitor.active = false;
    const task = this.monitorTasks.get(id);
    if (task) {
      task.stop();
      this.monitorTasks.delete(id);
    }
    await this.persistMonitors();
    return true;
  }

  listMonitors(): MonitorSubscription[] {
    return Array.from(this.monitors.values());
  }

  private startMonitor(monitor: MonitorSubscription): void {
    this.monitors.set(monitor.id, monitor);
    const task = cron.schedule(monitor.cronExpression, () => {
      void this.tickMonitor(monitor);
    });
    this.monitorTasks.set(monitor.id, task);
  }

  private async tickMonitor(monitor: MonitorSubscription): Promise<void> {
    if (!this.monitorDeps) return;

    const deps = this.monitorDeps;
    return withLock(`monitor:${monitor.id}`, async () => {
      try {
        const result = await deps.runExtraction(monitor.targetUrl || undefined, monitor.templateId);
        const resultStr = JSON.stringify(result);
        const resultHash = crypto.createHash('sha256').update(resultStr).digest('hex');

        // If no prior hash, this is the first run - record but don't notify
        if (!monitor.lastResultHash) {
          monitor.lastResultHash = resultHash;
          monitor.lastResult = result;
          monitor.lastRunAt = new Date().toISOString();
          await this.persistMonitors();
          return;
        }

        // If hash matches, no change - skip diff and notify
        if (monitor.lastResultHash === resultHash) {
          monitor.lastRunAt = new Date().toISOString();
          await this.persistMonitors();
          return;
        }

        // The hash comparison above already proved the result changed (that's the whole
        // reason we're in this branch). deps.diff (F02's diffJson) only detects
        // schema-shape drift -- field added/removed/type-changed -- never a same-shape
        // scalar value change (price 100 -> 50 produces zero entries by design), so it
        // cannot gate notify here; it only enriches the notification with entries when
        // it has something structural to say.
        const diffResult = deps.diff(monitor.lastResult, result);
        const summary = diffResult.changed ? diffResult.summary : 'result value changed';
        await deps.notify(monitor.notifyEndpointUrl, {
          monitorId: monitor.id,
          templateId: monitor.templateId,
          changed: true,
          summary,
          before: monitor.lastResult,
          after: result,
          at: new Date().toISOString(),
        });
        monitor.lastChange = { at: new Date().toISOString(), summary };

        monitor.lastResultHash = resultHash;
        monitor.lastResult = result;
        monitor.lastRunAt = new Date().toISOString();
        await this.persistMonitors();
      } catch (error) {
        // Log error but don't fail the tick
        console.error(`Monitor tick failed for ${monitor.id}:`, error);
        monitor.lastRunAt = new Date().toISOString();
        await this.persistMonitors();
      }
    });
  }

  private async persistMonitors(): Promise<void> {
    await atomicWriteFile(getMonitorsPath(), JSON.stringify(Array.from(this.monitors.values()), null, 2));
  }
}
