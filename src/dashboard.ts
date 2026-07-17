import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { loadManifest, registerActionSequenceTemplate, updateVerificationStatus } from './storage.js';
import { RegisterExtractionTemplateShape, ScheduleStockCheckShape, isHttpUrl } from './types.js';
import type { Manifest, ExtractionResult, ReplayActionStep } from './types.js';
import { getAllSla } from './metrics.js';
import { buildUsageMarkdown, renderDocsPage, getUsagePath } from './usage.js';
import { templatesWithSavedCookies, saveCookies } from './cookie-store.js';
import { getProgress, reportDashboardStatus } from './progress.js';
import type { Scheduler, ScheduledJob } from './scheduler.js';

const DASHBOARD_PORT = 3000;
const LOGS_DIR = path.resolve(process.cwd(), 'output', 'logs');
const APIS_DIR = path.resolve(process.cwd(), 'apis');

export interface DashboardDeps {
  runExtraction: (
    targetUrl: string,
    templateId?: string,
    proxyUrl?: string,
    cookieString?: string,
    simulateLowBandwidth?: boolean,
    headful?: boolean,
    useSavedCookies?: boolean,
    connectionId?: string
  ) => Promise<ExtractionResult>;
  scheduler: Scheduler;
  isBrowserReady: () => boolean;
  log: (message: string) => void;
  logError: (message: string) => void;
}

interface LogEntry {
  prefix: string;
  timestamp: string;
  screenshotUrl: string | null;
  domUrl: string | null;
}

async function listForensicLogs(): Promise<LogEntry[]> {
  let files: string[];
  try {
    files = await fs.readdir(LOGS_DIR);
  } catch {
    return [];
  }
  const byPrefix = new Map<string, LogEntry>();
  for (const file of files) {
    const match = file.match(/^(.+)-(screenshot\.png|dom\.html)$/);
    if (!match) continue;
    const [, prefix, kind] = match;
    const entry = byPrefix.get(prefix) ?? { prefix, timestamp: prefix.slice(0, 19).replace(/-/g, ':'), screenshotUrl: null, domUrl: null };
    if (kind === 'screenshot.png') entry.screenshotUrl = `/logs/${file}`;
    if (kind === 'dom.html') entry.domUrl = `/logs/${file}`;
    byPrefix.set(prefix, entry);
  }
  return Array.from(byPrefix.values()).sort((a, b) => (a.prefix < b.prefix ? 1 : -1));
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `recording-${randomBytes(3).toString('hex')}`;
}

