# 07-platform-design / website-design.md

**Surface:** Web (Program 2). **Owned by:** Web Builder + Design Lead (brand gate G3b). **Repo:** `apimemcp-platform` (`apps/web`). **Features that build it:** W01–W08. **Consumes:** the cloud execution API (X01–X07) and the shared cross-surface design system ([design-system.md](./design-system.md)). **Reads registry data** via jsDelivr + the Postgres mirror (X07). **Depends on engine features** for its content: F01 (schema), F03 (verification badges), F11 (provenance), F18 (hosted-exec substrate behind X01).

> This is a **plan**, not the product. It specifies what the Web Builder builds against, page by page, and how the site expresses the brand. No code is written here.

---

## 1. Purpose of the website

The website is the **community hub and public face** of APImeMCP's consumer track. It exists to do three things:

1. **Sell the inversion** — communicate the radical idea (a portable, versioned, verified "programmatic access to a screen" for the ~99% of the web with no API) to devs, agents, and non-technical consumers in the first ten seconds.
2. **Browse + run community APIs from any browser** — the registry is walkable, searchable, and every template is **one-tap runnable** against the cloud execution layer, with results streamed back live. Phones and browsers can't run Playwright, so the site is a **thin client of the cloud API (X01)** — it never executes templates itself.
3. **Grow the flywheel** — make contributing a template (a registry PR) and monitoring a template (get a push when a value changes) obvious and low-friction, so usage signals feed back into more contribution.

The site is the elevation of the existing raw "compiler/terminal" dashboard into a **polished product + community hub** — same brand DNA, production finish.

---

## 2. Identity (grounded — deliberately not a templated default)

The site **extends the established "compiler/terminal" brand**, elevated from raw dashboard to a designed product. Full token definitions live in [design-system.md](./design-system.md); the load-bearing brand facts:

- **Palette:** phosphor amber **`#ffb627`** on void **`#14100a`**. Amber is the signal/primary; void is the ground. This is a dark-first, single-accent identity — the "output of a machine that just compiled your API" feeling.
- **Type:** **IBM Plex Mono** for machine output (results, code, template ids, ledger rows, the hero terminal) + **IBM Plex Sans** for interface copy (nav, prose, buttons, marketing). The mono/sans split *is* the brand: machine vs human, output vs interface.
- **Metaphor:** the **compiler**. A website with no API is "uncompiled"; a template is the compiled artifact; running it is executing the compiled program. The UI makes this literal wherever it can.

### Signature element — the live interactive hero terminal (W08)

