---
name: using-apimemcp
description: Use when asked to build a data-extraction API, scraper, downloader, scheduled monitor, or record-and-replay browser workflow for a specific website, or when APImeMCP MCP tools (register_extraction_template, execute_native_extraction, save_template_cookies, batch_download_assets, schedule_stock_check) are available for the task.
---

# Using APImeMCP

## Overview

apimemcp is a "compiler pattern" MCP server: you register a small piece of logic once
per domain, then re-run it deterministically. There are two kinds of template:

- **Extraction** (`register_extraction_template` → `execute_native_extraction`): a
  JavaScript script run inside a real, isolated Playwright/Chromium context via
  `page.evaluate()`. The script can do DOM queries, or just `fetch()` a JSON endpoint
  directly if one exists — "extraction script" means "any JS that returns
  JSON-serializable data from inside the page." Returns the scraped data.
- **Action-sequence** (created by the recorder Chrome extension, not a tool): a
  recorded browser workflow — click, fill, navigate, submit — replayed step by step.
  For *doing* a task (log in, post, submit a form), not scraping. Registered by the
  extension POSTing to the server's `/api/recordings`; run the same way via
  `execute_native_extraction` with its `templateId`.

Every registered template is simultaneously three things: an MCP tool call, a plain
HTTP endpoint (`POST http://127.0.0.1:3000/api/run/<id>`), and a uniquely-named
standalone script (`apis/<id>.mjs`, only needs Playwright — no server/repo). Each
also gets an auto-generated console guide (`apis/<id>.md`, rendered at `/docs/<id>`).

## Before writing any script: check for a real API first

Scraping a rendered DOM is the fallback, not the default. Many sites you'd think to
scrape already expose the data as JSON to their own frontend.

```dot
digraph decision {
  "Need data from a site" [shape=box];
  "Does it have a public/official API for this?" [shape=diamond];
  "Does the site's own frontend fetch JSON internally?" [shape=diamond];
  "Register a template that fetch()s that API/endpoint" [shape=box];
  "Register a template that queries the DOM" [shape=box];

  "Need data from a site" -> "Does it have a public/official API for this?";
  "Does it have a public/official API for this?" -> "Register a template that fetch()s that API/endpoint" [label="yes"];
  "Does it have a public/official API for this?" -> "Does the site's own frontend fetch JSON internally?" [label="no"];
  "Does the site's own frontend fetch JSON internally?" -> "Register a template that fetch()s that API/endpoint" [label="yes"];
  "Does the site's own frontend fetch JSON internally?" -> "Register a template that queries the DOM" [label="no"];
}
```