function cookiesToString(cookies: Array<Record<string, unknown>>): string {
  return cookies
    .filter((c) => c && c.name != null && c.value != null)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * The recorder extension already collects session cookies for the domain it just
 * recorded on (see extension/background.js's stopRecording()). Previously those
 * cookies were only ever attached to the new action-sequence template - an
 * already-registered EXTRACTION template on the same domain got no benefit; the
 * user had to separately call save_template_cookies by hand. This bridges the gap:
 * any extraction-kind template whose domainPattern matches the recording's domain
 * (exact host or suffix, same convention as findTemplateByUrl) gets the same cookies
 * saved automatically. Deliberately does NOT reuse findTemplateByUrl's single-"best"-
 * match logic - that picks one entry via a longest-pattern/most-recent tiebreak, and
 * the action-sequence template just registered would usually win that tiebreak (it's
 * the freshest). This bridges to every matching extraction template (there can be
 * more than one per domain - N:1 is a supported pattern), not just one.
 */
async function bridgeCookiesToExtractionTemplates(
  startUrl: string,
  cookies: Array<Record<string, unknown>>
): Promise<string[]> {
  const cookieString = cookiesToString(cookies);
  if (!cookieString) return [];
  let hostname: string;
  try {
    hostname = new URL(startUrl).hostname.toLowerCase();
  } catch {
    return [];
  }
  const manifest = await loadManifest();
  const bridgedTo: string[] = [];
  for (const entry of Object.values(manifest)) {
    if (entry.kind === 'action-sequence') continue;
    const pattern = entry.domainPattern;
    if (hostname !== pattern && !hostname.endsWith(`.${pattern}`)) continue;
    await saveCookies(entry.templateId, cookieString);
    bridgedTo.push(entry.templateId);
  }
  return bridgedTo;
}

function cronColumns(expr: string): string[] {
  const parts = expr.trim().split(/\s+/);
  while (parts.length < 5) parts.push('*');
  return parts.slice(0, 5);
}

function renderDashboard(manifest: Manifest, browserReady: boolean, cookieSet: Set<string>): string {
  const templates = Object.values(manifest);

  const templateRows = templates
    .map(
      (entry) => `
      <div class="row" data-template-id="${entry.templateId}" ${entry.fixedTargetUrl ? 'data-fixed-target="1"' : ''}>
        <div class="row-main">
          <span class="mono id">${entry.templateId}</span>
          ${entry.fixedTargetUrl ? `<span class="mono fixed-badge" title="${entry.fixedTargetUrl}">&#9733; no input needed</span>` : ''}
          ${entry.kind === 'action-sequence' ? '<span class="mono kind-badge" title="Action-sequence template">&#9881; action-sequence</span>' : ''}
          ${cookieSet.has(entry.templateId) ? '<span class="mono cookie-badge" title="Session cookies saved for this template">&#128273; cookies saved</span>' : ''}
          ${entry.lastVerified ? `<span class="dot ${entry.lastVerified.success ? 'on' : 'off'}" title="${entry.lastVerified.success ? 'Last verified OK' : (entry.lastVerified.error ?? 'Last verification failed')}"></span>` : ''}
          <span class="mono domain">${entry.domainPattern}</span>
          <span class="mono ts dim">${entry.updatedAt}</span>
        </div>
        <div class="row-controls">
          ${
            entry.fixedTargetUrl
              ? `<span class="mono fixed-url dim">${entry.fixedTargetUrl}</span>`
              : '<input type="text" class="url-input mono" placeholder="https://example.com/page" />'
          }
          <button class="btn run-btn" onclick="runTemplate('${entry.templateId}', this)">Run</button>
          ${
            entry.kind === 'action-sequence'
              ? `<button class="btn watch-btn" onclick="runTemplate('${entry.templateId}', this, true)" title="Run in a visible browser window so you can watch it">&#128065; Watch</button>`
              : ''
          }
          ${
            cookieSet.has(entry.templateId)
              ? `<button class="btn cookie-btn" onclick="runTemplate('${entry.templateId}', this, false, true)" title="Run using the session cookies saved for this template">&#128273; Use saved cookies</button>`
              : ''
          }
          <a class="btn docs-btn" href="/docs/${entry.templateId}" target="_blank" title="How to run this API from the console, without the dashboard">&#128214; Docs</a>
        </div>
        <div class="row-qa">
          <input type="text" class="proxy-input mono" placeholder="QA Proxy URL (e.g., http://user:pass@ip:port)" />
          <div class="cookie-container">
            <input type="password" class="cookie-input mono" placeholder="QA Auth Cookie (name=val; ...)" />
            <span class="info-btn" onclick="toggleInfo(this)" title="How to get this?">&#9432;</span>
            <div class="cookie-instructions">
              <strong>How to get a session cookie for your own test account:</strong><br/>
              Only for an account and domain <em>you</em> control (localhost / staging) &mdash;
              never a session you don't own.<br/>
              1. Log into your own account on that domain.<br/>
              2. Press <strong>F12</strong> to open Developer Tools.<br/>
              3. Go to the <strong>Application</strong> tab (Chrome) or <strong>Storage</strong> tab (Firefox).<br/>
              4. Expand <strong>Cookies</strong> on the left and select the domain.<br/>
              5. Copy the session cookie(s) and format them here as: <code>name=value; name2=value2</code>
            </div>
          </div>
          <label class="bandwidth-label mono"><input type="checkbox" class="bandwidth-cb" /> Simulate low bandwidth (block media/CSS)</label>
        </div>
        <pre class="result mono"></pre>
      </div>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>APImeMCP</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --void: #14100a;
    --panel: #1e1811;
    --panel-2: #241d14;
    --line: #3a2f1f;
    --phosphor: #ffb627;
    --phosphor-dim: #8a5a1e;
    --ok: #7fd858;
    --err: #ff5f56;
    --paper: #f0e6d2;
    --ink: #2a2015;
    --text: #d8c9a8;
    --text-dim: #7a6a4e;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--void);
    color: var(--text);
    font-family: 'IBM Plex Sans', sans-serif;
    min-height: 100vh;
  }
  .mono { font-family: 'IBM Plex Mono', monospace; }
  .dim { color: var(--text-dim); }
  a { color: var(--phosphor); }

  .chrome {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 1rem;
    background: var(--panel-2);
    border-bottom: 1px solid var(--line);
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--text-dim); flex-shrink: 0; }
  .dot.on { background: var(--ok); }
  .dot.off { background: var(--err); }
  .chrome-title { font-family: 'IBM Plex Mono', monospace; font-size: 0.85rem; color: var(--text-dim); margin-left: 0.5rem; }
  .chrome-title b { color: var(--phosphor); font-weight: 600; }

  main {
    max-width: 1080px;
    margin: 0 auto;
    padding: 1.5rem 1rem 4rem;
    display: grid;
    gap: 1.75rem;
  }
  section h2 {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.75rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--phosphor-dim);
    margin: 0 0 0.6rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--line);
  }

  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 3px; }

  /* templates ledger */
  .row { padding: 0.75rem 1rem; border-bottom: 1px solid var(--line); }
  .row:last-child { border-bottom: none; }
  .row-main { display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; }
  .id { color: var(--phosphor); font-weight: 600; }
  .domain { color: var(--text); }
  .fixed-badge { color: var(--ok); font-size: 0.75rem; }
  .kind-badge { color: var(--text-dim); font-size: 0.75rem; }
  .cookie-badge { color: var(--ok); font-size: 0.75rem; }
  .fixed-url { flex: 1; font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ts { font-size: 0.75rem; margin-left: auto; }
  .row-controls { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .url-input {
    flex: 1; min-width: 0; padding: 0.45rem 0.6rem; background: var(--void);
    border: 1px solid var(--line); border-radius: 2px; color: var(--text); font-size: 0.85rem;
  }
  .url-input:focus-visible { outline: 2px solid var(--phosphor); outline-offset: 1px; }
  .row-qa { display: flex; gap: 0.5rem; margin-top: 0.4rem; flex-wrap: wrap; align-items: center; }
  .proxy-input, .cookie-input {
    flex: 1; min-width: 160px; padding: 0.4rem 0.6rem; background: var(--void);
    border: 1px solid var(--line); border-radius: 2px; color: var(--text-dim); font-size: 0.78rem;
  }
  .proxy-input:focus-visible, .cookie-input:focus-visible { outline: 2px solid var(--phosphor); outline-offset: 1px; }
  .bandwidth-label { display: flex; align-items: center; gap: 0.35rem; font-size: 0.75rem; color: var(--text-dim); white-space: nowrap; }
  .cookie-container { position: relative; flex: 1; min-width: 160px; }
  .cookie-container .cookie-input { width: 100%; padding-right: 1.8rem; }
  .info-btn {
    position: absolute; right: 0.5rem; top: 50%; transform: translateY(-50%);
    color: var(--text-dim); cursor: pointer; font-size: 0.9rem; line-height: 1;
    user-select: none; transition: color 0.15s ease;
  }
  .info-btn:hover { color: var(--phosphor); }
  .cookie-instructions {
    display: none; margin-top: 0.4rem; padding: 0.6rem 0.7rem; background: var(--void);
    border: 1px solid var(--line); border-radius: 2px; font-size: 0.72rem; line-height: 1.5;
    color: #94a3b8; font-family: 'IBM Plex Sans', sans-serif;
  }
  .cookie-instructions code {
    font-family: 'IBM Plex Mono', monospace; background: var(--panel-2); padding: 0.05rem 0.3rem;
    border-radius: 2px; color: var(--text);
  }
  .btn {
    background: transparent; border: 1px solid var(--phosphor-dim); color: var(--phosphor);
    padding: 0.45rem 1rem; border-radius: 2px; cursor: pointer; font-family: 'IBM Plex Mono', monospace;
    font-size: 0.8rem; font-weight: 600;
  }
  .btn:hover { background: var(--phosphor); color: var(--ink); }
  .btn:disabled { opacity: 0.4; cursor: default; background: none; color: var(--phosphor); }
  .btn:focus-visible { outline: 2px solid var(--phosphor); outline-offset: 2px; }
  .watch-btn { border-color: var(--ok); color: var(--ok); flex-shrink: 0; }
  .watch-btn:hover:not(:disabled) { background: var(--ok); color: var(--ink); }
  .watch-btn:disabled { color: var(--ok); }
  .cookie-btn { border-color: var(--ok); color: var(--ok); flex-shrink: 0; }
  .cookie-btn:hover:not(:disabled) { background: var(--ok); color: var(--ink); }
  .docs-btn { text-decoration: none; flex-shrink: 0; display: inline-flex; align-items: center; }
  .docs-btn:hover { background: var(--phosphor); color: var(--ink); }
  .result:empty { display: none; }
  .result {
    margin: 0.6rem 0 0; padding: 0.6rem; background: var(--void); border-radius: 2px;
    font-size: 0.75rem; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-all;
    color: var(--text-dim);
  }
  .empty { padding: 1rem; color: var(--text-dim); font-size: 0.85rem; }

  /* activity ticker */
  #ticker {
    font-family: 'IBM Plex Mono', monospace; font-size: 0.78rem; padding: 0.75rem 1rem;
    max-height: 220px; overflow-y: auto; display: flex; flex-direction: column-reverse;
  }
  .tick { padding: 0.15rem 0; border-bottom: 1px dotted var(--line); display: flex; gap: 0.6rem; }
  .tick .ts { margin-left: 0; flex-shrink: 0; }
  .tick.running .status { color: var(--phosphor); }
  .tick.done .status { color: var(--ok); }
  .tick.failed .status { color: var(--err); }
  .cursor { display: inline-block; width: 7px; background: var(--phosphor); animation: blink 1s step-end infinite; }
  @media (prefers-reduced-motion: reduce) { .cursor { animation: none; opacity: 1; } }
  @keyframes blink { 50% { opacity: 0; } }

  /* stats - printout panel */
  .printout {
    background: var(--paper); color: var(--ink); border-radius: 3px; padding: 1rem 1.25rem;
    font-family: 'IBM Plex Mono', monospace; display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem;
  }
  .printout .stat-label { font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.6; }
  .printout .stat-value { font-size: 1.4rem; font-weight: 600; }
  .printout .domains { grid-column: 1 / -1; font-size: 0.8rem; opacity: 0.8; word-break: break-all; }

  /* crontab table */
  table.crontab { width: 100%; border-collapse: collapse; font-family: 'IBM Plex Mono', monospace; font-size: 0.8rem; }
  table.crontab th { text-align: left; color: var(--phosphor-dim); font-weight: 600; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--line); font-size: 0.7rem; letter-spacing: 0.06em; }
  table.crontab td { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--line); }
  table.crontab tr:last-child td { border-bottom: none; }
  .cron-field { color: var(--phosphor); }

  form.job-form { display: flex; flex-wrap: wrap; gap: 0.5rem; padding: 0.85rem 1rem; border-top: 1px solid var(--line); }
  form.job-form input { flex: 1; min-width: 140px; }
  form.job-form input, form.job-form select { padding: 0.45rem 0.6rem; background: var(--void); border: 1px solid var(--line); border-radius: 2px; color: var(--text); font-size: 0.8rem; font-family: 'IBM Plex Mono', monospace; }
  .form-status { font-family: 'IBM Plex Mono', monospace; font-size: 0.75rem; padding: 0 1rem 0.75rem; color: var(--text-dim); }

  /* logs list */
  .log-item { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 1rem; border-bottom: 1px solid var(--line); font-size: 0.82rem; }
  .log-item:last-child { border-bottom: none; }
  .log-item a { text-decoration: none; }
  .log-item a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="chrome">
  <span class="dot on" title="MCP connection"></span>
  <span class="dot ${browserReady ? 'on' : 'off'}" title="Browser"></span>
  <span class="dot on" title="Dashboard"></span>
  <span class="chrome-title"><b>APImeMCP</b> — compiler pattern extraction control</span>
