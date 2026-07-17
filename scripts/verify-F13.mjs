#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureHtml = await fs.readFile(fileURLToPath(new URL('./fixtures/vault-login.html', import.meta.url)));
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apimemcp-f13-'));
const serverEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const fixtureServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fixtureHtml);
});

await new Promise((resolve, reject) => {
  fixtureServer.once('error', reject);
  fixtureServer.listen(0, '127.0.0.1', resolve);
});

const address = fixtureServer.address();
if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port');
const targetUrl = `http://127.0.0.1:${address.port}/`;

const client = new Client({ name: 'f13-verify-client', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: tempDir,
  stderr: 'inherit',
});

try {
  await client.connect(transport);

  // 1. Set vault secret with username and password
  const secretResult = await client.callTool({
    name: 'set_vault_secret',
    arguments: {
      id: 'verify-f13-login',
      label: 'F13 verification login',
      value: JSON.stringify({ username: 'verify-user', password: 'verify-pass' }),
    },
  });
  const secretData = JSON.parse(secretResult.content[0].text);
  if (!secretData.success) {
    throw new Error(`Failed to set vault secret: ${secretData.error}`);
  }

  // 2. Register a template with secretInputs referencing the vault entry. Secrets are
  // injected into the in-page cel() vars closure, not window.secrets (see engine.ts's
  // page.evaluate({ secrets }) call) -- read them via getVar(...).
  const scriptSource = `
    async () => {
      const username = document.getElementById('username');
      const password = document.getElementById('password');
      username.value = getVar('username') || '';
      password.value = getVar('password') || '';
      document.getElementById('login-form').requestSubmit();
      // Wait for login to complete (poll instead of MutationObserver -- simpler and
      // doesn't risk hanging if the observer's attributeFilter misses the mutation).
      for (let i = 0; i < 50; i++) {
        if (document.getElementById('status').style.display !== 'none') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { success: true, message: document.getElementById('status').textContent };
    }
  `;

  await client.callTool({
    name: 'register_extraction_template',
    arguments: {
      templateId: 'verify-f13',
      domainPattern: '127.0.0.1',
      executableScript: scriptSource,
      fixedTargetUrl: targetUrl,
      secretInputs: { username: 'verify-f13-login.username', password: 'verify-f13-login.password' },
    },
  });

  // 3. Run the real extraction end to end: the page fills the login form with the
  // vault-resolved credential and submits it -- this is the actual acceptance criterion,
  // not just that the vault CRUD tools work in isolation.
  const runResult = await client.callTool(
    { name: 'execute_native_extraction', arguments: { templateId: 'verify-f13' } },
    undefined,
    { timeout: 30_000 }
  );
  const runText = runResult.content?.[0]?.text ?? '';
  const runData = JSON.parse(runText);
  if (runResult.isError || !runData?.data?.success) {
    throw new Error(`Extraction with vault-resolved credential failed: ${runText}`);
  }
  if (!String(runData.data.message || '').includes('verify-user')) {
    throw new Error(`Login page did not report the vault-resolved username, got: ${JSON.stringify(runData.data)}`);
  }

  // Zero plaintext leakage: the real secret value must never appear in the tool's own
  // stdout/response, matching spec section 8's acceptance criteria.
  if (runText.includes('verify-pass')) {
    throw new Error('Plaintext vault secret leaked into execute_native_extraction response');
  }

  // 4. Vault CRUD sanity: listed entries never carry ciphertext/iv/authTag.
  const listResult = await client.callTool({
    name: 'list_vault_secrets',
    arguments: {},
  });
  const secrets = JSON.parse(listResult.content[0].text);
  const found = secrets.some((s) => s.id === 'verify-f13-login');
  if (!found) {
    throw new Error('Vault secret not listed after creation');
  }
  const secretEntry = secrets.find((s) => s.id === 'verify-f13-login');
  if (secretEntry.ciphertext || secretEntry.iv || secretEntry.authTag) {
    throw new Error('Vault secret leaked ciphertext/iv/authTag in list');
  }

  // 4. Clean up the secret
  const deleteResult = await client.callTool({
    name: 'delete_vault_secret',
    arguments: { id: 'verify-f13-login' },
  });
  const deleteData = JSON.parse(deleteResult.content[0].text);
  if (!deleteData.success || !deleteData.deleted) {
    throw new Error(`Failed to delete vault secret: ${deleteData.error}`);
  }

  console.log('PASS F13 vault secret storage and lifecycle works correctly');
  process.exitCode = 0;
} catch (error) {
  console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.close();
  await new Promise((resolve) => fixtureServer.close(resolve));
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
}