To check the middle branch empirically (don't guess): load the target page with
`chromium.launch()` + `page.on('response', ...)`, filter for `content-type: json`,
and look at what the page itself requests. A five-line probe script beats
DOM-scraping every time it finds something — fewer moving parts, survives site
redesigns, gets fields the DOM never renders (exact prices, dimensions, etc.).

This determines *how* the script works, not *whether* to use apimemcp — either way
the result gets registered as a normal template. Building infrastructure to defeat
rate limits, auth walls, or ToS on a specific target is a separate, real decision —
apply the same judgment here you'd apply to writing that code by hand.

## Tools (exact signatures)

| Tool | Input | Notes |
|---|---|---|
| `register_extraction_template` | `templateId` (kebab-case), `domainPattern`, `executableScript`, `fixedTargetUrl?` | Upserts by `templateId`. Multiple templates can share a `domainPattern` (N:1) — always pass explicit `templateId` when more than one template targets the same domain, auto-match-by-URL is only reliable for a domain's single most-recently-registered template. Set `fixedTargetUrl` when the page never varies (see below). |
| `execute_native_extraction` | `targetUrl?`, `templateId?`, `proxyUrl?`, `cookieString?` | Runs an extraction OR an action-sequence template (dispatched by kind). `targetUrl` is only optional for a `fixedTargetUrl` template. `cookieString` (`name=value; name2=value2`) runs it as a logged-in user AND is auto-saved for that template (see below). Logs a metric on success. |
| `save_template_cookies` | `templateId`, `cookieString` | Persist session cookies for a template **without running it** — use this when the user mentions/shares cookies in chat so they land in the dashboard. |
| `batch_download_assets` | `urls: string[]`, `outputDir` | Concurrency-limited (5 at a time). Use for "download the images" rather than a hand-rolled fetch loop. |
| `schedule_stock_check` | `targetUrl`, `cronExpression` (5-field only), `templateId?` | Persists across restarts. |
| `get_extraction_stats` | none | Totals, recent domains, last run — read this instead of re-deriving from raw files. |
| `send_notification` | `endpointUrl`, `message` | Generic webhook POST. |

Action-sequence templates are **created by the recorder extension** (it POSTs recorded
steps + cookies to `/api/recordings`), not by a tool — there's no "register workflow"
tool. You run them via `execute_native_extraction`.

Resource `status://server` and dashboard `http://127.0.0.1:3000` (if running) expose
the same data for inspection — check `status://server` before assuming the browser
isn't ready.

## What this server can do (capabilities)

- **Extraction APIs** — register a per-domain script, run it deterministically; returns JSON.
- **Recorded workflow replay** — a Chrome extension records real clicks/typing/navigation,
  compiles them to an action-sequence template that replays headlessly (login, post, submit).
- **Watch mode** — action-sequence templates can run in a visible browser window
  (dashboard "Watch" button, or HTTP `{"headful":true}`) so you can see them execute.
- **Logged-in runs + saved cookies** — supply `cookieString` (via the tool or the
  dashboard cookie box); it's saved per template, and the dashboard shows a "Use saved
  cookies" button to re-run without re-pasting.
- **Batch image download** — `batch_download_assets`, or the standalone script's
  `--download` flag which saves every image URL in a result to a folder.
- **Every template is portable** — also reachable as an HTTP endpoint and as a
  standalone `apis/<id>.mjs` (only needs Playwright), each with a generated docs page
  at `/docs/<id>`.
- **Scheduling, metrics, notifications** — cron re-runs, run stats, webhook pings.

## Templates with no per-run input ("fixed-target")

Some requests don't have a URL that varies per call — "get me today's top deals on
Amazon" always hits the same deals page; there's nothing for a caller to supply.
Register those with `fixedTargetUrl` set to that one page, and call
`execute_native_extraction` with just `templateId` — no `targetUrl`. The dashboard
marks these with a ★ badge instead of a URL input, so they're visually distinct
from templates that need a per-call target. Don't ask the caller for a URL a
fixed-target template doesn't need.

## Defaults — don't ask, just pick these unless told otherwise

- **Deliverable shape:** a plain JSON result (via `execute_native_extraction`'s
  return value, or files on disk from `batch_download_assets`). Do not build a web
  viewer/UI unless the user asks for one to *look at* something — most requests to
  "make an API for X" want data, not a page.
- **Images:** if the extracted data includes image URLs and the request is
  data-oriented ("get me all the X"), download them with `batch_download_assets`
  into a clearly-named folder rather than only returning URLs — a folder of files
  is a more complete answer than a list of links the user then has to fetch
  themselves.
- **Auth/API keys:** this is the one thing you genuinely can't decide yourself —
  if the best path needs a key (e.g., a first-party API that requires one), ask for
  it once, don't substitute scraping to avoid asking.
- **Cookies mentioned in chat:** when the user shares session cookies for a site,
  persist them to the relevant template with `save_template_cookies` (or pass
  `cookieString` when running) so they show up in the dashboard's saved-cookies store
  — don't use them once and drop them.

## Verify empirically before committing to a script

Every one of these was a real bug hit while building and using this server —
guessed instead of checked, cost a rewrite:

- Pagination style (click-through vs. infinite scroll) — different sites do both;
  a quick live probe (scroll, check if item count changes) settles it in seconds.
- Whether a field (e.g. price) actually renders for an anonymous session — some
  data is login-gated; check the live DOM/response before assuming a selector is
  wrong.
- The exact request shape of a discovered JSON endpoint (query params, headers) —
  capture it from a real `page.on('response')` listener, don't hand-guess the URL.

Write one small probe (fetch or DOM query, console.log the shape), confirm it
matches expectations, *then* register the real template. Skipping the probe is the
single most common source of a wrong-on-first-try template.

## Common mistakes

- Treating "make an API for X" as "must use apimemcp" even when X has its own
  public API that's faster and more reliable — see decision flowchart above.
- Registering a second template for a domain that already has one and expecting
  the first to still auto-match by URL (it won't — pass explicit `templateId`).
- Building a full dashboard/viewer page when the user just wanted data back.
