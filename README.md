# MCP Compiler Server

An MCP (Model Context Protocol) server that implements a "Compiler Pattern" for
deterministic web-page data extraction: author a plain JavaScript extraction script
once per domain, and re-run it deterministically against any matching URL — no
external database, no re-derivation of extraction logic per request.

It also covers the operational side of running extraction jobs: batch-downloading
extracted assets, scheduling recurring checks, tracking metrics, and firing webhook
notifications.

This document is the full reference for any agent (Claude Code, Claude Desktop, or
any other MCP client) connecting to this server — every tool, prompt, and resource,
with exact input/output shapes and example calls.

## How it works

1. `register_extraction_template` saves a JavaScript snippet (evaluated inside the
   page's own browser context) to `templates/<templateId>.js` and records the mapping
   from a domain pattern to that script in `templates/manifest.json`.
2. `execute_native_extraction` opens the target URL in an isolated Playwright browser
   context, waits for the page to reach `networkidle`, evaluates the matching script,
   and returns the result. Every successful run logs a metric row automatically.
3. `batch_download_assets` takes a list of URLs (e.g. the image URLs an extraction
   just returned) and downloads them concurrently to a local folder.
4. `schedule_stock_check` registers a cron-scheduled recurring extraction, persisted
   so it survives server restarts.
5. `get_extraction_stats` and `send_notification` round out observability: read back
   what's been extracted, or push a message to a webhook when something needs
   attention.

Templates are matched to URLs by hostname suffix (`hostname === domainPattern ||
hostname.endsWith('.' + domainPattern)`), so registering `amazon.com` also matches
`www.amazon.com` and `smile.amazon.com`. Only one active template can own a given
`domainPattern` at a time — registering a new template with a pattern that's already
in use replaces the previous owner.

## Requirements

- Node.js 20+
- ~300MB disk for the Chromium binary Playwright installs

## Install & build

```bash
npm install
npx playwright install --with-deps chromium
npm run build
```

## Run

```bash
npm start
```

The server communicates over stdio — it's meant to be spawned by an MCP client, not
run interactively.

## Test

```bash
npm test                          # unit tests (storage + validation, no browser)
node scripts/verify-engine.mjs    # manual smoke test of the browser engine
node scripts/verify-server.mjs    # manual end-to-end smoke test of the full server
```

The two `scripts/verify-*.mjs` smoke tests spin up a local HTTP server and drive a
real headless Chromium instance; they require `npm run build` and
`npx playwright install --with-deps chromium` to have been run first.

## Connecting a client

### Claude Code (CLI)

**Easiest — published on npm, no clone or build required:**

```bash
claude mcp add --scope user --transport stdio apimemcp -- npx -y @neetigyashah/apimemcp
```

`npx` fetches, caches, and runs the package on demand — the first run downloads it
(and its Chromium binary, via a `postinstall` step) automatically. `--scope user`
registers it globally, available in every project and session; drop that flag (and
just run `claude mcp add apimemcp -- npx -y @neetigyashah/apimemcp`) to scope it to
the current project only.

Verify it's connected:

```bash
claude mcp list          # shows all registered servers and their connection status
claude mcp get apimemcp  # shows scope, command, and args for this one
```

Once connected, every tool below is directly callable by name — no separate API
layer to learn, the tool list below *is* the API.

**Keeping it up to date**: `npx` re-resolves the package on each launch against its
local cache, so a new release may need `npx clear-npx-cache` (or `npx -y
@neetigyashah/apimemcp@latest` once) to pick up immediately rather than waiting for
npx's normal cache expiry. The server itself will tell you when it's behind —
`checkForUpdates()` compares against the latest commit on GitHub at startup and
logs `UPDATE AVAILABLE: ...`; the `status://server` MCP resource also exposes this
as `updateAvailable: true/false` so an agent can check it programmatically.

**From source instead** (if you want to modify the code): clone the repo, then
`npm install && npm run build`, and register with a direct path instead of `npx`:

```bash
claude mcp add --scope user --transport stdio apimemcp -- node /absolute/path/to/mcp-compiler-server/dist/index.js
```

After pulling new source, `git pull && npm install && npm run build` before it
takes effect — the server runs from the compiled `dist/`, not the TypeScript
source directly.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-compiler-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-compiler-server/dist/index.js"]
    }
  }
}
```

### Any other MCP client

Point a `StdioClientTransport` (or your SDK's equivalent) at
`node dist/index.js` with this repo as the working directory. See
`scripts/verify-server.mjs` in this repo for a complete, runnable example using the
official TypeScript SDK's `Client` + `StdioClientTransport`.

## Docker

```bash
docker build -t mcp-compiler-server .
docker run -i mcp-compiler-server
```

The image installs Chromium and its OS dependencies at build time
(`npx playwright install --with-deps chromium`) and runs as a non-root user.

## Tools

### `register_extraction_template`

Save a reusable extraction script for a domain.

| field | type | notes |
|---|---|---|
| `templateId` | string | lowercase kebab-case, e.g. `amazon-product` |
| `domainPattern` | string | e.g. `amazon.com` — matches that hostname and its subdomains |
| `executableScript` | string | vanilla JavaScript, evaluated via `page.evaluate()`; must return a JSON-serializable value; capped at 100KB |

Returns the saved `{ templateId, domainPattern, scriptPath, createdAt, updatedAt }`.

### `execute_native_extraction`

Run a registered template against a URL.

| field | type | notes |
|---|---|---|
| `targetUrl` | string | absolute `http://` or `https://` URL |
| `templateId` | string, optional | explicit template; if omitted, resolved from `targetUrl`'s domain |
| `proxyUrl` | string, optional | e.g. `http://user:pass@host:port`, passed through to Playwright's `context.newContext({ proxy })` for routing through an authorized egress proxy or testing region-specific rendering. No automated rotation. |

