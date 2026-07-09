# MCP Compiler Server — Design Spec

Date: 2026-07-09
Status: Approved for planning

## Purpose

An enterprise-grade MCP (Model Context Protocol) server that provides deterministic,
repeatable web-page data extraction for synthetic testing and automation workflows.
Extraction logic is authored once as a plain JavaScript "template" tied to a domain,
persisted to disk, and re-applied deterministically on every subsequent request against
matching URLs — the "Compiler Pattern": compile an extraction script once, execute it
many times, instead of re-deriving extraction logic per request.

Non-goals: this is not a bot-detection-evasion tool. It does not rotate IPs, does not
bundle anti-fingerprinting plugins, and does not target arbitrary third-party sites at
scale. Stealth configuration exists solely to produce consistent, predictable DOM
rendering for the server's own QA/automation use, not to defeat anti-bot systems.

## Architecture

Four isolated units:

- **types.ts** — Zod schemas (source of truth for validation) + inferred TS types. No logic.
- **storage.ts** — file I/O only: init `./templates/` + `manifest.json` on startup, atomic
  writes, CRUD over manifest entries. No knowledge of Playwright or MCP.
- **engine.ts** — browser automation only: owns the persistent browser instance, executes
  a script against a URL, returns extracted data or throws. No knowledge of the manifest
  or MCP.
- **index.ts** — the only file that wires storage + engine into MCP tools. Owns process
  lifecycle (startup, graceful shutdown, stderr-only logging).

Each unit can be understood, tested, and changed independently: storage and the
domain-matching function are pure and unit-testable without a browser; engine is
integration-tested manually; index.ts is thin wiring.

## Manifest & Domain Matching

Manifest (`templates/manifest.json`) is a map keyed by `templateId`:

```json
{
  "amazon-product": {
    "templateId": "amazon-product",
    "domainPattern": "amazon.com",
    "scriptPath": "templates/amazon-product.js",
    "createdAt": "2026-07-09T00:00:00.000Z",
    "updatedAt": "2026-07-09T00:00:00.000Z"
  }
}
```

- **Upsert by templateId**: registering an existing `templateId` overwrites its script and
  pattern, bumping `updatedAt`.
- **One-active-template-per-domain invariant**: if the incoming `domainPattern` exactly
  matches another entry's `domainPattern`, that other entry is deleted so only one
  templateId ever owns a given domain.
- **Matching algorithm**: parse `targetUrl` with the native `URL` class, lowercase the
  hostname, and match a template if `hostname === domainPattern || hostname.endsWith('.' +
  domainPattern)`. No regex evaluation of user input, no substring-anywhere matching —
  avoids ReDoS and false positives like `amazon.com.evil.net`. When multiple entries could
  match, the entry with the longest `domainPattern` string wins (a simple, deterministic
  proxy for specificity — `smile.amazon.com` outranks `amazon.com`).
- This matching function is a pure, exported function, unit-tested without a browser.

## Engine Behavior

- **Persistent browser, per-request context** (performance-corrected from the original
  draft): `chromium.launch()` runs once at server startup and stays alive for the process
  lifetime. Each `execute_native_extraction` call creates an isolated `browser.newContext()`
  (no shared cookies/cache across requests), opens a page, and the `finally` block calls
  `await context.close()`. The browser itself is closed only on process shutdown
  (`SIGINT`/`SIGTERM` handlers), not per request — avoids the cost of relaunching a full
  Chromium process on every call under concurrent QA runs.
- **Rendering consistency (native only)**: fixed desktop UA, 1280×800 viewport, and
  `addInitScript` to patch `navigator.webdriver`. No `playwright-extra` or
  `puppeteer-extra-plugin-stealth` dependency — native config is sufficient for
  consistent hydration, and a dedicated stealth-fingerprinting library is scoped out as
  it's purpose-built for bot-detection evasion, not QA determinism.
- **Optional proxy passthrough**: `execute_native_extraction` accepts an optional
  `proxyUrl` (e.g. `http://username:password@ip:port`), for routing through authorized
  corporate egress proxies or testing region-specific rendering. Parsed with the native
  `URL` class into Playwright's `context` proxy shape — `{ server: '<protocol>//<host>',
  username, password }` — and passed to `browser.newContext({ proxy })`. No automated
  proxy rotation or pooling logic.
- `goto(url, { timeout: 30_000, waitUntil: 'networkidle' })`.
- `page.evaluate()` the stored script; the result is round-tripped through
  `JSON.stringify`/`parse` to confirm it's JSON-serializable (catches functions, circular
  references, `undefined`).
- **Scheme guard**: `targetUrl` must be `http:`/`https:` — blocks `file://`, `chrome://`,
  etc. A headless browser navigating arbitrary schemes is a local-file-exfiltration risk;
  this is a cheap, non-negotiable check, not full SSRF hardening (out of scope for a local
  stdio tool).
- Every result — success or failure — returns an envelope: `{ success, data?, error?, meta:
  { url, templateId, domainMatched, durationMs, timestamp } }` so callers get
  timing/provenance, not just raw JSON.

## Tool Contracts

- `register_extraction_template`
  - `templateId`: `^[a-z0-9]+(-[a-z0-9]+)*$`
  - `domainPattern`: non-empty, lowercased
  - `executableScript`: non-empty, capped at 100KB
  - Writes `templates/<templateId>.js`, updates manifest atomically.
- `execute_native_extraction`
  - `targetUrl`: absolute URL, `http`/`https` only
  - `templateId`: optional — if omitted, runs domain-matching; no match returns a
    structured error (no silent full-page fallback extraction)
  - `proxyUrl`: optional, parsed as above

## Testing (Vitest)

Unit tests for the two pure, browser-free pieces:
- `storage.ts`: atomic write survives a crash mid-write, init creates missing
  dir/manifest, upsert-by-templateId, delete-on-domain-collision.
- Domain-matching function: exact match, subdomain match, no match, most-specific-wins
  when multiple patterns could match.

No Playwright in the automated test suite (keeps it fast and dependency-free); engine.ts
is verified manually against a real page during implementation.

## Packaging & Deployment

- Git repo committed incrementally as the project is built.
- `Dockerfile`: `node:20-slim`, `npm ci`, `npx playwright install --with-deps chromium`,
  build, run as non-root user.
- `README.md`: install/build commands, Claude Desktop `mcpServers` JSON config, tool
  documentation, and a note on the scheme guard and proxy passthrough's intended use.
- `templates/*.js` and `manifest.json` are tracked in git — they're the reusable
  extraction library the project produces, not throwaway runtime data. Only
  `node_modules/`, `dist/`, and `.env` are gitignored.
