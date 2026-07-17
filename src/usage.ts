import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ManifestEntry, ActionSequence } from './types.js';
import { evaluateCel } from './cel-eval.js';

const HOST = 'http://127.0.0.1:3000';
// Kept in lockstep with engine.ts so a standalone script reproduces the server's run.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function getApisDir(): string {
  return path.resolve(process.cwd(), 'apis');
}

export function getUsagePath(templateId: string): string {
  return path.join(getApisDir(), `${templateId}.md`);
}

export function getScriptPath(templateId: string): string {
  return path.join(getApisDir(), `${templateId}.mjs`);
}

/**
 * A uniquely-named, fully standalone Node script for one template. The ONLY runtime
 * dependency is Playwright — it embeds the template's own logic (the extraction script,
 * or the recorded action steps + cookies) so someone can copy the one file and run it
 * with no APImeMCP server and no repo. `contents` is the raw template file: JS source
 * for extraction, the JSON string of an ActionSequence for action-sequence.
 */
export function buildStandaloneScript(entry: ManifestEntry, contents: string): string {
  return entry.kind === 'action-sequence'
    ? buildStandaloneAction(entry, JSON.parse(contents) as ActionSequence)
    : buildStandaloneExtraction(entry, contents);
}

function buildStandaloneExtraction(entry: ManifestEntry, scriptSource: string): string {
  const id = entry.templateId;
  const fixed = entry.fixedTargetUrl;
  const defaultUrl = fixed || `https://${entry.domainPattern}/`;
  const argHint = fixed ? '' : ` "<a real ${entry.domainPattern} page URL>"`;
  return `#!/usr/bin/env node
// ${id}.mjs — standalone extractor for ${entry.domainPattern}.
// Self-contained: the ONLY dependency is Playwright. No APImeMCP server, no repo.
//   npm i playwright && npx playwright install chromium
//   node ${id}.mjs${argHint}                # print the JSON
//   node ${id}.mjs${argHint} --download     # also download every image to ./${id}-images/
import { chromium } from 'playwright';

const ARGS = process.argv.slice(2);
const DOWNLOAD = ARGS.includes('--download');
const IMAGES_DIR = ${JSON.stringify('./' + id + '-images')};
const TARGET_URL = ARGS.find((a) => !a.startsWith('--')) || ${JSON.stringify(defaultUrl)};

// AUTH: to run this as a logged-in user, paste your own ${entry.domainPattern} session
// cookies here as 'name=value; name2=value2' (see the "Authentication" section of this
// template's docs for how to copy them from your browser). Leave '' for anonymous.
const COOKIES = '';

// The extraction script that runs inside the page (verbatim from the template).
const EXTRACTION_SCRIPT = ${JSON.stringify(scriptSource)};
const CEL_EVALUATOR_SOURCE = ${JSON.stringify(evaluateCel.toString())};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ userAgent: ${JSON.stringify(UA)}, viewport: { width: 1280, height: 800 } });
  if (COOKIES) {
    await context.addCookies(COOKIES.split(';').map((s) => s.trim()).filter(Boolean).map((pair) => {
      const i = pair.indexOf('=');
      return { name: i === -1 ? pair : pair.slice(0, i).trim(), value: i === -1 ? '' : pair.slice(i + 1).trim(), url: TARGET_URL };
    }));
  }
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await context.newPage();
  const response = await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 });
  const result = await page.evaluate((src, evaluatorSource, status) => {
    class CelSyntaxError extends Error {
      constructor(message) {
        super(message);
        this.name = 'CelSyntaxError';
      }
    }
    const evaluateCel = (0, eval)(\`(\${evaluatorSource})\`);
    const vars = {};
    let lastResult;
    const cel = (expression) => evaluateCel(expression, {
      vars,
      page: { url: window.location.href, status, title: document.title },
      lastResult,
    }, CelSyntaxError);
    const setVar = (name, value) => { vars[name] = value; };
    const getVar = (name) => vars[name];
    const value = eval(src);
    lastResult = await (typeof value === 'function' ? value() : value);
    return lastResult;
  }, EXTRACTION_SCRIPT, CEL_EVALUATOR_SOURCE, response?.status());
  console.log(JSON.stringify(result, null, 2));
  if (DOWNLOAD) await downloadImages(collectImageUrls(result), IMAGES_DIR);
} finally {
  await browser.close();
}

// Walk the extracted JSON and collect every image URL (by file extension, or by a
// key that looks image-y like imageUrl/photo/avatar) so --download works whatever
// this template's field names are.
function collectImageUrls(data) {
  const urls = new Set();
  const IMG_EXT = /\\.(jpe?g|png|webp|gif|avif|svg)(\\?|#|$)/i;
  const IMG_KEY = /(image|img|photo|thumb|thumbnail|avatar|picture|banner|cover)/i;
  (function walk(v, key) {
    if (typeof v === 'string') {
      if (/^https?:\\/\\//i.test(v) && (IMG_EXT.test(v) || (key && IMG_KEY.test(key)))) urls.add(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
    } else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) walk(val, k);
    }
  })(data, '');
  return [...urls];
}

// Download all URLs to a folder, 5 at a time, using Node's built-in fetch (no deps).
async function downloadImages(urls, dir) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  if (!urls.length) { console.error('No image URLs found in the result.'); return; }
  await mkdir(dir, { recursive: true });
  let cursor = 0, done = 0, failed = 0;
  async function worker() {
    while (cursor < urls.length) {
      const idx = cursor++;
      try {
        const res = await fetch(urls[idx]);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        let base = decodeURIComponent(new URL(urls[idx]).pathname.split('/').pop() || 'image');
        if (!/\\.\\w{2,5}$/.test(base)) base += '.img';
        await writeFile(join(dir, String(idx).padStart(4, '0') + '-' + base), Buffer.from(await res.arrayBuffer()));
        done++;
      } catch { failed++; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, urls.length) }, worker));
  console.error('Downloaded ' + done + ' image(s) to ' + dir + (failed ? ' (' + failed + ' failed)' : ''));
}
`;
}

