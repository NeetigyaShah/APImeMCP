import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection, confirmAppConnection, listAppConnections } from '../dist/app-connections.js';
import { launchPersistentContext } from '../dist/engine.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'f00-login.html');
const fixture = await fs.readFile(fixturePath);
const originalCwd = process.cwd();
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apimemcp-verify-f00-'));
let server;
let context;

try {
  server = createServer((request, response) => {
    if (request.url !== '/login') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fixture);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port');
  const loginUrl = `http://127.0.0.1:${address.port}/login`;
  process.chdir(tempDir);

  const connection = await createConnection({
    connectionId: 'verify-f00',
    domainPattern: '127.0.0.1',
    loginUrl,
  });
  const profileDir = path.join(tempDir, connection.profileDir);

  context = await launchPersistentContext(profileDir, { headless: true });
  let page = context.pages()[0] ?? await context.newPage();
  await page.goto(loginUrl);
  await page.locator('input[name="username"]').fill('verify-f00');
  await page.locator('#login-form').evaluate((form) => form.requestSubmit());
  await page.locator('#logged-in:not([hidden])').waitFor();
  await context.close();
  context = undefined;

  await confirmAppConnection(connection.connectionId);

  context = await launchPersistentContext(profileDir, { headless: true });
  page = context.pages()[0] ?? await context.newPage();
  await page.goto(loginUrl);
  await page.locator('#logged-in:not([hidden])').waitFor();
  if (await page.locator('#login-form').isVisible()) throw new Error('Persistent profile did not retain login state');

  const connections = await listAppConnections();
  if (connections.length !== 1 || connections[0].status !== 'connected') {
    throw new Error('Connection was not persisted as connected');
  }
  console.log('F00 persistent profile verification passed');
} finally {
  await context?.close().catch(() => undefined);
  await new Promise((resolve) => server?.close(resolve) ?? resolve());
  process.chdir(originalCwd);
  await fs.rm(tempDir, { recursive: true, force: true });
}
