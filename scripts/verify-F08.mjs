import http from 'node:http';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const fixture = await readFile(new URL('./fixtures/f08-branching.html', import.meta.url), 'utf8');
const server = http.createServer((request, response) => {
  const stock = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('stock') === '1';
  response.setHeader('Content-Type', 'text/html');
  response.end(fixture
    .replaceAll('{{STOCK}}', stock ? '1' : '0')
    .replace('{{LABEL}}', stock ? 'In Stock' : 'Sold Out')
    .replace('{{HIDDEN}}', stock ? '' : 'hidden'));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const client = new Client({ name: 'verify-f08', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/index.js')], cwd: process.cwd() });
const payload = (result) => JSON.parse(result.content[0].text);
const targetUrl = (stock) => `http://127.0.0.1:${port}/?stock=${stock ? 1 : 0}`;

async function snapshotPath(filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isDirectory()) return { type: 'file', contents: (await readFile(filePath)).toString('base64') };
    const entries = await readdir(filePath, { withFileTypes: true });
    return {
      type: 'directory',
      entries: await Promise.all(entries.map(async (entry) => [entry.name, await snapshotPath(path.join(filePath, entry.name))])),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function restorePath(filePath, snapshot) {
  await rm(filePath, { recursive: true, force: true });
  if (!snapshot) return;
  if (snapshot.type === 'file') {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from(snapshot.contents, 'base64'));
    return;
  }
  await mkdir(filePath, { recursive: true });
  await Promise.all(snapshot.entries.map(([name, entry]) => restorePath(path.join(filePath, name), entry)));
}

const storageBefore = await Promise.all(['templates', 'apis', 'output', '.mcp-progress.json'].map(async (filePath) => [filePath, await snapshotPath(path.resolve(filePath))]));

try {
  await client.connect(transport);
  await client.callTool({ name: 'register_extraction_template', arguments: {
    templateId: 'f08-branching',
    domainPattern: '127.0.0.1',
    executableScript: `() => {
      setVar('inStock', document.querySelector('[data-stock]')?.dataset.stock === '1');
      if (cel('vars.inStock')) {
        document.querySelector('#load-more').click();
        return { state: 'in-stock', loaded: document.querySelector('#loaded').textContent };
      }
      return { state: 'sold-out' };
    }`,
  } });
  const inStock = payload(await client.callTool({ name: 'execute_native_extraction', arguments: { templateId: 'f08-branching', targetUrl: targetUrl(true) } }));
  const soldOut = payload(await client.callTool({ name: 'execute_native_extraction', arguments: { templateId: 'f08-branching', targetUrl: targetUrl(false) } }));
  if (inStock.data?.state !== 'in-stock' || inStock.data?.loaded !== 'loaded') throw new Error('In-stock state did not take the load-more branch');
  if (soldOut.data?.state !== 'sold-out' || 'loaded' in soldOut.data) throw new Error('Sold-out state did not take the empty branch');

  await client.callTool({ name: 'register_extraction_template', arguments: {
    templateId: 'f08-regression', domainPattern: 'localhost', executableScript: '() => ({ title: document.title, stock: document.body.dataset.stock })',
  } });
  const regression = payload(await client.callTool({ name: 'execute_native_extraction', arguments: { templateId: 'f08-regression', targetUrl: targetUrl(true).replace('127.0.0.1', 'localhost') } }));
  if (JSON.stringify(regression.data) !== JSON.stringify({ title: 'F08 Branching Fixture', stock: '1' })) throw new Error('Pre-F08 template output regressed');
  console.log('PASS: in-stock branch, sold-out branch, and non-CEL regression verified');
} finally {
  await client.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  await Promise.all(storageBefore.map(([filePath, snapshot]) => restorePath(path.resolve(filePath), snapshot)));
}