function buildStandaloneAction(entry: ManifestEntry, sequence: ActionSequence): string {
  const id = entry.templateId;
  const hasCookies = Array.isArray(sequence.cookies) && sequence.cookies.length > 0;
  const cookieWarning = hasCookies
    ? '// WARNING: this file embeds session cookies captured at record time. Do NOT share it.\n'
    : '';
  return `#!/usr/bin/env node
// ${id}.mjs — standalone workflow replay for ${entry.domainPattern}.
// Self-contained: the ONLY dependency is Playwright. No APImeMCP server, no repo.
//   npm i playwright && npx playwright install chromium
//   node ${id}.mjs           # headless
//   node ${id}.mjs --watch   # visible browser so you can watch it
${cookieWarning}import { chromium } from 'playwright';

const START_URL = ${JSON.stringify(sequence.startUrl)};
const STEPS = ${JSON.stringify(sequence.steps, null, 2)};
const COOKIES = ${JSON.stringify(sequence.cookies || [])};
const HEADFUL = process.argv.includes('--watch');
const STEP_TIMEOUT = 3000, NAV_TIMEOUT = 30000;

const sameSite = (s) => (s === 'no_restriction' ? 'None' : s === 'strict' ? 'Strict' : s === 'lax' ? 'Lax' : 'Lax');

const browser = await chromium.launch({ headless: !HEADFUL });
try {
  const context = await browser.newContext({ userAgent: ${JSON.stringify(UA)}, viewport: { width: 1280, height: 800 } });
  if (COOKIES.length) {
    await context.addCookies(COOKIES.map((c) => ({
      name: String(c.name), value: String(c.value), domain: String(c.domain), path: String(c.path || '/'),
      secure: !!c.secure, httpOnly: !!c.httpOnly,
      expires: typeof c.expirationDate === 'number' ? c.expirationDate : -1, sameSite: sameSite(c.sameSite),
    })));
  }
  const page = await context.newPage();
  await page.goto(START_URL, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    if (step.type === 'navigate') { await page.goto(step.url || '', { waitUntil: 'networkidle', timeout: NAV_TIMEOUT }); continue; }
    if (step.type === 'waitForNavigation') { await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }); continue; }
    let done = false;
    for (const sel of step.selectors || []) {
      try {
        const loc = page.locator(sel).first();
        if (step.type === 'click') await loc.click({ timeout: STEP_TIMEOUT });
        else if (step.type === 'fill') await loc.fill(step.value || '', { timeout: STEP_TIMEOUT });
        else if (step.type === 'select') await loc.selectOption(step.value || '', { timeout: STEP_TIMEOUT });
        done = true; break;
      } catch { /* try next fallback selector */ }
    }
    if (!done) throw new Error('step ' + (i + 1) + ' (' + step.type + '): no selector matched: ' + (step.selectors || []).join(', '));
  }
  console.log(JSON.stringify({ success: true, completedSteps: STEPS.length }, null, 2));
} finally {
  if (HEADFUL) await new Promise((r) => setTimeout(r, 1500));
  await browser.close();
}
`;
}

