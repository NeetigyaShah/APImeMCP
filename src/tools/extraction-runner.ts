import type { ActionSequence, ExtractionResult, Manifest, ManifestEntry, RunKind } from '../types.js';
import type { ExecuteActionSequenceOptions, ExecuteExtractionOptions } from '../engine.js';
import { isStaticHttpEntry } from '../types.js';
import { checkDrift } from '../drift.js';
import type { DriftReport } from '../drift.js';
import { applyTransform } from '../transform.js';
import { withResultCache } from '../result-cache.js';
import { compareSnapshot, saveSnapshot } from '../snapshot.js';
import type { SnapshotComparison, SnapshotMode, GoldenSnapshot } from '../snapshot.js';
import type { ProvenanceReceipt } from '../provenance.js';

export type SnapshotExtractionResult = ExtractionResult & {
  snapshotRecorded?: GoldenSnapshot;
  snapshotCheck?: SnapshotComparison;
};

export interface ExtractionRunnerDeps {
  loadManifest: () => Promise<Manifest>;
  findTemplateById: (manifest: Manifest, templateId: string) => ManifestEntry | undefined;
  findTemplateByUrl: (manifest: Manifest, targetUrl: string) => ManifestEntry | undefined;
  readFile: (path: string, encoding: 'utf8') => Promise<string>;
  resolvePath: (...paths: string[]) => string;
  executeExtraction: (options: ExecuteExtractionOptions) => Promise<unknown>;
  executeActionSequence: (options: ExecuteActionSequenceOptions) => Promise<void>;
  executeStaticHttpExtraction: (entry: ManifestEntry, targetUrl: string, opts?: { cookieString?: string; proxyUrl?: string }) => Promise<unknown>;
  createSuccessfulResult: (data: unknown, meta: ExtractionResult['meta'], outputSchema?: Record<string, unknown>, drift?: DriftReport) => ExtractionResult;
  buildReceipt: (input: { templateId: string; templateSource: string; targetUrl: string; data: unknown; outputSchema?: Record<string, unknown> }) => Promise<ProvenanceReceipt>;
  registryCdnAllowlist: string[];
  getAppConnection: (connectionId: string) => Promise<{ domainPattern: string; status: string } | undefined>;
  saveCookies: (templateId: string, cookieString: string) => Promise<void>;
  getSavedCookies: (templateId: string) => Promise<string | undefined>;
  executeMeasured: <T>(measure: { templateId: string; kind: RunKind }, operation: () => Promise<T>, enrichMeasure?: (result: T) => { driftDetected?: boolean; driftEntryCount?: number; driftEntries?: DriftReport['entries'] } | undefined) => Promise<T>;
  preExecutionMeasure: (templateId?: string, targetUrl?: string) => { templateId: string; kind: RunKind };
  reportProgress: (update: { tool: string; status: 'running' | 'done' | 'failed'; current: number; total: number; message: string }) => Promise<void>;
  logError: (message: string) => void;
}

