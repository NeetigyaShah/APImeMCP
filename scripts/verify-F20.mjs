#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const serverEntry = path.resolve(projectRoot, 'dist/index.js');
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apimemcp-f20-'));

// Fixture: price changes on every GET so the first cron tick establishes a baseline
// and the second tick observes a real, detectable change.
let tick = 0;
const fixtureServer = http.createServer((req, res) => {
  if (req.url === '/fixture') {
    tick++;
    const price = tick === 1 ? '100' : '50';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body><div class="price">${price}</div></body></html>`);
  } else {
    res.writeHead(404).end('Not found');
  }
});
await new Promise((resolve, reject) => {
  fixtureServer.once('error', reject);
  fixtureServer.listen(0, '127.0.0.1', resolve);
});
const fixtureAddr = fixtureServer.address();
const fixtureUrl = `http://127.0.0.1:${fixtureAddr.port}/fixture`;

// Webhook: records every notification the monitor fires.
const notifications = [];
const webhookServer = http.createServer((req, res) => {
  if (req.method !== 'POST') return res.writeHead(404).end('Not found');
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      notifications.push(JSON.parse(body));
      res.writeHead(200).end('OK');
    } catch {
      res.writeHead(400).end('Bad JSON');
    }
  });
});
await new Promise((resolve, reject) => {
  webhookServer.once('error', reject);
  webhookServer.listen(0, '127.0.0.1', resolve);
});
const webhookAddr = webhookServer.address();
const webhookUrl = `http://127.0.0.1:${webhookAddr.port}/webhook`;

const client = new Client({ name: 'f20-verify-client', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: tempDir,
  stderr: 'inherit',
});

function callTool(name, args) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
}

function parseResult(result) {
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) throw new Error(`Tool call failed: ${text}`);
  return JSON.parse(text);
}

let monitorId;
try {
  await client.connect(transport);

  console.log('Test 1: Register fixture template');
  const templateId = `f20-fixture-${randomUUID().slice(0, 8)}`;
  await callTool('register_extraction_template', {
    templateId,
    domainPattern: '127.0.0.1',
    executableScript: `
      (() => {
        const priceEl = document.querySelector('.price');
        return { price: parseInt(priceEl?.textContent || '0', 10) };
      })()
    `,
    fixedTargetUrl: fixtureUrl,
  });
  console.log(`  registered ${templateId}`);

  console.log('Test 2: Subscribe to monitor');
  const subscribeResult = parseResult(await callTool('subscribe_monitor', {
    templateId,
    cronExpression: '* * * * *',
    notifyEndpointUrl: webhookUrl,
  }));
  monitorId = subscribeResult.monitorId;
  if (!monitorId) throw new Error(`subscribe_monitor did not return a monitorId: ${JSON.stringify(subscribeResult)}`);
  console.log(`  subscribed ${monitorId}`);

  console.log('Test 3: List monitors');
  const listResult = parseResult(await callTool('list_monitors', {}));
  if (!listResult.monitors?.some((m) => m.id === monitorId)) {
    throw new Error(`Monitor ${monitorId} not found in list_monitors: ${JSON.stringify(listResult)}`);
  }
  console.log('  monitor listed');

  console.log('Test 4: Wait for two real cron ticks and verify change-detection notify');
  // Minimum cron granularity is 1 minute (ScheduleStockCheckShape enforces 5-field,
  // no-seconds cron) -- there is no tool to force a tick, so this genuinely waits for
  // the real schedule. First tick establishes the baseline (price=100, no notify
  // expected on first successful run); second tick observes price=50 and must notify
  // exactly once with real diff content.
  const deadline = Date.now() + 150_000;
  while (notifications.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (notifications.length === 0) {
    throw new Error('No notification received within 150s across two real cron ticks -- change-monitoring is not firing');
  }
  if (notifications.length > 1) {
    throw new Error(`Expected exactly one change notification, got ${notifications.length}: ${JSON.stringify(notifications)}`);
  }
  // notifyChange() (src/notifier.ts) wraps the monitor event: { event, message, timestamp }.
  const notification = notifications[0];
  const event = notification?.event;
  if (!event || event.monitorId !== monitorId || event.templateId !== templateId || !event.changed) {
    throw new Error(`Notification payload missing/wrong shape: ${JSON.stringify(notification)}`);
  }
  if (event.after?.data?.price !== 50 || event.before?.data?.price !== 100) {
    throw new Error(`Notification before/after don't reflect the real fixture price change: ${JSON.stringify(notification)}`);
  }
  console.log(`  received notification: ${JSON.stringify(notification)}`);

  console.log('Test 5: Unsubscribe monitor');
  const unsubResult = parseResult(await callTool('unsubscribe_monitor', { monitorId }));
  if (!unsubResult.ok) throw new Error(`Unsubscribe failed: ${JSON.stringify(unsubResult)}`);
  console.log('  unsubscribed');

  console.log('\nPASS F20 change-monitoring mesh: register, subscribe, list, real tick-driven notify, unsubscribe all verified live');
  process.exitCode = 0;
} catch (error) {
  console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (monitorId) {
    await callTool('unsubscribe_monitor', { monitorId }).catch(() => undefined);
  }
  await client.close().catch(() => undefined);
  await new Promise((resolve) => fixtureServer.close(resolve));
  await new Promise((resolve) => webhookServer.close(resolve));
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
}
