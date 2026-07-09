#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ICONS = {
  running: '[36m●[0m',
  done: '[32m✓[0m',
  failed: '[31m✗[0m',
};

function truncate(text, max) {
  if (!text || text.length <= max) return text || '';
  return `${text.slice(0, max - 1)}…`;
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

  let state;
  try {
    state = JSON.parse(readFileSync(path.join(projectDir, '.mcp-progress.json'), 'utf8'));
  } catch {
    process.stdout.write('');
    return;
  }

  if (!state || state.status === 'idle') {
    process.stdout.write('');
    return;
  }

  const percent = state.total > 0 ? Math.round((state.current / state.total) * 100) : 0;
  const label = state.status === 'running' ? `${percent}% (${state.current}/${state.total})` : state.status;
  const icon = ICONS[state.status] ?? '';
  const message = truncate(state.message, 40);
  process.stdout.write(`${icon} mcp-compiler-server — ${state.tool}: ${label}${message ? ' — ' + message : ''}`);
});

// If nothing is piped (interactive test run), stdin never ends on its own.
if (process.stdin.isTTY) {
  process.stdin.end();
}