export function createExtractionRunner(deps: ExtractionRunnerDeps) {
  return async function runExtraction(
    targetUrl?: string,
    templateId?: string,
    proxyUrl?: string,
    cookieString?: string,
    simulateLowBandwidth?: boolean,
    headful?: boolean,
    useSavedCookies?: boolean,
    connectionId?: string,
    executableScript?: string,
    _kind = 'extraction',
    onNetworkRequest?: (url: string) => void,
    snapshotMode: SnapshotMode = 'off',
    // Change-monitoring ticks need a genuinely fresh read every time -- serving a cached
    // result from a prior tick would mask real changes for up to the cache TTL, which
    // defaults to the same 60s as the minimum monitor interval (see F20).
    bypassCache = false,
  ): Promise<SnapshotExtractionResult> {
    const isDryRun = executableScript !== undefined;
    const startedAt = Date.now();
    let measure = deps.preExecutionMeasure(templateId, targetUrl);
    let measurementStarted = false;
    const buildMeta = (id: string, domainMatched: string, resolvedUrl: string) => ({
      url: resolvedUrl,
      templateId: id,
      domainMatched,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });

    if (!isDryRun) {
      await deps.reportProgress({ tool: 'execute_native_extraction', status: 'running', current: 0, total: 1, message: targetUrl ?? templateId ?? '' });
    }

    try {
      if (isDryRun) {
        if (!targetUrl) {
          measurementStarted = true;
          await recordFailedRun(deps, measure, 'targetUrl is required when executableScript is provided');
          return { success: false, error: 'targetUrl is required when executableScript is provided', meta: buildMeta('', '', '') };
        }
        measurementStarted = true;
        const data = await deps.executeMeasured({ templateId: 'no-input', kind: 'extraction' }, () => deps.executeExtraction({
          targetUrl,
          executableScript,
          proxyUrl,
          cookieString,
          simulateLowBandwidth: simulateLowBandwidth ?? true,
          captureForensicsOnError: false,
          onNetworkRequest,
        }));
        return { success: true, data, meta: buildMeta('', '', targetUrl) };
      }
      const manifest = await deps.loadManifest();
      const entry = templateId ? deps.findTemplateById(manifest, templateId) : targetUrl ? deps.findTemplateByUrl(manifest, targetUrl) : undefined;
      if (!entry) {
        const error = templateId ? `No registered template with templateId "${templateId}"` : targetUrl ? `No registered template matches the domain for ${targetUrl}` : 'targetUrl or templateId is required';
        measurementStarted = true;
        await recordFailedRun(deps, measure, error);
        await deps.reportProgress({ tool: 'execute_native_extraction', status: 'failed', current: 0, total: 1, message: error });
        return { success: false, error, meta: buildMeta(templateId ?? '', '', targetUrl ?? '') };
      }

      measure = { templateId: entry.templateId, kind: entry.kind ?? 'extraction' };

      const resolvedUrl = targetUrl ?? entry.fixedTargetUrl;
      if (!resolvedUrl) {
        const error = `Template "${entry.templateId}" has no fixedTargetUrl registered; targetUrl is required`;
        measurementStarted = true;
        await recordFailedRun(deps, measure, error);
        await deps.reportProgress({ tool: 'execute_native_extraction', status: 'failed', current: 0, total: 1, message: error });
        return { success: false, error, meta: buildMeta(entry.templateId, entry.domainPattern, '') };
      }

      if (connectionId) {
        if (cookieString || useSavedCookies) throw new Error('connectionId cannot be combined with cookieString or useSavedCookies');
        const connection = await deps.getAppConnection(connectionId);
        if (!connection) throw new Error(`No app connection configured for "${connectionId}"`);
        if (connection.status !== 'connected') throw new Error(`App connection "${connectionId}" is not connected; log in and call confirm_app_connection first`);
        const targetHostname = new URL(resolvedUrl).hostname.toLowerCase();
        const matchesConnection = targetHostname === connection.domainPattern || targetHostname.endsWith(`.${connection.domainPattern}`);
        if (!matchesConnection) throw new Error(`targetUrl hostname "${targetHostname}" does not match app connection "${connectionId}" (${connection.domainPattern})`);
      }

      if (entry.kind === 'action-sequence') {
        const raw = await deps.readFile(deps.resolvePath(process.cwd(), entry.scriptPath), 'utf8');
        const sequence = JSON.parse(raw) as ActionSequence;
        measurementStarted = true;
        await deps.executeMeasured(measure, () => deps.executeActionSequence({ sequence, proxyUrl, simulateLowBandwidth, headful, connectionId, networkAllowlist: entry.source === 'registry' ? entry.allowedDomains ?? [] : undefined, onNetworkRequest }));
        await deps.reportProgress({ tool: 'execute_native_extraction', status: 'done', current: 1, total: 1, message: resolvedUrl });
        const result = deps.createSuccessfulResult({ completedSteps: sequence.steps.length }, buildMeta(entry.templateId, entry.domainPattern, resolvedUrl), entry.outputSchema);
        result.provenance = await deps.buildReceipt({ templateId: entry.templateId, templateSource: raw, targetUrl: resolvedUrl, data: result.data, outputSchema: entry.outputSchema });
        return applySnapshot(result, entry.templateId, resolvedUrl, entry.outputSchema, snapshotMode);
      }

      if (isStaticHttpEntry(entry)) {
        if (!connectionId && cookieString) await deps.saveCookies(entry.templateId, cookieString);
        const effectiveCookies = connectionId ? undefined : cookieString || (useSavedCookies ? await deps.getSavedCookies(entry.templateId) : undefined);
        const run = async () => {
          measurementStarted = true;
          let drift: DriftReport | undefined;
          const data = await deps.executeMeasured(measure, () => deps.executeStaticHttpExtraction(entry, resolvedUrl, {
            cookieString: effectiveCookies,
            proxyUrl,
          }), (result) => {
            if (!entry.outputSchema) return undefined;
            drift = checkDrift(entry.templateId, entry.outputSchema, result);
            return { driftDetected: drift.hasDrift, driftEntryCount: drift.entries.length, driftEntries: drift.entries };
          });
          await deps.reportProgress({ tool: 'execute_native_extraction', status: 'done', current: 1, total: 1, message: resolvedUrl });
          const transformedData = entry.transform ? applyTransform(data, entry.transform) : data;
          const result = deps.createSuccessfulResult(transformedData, buildMeta(entry.templateId, entry.domainPattern, resolvedUrl), entry.outputSchema, drift);
          return applySnapshot(result, entry.templateId, resolvedUrl, entry.outputSchema, snapshotMode);
        };
        if (snapshotMode !== 'off') return run();
        return await withResultCache(
          { templateId: entry.templateId, targetUrl: resolvedUrl, cookieString: effectiveCookies, proxyUrl },
          run,
        );
      }

      if (!connectionId && cookieString) await deps.saveCookies(entry.templateId, cookieString);
      const effectiveCookies = connectionId ? undefined : cookieString || (useSavedCookies ? await deps.getSavedCookies(entry.templateId) : undefined);
      const run = async () => {
        measurementStarted = true;
        let drift: DriftReport | undefined;
        const templateSource = await deps.readFile(deps.resolvePath(process.cwd(), entry.scriptPath), 'utf8');
        const data = await deps.executeMeasured(measure, () => deps.executeExtraction({
          targetUrl: resolvedUrl,
          executableScript: templateSource,
          proxyUrl,
          cookieString: effectiveCookies,
          connectionId,
          simulateLowBandwidth: simulateLowBandwidth ?? true,
          waitStrategy: entry.waitStrategy,
          readySelector: entry.readySelector,
          networkAllowlist: entry.source === 'registry' ? entry.allowedDomains ?? [] : undefined,
          onNetworkRequest,
          secretInputs: entry.secretInputs,
        }), (result) => {
          if (!entry.outputSchema) return undefined;
          drift = checkDrift(entry.templateId, entry.outputSchema, result);
          return { driftDetected: drift.hasDrift, driftEntryCount: drift.entries.length, driftEntries: drift.entries };
        });
        await deps.reportProgress({ tool: 'execute_native_extraction', status: 'done', current: 1, total: 1, message: resolvedUrl });
        const transformedData = entry.transform ? applyTransform(data, entry.transform) : data;
        const result = deps.createSuccessfulResult(transformedData, buildMeta(entry.templateId, entry.domainPattern, resolvedUrl), entry.outputSchema, drift);
        result.provenance = await deps.buildReceipt({ templateId: entry.templateId, templateSource, targetUrl: resolvedUrl, data: result.data, outputSchema: entry.outputSchema });
        return applySnapshot(result, entry.templateId, resolvedUrl, entry.outputSchema, snapshotMode);
      };
      if (connectionId || snapshotMode !== 'off' || bypassCache) return run();
      return await withResultCache(
        { templateId: entry.templateId, targetUrl: resolvedUrl, cookieString: effectiveCookies, proxyUrl },
        run,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!measurementStarted) {
        measurementStarted = true;
        await recordFailedRun(deps, measure, message);
      }
      deps.logError(`execute_native_extraction failed: ${message}`);
      if (!isDryRun) {
        await deps.reportProgress({ tool: 'execute_native_extraction', status: 'failed', current: 0, total: 1, message });
      }
      return { success: false, error: message, meta: buildMeta(templateId ?? '', '', targetUrl ?? '') };
    }
  };
}

async function applySnapshot(
  result: ExtractionResult,
  templateId: string,
  targetUrl: string,
  outputSchema: Record<string, unknown> | undefined,
  snapshotMode: SnapshotMode,
): Promise<SnapshotExtractionResult> {
  if (snapshotMode === 'record') {
    return { ...result, snapshotRecorded: await saveSnapshot(templateId, result.data, { targetUrl, outputSchema }) };
  }
  if (snapshotMode === 'check') {
    return { ...result, snapshotCheck: await compareSnapshot(templateId, result.data) };
  }
  return result;
}

async function recordFailedRun(
  deps: Pick<ExtractionRunnerDeps, 'executeMeasured'>,
  measure: { templateId: string; kind: RunKind },
  message: string,
): Promise<void> {
  const failure = new Error(message);
  try {
    await deps.executeMeasured(measure, async () => { throw failure; });
  } catch (error) {
    if (error !== failure) throw error;
  }
}