</div>

<main>
  <section>
    <h2>Templates</h2>
    <div class="panel" id="templates-panel">
      ${templateRows || '<div class="empty">No templates registered yet. Use register_extraction_template.</div>'}
    </div>
  </section>

  <section>
    <h2>Activity</h2>
    <div class="panel" id="ticker"></div>
  </section>

  <section>
    <h2>Extraction stats</h2>
    <div class="printout" id="stats">
      <table class="crontab">
        <thead><tr><th>template</th><th>runs</th><th>success rate</th><th>p95 latency</th><th>drift</th><th>last run</th></tr></thead>
        <tbody><tr><td colspan="6" class="empty">No extraction measures yet.</td></tr></tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Scheduled jobs</h2>
    <div class="panel">
      <table class="crontab">
        <thead>
          <tr><th>min</th><th>hr</th><th>dom</th><th>mon</th><th>dow</th><th>target</th><th>template</th></tr>
        </thead>
        <tbody id="jobs-body"><tr><td colspan="7" class="empty">Loading…</td></tr></tbody>
      </table>
      <form class="job-form" id="job-form">
        <input type="text" name="targetUrl" placeholder="https://example.com/page" required />
        <input type="text" name="templateId" placeholder="templateId (optional)" />
        <input type="text" name="cronExpression" placeholder="0 * * * * (min hr dom mon dow)" required />
        <button type="submit" class="btn">Schedule</button>
      </form>
      <div class="form-status" id="job-form-status"></div>
    </div>
  </section>

  <section>
    <h2>Forensic captures</h2>
    <div class="panel" id="logs-body">
      <div class="empty">Loading…</div>
    </div>
  </section>
