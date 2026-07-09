import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicWriteFile } from './storage.js';

export interface ProgressState {
  tool: string;
  status: 'idle' | 'running' | 'done' | 'failed';
  current: number;
  total: number;
  message: string;
}

function getProgressPath(): string {
  return path.resolve(process.cwd(), '.mcp-progress.json');
}

export async function reportProgress(update: ProgressState): Promise<void> {
  try {
    await atomicWriteFile(getProgressPath(), JSON.stringify({ ...update, updatedAt: new Date().toISOString() }, null, 2));
  } catch {
    // ponytail: best-effort UI telemetry, must never crash the extraction/download it's reporting on
    // (Windows can EPERM a rename() if the destination is open for read at that instant)
  }
}

function getDashboardStatusPath(): string {
  return path.resolve(process.cwd(), '.mcp-dashboard.json');
}

export async function reportDashboardStatus(port: number): Promise<void> {
  try {
    await atomicWriteFile(getDashboardStatusPath(), JSON.stringify({ port, url: `http://127.0.0.1:${port}` }, null, 2));
  } catch {
    // ponytail: best-effort UI telemetry, same reasoning as reportProgress above
  }
}

export async function getProgress(): Promise<(ProgressState & { updatedAt: string }) | null> {
  try {
    return JSON.parse(await fs.readFile(getProgressPath(), 'utf8'));
  } catch {
    return null;
  }
}