The landing hero is a **real, live terminal**, not a video or mockup. The visitor **types a domain**, and watches a real community template **compile → run → stream real results** in the terminal, using the actual cloud execution path (X01 → X02). The compiler metaphor is made literal, and the data is **real, never mocked** (the project's "real data everywhere" rule). This is the single most important conversion surface — it proves the entire product in one interaction, before any signup.

### Structural device — the registry as a monospace "ledger" (W03)

The registry browser is presented as an **"npm-registry-for-websites" ledger**: a dense, monospace, scannable table where **each row is a template** carrying:

- a **live verification badge** (F03 shields.io status — green = verified by last night's re-verification run),
- a **run count** (usage signal),
- a category / domain,
- and a **one-tap Run** control.

The ledger reads like a package registry crossed with a terminal log — dense, honest, machine-legible.

### Deliberately avoided (anti-default stance)

Explicitly **do not** drift toward the three "AI-default" looks the brand is meant to stand apart from:

- cream background + serif ("editorial startup"),
- pure black + acid/neon green ("hacker cliché"),
- broadsheet/newspaper grid.

The terminal-phosphor identity is already distinctive and *earned* by the product's nature (it literally is a compiler/terminal). The Design Lead gates (G3b) any UI PR that dilutes it.

---

## 3. Pages / information architecture

Seven top-level surfaces. Each entry lists purpose, key components, data source, and the engine/cloud features it surfaces.

### 3.1 Landing (W08)
- **Purpose:** vision + instant proof. Convert a cold visitor by *showing*, not telling.
- **Key components:** hero **live compile-and-run terminal** (type a domain → real result); the inversion pitch ("you get an API today only if a vendor builds one — here anyone can"); the flywheel diagram; target-market strip (RPA replacement, financial data, healthcare portals, gov/civic, supply-chain, competitive intel, QA/E2E); social proof (verified-template count, total runs, contributor count from X07); CTAs → Registry browser + Contribute.
- **Data:** live counts from the Postgres mirror (X07); the hero calls X01 for a real run.
- **Surfaces:** the whole value prop; F18/X01/X02 (the hero runs a real template).

### 3.2 Registry browser (W03)
- **Purpose:** discover community templates.
- **Key components:** the monospace **ledger** table; **search** (by domain/name/capability — pairs with semantic discovery F22 when available); **filters** (category, verification status, template kind incl. `static-http` F15); **sort** (trending / run-count / recently verified); per-row **verification badge (F03)**, run count, one-tap **Run**.
- **Data:** X07 registry mirror/cache (fast catalog + search); badges from F03 status.
- **Surfaces:** F03 (badges), F15 (kind filter), F22 (search), the registry itself.

### 3.3 Template detail (W04)
- **Purpose:** everything about one template + the entry to run it.
- **Key components:** rendered **docs**; the **F01 output schema** (typed, human-readable — drives the result views downstream); **verification** history/badge (F03); **provenance** panel (F11 — content-hash + version + schema-valid, signed, exportable — the trust surface); **Run** button (opens the run console pre-targeted); **`.mjs` download** (the standalone script, for self-host users); inputs the template expects (target URL, whether cookies are needed).
- **Data:** registry manifest (via jsDelivr + X07); F01 schema; F11 receipts.
- **Surfaces:** F01, F03, F11, and the self-host `.mjs` export path.

### 3.4 Run console (W05)
- **Purpose:** run a template and see live results.
- **Key components:** **inputs** (target URL or one-tap fixed-target; optional cookie string for auth templates); **enqueue → live progress** (SSE/websocket from X04); **result views** switchable by shape — **JSON**, **table**, **image gallery**, plus **share**; result **typed by the F01 schema** (dataviz + ui-styling skills render table/gallery). For **heavy paginated templates** that exceed the cloud tier, the console shows the clear **"too heavy for the cloud tier — run on your self-host server"** message with a deep-link to self-host instructions (the free-tier-first tradeoff, X03) — or, under the recommended $0 full-stack, routes to the Oracle worker / GitHub Actions runner (see [hosting-options.md](./hosting-options.md)).
- **Data:** X01 (POST/GET run), X04 (live delivery); results **ephemeral, not persisted server-side by default** (F18 / X04).
- **Surfaces:** X01, X02, X03 (heavy fallback), X04, F01.

### 3.5 Contribute (W06)
- **Purpose:** turn a visitor into a contributor.
- **Key components:** **PR onboarding** (how a template becomes a registry entry); the **gate explainer** (what F03 nightly verification + F19 lint check, so a contributor knows the bar); links to the `apimemcp-templates` repo; "make me an API for X" pointer (F21) for agent-assisted authoring.
- **Data:** static + links to the templates repo.
- **Surfaces:** the registry contribution flow, F03/F19 gates.

### 3.6 Docs
- **Purpose:** explain the vision and the two tracks.
- **Key components:** **vision** (the inversion, the determinism-vs-computer-use moat); **how-it-works** (template lifecycle: solve once → crystallize → run in ms → self-heal on drift); **self-host** guide (the full-power MCP-server track — arbitrary local templates, own Playwright); **API reference** (the X01 execution API for programmatic consumers).
- **Data:** static / MDX.
- **Surfaces:** both tracks (self-host vs cloud/consumer), X01 API.

### 3.7 Account (W07)
- **Purpose:** the logged-in user's home.
- **Key components:** **monitors** (subscribed template+inputs+schedule, last value, history — the killer feature, X05); **run history**; **saved cookies** (per-user, encrypted — X06, opt-in); **API keys** (for programmatic X01 access).
- **Data:** user data in **Neon Postgres**; auth via **Clerk**.
- **Surfaces:** X05 (monitors), X06 (cookies/vault), X01 (keys), W07.

---

## 4. Tech stack (locked)

| Concern | Choice | Notes |
|---|---|---|
| Framework | **Next.js App Router** | `vercel:nextjs`, `vercel:react-best-practices` |
| Components | **shadcn/ui + Tailwind** | themed to the phosphor/void design system ([design-system.md](./design-system.md)) via `vercel:shadcn` |
| Monorepo | **Turborepo** (`apps/web`, `apps/mobile`, `packages/shared`) | scaffolded in W01 (`next-forge`) |
| Hosting | **Vercel** (Hobby free-tier-first) | or Cloudflare Pages in the $0 full-stack ([hosting-options.md](./hosting-options.md)) |
| Registry data | **jsDelivr** (raw manifest) + **cached Postgres mirror** (X07) | mirror gives fast catalog/search; jsDelivr is the source of truth |
| User data | **Postgres (Neon)** | monitors, history, keys |
| Auth | **Clerk** | `vercel:auth`; **same accounts as mobile** (shared Clerk) |
| Execution | **calls X01** | the site never runs Playwright — thin client of the cloud API |

Shared **types come from the published `@neetigyashah/apimemcp` package** and the registry manifest only (ADR-06) — the web app **never imports engine internals**. F01 result types flow through `packages/shared` so the result views are typed end-to-end.

---

## 5. Key interactions

- **The live hero (W08):** input a domain → the site calls X01 with a matching community template → streams compile/run progress → renders the real result in-terminal. Must degrade gracefully (a curated fallback template) if the typed domain has no template, and must never show mocked data.
- **One-tap Run from the ledger (W03→W05):** a row's Run opens the run console pre-targeted; enqueue is immediate; progress streams via X04.
- **Result view switching (W05):** JSON ⇄ table ⇄ image gallery, chosen by the F01 schema shape (e.g. array-of-objects → table default; media URLs → gallery). Share produces a link to a read-only result snapshot.
- **Monitor subscribe (W07→X05):** from a template detail or run, "monitor this" captures template+inputs+schedule; changes arrive as an **Expo push on mobile** and appear in the Account monitors list on web.

---

## 6. Accessibility & responsive floor (Design-Lead gated)

- **A11y floor on every page:** visible focus rings (amber on void — must meet contrast), reduced-motion honored (the hero terminal's stream animation respects `prefers-reduced-motion`), semantic landmarks, keyboard-navigable ledger and result tables, sufficient contrast for amber-on-void body text (large/interactive elements pass; body copy uses the design-system's tuned foreground, not raw `#ffb627` on `#14100a` where it would fail).
- **Responsive:** the ledger collapses from a dense table (desktop) to stacked cards (mobile) without losing the badge / run-count / Run affordances. The hero terminal remains usable on a phone (the same product the mobile app delivers natively).
- **Real data everywhere:** no lorem, no fake result screenshots — the design system's rule, enforced at G3b.

---

## 7. Feature map (which W## builds what)

| Page / capability | Feature | Wave | Key deps |
|---|---|---|---|
| Monorepo + Vercel project + CI/CD | **W01** | P0 | — |
| Cross-surface design system (this brand, tokens) | **W02** | P0 | W01 |
| Registry browser + search + badges | **W03** | P1 | W01, W02, X07 |
| Template detail + schema/docs | **W04** | P1 | W03, F01 |
| Run console (live results) | **W05** | P2 | W04, X01, X04 |
| Contribute flow | **W06** | P2 | W03, registry |
| Auth + accounts + dashboard (monitors/history/keys) | **W07** | P1 | W01 |
| Landing + interactive hero | **W08** | P2 | W02, X01 |

**Sequencing note:** the site's **P0** (W01, W02) runs in parallel with Program 1 Waves 1–2; the "run community APIs" core (W05) lands after the cloud (X01/X02/X04) and the engine substrate (F18/F15/F03) are ready. See [cloud-architecture.md](./cloud-architecture.md) for the execution layer the site depends on.