</main>

<script>
function toggleInfo(btn) {
  const panel = btn.closest('.cookie-container').querySelector('.cookie-instructions');
  panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
}

async function runTemplate(templateId, btn, headful, useSavedCookies) {
  const row = btn.closest('.row');
  const isFixedTarget = row.dataset.fixedTarget === '1';
  const urlInput = row.querySelector('.url-input');
  const url = isFixedTarget ? '' : urlInput.value.trim();
  const proxyUrl = row.querySelector('.proxy-input').value.trim();
  const cookieString = row.querySelector('.cookie-input').value.trim();
  const simulateLowBandwidth = row.querySelector('.bandwidth-cb').checked;
  const result = row.querySelector('.result');
  const btns = row.querySelectorAll('.run-btn, .watch-btn, .cookie-btn');
  if (!isFixedTarget && !url) { result.textContent = 'Enter a URL first'; return; }
  btns.forEach((b) => (b.disabled = true));
  result.textContent = headful ? 'Running - watch the browser window that opens...'
    : useSavedCookies ? 'Running with your saved cookies...' : 'Running...';
  try {
    const res = await fetch('/api/run/' + encodeURIComponent(templateId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, proxyUrl, cookieString, simulateLowBandwidth, headful: !!headful, useSavedCookies: !!useSavedCookies }),
    });
    const data = await res.json();
    result.textContent = JSON.stringify(data, null, 2);
    // A run may have just saved new cookies (or used them) - refresh so the badge/button appear.
    if (cookieString) loadTemplates();
  } catch (err) {
    result.textContent = 'Request failed: ' + err.message;
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

let lastTick = null;
async function pollProgress() {
  try {
    const res = await fetch('/api/progress');
    const state = await res.json();
    if (!state || state.status === 'idle') return;
    const key = state.tool + '|' + state.status + '|' + state.current + '|' + state.total + '|' + state.message;
    if (key === lastTick) return;
    lastTick = key;
    const ticker = document.getElementById('ticker');
    const line = document.createElement('div');
    line.className = 'tick ' + state.status;
    const pct = state.total > 0 ? Math.round((state.current / state.total) * 100) : 0;
    const label = state.status === 'running' ? pct + '% (' + state.current + '/' + state.total + ')' : state.status;
    line.innerHTML = '<span class="ts dim">' + new Date(state.updatedAt).toLocaleTimeString() + '</span>' +
      '<span class="status">' + state.tool + '</span><span>' + label + '</span>' +
      '<span class="dim">' + (state.message || '') + '</span>';
    ticker.prepend(line);
    while (ticker.children.length > 40) ticker.removeChild(ticker.lastChild);
  } catch {
    // dashboard poll failures are non-fatal, just skip this tick
  }
}

async function pollStats() {
  try {
    const res = await fetch('/api/stats');
    const payload = await res.json();
    const body = document.querySelector('#stats tbody');
    if (!payload.templates.length) return;
    body.innerHTML = payload.templates.map(function (sla) {
      return '<tr data-template-id="' + sla.templateId + '"><td>' + sla.templateId + '</td><td>' + sla.runs + '</td><td>' +
        Math.round(sla.successRate * 100) + '%</td><td>' + Math.round(sla.p95DurationMs) +
        ' ms</td><td data-drift-count="' + sla.driftCount + '">' + sla.driftCount + (sla.lastDriftAt ? ' (last ' + new Date(sla.lastDriftAt).toLocaleString() + ')' : '') +
        (sla.driftEntries?.length ? '<br><span class="dim">' + sla.driftEntries.map(function (entry) { return entry.kind + ':' + entry.path; }).join(', ') + '</span>' : '') +
        '</td><td>' + new Date(sla.lastRunAt).toLocaleString() + '</td></tr>';
    }).join('');
  } catch {
    // non-fatal
  }
}

async function loadJobs() {
  const body = document.getElementById('jobs-body');
  try {
    const res = await fetch('/api/jobs');
    const jobs = await res.json();
    if (!jobs.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty">No scheduled jobs yet.</td></tr>';
      return;
    }
    body.innerHTML = jobs.map(function (j) {
      var parts = j.cronExpression.trim().split(/\\s+/);
      while (parts.length < 5) parts.push('*');
      return '<tr>' + parts.slice(0, 5).map(function (p) { return '<td class="cron-field">' + p + '</td>'; }).join('') +
        '<td>' + j.targetUrl + '</td><td>' + (j.templateId || '<span class="dim">auto</span>') + '</td></tr>';
    }).join('');
  } catch {
    body.innerHTML = '<tr><td colspan="7" class="empty">Could not load jobs.</td></tr>';
  }
}

document.getElementById('job-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  const form = e.target;
  const status = document.getElementById('job-form-status');
  const payload = {
    targetUrl: form.targetUrl.value.trim(),
    cronExpression: form.cronExpression.value.trim(),
    templateId: form.templateId.value.trim() || undefined,
  };
  status.textContent = 'Scheduling...';
  try {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      status.textContent = 'Error: ' + (data.error || 'could not schedule job');
      return;
    }
    status.textContent = 'Scheduled ' + data.jobId;
    form.reset();
    loadJobs();
  } catch (err) {
    status.textContent = 'Request failed: ' + err.message;
  }
});

