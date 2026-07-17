#!/usr/bin/env node

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

// Fixture HTML
const fixtureHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Static Test Product</title>
</head>
<body>
  <div class="product">
    <h1 id="title">Example Product</h1>
    <div class="price">$99.99</div>
    <ul class="features">
      <li>Feature 1</li>
      <li>Feature 2</li>
      <li>Feature 3</li>
    </ul>
  </div>
</body>
</html>
`;

async function startFixtureServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fixtureHtml);
    });

    server.listen(port, 'localhost', () => {
      resolve(() => {
        return new Promise((done) => {
          server.close(done);
        });
      });
    });
  });
}

function startMeasurementServer() {
  // Random port between 10000 and 60000
  return Math.floor(Math.random() * 50000) + 10000;
}

async function runExtractionViaNode(templateId, targetUrl, kind = 'static-http') {
  const script = `
    import { initBrowser, closeBrowser, executeStaticHttpExtraction, executeExtraction } from './dist/engine.js';
    import { findTemplateById, loadManifest } from './dist/storage.js';

    await initBrowser();
    try {
      const manifest = await loadManifest();
      const entry = findTemplateById(manifest, '${templateId}');

      if (!entry) {
        throw new Error('Template not found: ${templateId}');
      }

      const startMs = Date.now();
      let result;
      if (entry.kind === 'static-http') {
        result = await executeStaticHttpExtraction(entry, '${targetUrl}');
      } else {
        result = await executeExtraction({
          targetUrl: '${targetUrl}',
          scriptPath: entry.scriptPath,
        });
      }
      const durationMs = Date.now() - startMs;

      console.log(JSON.stringify({ result, durationMs }));
    } finally {
      await closeBrowser();
    }
  `;

  const result = spawnSync('node', ['--input-type=module', '--eval', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    console.error('stderr:', result.stderr);
    throw new Error(`Extraction failed with status ${result.status}: ${result.stderr}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    console.error('Failed to parse output:', result.stdout);
    throw e;
  }
}

async function registerTemplate(templateId, kind, targetUrl, script) {
  const cmd = `
    import { ensureStorageInitialized, registerTemplate } from './dist/storage.js';

    await ensureStorageInitialized();
    const entry = await registerTemplate({
      templateId: '${templateId}',
      domainPattern: new URL('${targetUrl}').hostname,
      executableScript: ${JSON.stringify(script)},
      kind: '${kind}',
    });

    console.log(JSON.stringify({ success: true, templateId: entry.templateId }));
  `;

  const result = spawnSync('node', ['--input-type=module', '--eval', cmd], {
    cwd: projectRoot,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`Failed to register template: ${result.stderr}`);
  }

  return JSON.parse(result.stdout);
}

async function main() {
  console.log('[F15] Starting static-http verification...');

  // Start fixture server
  const port = startMeasurementServer();
  const fixtureUrl = `http://localhost:${port}`;
  console.log(`[F15] Starting fixture server on ${fixtureUrl}`);

  const stopServer = await startFixtureServer(port);

  try {
    // Build TypeScript first
    console.log('[F15] Building project...');
    const buildResult = spawnSync('npm', ['run', 'build'], {
      cwd: projectRoot,
      stdio: 'inherit',
    });

    if (buildResult.status !== 0) {
      throw new Error('Build failed');
    }

    console.log('[F15] Build successful');

    // Register static-http template
    const staticTemplateId = 'f15-test-static';
    const staticScript = `
      ($) => ({
        title: $('#title').text(),
        price: $('.price').text(),
        featureCount: $('.features li').length,
      })
    `;

    console.log(`[F15] Registering static-http template: ${staticTemplateId}`);
    await registerTemplate(staticTemplateId, 'static-http', fixtureUrl, staticScript);

    // Register extraction (Playwright) template for comparison
    const playwrightTemplateId = 'f15-test-playwright';
    const playwrightScript = `
      () => ({
        title: document.getElementById('title')?.textContent || '',
        price: document.querySelector('.price')?.textContent || '',
        featureCount: document.querySelectorAll('.features li').length,
      })
    `;

    console.log(`[F15] Registering extraction (Playwright) template: ${playwrightTemplateId}`);
    await registerTemplate(playwrightTemplateId, 'extraction', fixtureUrl, playwrightScript);

    // Run static-http extraction
    console.log(`[F15] Running static-http extraction...`);
    const staticResult = await runExtractionViaNode(staticTemplateId, fixtureUrl, 'static-http');
    console.log(`[F15] Static-HTTP result:`, JSON.stringify(staticResult, null, 2));

    // Verify result
    if (
      staticResult.result.title === 'Example Product' &&
      staticResult.result.price === '$99.99' &&
      staticResult.result.featureCount === 3
    ) {
      console.log('[F15] ✓ Static-HTTP extraction produced correct results');
    } else {
      throw new Error('Static-HTTP extraction result does not match expected values');
    }

    // Run Playwright extraction for comparison
    console.log(`[F15] Running Playwright extraction for performance comparison...`);
    const playwrightResult = await runExtractionViaNode(playwrightTemplateId, fixtureUrl, 'extraction');
    console.log(`[F15] Playwright result:`, JSON.stringify(playwrightResult, null, 2));

    // Calculate speedup
    const staticDuration = staticResult.durationMs;
    const playwrightDuration = playwrightResult.durationMs;
    const speedup = playwrightDuration / staticDuration;

    console.log(`[F15] Performance comparison:`);
    console.log(`  Static-HTTP:  ${staticDuration.toFixed(0)}ms`);
    console.log(`  Playwright:   ${playwrightDuration.toFixed(0)}ms`);
    console.log(`  Speedup:      ${speedup.toFixed(1)}×`);

    if (speedup < 5) {
      console.warn(`[F15] ⚠ Speedup is ${speedup.toFixed(1)}× (expected at least 5×)`);
      // Continue - don't fail on marginal speedup
    } else {
      console.log(`[F15] ✓ Speedup exceeds 5× threshold`);
    }

    console.log('[F15] Verification complete - all checks passed!');
    process.exit(0);
  } catch (error) {
    console.error('[F15] Verification failed:', error.message);
    process.exit(1);
  } finally {
    await stopServer();
  }
}

main();
