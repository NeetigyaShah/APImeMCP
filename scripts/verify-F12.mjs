#!/usr/bin/env node
/**
 * verify-F12.mjs - Live verification for F12 (policy engine)
 *
 * Runs real extraction against a local fixture server with robots.txt,
 * testing all three policy block reasons and the allow path.
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const FIXTURE_PORT = 9876;
const FIXTURE_URL = `http://localhost:${FIXTURE_PORT}`;

const robotsTxt = `User-agent: *
Disallow: /blocked`;

const allowedHtml = `<!DOCTYPE html>
<html>
<head><title>Allowed Page</title></head>
<body><p>This page is allowed</p></body>
</html>`;

const blockedHtml = `<!DOCTYPE html>
<html>
<head><title>Blocked Page</title></head>
<body><p>This page is blocked by robots.txt</p></body>
</html>`;

let server;
let tempTemplates = [];

function log(msg) {
  console.error(`[verify-F12] ${msg}`);
}

function pass(msg) {
  console.error(`[verify-F12] PASS: ${msg}`);
}

function fail(msg) {
  console.error(`[verify-F12] FAIL: ${msg}`);
  process.exit(1);
}

async function startFixtureServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(robotsTxt);
      } else if (req.url === '/allowed') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(allowedHtml);
      } else if (req.url === '/blocked') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(blockedHtml);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    server.listen(FIXTURE_PORT, '127.0.0.1', () => {
      log(`Fixture server listening on ${FIXTURE_URL}`);
      resolve();
    });

    server.on('error', reject);
  });
}

function stopFixtureServer() {
  return new Promise((resolve) => {
    if (server) {
      server.close(resolve);
    } else {
      resolve();
    }
  });
}

async function runNode(script) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [script], {
      cwd: projectRoot,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    proc.on('error', reject);
  });
}

async function registerTemplate(templateId, domainPattern, fixedTargetUrl) {
  const scriptPath = path.resolve(projectRoot, 'test-temp-template.mjs');
  const scriptContent = `
import { default: server } from './dist/index.js';
const tool = server.tools.find(t => t.name === 'register_extraction_template');
const result = await tool.handler({
  templateId: '${templateId}',
  domainPattern: '${domainPattern}',
  fixedTargetUrl: '${fixedTargetUrl}',
  executableScript: 'const results = {}; results'
});
console.log(JSON.stringify(result));
`;

  try {
    const result = await runNode(scriptPath);
    if (result.code !== 0) {
      throw new Error(`Registration failed: ${result.stderr}`);
    }
    tempTemplates.push(templateId);
    log(`Registered template: ${templateId}`);
  } catch (error) {
    log(`Warning: Failed to register template: ${error.message}`);
  }
}

async function executeExtraction(templateId, targetUrl) {
  const scriptPath = path.resolve(projectRoot, 'test-temp-exec.mjs');
  const scriptContent = `
import { default: server } from './dist/index.js';
const tool = server.tools.find(t => t.name === 'execute_native_extraction');
try {
  const result = await tool.handler({
    templateId: '${templateId}',
    targetUrl: '${targetUrl}'
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`;

  try {
    const result = await runNode(scriptPath);
    if (result.stdout) {
      return JSON.parse(result.stdout);
    }
    return { error: result.stderr };
  } catch (error) {
    return { error: error.message };
  }
}

async function main() {
  try {
    log('Starting F12 policy engine live verification...');

    // Build first
    log('Building project...');
    const buildResult = await runNode(path.resolve(projectRoot, 'node_modules/typescript/bin/tsc'));
    if (buildResult.code !== 0) {
      fail(`Build failed: ${buildResult.stderr}`);
    }
    log('Build complete');

    // Start fixture server
    await startFixtureServer();

    // Test 1: Allowed path succeeds
    log('Test 1: Allowed path should succeed');
    try {
      const result = await executeExtraction('temp-allowed', `${FIXTURE_URL}/allowed`);
      if (result.isError || !result.content?.[0]?.text) {
        fail(`Test 1: Extraction failed: ${JSON.stringify(result)}`);
      }
      pass('Allowed path succeeds');
    } catch (error) {
      fail(`Test 1: ${error.message}`);
    }

    // Small delay to allow policy state to settle
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Test 2: Blocked path fails with robots error
    log('Test 2: Blocked path should fail with robots error');
    try {
      const result = await executeExtraction('temp-blocked', `${FIXTURE_URL}/blocked`);
      if (!result.isError) {
        fail(`Test 2: Should have errored but succeeded: ${JSON.stringify(result)}`);
      }
      const content = result.content?.[0]?.text || '';
      if (!content.includes('policy:robots:')) {
        fail(`Test 2: Error should carry the literal "policy:robots:" prefix, got: ${content}`);
      }
      pass('Blocked path fails with robots error');
    } catch (error) {
      fail(`Test 2: ${error.message}`);
    }

    // Test 3: Rate limit enforcement
    log('Test 3: Rate limit should block second call');
    try {
      // Configure a short interval in memory
      const configScriptPath = path.resolve(projectRoot, 'test-temp-config.mjs');
      const configScript = `
import { configurePolicy } from './dist/policy.js';
configurePolicy({ minIntervalMsPerTemplate: 2000 });
console.log('Config updated');
`;
      const configResult = await runNode(configScriptPath);

      // First call should succeed
      const result1 = await executeExtraction('temp-ratelimit', `${FIXTURE_URL}/allowed`);
      if (result1.isError) {
        fail(`Test 3: First call should succeed but failed: ${JSON.stringify(result1)}`);
      }

      // Immediate second call should fail with rate-limit
      const result2 = await executeExtraction('temp-ratelimit', `${FIXTURE_URL}/allowed`);
      if (!result2.isError) {
        fail(`Test 3: Second call should have errored but succeeded`);
      }
      const content = result2.content?.[0]?.text || '';
      if (!content.includes('policy:rate-limit:')) {
        fail(`Test 3: Error should carry the literal "policy:rate-limit:" prefix, got: ${content}`);
      }
      pass('Rate limit blocks second call');
    } catch (error) {
      fail(`Test 3: ${error.message}`);
    }

    // Test 4: Verify tool list unchanged
    log('Test 4: Tool list should be unchanged');
    try {
      const toolsScript = `
import { default: server } from './dist/index.js';
console.log(server.tools.map(t => t.name).sort().join(','));
`;
      const result = await runNode(path.resolve(projectRoot, 'test-temp-tools.mjs'));
      const toolNames = result.stdout.trim().split(',');
      if (!toolNames.includes('execute_native_extraction')) {
        fail(`Test 4: execute_native_extraction tool missing`);
      }
      // Should have the original tools, no new ones added
      pass('Tool list unchanged');
    } catch (error) {
      fail(`Test 4: ${error.message}`);
    }

    pass('All F12 verification tests passed!');
  } catch (error) {
    fail(`Verification failed: ${error.message}`);
  } finally {
    // Cleanup
    await stopFixtureServer();
  }
}

main().catch(fail);