/**
 * A per-template "how to run this API from a console, without Claude Code or the
 * dashboard UI" guide. Pure function of the manifest entry (+ an optional real
 * example URL pulled from run history), so it can be regenerated at any time.
 */
export function buildUsageMarkdown(entry: ManifestEntry, exampleUrl?: string, standaloneScript?: string): string {
  const id = entry.templateId;
  const isAction = entry.kind === 'action-sequence';
  const fixed = entry.fixedTargetUrl;
  // The URL to show in the copy-paste example: a real one from history if we have it,
  // else the fixed target, else a placeholder built from the domain.
  const example = exampleUrl || fixed || `https://${entry.domainPattern}/`;
  const needsUrl = !isAction && !fixed;

  // The JSON body for the POST: fixed-target/action templates need no url.
  const body = needsUrl ? `{"url":"${example}"}` : '{}';

  const kindLine = isAction
    ? `Recorded **action-sequence** for \`${entry.domainPattern}\` — replays the recorded steps (click/fill/navigate) and returns \`{ completedSteps }\`.`
    : `**Extraction** template for \`${entry.domainPattern}\` — runs its script against a page and returns the scraped data in \`data\`.`;

  const urlNote = needsUrl
    ? `\nThis template needs a target URL: pass any real page URL on \`${entry.domainPattern}\` in the \`url\` field.`
    : `\nNo URL needed — this template always targets \`${fixed}\`, so the body is just \`{}\`.`;

  const watchBlock = isAction
    ? `
### Watch it run (opens a visible browser)

\`\`\`bash
curl -X POST ${HOST}/api/run/${id} \\
  -H "Content-Type: application/json" \\
  -d '{"headful":true}'
\`\`\`
`
    : '';

  const runCmd = isAction ? `node ${id}.mjs` : needsUrl ? `node ${id}.mjs "${example}"` : `node ${id}.mjs`;
  const watchLine = isAction ? `\nnode ${id}.mjs --watch   # visible browser, watch it run` : '';
  const downloadLine = isAction ? '' : `\n${runCmd} --download   # ...and download every image in the result to ./${id}-images/`;

  const dom = entry.domainPattern;
  // A standard, always-present block on running the template as a logged-in user.
  // You never supply a password - you supply your own session cookies for the site.
  const howToGet = `Log into \`${dom}\` in your normal browser, press **F12** → **Application** tab
(Chrome) / **Storage** (Firefox) → **Cookies** → select \`${dom}\`, and copy the
session cookie(s) formatted as \`name=value; name2=value2\`.`;
  const authSection = isAction
    ? `## 3. Authentication — running as a logged-in user

This recorded workflow already carries the session cookies captured for \`${dom}\` when
it was recorded, so it replays as you. If that session has expired, refresh it:

${howToGet}

Then replace the \`COOKIES = [...]\` array near the top of \`${id}.mjs\` (or re-record the
workflow). You never store a password — only the session cookie your browser already holds.

> ⚠ Session cookies are live account access. Use only your own accounts, and never share a
> file that contains them.
`
    : `## 3. Authentication — running as a logged-in user

Some \`${dom}\` pages only return data when you're signed in. You never hand this tool a
password — you give it your own **session cookies** for \`${dom}\` and it replays them.

**Get them (your own account only):** ${howToGet}

**Where to put them:**

- **HTTP API** — add a \`cookieString\` field to the POST body:

  \`\`\`bash
  curl -X POST ${HOST}/api/run/${id} -H "Content-Type: application/json" \\
    -d '{${needsUrl ? `"url":"${example}",` : ''}"cookieString":"name=value; name2=value2"}'
  \`\`\`

  Cookies sent this way (or in a chat via \`execute_native_extraction\`) are **saved for
  this template**, so the dashboard then shows a **🔑 Use saved cookies** button and you
  don't have to paste them again.

- **Standalone script** — set the \`COOKIES\` line near the top of \`${id}.mjs\`:

  \`\`\`js
  const COOKIES = 'name=value; name2=value2';
  \`\`\`

> ⚠ Session cookies are live account access. Use only your own accounts, and never share a
> command or file that contains them.
`;

  // Section 3: the fully self-contained script. Only rendered when we have the script
  // text (i.e. generated with the template's contents in hand); the docs-route fallback
  // that builds from just the manifest entry omits it.
  const standaloneSection = standaloneScript
    ? `## 4. Standalone script — only needs Playwright (no server, no repo)

Download [\`${id}.mjs\`](/apis/${id}.mjs) (or copy the full source below), then:

\`\`\`bash
npm i playwright
npx playwright install chromium
${runCmd}${watchLine}${downloadLine}
\`\`\`

It embeds this template's entire logic and prints the JSON to stdout — the only
dependency is Playwright.${isAction ? '' : `

**Download the images too:** add \`--download\` and every image URL found in the
result (product photos, thumbnails, etc.) is saved to \`./${id}-images/\`, 5 at a
time, using Node's built-in fetch — no extra dependency.`}

