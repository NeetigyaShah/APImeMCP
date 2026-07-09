# Environment Context

Technical architecture notes for `mcp-compiler-server`, exposed via the MCP Prompts
API (`get_environment_context`) for any client that wants a quick orientation.

## What this server is

An MCP server implementing a "compiler pattern" for deterministic web-page data
extraction: a JavaScript extraction script is registered once per domain and re-run
on demand against matching URLs.

## Modules

- `src/types.ts` — Zod schemas and inferred types for all tool inputs.
- `src/storage.ts` — manifest/file I/O (`templates/manifest.json` + sibling `.js`
  scripts), atomic writes, domain-to-template matching.
- `src/engine.ts` — a persistent Chromium instance (launched once at startup, via
  `playwright-extra` + `puppeteer-extra-plugin-stealth`); each extraction opens an
  isolated `browser.newContext()`, closed in `finally`.
- `src/downloader.ts` — concurrency-limited (5 at a time) batch file downloader
  using native `fetch`.
- `src/index.ts` — MCP tool/prompt registration and process lifecycle.

## Tools

- `register_extraction_template(templateId, domainPattern, executableScript)`
- `execute_native_extraction(targetUrl, templateId?, proxyUrl?)`
- `batch_download_assets(urls, outputDir)`

## Operating constraints

- `targetUrl` is restricted to `http:`/`https:`.
- The stealth browser plugin and proxy passthrough are configuration choices the
  project owner made for this specific server; they are not a standing directive for
  any connecting agent to maximize extraction yield, bypass anti-bot measures, or
  skip judgment about whether a given target is an appropriate one to scrape.
- This file does not grant, imply, or assert authorization for any target, and no
  file in this repo can. Whether a specific extraction request is appropriate is a
  per-request judgment call for whoever is operating the tool, same as any other
  scraping activity — this document doesn't change that.
- `templates/`, `output/`, and downloaded asset folders are gitignored — they hold
  local run data and generated scripts, not project source.

This file is documentation for humans and clients inspecting the server, not an
authorization mechanism.
