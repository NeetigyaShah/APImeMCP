# Forensic Observability, Dashboard, CLI Runner & Living-Room Template — Design Spec

Date: 2026-07-09
Status: Approved for planning

## Purpose

Four additions to `mcp-compiler-server`:

1. Capture a screenshot + DOM snapshot automatically whenever an extraction fails,
   so a failure is debuggable without re-running it.
2. A local Express dashboard for browsing registered templates and triggering a run
   without needing an MCP client.
3. A standalone CLI script so a registered template can be invoked directly (e.g.
   from cron) without going through the MCP protocol at all.
4. A new `bernhardt-living-room` template, registered through the existing
   `register_extraction_template` tool like any other template — this is a content
   addition and a live end-to-end test of items 1 and 3, not new server code.

## Phase 1: Forensic capture on extraction failure (`src/engine.ts`)

`executeExtraction` wraps its `page.goto()` + `page.evaluate()` sequence (currently
unguarded) in a try/catch, inside the existing context/`finally` block so the page
is still alive when a failure is caught:

- On catch: ensure `output/logs/` exists (`fs.mkdir(..., { recursive: true })`).
- Build a prefix: `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  — timestamp for human sorting, short random suffix so two extractions failing in
  the same millisecond (a scheduled job and a dashboard-triggered run overlapping,
  for instance) don't collide.
- `await page.screenshot({ path: 'output/logs/<prefix>-screenshot.png', fullPage: true })`.
- `await fs.writeFile('output/logs/<prefix>-dom.html', await page.content())`.
- Throw a new `Error` whose message includes the original failure's message plus
  both artifact paths, e.g. `Extraction failed: <original message> (forensic
  artifacts: output/logs/<prefix>-screenshot.png, output/logs/<prefix>-dom.html)`.
- If the screenshot/DOM-dump calls themselves throw (e.g. page already closed),
  catch that separately and fall back to throwing the original error unadorned —
  forensic capture must never mask the real failure or throw a *different*,
  more confusing error.

`output/` is already gitignored (added in an earlier session) — no change needed
there, just confirming it stays that way.

## Phase 2: Dashboard (`src/index.ts` + `express` dependency)

- `npm install express` (+ `@types/express` dev dependency for strict TS).
- Started inside `main()`, after the MCP transport connects, bound to
  `127.0.0.1:3000` only (never `0.0.0.0` — the dashboard can trigger scraping jobs
  with no auth, so it must not be reachable from the network).
- If `listen()` fails (e.g. `EADDRINUSE`), log a warning via the existing `log()`
  helper and continue — a dashboard port conflict must not prevent the actual MCP
  server (the thing an agent depends on) from starting.
- `GET /`: reads `templates/manifest.json` fresh on every request (so newly
  registered templates appear without a server restart), renders a small styled
  HTML page — one card per template (`templateId`, `domainPattern`, `updatedAt`),
  each with a URL text input and a "Run Now" button. Plain inline `<style>` and a
  small vanilla-JS `fetch()` call on click, no client framework/build step.
- `GET /api/run/:templateId?url=<targetUrl>`: validates `templateId` matches the
  existing kebab-case pattern and `url` passes the existing `isHttpUrl` check,
  returning 400 with a clear message on either failure. On valid input, calls the
  **same shared `runExtraction()` helper** `execute_native_extraction` and the
  scheduler already use (not a raw call to `engine.executeExtraction`, which only
  accepts an already-resolved `scriptPath`, not a `templateId`) — this means a
  dashboard-triggered run gets metric logging and TUI progress reporting for free,
  identically to any other trigger path. Returns the `ExtractionResult` JSON
  directly as the response body for the dashboard's fetch call to render.

## Phase 3: CLI runner (`scripts/run.mjs`)

`node scripts/run.mjs <templateId> <targetUrl>`:

- Validates both CLI args are present; prints usage and exits 1 if not.
- Spawns the compiled server (`dist/index.js`) as a child process via
  `StdioClientTransport` + `Client`, exactly like the existing
  `scripts/verify-server.mjs` pattern — each invocation gets its own fresh browser
  lifecycle, matching how a cron-triggered process normally works (no persistent
  daemon to manage).
- Calls `execute_native_extraction` with the given `templateId`/`targetUrl`, prints
  the JSON result to stdout, and exits `0` on `success: true` or `1` otherwise —
  cron-friendly exit codes.

## Phase 4: `bernhardt-living-room` template (content, not code)

Registered via the existing `register_extraction_template` tool — no new server
capability, and serves as the live end-to-end test for Phases 1 and 3 (a real
paginated extraction that can legitimately fail partway through, and a real
target for the CLI runner).

Verified against the live page
(`https://www.bernhardt.com/products/luxury-living-room-furniture#?RoomType=Living...`):
same AngularJS `.grid-item` grid as `bernhardt-bed-listing`, same click-based
"Next ›" pagination derived from the "Showing X-Y of TOTAL" pager text (currently
1,104 items / 48 per page ≈ 23 pages) — **not** scroll-based; scrolling was tested
live and does nothing on this site. The script reuses the exact pagination logic
already proven in `bernhardt-bed-listing.js`.

Extracted fields per product: `title` (`.product-header` text), `price`
(`.price-component` text — verified via live markup inspection to be an Angular
`ngIf` gated on `hasPermission('SeePrice')` / `showUnauthenticatedPrice`, both false
for an anonymous session, so this will be an empty string for every product; no
login flow exists or is in scope, so the field is extracted as-is rather than
faked), `imageUrl` (`img.grid-image` `src`), `productUrl` (kept for consistency
with the sibling bedroom template).

## Testing

- Phase 1: manually trigger a failure (e.g. register a template with a script that
  throws, or point at a URL that 404s) and confirm the screenshot + HTML dump land
  in `output/logs/` and the thrown error message includes both paths.
- Phase 2: start the server, hit `http://127.0.0.1:3000/` with a real HTTP request,
  confirm the registered templates render as cards, click "Run Now" (or call
  `/api/run/:templateId` directly) against a real URL and confirm live JSON comes
  back.
- Phase 3: run `node scripts/run.mjs bernhardt-living-room <url>` for real, confirm
  exit code 0 and JSON output on success.
- Phase 4: register the template, run a real (partial, time-boxed) extraction
  against the live page and confirm the returned objects have the expected shape;
  full 23-page runs are the CLI/dashboard's job to run when actually wanted, not
  something the test suite does automatically.

No new Vitest unit tests are required — Phases 2-4 are only meaningfully verified
against a real browser/real HTTP server/the live target site, consistent with how
`engine.ts` itself has no unit tests in this project.