### Full source — save as \`${id}.mjs\`

\`\`\`js
${standaloneScript.trimEnd()}
\`\`\`
`
    : `## 4. One-shot, from a source checkout

\`\`\`bash
node scripts/run.mjs ${id} "${fixed || example}"
\`\`\`

Needs the repo (the \`scripts/\` folder isn't in the npm package).
`;

  return `# API: ${id}

${kindLine}
${urlNote}

## 1. Start the server (once)

The server is the API. Start it and leave it running:

\`\`\`bash
apimemcp
\`\`\`

(from a source checkout: \`node dist/index.js\`.) It listens on \`${HOST}\` — the
same process that serves the dashboard also serves this HTTP API, so you don't need
to open the dashboard at all.

## 2. Call it from the console

**bash / macOS / Linux / Git Bash:**

\`\`\`bash
curl -X POST ${HOST}/api/run/${id} \\
  -H "Content-Type: application/json" \\
  -d '${body}'
\`\`\`

**Windows PowerShell:**

\`\`\`powershell
Invoke-RestMethod -Method Post -Uri ${HOST}/api/run/${id} \`
  -ContentType application/json -Body '${body}'
\`\`\`

Response is JSON: \`{ success, data?, error?, meta }\`.${isAction ? ' For an action-sequence, `data` is `{ completedSteps }`.' : ' `data` holds the extracted result.'}
${watchBlock}
${authSection}
${standaloneSection}
---

_Generated by APImeMCP. Regenerate all of these with \`node scripts/gen-usage.mjs\`._
`;
}

/** Best-effort: write both the standalone script (apis/<id>.mjs) and the usage guide
 *  (apis/<id>.md) with that script inlined. `contents` is the raw template file (JS
 *  source or ActionSequence JSON). Never throws — these are convenience artifacts,
 *  their failure must not break template registration. */