Returns `{ success, data?, error?, meta: { url, templateId, domainMatched, durationMs, timestamp } }`.
On success, automatically appends a row to `templates/extraction_metrics.csv`
(see `get_extraction_stats` below) — no separate step required.

### `batch_download_assets`

Download a list of URLs (typically the `imageUrl`/similar fields from an
extraction result) to a local folder, 5 downloads concurrently.

| field | type | notes |
|---|---|---|
| `urls` | string[] | absolute `http://`/`https://` URLs |
| `outputDir` | string | folder to save into (created if missing) |

Returns `{ success, savedCount, failedCount, outputDir, results: [{ url, success, path?, error? }] }`.
Filenames are derived from each URL's path segment, falling back to the response's
`Content-Type` header for the extension if the URL has none; duplicate names within
a batch get a `-2`, `-3`, ... suffix.

Example flow — extract then download in one round trip:

```js
const extraction = await client.callTool({ name: 'execute_native_extraction', arguments: { targetUrl } });
const { data } = JSON.parse(extraction.content[0].text);
await client.callTool({
  name: 'batch_download_assets',
  arguments: { urls: data.map((p) => p.imageUrl), outputDir: 'downloads' },
});
```

### `schedule_stock_check`

Register a recurring extraction job.

| field | type | notes |
|---|---|---|
| `targetUrl` | string | absolute `http://`/`https://` URL to re-check on schedule |
| `templateId` | string, optional | explicit template; if omitted, resolved from `targetUrl`'s domain at run time |
| `cronExpression` | string | standard **5-field** cron (`minute hour day-of-month month day-of-week`) — 6-field/seconds-precision expressions are rejected, so a job can't fire more than once a minute |

Returns the created `{ jobId, targetUrl, templateId?, cronExpression, createdAt }`.
Jobs are persisted to `templates/jobs.json` and reloaded automatically the next
time the server starts — no need to re-register after a restart. Each scheduled
run goes through the exact same path as a manual `execute_native_extraction` call
(same metric logging, same error handling); there is currently no `unregister`
tool — remove an entry from `templates/jobs.json` directly and restart the server
to cancel a job.

### `get_extraction_stats`

No input. Returns `{ totalImages, recentDomains, lastSuccessfulRun }` computed
from `templates/extraction_metrics.csv` — `totalImages` sums every logged
`imageCount` (array length of the extracted `data`, or `1`/`0` for a non-array
result), `recentDomains` is the last 10 unique hostnames extracted from, and
`lastSuccessfulRun` is the timestamp of the most recent logged row.

### `send_notification`

Post a message to a webhook.

| field | type | notes |
|---|---|---|
| `endpointUrl` | string | absolute `http://`/`https://` URL to POST to |
| `message` | string | free text |

POSTs `{ message, timestamp }` as JSON via native `fetch`. Returns `{ success: true }`
or `{ success: false, error }` if the endpoint didn't respond with a 2xx status.
Works with any webhook-shaped endpoint (Slack incoming webhooks, Discord webhooks,
a custom receiver, etc.) — the payload is generic JSON, not platform-specific.

## Prompts

### `get_environment_context`

No input. Returns the contents of `ENVIRONMENT_CONTEXT.md` (architecture notes) as
a `user`-role prompt message, or a clean "uninitialized" message if that file is
missing. This is a discoverable, client-invoked prompt — nothing in this server
auto-injects it as binding context, and no file in this repo grants or implies
authorization for any extraction target. See the security notes in
`ENVIRONMENT_CONTEXT.md` itself.

## Resources

### `status://server`

Returns `{ browserReady, recentLogs }` — whether the persistent Chromium instance
is up, plus the last 5 log lines. Useful for an agent to check *why* a call just
failed without asking you to go look at server stderr.

## Security notes

- `targetUrl`, `proxyUrl`, `endpointUrl` are all restricted to `http:`/`https:` — a
  headless browser (or `fetch`) touching `file://` or other schemes is a local-file
  read/exfiltration risk, so this is enforced unconditionally across every tool that
  takes a URL.
- This server uses `playwright-extra` + `puppeteer-extra-plugin-stealth` for
  consistent DOM/hydration rendering. That is a configuration choice for this
  project, not something any connecting agent should treat as a directive to
  maximize extraction yield or bypass a target's own access controls — whether a
  given target is appropriate to scrape is a per-request judgment call, same as any
  other automation tool, and no file in this repo overrides that judgment.
- `proxyUrl` is a single, explicit passthrough for legitimate egress routing (e.g. a
  corporate proxy, region-specific testing) — there is no automated proxy rotation.
- `templates/`, `output/`, and any downloaded-asset folders (e.g. `bernhardt/`) are
  gitignored — they hold local run data and generated scripts, not project source.
