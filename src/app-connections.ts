import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './storage.js';
import { withLock } from './lock.js';
import { RegisterExtractionTemplateShape, isHttpUrl } from './types.js';
import type { ConnectAppInput } from './types.js';

export type AppConnectionStatus = 'configured' | 'open' | 'confirmed' | 'error';

export interface AppConnection {
  connectionId: string;
  domainPattern: string;
  loginUrl: string;
  profileDir: string;
  autoStart: boolean;
  status: AppConnectionStatus;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  confirmedAt?: string;
  error?: string;
}

function getConnectionsPath(): string {
  return path.join(path.resolve(process.cwd(), 'templates'), 'app-connections.json');
}

export function getAppProfilePath(connection: AppConnection): string {
  return path.resolve(process.cwd(), connection.profileDir);
}

async function loadRaw(): Promise<AppConnection[]> {
  try {
    const raw = await fs.readFile(getConnectionsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AppConnection[]) : [];
  } catch {
    return [];
  }
}

async function saveRaw(connections: AppConnection[]): Promise<void> {
  await atomicWriteFile(getConnectionsPath(), JSON.stringify(connections, null, 2));
}

function validateConnectionInput(input: ConnectAppInput): void {
  if (!RegisterExtractionTemplateShape.templateId.safeParse(input.connectionId).success) {
    throw new Error('connectionId must be lowercase kebab-case alphanumeric');
  }
  if (!isHttpUrl(input.loginUrl)) {
    throw new Error('loginUrl must be an absolute http:// or https:// URL');
  }
  let loginHostname: string;
  try {
    loginHostname = new URL(input.loginUrl).hostname.toLowerCase();
  } catch {
    throw new Error('loginUrl must contain a valid hostname');
  }
  const pattern = input.domainPattern.toLowerCase();
  if (loginHostname !== pattern && !loginHostname.endsWith(`.${pattern}`)) {
    throw new Error(`loginUrl hostname "${loginHostname}" does not match domainPattern "${pattern}"`);
  }
}

export async function ensureAppConnectionsInitialized(): Promise<void> {
  await fs.mkdir(path.dirname(getConnectionsPath()), { recursive: true });
  try {
    await fs.access(getConnectionsPath());
  } catch {
    await saveRaw([]);
  }
}

export async function listAppConnections(): Promise<AppConnection[]> {
  await ensureAppConnectionsInitialized();
  return loadRaw();
}

export async function getAppConnection(connectionId: string): Promise<AppConnection | undefined> {
  const connections = await listAppConnections();
  return connections.find((connection) => connection.connectionId === connectionId);
}

export async function upsertAppConnection(input: ConnectAppInput): Promise<AppConnection> {
  validateConnectionInput(input);
  return withLock(async () => {
    const connections = await listAppConnections();
    const now = new Date().toISOString();
    const existing = connections.find((connection) => connection.connectionId === input.connectionId);
    const changedTarget = existing && (existing.domainPattern !== input.domainPattern || existing.loginUrl !== input.loginUrl);
    const connection: AppConnection = {
      connectionId: input.connectionId,
      domainPattern: input.domainPattern,
      loginUrl: input.loginUrl,
      profileDir: existing?.profileDir ?? path.join('templates', 'app-profiles', input.connectionId),
      autoStart: input.autoStart ?? existing?.autoStart ?? false,
      status: changedTarget ? 'configured' : (existing?.status ?? 'configured'),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(changedTarget ? {} : existing?.lastOpenedAt ? { lastOpenedAt: existing.lastOpenedAt } : {}),
      ...(changedTarget ? {} : existing?.confirmedAt ? { confirmedAt: existing.confirmedAt } : {}),
      ...(changedTarget ? {} : existing?.error ? { error: existing.error } : {}),
    };
    const next = connections.filter((item) => item.connectionId !== input.connectionId);
    next.push(connection);
    await saveRaw(next);
    return connection;
  });
}

async function updateConnection(
  connectionId: string,
  update: (connection: AppConnection) => AppConnection
): Promise<AppConnection> {
  return withLock(async () => {
    const connections = await listAppConnections();
    const existing = connections.find((connection) => connection.connectionId === connectionId);
    if (!existing) throw new Error(`No app connection configured for "${connectionId}"`);
    const updated = update({ ...existing, updatedAt: new Date().toISOString() });
    await saveRaw(connections.map((item) => (item.connectionId === connectionId ? updated : item)));
    return updated;
  });
}

export function markAppConnectionOpen(connectionId: string): Promise<AppConnection> {
  return updateConnection(connectionId, (connection) => ({
    ...connection,
    status: connection.status === 'confirmed' ? 'confirmed' : 'open',
    lastOpenedAt: new Date().toISOString(),
    error: undefined,
  }));
}

export function confirmAppConnection(connectionId: string): Promise<AppConnection> {
  return updateConnection(connectionId, (connection) => ({
    ...connection,
    status: 'confirmed',
    confirmedAt: new Date().toISOString(),
    error: undefined,
  }));
}

export function markAppConnectionError(connectionId: string, error: string): Promise<AppConnection> {
  return updateConnection(connectionId, (connection) => ({ ...connection, status: 'error', error }));
}
