import cron from 'node-cron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile } from './storage.js';

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

type ExtractionRunner = (targetUrl: string, templateId?: string) => Promise<void>;

export class Scheduler {
  private jobs = new Map<string, ScheduledJob>();
  private tasks = new Map<string, ReturnType<typeof cron.schedule>>();

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
}