async function loadLogs() {
  const el = document.getElementById('logs-body');
  try {
    const res = await fetch('/api/logs');
    const logs = await res.json();
    if (!logs.length) {
      el.innerHTML = '<div class="empty">No failures captured yet — that\\'s a good sign.</div>';
      return;
    }
    el.innerHTML = logs.map(function (l) {
      return '<div class="log-item"><span class="mono dim">' + l.prefix + '</span>' +
        (l.screenshotUrl ? '<a href="' + l.screenshotUrl + '" target="_blank">screenshot</a>' : '') +
        (l.domUrl ? '<a href="' + l.domUrl + '" target="_blank">dom</a>' : '') + '</div>';
    }).join('');
  } catch {
    el.innerHTML = '<div class="empty">Could not load logs.</div>';
  }
}

let knownTemplateIds = ${JSON.stringify(templates.map((t) => t.templateId).sort())};

function templateRowHtml(entry) {
  const fixed = !!entry.fixedTargetUrl;
  return '<div class="row" data-template-id="' + entry.templateId + '"' + (fixed ? ' data-fixed-target="1"' : '') + '>' +
    '<div class="row-main">' +
      '<span class="mono id">' + entry.templateId + '</span>' +
      (fixed ? '<span class="mono fixed-badge" title="' + entry.fixedTargetUrl + '">&#9733; no input needed</span>' : '') +
      (entry.kind === 'action-sequence' ? '<span class="mono kind-badge" title="Action-sequence template">&#9881; action-sequence</span>' : '') +
      (entry.hasSavedCookies ? '<span class="mono cookie-badge" title="Session cookies saved for this template">&#128273; cookies saved</span>' : '') +
      (entry.lastVerified ? '<span class="dot ' + (entry.lastVerified.success ? 'on' : 'off') + '" title="' + (entry.lastVerified.success ? 'Last verified OK' : (entry.lastVerified.error || 'Last verification failed')) + '"></span>' : '') +
      '<span class="mono domain">' + entry.domainPattern + '</span>' +
      '<span class="mono ts dim">' + entry.updatedAt + '</span>' +
    '</div>' +
    '<div class="row-controls">' +
      (fixed
        ? '<span class="mono fixed-url dim">' + entry.fixedTargetUrl + '</span>'
        : '<input type="text" class="url-input mono" placeholder="https://example.com/page" />') +
      '<button class="btn run-btn" onclick="runTemplate(\\'' + entry.templateId + '\\', this)">Run</button>' +
      (entry.kind === 'action-sequence'
        ? '<button class="btn watch-btn" onclick="runTemplate(\\'' + entry.templateId + '\\', this, true)" title="Run in a visible browser window so you can watch it">&#128065; Watch</button>'
        : '') +
      (entry.hasSavedCookies
        ? '<button class="btn cookie-btn" onclick="runTemplate(\\'' + entry.templateId + '\\', this, false, true)" title="Run using the session cookies saved for this template">&#128273; Use saved cookies</button>'
        : '') +
      '<a class="btn docs-btn" href="/docs/' + entry.templateId + '" target="_blank" title="How to run this API from the console, without the dashboard">&#128214; Docs</a>' +
    '</div>' +
    '<div class="row-qa">' +
      '<input type="text" class="proxy-input mono" placeholder="QA Proxy URL (e.g., http://user:pass@ip:port)" />' +
      '<div class="cookie-container">' +
        '<input type="password" class="cookie-input mono" placeholder="QA Auth Cookie (name=val; ...)" />' +
        '<span class="info-btn" onclick="toggleInfo(this)" title="How to get this?">&#9432;</span>' +
        '<div class="cookie-instructions">' +
          '<strong>How to get a session cookie for your own test account:</strong><br/>' +
          'Only for an account and domain <em>you</em> control (localhost / staging) &mdash; never a session you don\\'t own.<br/>' +
          '1. Log into your own account on that domain.<br/>' +
          '2. Press <strong>F12</strong> to open Developer Tools.<br/>' +
          '3. Go to the <strong>Application</strong> tab (Chrome) or <strong>Storage</strong> tab (Firefox).<br/>' +
          '4. Expand <strong>Cookies</strong> on the left and select the domain.<br/>' +
          '5. Copy the session cookie(s) and format them here as: <code>name=value; name2=value2</code>' +
        '</div>' +
      '</div>' +
      '<label class="bandwidth-label mono"><input type="checkbox" class="bandwidth-cb" /> Simulate low bandwidth (block media/CSS)</label>' +
    '</div>' +
    '<pre class="result mono"></pre></div>';
}

