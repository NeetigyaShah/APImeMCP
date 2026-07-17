import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './storage.js';
import { withLock } from './lock.js';
import { AppConnectionSchema, RegisterExtractionTemplateShape, isHttpUrl } from './types.js';
import type { AppConnection, ConnectAppInput } from './types.js';

export type { AppConnection } from './types.js';

function getConnectionsPath(): string {
  return path.join(path.resolve(process.cwd(), 'templates'), 'app-connections.json');
}

export function getAppProfilePath(connection: AppConnection): string {
  const profilesDir = path.resolve(process.cwd(), 'templates', 'app-profiles');
  const profileDir = path.resolve(process.cwd(), connection.profileDir);
  if (profileDir !== profilesDir && !profileDir.startsWith(`${profilesDir}${path.sep}`)) {
    throw new Error('profileDir must stay within templates/app-profiles');
  }
  return profileDir;
}

export async function resolveProfileDir(connectionId: string): Promise<string> {
  const connection = await getAppConnection(connectionId);
  if (!connection) throw new Error(`No app connection configured for "${connectionId}"`);
  return getAppProfilePath(connection);
}

export const resolveAppProfileDir = resolveProfileDir;

async function loadRaw(): Promise<AppConnection[]> {
  try {
    const raw = await fs.readFile(getConnectionsPath(), 'utf8');
    const parsed = AppConnectionSchema.array().safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
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
    const loginUrl = new URL(input.loginUrl);
    if (loginUrl.username || loginUrl.password) throw new Error('loginUrl must not include credentials');
    loginHostname = loginUrl.hostname.toLowerCase();
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

export async function createConnection(input: ConnectAppInput): Promise<AppConnection> {
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
      status: changedTarget ? 'pending' : (existing?.status ?? 'pending'),
      createdAt: existing?.createdAt ?? now,
      ...(changedTarget ? {} : existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
    };
    const next = connections.filter((item) => item.connectionId !== input.connectionId);
    next.push(connection);
    await saveRaw(next);
    return connection;
  });
}

export const getConnection = getAppConnection;
export const listConnections = listAppConnections;

export const upsertAppConnection = createConnection;

async function updateConnection(
  connectionId: string,
  update: (connection: AppConnection) => AppConnection
): Promise<AppConnection> {
  return withLock(async () => {
    const connections = await listAppConnections();
    const existing = connections.find((connection) => connection.connectionId === connectionId);
    if (!existing) throw new Error(`No app connection configured for "${connectionId}"`);
    const updated = update(existing);
    await saveRaw(connections.map((item) => (item.connectionId === connectionId ? updated : item)));
    return updated;
  });
}

export function updateConnectionStatus(
  connectionId: string,
  status: AppConnection['status']
): Promise<AppConnection> {
  return updateConnection(connectionId, (connection) => ({
    ...connection,
    status,
    ...(status === 'connected' ? { lastUsedAt: new Date().toISOString() } : {}),
  }));
}

export const markAppConnectionOpen = (connectionId: string) => updateConnectionStatus(connectionId, 'pending');
export const confirmAppConnection = (connectionId: string) => updateConnectionStatus(connectionId, 'connected');
export const markAppConnectionError = (connectionId: string, _error: string) => updateConnectionStatus(connectionId, 'error');
