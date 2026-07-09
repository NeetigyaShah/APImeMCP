# MCP Compiler Server

An MCP (Model Context Protocol) server that implements a "Compiler Pattern" for
deterministic web-page data extraction: author a plain JavaScript extraction script
once per domain, and re-run it deterministically against any matching URL — no
external database, no re-derivation of extraction logic per request.

## How it works

1. `register_extraction_template` saves a JavaScript snippet (evaluated inside the
   page's own browser context) to `templates/<templateId>.js` and records the mapping
   from a domain pattern to that script in `templates/manifest.json`.
2. `execute_native_extraction` opens the target URL in an isolated Playwright browser
   context, waits for the page to reach `networkidle`, evaluates the matching script,
   and returns the result.

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
npm test                       # unit tests (storage + validation, no browser)
node scripts/verify-engine.mjs # manual smoke test of the browser engine
node scripts/verify-server.mjs # manual end-to-end smoke test of the full server
```

The two `scripts/verify-*.mjs` smoke tests spin up a local HTTP server and drive a
real headless Chromium instance; they require `npm run build` and
`npx playwright install --with-deps chromium` to have been run first.

## Claude Desktop configuration

Add to your Claude Desktop config (`claude_desktop_config.json`):

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

## Docker

```bash
docker build -t mcp-compiler-server .
docker run -i mcp-compiler-server
```

The image installs Chromium and its OS dependencies at build time
(`npx playwright install --with-deps chromium`) and runs as a non-root user.

## Tools

### `register_extraction_template`

| field | type | notes |
|---|---|---|
| `templateId` | string | lowercase kebab-case, e.g. `amazon-product` |
| `domainPattern` | string | e.g. `amazon.com` — matches that hostname and its subdomains |
| `executableScript` | string | vanilla JavaScript, evaluated via `page.evaluate()`; must return a JSON-serializable value; capped at 100KB |

### `execute_native_extraction`

| field | type | notes |
|---|---|---|
| `targetUrl` | string | absolute `http://` or `https://` URL |
| `templateId` | string, optional | explicit template; if omitted, resolved from `targetUrl`'s domain |
| `proxyUrl` | string, optional | e.g. `http://user:pass@host:port`, passed through to Playwright's `context.newContext({ proxy })` for routing through an authorized egress proxy or testing region-specific rendering. No automated rotation. |

Returns `{ success, data?, error?, meta: { url, templateId, domainMatched, durationMs, timestamp } }`.

## Security notes

- `targetUrl` is restricted to `http:`/`https:` — a headless browser navigating to
  `file://` or other schemes is a local-file-exfiltration risk, so this is enforced
  unconditionally.
- Stealth configuration (fixed user agent, fixed viewport, `navigator.webdriver`
  patch) exists to make DOM rendering deterministic across runs. This server does not
  bundle bot-detection-evasion tooling and does not rotate IPs — `proxyUrl` is a
  single, explicit passthrough for legitimate egress routing, not an anti-ban feature.