async function loadTemplates() {
  try {
    const res = await fetch('/api/templates');
    const list = await res.json();
    const ids = list.map(function (t) { return t.templateId; }).sort();
    if (JSON.stringify(ids) === JSON.stringify(knownTemplateIds)) return;
    knownTemplateIds = ids;
    const panel = document.getElementById('templates-panel');
    panel.innerHTML = list.length
      ? list.map(templateRowHtml).join('')
      : '<div class="empty">No templates registered yet. Use register_extraction_template.</div>';
  } catch {
    // best-effort refresh, keep showing the last known list on failure
  }
}

pollProgress();
pollStats();
loadJobs();
loadLogs();
loadTemplates();
setInterval(pollProgress, 2000);
setInterval(pollStats, 5000);
setInterval(loadTemplates, 5000);
</script>
</body>
</html>`;
}

export function startDashboard(deps: DashboardDeps): void {
  const app = express();
  app.use(express.json());

  app.get('/', async (_req, res) => {
    const manifest = await loadManifest();
    res.type('html').send(renderDashboard(manifest, deps.isBrowserReady(), await templatesWithSavedCookies()));
  });

  app.post('/api/run/:templateId', async (req, res) => {
    const { templateId } = req.params;
    const body = req.body ?? {};
    const targetUrl = typeof body.url === 'string' && body.url ? body.url : undefined;
    const proxyUrl = typeof body.proxyUrl === 'string' && body.proxyUrl ? body.proxyUrl : undefined;
    const cookieString = typeof body.cookieString === 'string' && body.cookieString ? body.cookieString : undefined;
    const simulateLowBandwidth = body.simulateLowBandwidth === true;
    // Only meaningful for action-sequence (recorded) templates - runExtraction only
    // forwards this into the action-sequence execution path, so it's a harmless no-op
    // for extraction templates rather than something that needs rejecting here.
    const headful = body.headful === true;
    const useSavedCookies = body.useSavedCookies === true;
    const connectionId = typeof body.connectionId === 'string' && body.connectionId ? body.connectionId : undefined;

    if (!RegisterExtractionTemplateShape.templateId.safeParse(templateId).success) {
      res.status(400).json({ success: false, error: 'invalid templateId' });
      return;
    }
    if (targetUrl && !isHttpUrl(targetUrl)) {
      res.status(400).json({ success: false, error: 'url must be an absolute http:// or https:// URL' });
      return;
    }

    const result = await deps.runExtraction(
      targetUrl,
      templateId,
      proxyUrl,
      cookieString,
      simulateLowBandwidth,
      headful,
      useSavedCookies,
      connectionId
    );
    res.json(result);
  });

  app.get('/api/progress', async (_req, res) => {
    res.json((await getProgress()) ?? { status: 'idle' });
  });

  app.get('/api/stats', async (_req, res) => {
    res.json({ templates: await getAllSla() });
  });

  app.get('/api/jobs', (_req, res) => {
    res.json(deps.scheduler.list());
  });

  app.post('/api/jobs', async (req, res) => {
    const parsed = z.object(ScheduleStockCheckShape).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    try {
      const job: ScheduledJob = await deps.scheduler.register(
        parsed.data.targetUrl,
        parsed.data.cronExpression,
        parsed.data.templateId
      );
      deps.log(`Scheduled job "${job.jobId}" (${job.cronExpression}) for ${job.targetUrl}`);
      res.json(job);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ success: false, error: message });
    }
  });

  app.get('/api/logs', async (_req, res) => {
    res.json(await listForensicLogs());
  });

  app.get('/api/templates', async (_req, res) => {
    const cookieSet = await templatesWithSavedCookies();
    res.json(Object.values(await loadManifest()).map((e) => ({ ...e, hasSavedCookies: cookieSet.has(e.templateId) })));
  });

  // CORS is scoped to just this one route: it's the only endpoint an external
  // origin (the recorder extension's chrome-extension:// background worker) needs to
  // reach, and the server otherwise only binds to 127.0.0.1 for same-origin dashboard use.
  app.options('/api/recordings', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
  });

  app.post('/api/recordings', async (req, res) => {
    try {
      const body = req.body ?? {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const startUrl = typeof body.startUrl === 'string' ? body.startUrl : '';
      const steps = body.steps as ReplayActionStep[];

      res.set('Access-Control-Allow-Origin', '*');

      if (!name) {
        res.status(400).json({ success: false, error: 'name must not be empty' });
        return;
      }
      if (!isHttpUrl(startUrl)) {
        res.status(400).json({ success: false, error: 'startUrl must be an absolute http:// or https:// URL' });
        return;
      }
      if (!Array.isArray(steps)) {
        res.status(400).json({ success: false, error: 'steps must be an array' });
        return;
      }

      const templateId = slugify(name);
      const rawCookies = Array.isArray(body.cookies) ? body.cookies : [];
      await registerActionSequenceTemplate({
        templateId,
        sequence: { startUrl, steps, cookies: rawCookies.length ? rawCookies : undefined },
      });

      const result = await deps.runExtraction(startUrl, templateId);
      await updateVerificationStatus(templateId, { success: result.success, error: result.error });

      // Also hand these cookies to any existing extraction-kind template on the same
      // domain, so recording a workflow "primes" that template's saved cookies too.
      const cookiesBridgedTo = rawCookies.length ? await bridgeCookiesToExtractionTemplates(startUrl, rawCookies) : [];

      res.json({
        success: true,
        templateId,
        verified: result.success,
        error: result.success ? undefined : result.error,
        cookiesBridgedTo,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.use('/logs', express.static(LOGS_DIR));
  // Raw markdown guides (plain text) - still handy for curl/download.
  app.use('/apis', express.static(APIS_DIR, { setHeaders: (res) => res.type('text/plain') }));

  // Rendered docs page for one template - the "Docs" button target. Reads the
  // generated apis/<id>.md (which has the real last-run URL baked in); falls back to
  // generating from the manifest entry if the file isn't there yet.
  app.get('/docs/:templateId', async (req, res) => {
    const { templateId } = req.params;
    if (!RegisterExtractionTemplateShape.templateId.safeParse(templateId).success) {
      res.status(400).type('text/plain').send('invalid templateId');
      return;
    }
    let md: string;
    try {
      md = await fs.readFile(getUsagePath(templateId), 'utf8');
    } catch {
      const entry = (await loadManifest())[templateId];
      if (!entry) {
        res.status(404).type('text/plain').send(`No template "${templateId}"`);
        return;
      }
      md = buildUsageMarkdown(entry, entry.fixedTargetUrl);
    }
    res.type('html').send(renderDocsPage(templateId, md));
  });

  const httpServer = app.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    deps.log(`Dashboard listening on http://127.0.0.1:${DASHBOARD_PORT}`);
    void reportDashboardStatus(DASHBOARD_PORT);
  });
  httpServer.on('error', (err) => {
    deps.logError(`Dashboard failed to start: ${err instanceof Error ? err.message : String(err)}`);
  });
}