export async function writeUsageReadme(entry: ManifestEntry, exampleUrl?: string, contents?: string): Promise<void> {
  try {
    await fs.mkdir(getApisDir(), { recursive: true });
    let script: string | undefined;
    if (contents !== undefined) {
      script = buildStandaloneScript(entry, contents);
      await fs.writeFile(getScriptPath(entry.templateId), script, 'utf8');
    }
    await fs.writeFile(getUsagePath(entry.templateId), buildUsageMarkdown(entry, exampleUrl, script), 'utf8');
  } catch {
    // swallow - see doc comment
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineMd(s: string): string {
  // escape first so page content can never inject HTML, then apply a safe inline subset
  let t = escapeHtml(s);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/(^|[^_])_([^_]+)_(?=[^_]|$)/g, '$1<em>$2</em>');
  return t;
}

/**
 * Render the constrained markdown subset that buildUsageMarkdown emits (headings,
 * fenced code blocks, hr, bold/inline-code/italic, paragraphs) to HTML. Not a general
 * markdown parser - just enough for the docs page, over content we generate ourselves.
 */
export function markdownToHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      out.push('<p>' + para.map(inlineMd).join('<br>') + '</p>');
      para = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      out.push(
        `<pre class="code"><button class="copy" onclick="copyCode(this)">copy</button><code>${escapeHtml(code.join('\n'))}</code></pre>`
      );
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flush();
      out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`);
      continue;
    }
    if (/^---\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      continue;
    }
    if (/^\s*$/.test(line)) {
      flush();
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join('\n');
}

/** A full themed HTML docs page for one template, rendered from its usage markdown. */
export function renderDocsPage(templateId: string, md: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(templateId)} — docs — APImeMCP</title>
<style>
  :root { --void:#14100a; --panel:#1e1811; --panel-2:#241d14; --line:#3a2f1f; --phosphor:#ffb627; --ok:#7fd858; --text:#d8c9a8; --text-dim:#7a6a4e; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--void); color:var(--text); font-family:-apple-system,'Segoe UI',system-ui,sans-serif; line-height:1.6; }
  .chrome { display:flex; align-items:center; gap:.75rem; padding:.6rem 1rem; background:var(--panel-2); border-bottom:1px solid var(--line); font-family:ui-monospace,Consolas,monospace; font-size:.85rem; }
  .chrome a { color:var(--text-dim); text-decoration:none; }
  .chrome a:hover { color:var(--phosphor); }
  .chrome b { color:var(--phosphor); }
  main { max-width:820px; margin:0 auto; padding:1.5rem 1.2rem 4rem; }
  h1 { font-size:1.3rem; color:var(--phosphor); font-family:ui-monospace,Consolas,monospace; }
  h2 { font-size:1rem; color:var(--phosphor); margin-top:1.8rem; border-bottom:1px solid var(--line); padding-bottom:.3rem; }
  h3 { font-size:.9rem; color:var(--ok); margin-top:1.4rem; }
  code { font-family:ui-monospace,Consolas,monospace; background:var(--panel-2); padding:.1rem .35rem; border-radius:2px; font-size:.85em; color:var(--text); }
  pre.code { position:relative; background:#0e0b06; border:1px solid var(--line); border-radius:4px; padding:.85rem 1rem; overflow-x:auto; }
  pre.code code { background:none; padding:0; color:var(--text); font-size:.82rem; line-height:1.5; white-space:pre; }
  pre.code .copy { position:absolute; top:.4rem; right:.4rem; background:transparent; border:1px solid var(--line); color:var(--text-dim); font-family:ui-monospace,monospace; font-size:.7rem; padding:.15rem .5rem; border-radius:2px; cursor:pointer; }
  pre.code .copy:hover { border-color:var(--phosphor); color:var(--phosphor); }
  hr { border:none; border-top:1px solid var(--line); margin:2rem 0; }
  a { color:var(--phosphor); }
</style>
</head><body>
<div class="chrome"><a href="/">&larr; dashboard</a> <span>/</span> <b>${escapeHtml(templateId)}</b> <span>docs</span></div>
<main>${markdownToHtml(md)}</main>
<script>
function copyCode(btn){
  var code = btn.parentElement.querySelector('code').innerText;
  navigator.clipboard.writeText(code).then(function(){ var o=btn.textContent; btn.textContent='copied'; setTimeout(function(){btn.textContent=o;},1200); });
}
</script>
</body></html>`;
}
