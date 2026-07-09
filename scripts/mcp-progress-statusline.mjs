#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ICONS = {
  running: '[36m●[0m',
  done: '[32m✓[0m',
  failed: '[31m✗[0m',
};

// How long a finished job's result stays visible before the line settles back
// to the dashboard baseline. Running jobs are never treated as stale.
const RESULT_VISIBLE_MS = 30_000;

function truncate(text, max) {
  if (!text || text.length <= max) return text || '';
  return `${text.slice(0, max - 1)}…`;
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function dashboardLine(projectDir) {
  const dashboard = readJson(path.join(projectDir, '.mcp-dashboard.json'));
  if (!dashboard?.port) return '';
  return `[34m◈[0m APImeMCP — dashboard live on :${dashboard.port}`;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  let projectDir = process.cwd();
  try {
    const context = JSON.parse(input);
    projectDir = context.workspace?.project_dir || context.workspace?.current_dir || context.cwd || projectDir;
  } catch {
    // no usable stdin JSON, fall back to cwd
  }

  const state = readJson(path.join(projectDir, '.mcp-progress.json'));
  const isFinished = state?.status === 'done' || state?.status === 'failed';
  const isStale = isFinished && Date.now() - new Date(state.updatedAt).getTime() > RESULT_VISIBLE_MS;

  if (!state || state.status === 'idle' || isStale) {
    process.stdout.write(dashboardLine(projectDir));
    return;
  }

  const percent = state.total > 0 ? Math.round((state.current / state.total) * 100) : 0;
  const label = state.status === 'running' ? `${percent}% (${state.current}/${state.total})` : state.status;
  const icon = ICONS[state.status] ?? '';
  const message = truncate(state.message, 40);
  process.stdout.write(`${icon} APImeMCP — ${state.tool}: ${label}${message ? ' — ' + message : ''}`);
});

// If nothing is piped (interactive test run), stdin never ends on its own.
if (process.stdin.isTTY) {
  process.stdin.end();
}
