# APImeMCP

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

## Using a template without an MCP client or the dashboard UI

Every registered template is also a plain HTTP endpoint on the running server, so you
can call it straight from a terminal — no Claude Code, no clicking the dashboard:

```bash
curl -X POST http://127.0.0.1:3000/api/run/<templateId> \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/page"}'     # omit url for fixed-target / recorded templates: -d '{}'
```

Each template gets two auto-generated artifacts (written on registration, regenerate all
with `node scripts/gen-usage.mjs`):

- **`apis/<templateId>.md`** — a copy-paste guide, filled in with that template's real
  last-run URL. The dashboard's per-template rows link to a rendered version (the "Docs"
  button → `/docs/<templateId>`).
- **`apis/<templateId>.mjs`** — a uniquely-named, fully **standalone** script that embeds
  that template's entire logic. Its only dependency is Playwright, so anyone can grab the
  one file and run it with no APImeMCP server and no repo:

  ```bash
  npm i playwright && npx playwright install chromium
  node <templateId>.mjs            # extraction: pass a URL if the template needs one
  node <templateId>.mjs --watch    # action-sequence: visible browser
  ```

See `apis/README.md` for the index once you've registered at least one template.

## Using a community template (public registry)

```bash
apimemcp add <domain>
```

Fetches the matching template from the [apimemcp-templates](https://github.com/NeetigyaShah/APImeMCP-Templates)
registry and registers it locally — no browser/dashboard startup, just a fetch +
local write. Works from a fresh install with no existing `templates/` directory.
See `add_community_template` under Tools for the MCP-tool equivalent, and the
registry repo's own `CONTRIBUTING.md` to add a template.

## Connected app profiles (no manual cookie extraction)

For sites that require login, use a persistent browser profile instead of copying
cookies into chat. Each connection gets its own Chromium profile under
`templates/app-profiles/<connectionId>/` and is scoped to one domain pattern.

An agent can start the login flow:

```js
await client.callTool({
  name: 'connect_app',
  arguments: {
    connectionId: 'amazon',
    domainPattern: 'amazon.com',
    loginUrl: 'https://www.amazon.com/ap/signin',
    autoStart: true
  }
});
```

APImeMCP opens a visible browser window. Log in normally in that window, then
confirm the connection:

```js
await client.callTool({
  name: 'confirm_app_connection',
  arguments: { connectionId: 'amazon' }
});
```

Use the connection on an extraction:

```js
await client.callTool({
  name: 'execute_native_extraction',
  arguments: {
    templateId: 'amazon-product',
    targetUrl: 'https://www.amazon.com/dp/EXAMPLE',
    connectionId: 'amazon'
  }
});
```

Connections with `autoStart: true` reopen their persistent browser profiles when
the MCP server starts. The server does not scrape or print cookies; Chromium owns
the session state. The profile directories are still sensitive login material and
must not be committed or shared. Use `list_app_connections` to inspect configured
profiles. Native OAuth/API connectors for services such as Slack or Google Drive
can be added later as a separate connector type when the provider's client ID,
scopes, and callback policy are known.

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

Three ways to connect, in order of preference. All three register a server named
`apimemcp`; `--scope user` makes it available in every project and session (drop
that flag to scope it to just the current project).

#### Option A — global install (recommended, confirmed working)

```bash
npm install -g @neetigyashah/apimemcp
claude mcp add --scope user --transport stdio apimemcp -- apimemcp
claude mcp list
```

The last command should show `apimemcp ... ✔ Connected`. The install step also
fetches the Chromium binary Playwright needs (`postinstall`), and no git clone or
TypeScript build is involved.

**Updating**: `npm update -g @neetigyashah/apimemcp`, then restart your Claude Code
session.

#### Option B — `npx`, no persistent install

```bash
claude mcp add --scope user --transport stdio apimemcp -- npx -y @neetigyashah/apimemcp
claude mcp list
```

Worth trying if you'd rather not install anything globally. **If `claude mcp list`
shows it connected, you're done** — nothing further to read here.

If instead it shows `✘ Failed to connect`: this is a known, confirmed-reproducible
`npx` bug on some npm/Windows combinations, unrelated to this package specifically
(the package's own shim scripts run correctly when invoked directly — `npx` itself
fails to put its cache directory on the child process's `PATH` before executing).
Remove the failed registration and use Option A instead:

```bash
claude mcp remove apimemcp -s user
```

**Updating**: nothing to do — `npx` re-resolves against the registry each launch.

#### Option C — from source (for modifying the code)

```bash
git clone https://github.com/NeetigyaShah/APImeMCP.git
cd APImeMCP
npm install && npm run build
claude mcp add --scope user --transport stdio apimemcp -- node /absolute/path/to/APImeMCP/dist/index.js
```

**Updating**: `git pull && npm install && npm run build` in that directory, then
restart your Claude Code session — it runs from the compiled `dist/`, not the
TypeScript source directly, so pulling alone isn't enough.

#### All options: staying current

Whichever option you used, the server tells you when a newer version exists on its
own: `checkForUpdates()` compares against the latest commit on GitHub at startup
and logs `UPDATE AVAILABLE: ...`, and the `status://server` MCP resource exposes
`updateAvailable: true/false` so an agent can check programmatically instead of you
watching stderr.

#### Optional: the `using-apimemcp` skill

The package ships a Claude Code skill (`skills/using-apimemcp/SKILL.md`) that
teaches an agent this server's tool signatures and the compiler-pattern
workflow up front, so it doesn't need to rediscover them by trial and error
each session. Activate it once per machine:

```bash
mkdir -p ~/.claude/skills/using-apimemcp
cp "$(npm root -g)/@neetigyashah/apimemcp/skills/using-apimemcp/SKILL.md" ~/.claude/skills/using-apimemcp/SKILL.md
```

(from source: `cp skills/using-apimemcp/SKILL.md ~/.claude/skills/using-apimemcp/SKILL.md`)

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apimemcp": {
      "command": "node",
      "args": ["/absolute/path/to/APImeMCP/dist/index.js"]
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
docker build -t apimemcp .
docker run -i apimemcp
```

The image installs Chromium and its OS dependencies at build time
(`npx playwright install --with-deps chromium`) and runs as a non-root user.

## Recorder extension (record-once, replay via APImeMCP)

`extension/` is a Chrome MV3 extension, separate from the npm package - it's not
included in the published tarball, so get it by cloning this repo. It records
clicks/typing/navigation in a normal browser tab, then sends the recording (plus
cookies for replay) to this server's `POST /api/recordings` endpoint, which
registers it as a new **action-sequence** template - a different kind from the
page.evaluate() extraction templates above: instead of returning scraped data, it
replays the literal recorded steps (click, fill, select, navigate) headlessly via
Playwright, useful for repeating a workflow (e.g. "post a video," "submit a form")
rather than extracting a page's contents. It's auto-verified once immediately after
registering, and shows up in the dashboard alongside extraction templates with an
"action-sequence" badge and a pass/fail status dot. See `extension/README.md` for
how to load it (`chrome://extensions` → Developer mode → Load unpacked).

Action-sequence templates get a second **Watch** button next to Run - it replays the
same steps but launches a separate, visible browser window instead of using the
shared headless one, so you can watch it actually click through the recorded steps.
The window closes itself ~1.5s after finishing. Extraction templates don't get this
button; watching a `page.evaluate()` scrape execute isn't the point the way watching
a recorded workflow replay is.

## Tools

### `register_extraction_template`

Save a reusable extraction script for a domain.

| field | type | notes |
|---|---|---|
| `templateId` | string | lowercase kebab-case, e.g. `amazon-product` |
| `domainPattern` | string | e.g. `amazon.com` — matches that hostname and its subdomains |
| `executableScript` | string | vanilla JavaScript, evaluated via `page.evaluate()`; must return a JSON-serializable value; capped at 100KB |
| `fixedTargetUrl` | string, optional | for a template that always targets the same page (e.g. "today's deals") — set this and `execute_native_extraction` can omit `targetUrl` entirely. Marked with a ★ badge in the dashboard. |
| `waitStrategy` | `'domcontentloaded'\|'load'\|'networkidle'`, optional | how long to wait after navigation before running the script. Omit it and new templates default to the fast `domcontentloaded`; templates registered before this field existed were migrated to explicit `networkidle` (their original behavior) so nothing broke retroactively. Set `networkidle` explicitly if a page populates its data asynchronously after the initial HTML loads (e.g. a paginated grid) and `readySelector` isn't a better fit. |
| `readySelector` | string, optional | wait for this selector to appear before running the script — a more precise alternative to `networkidle` when you know exactly what element indicates "the data is ready." |

Returns the saved `{ templateId, domainPattern, scriptPath, fixedTargetUrl?, waitStrategy?, readySelector?, createdAt, updatedAt }`.
Re-registering an existing `templateId` with the same script but a new `waitStrategy`/`readySelector` updates just that setting (upsert semantics).

By default, `execute_native_extraction` also blocks images/media/fonts/CSS for extraction
templates (not for recorded/action-sequence ones) to speed up runs — pass
`simulateLowBandwidth: false` explicitly to disable this for one call.

### `add_community_template`

Pull a pre-verified template from the public
[apimemcp-templates](https://github.com/NeetigyaShah/APImeMCP-Templates) registry (a
plain git repo, mirrored free via jsDelivr — no server, no publish step beyond a merged
PR) and register it locally.

| field | type | notes |
|---|---|---|
| `domain` | string | e.g. `amazon.com` — matched against the registry's templates by domain, longest-pattern-wins |

Registry templates are marked `source: 'registry'` in your local manifest and run with a
**network allowlist enforced by default** (only the template's own domain, plus a small
curated CDN/asset allowlist) — a community template can't exfiltrate scraped data or ride
your session to an arbitrary endpoint. Locally-authored templates are untouched by this —
trusted by definition, same as always. Same functionality is available from the shell
without an MCP client: `apimemcp add <domain>` (no browser/dashboard startup, just a
fetch + local registration).

### `execute_native_extraction`

Run a registered template against a URL.

| field | type | notes |
|---|---|---|
| `targetUrl` | string, optional | absolute `http://` or `https://` URL. Omit only when `templateId` refers to a template registered with `fixedTargetUrl` — that URL is used automatically. |
| `templateId` | string, optional | explicit template; if omitted, resolved from `targetUrl`'s domain (in which case `targetUrl` is required) |
| `connectionId` | string, optional | confirmed persistent browser profile created by `connect_app`; must match the target domain; cannot be combined with manual cookie input |
| `proxyUrl` | string, optional | e.g. `http://user:pass@host:port`, passed through to Playwright's `context.newContext({ proxy })` for routing through an authorized egress proxy or testing region-specific rendering. No automated rotation. |

Returns `{ success, data?, error?, meta: { url, templateId, domainMatched, durationMs, timestamp } }`.
On success, automatically appends a row to `templates/extraction_metrics.csv`
(see `get_extraction_stats` below) — no separate step required.

If the resolved template was registered as an **action-sequence** (via the recorder
extension's `/api/recordings` endpoint, not `register_extraction_template`), this
replays the recorded click/fill/select/navigate steps headlessly instead of running a
`page.evaluate()` script — `data` is just `{ completedSteps }` rather than scraped
content. See "Recorder extension" above.

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

### `save_template_cookies`

Persist session cookies for a template so the dashboard can reuse them — without
running an extraction.

| field | type | notes |
|---|---|---|
| `templateId` | string | the template the cookies belong to |
| `cookieString` | string | `name=value; name2=value2` session cookies |

Saves to `templates/saved-cookies.json`. The dashboard then shows a **🔑 cookies
saved** badge and a **🔑 Use saved cookies** button on that template's row. Cookies
also passed via `execute_native_extraction`'s `cookieString` are saved the same way
automatically. Own accounts/domains only — these are live session credentials.

### `connect_app`

Open or configure a persistent browser profile for a logged-in site. The visible
browser window is intentionally user-driven: complete login there, then call
`confirm_app_connection`.

| field | type | notes |
|---|---|---|
| `connectionId` | string | lowercase kebab-case profile name, e.g. `amazon` |
| `domainPattern` | string | domain that owns the login profile |
| `loginUrl` | string | absolute `http://`/`https://` URL under the domain |
| `autoStart` | boolean, optional | reopen this profile when the server starts |

### `confirm_app_connection`

Mark a visible profile ready for extraction after login.

| field | type | notes |
|---|---|---|
| `connectionId` | string | configured profile to confirm |

### `list_app_connections`

No input. Returns configured connection IDs, domain scopes, startup behavior, and
confirmation status. It never returns cookie values.

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
