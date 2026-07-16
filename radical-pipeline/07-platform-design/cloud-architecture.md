# 07-platform-design / cloud-architecture.md

**Surface:** Cloud (Program 2). **Posture:** Vercel-native, **free-tier-first** (locked decision ⑦). **Owned by:** Cloud/Infra Builder. **Gated by:** Security-Reviewer (**all X## are security-sensitive** — untrusted community templates, user cookies, auth). **Repo:** `apimemcp-platform` (cloud functions/workflows). **Features:** X01–X07. **Bridges to:** the website ([website-design.md](./website-design.md)) and mobile app ([mobile-app-design.md](./mobile-app-design.md)), both thin clients. **Free-hosting deep-dive:** [hosting-options.md](./hosting-options.md).

> Plan only. This specifies the cloud execution layer the web and mobile clients call. No code here.

---

## 1. Why the cloud layer exists (the bridge)

**Phones and browsers can't run Playwright.** That single fact makes the **cloud execution layer (X##) mandatory** — it is the bridge between the consumer surfaces (thin clients) and the deterministic extraction engine. Without it there is no "run a community API from your phone".

Two hard boundaries define the layer:

- **Registry-only.** The cloud runs **only registry (community) templates** — never arbitrary user-supplied code. That is exactly the safe scope of engine feature **F18** (ephemeral hosted endpoint over read-registry): the productized cloud runtime *is* F18 hardened for multi-tenant use. Self-host remains the track for arbitrary local templates and full Playwright power.
- **Sandboxed + network-allowlisted.** Community templates are untrusted input. They run inside a sandbox (Vercel Sandbox microVM or `@sparticuz/chromium`) with an outbound **network allowlist** (engine item-5 sandboxing), so a malicious template can't exfiltrate or pivot.

Auth templates: the user supplies cookies that **transit encrypted and are used ephemerally** (or are stored in a per-user encrypted vault, F13/X06, **only if the user opts in**). The engine repo and the platform repo share **only the registry manifest + the published `@neetigyashah/apimemcp` types** (ADR-06) — the cloud never imports engine internals.

---

## 2. Components X01–X07

### X01 — Execution API gateway (Vercel Functions)
The single entry point every client calls.

- `POST /api/run` `{ templateId, targetUrl?, cookieString? }` → `{ jobId }`
- `GET /api/run/:id` → `{ status, result? }` (status/result polling; live updates come via X04)
- **Auth:** Clerk (same accounts across web + mobile).
- **Rate-limit + WAF:** `vercel:vercel-firewall` / routing middleware — per-user and per-IP limits, abuse protection at the edge before the function runs.
- **Gates:** Se + Lv. **Risk:** H (public execution surface). **Deps:** F18.

### X02 — Safe registry-only runtime
Where a template actually executes.

- **Inline fast path:** light templates + **`static-http` (F15)** + quick extractions run **inline in a Function** via **`@sparticuz/chromium`** *or* **Vercel Sandbox** (isolated microVM) — returning a **synchronous result within the function timeout**.
- **Registry-only + network-allowlisted** (item-5). No arbitrary code, no open egress.
- **⚠ Feasibility spike (mandatory, early):** confirm Playwright/Chromium runs acceptably inside Sandbox/Function. **If it does not**, `@sparticuz/chromium` covers the light path and **heavy templates stay self-host** (or move to the Oracle worker under the $0 full-stack — see [hosting-options.md](./hosting-options.md)). This spike de-risks the entire cloud track and must run in P0/P1.
- **Gates:** Se + Lv. **Risk:** H. **Deps:** F18, F15, item-5.

### X03 — Durable orchestration + heavy fallback (`vercel:workflow`)
For anything that doesn't fit a single sync function call.

- **Multi-step + monitor flows** with retries and pause/resume, via Vercel Workflow.
- **Heavy paginated templates** (the "1000-comment" class) that exceed serverless limits return a clear, honest message: **"too heavy for the cloud tier — run on your self-host server"**, plus a **deep-link to self-host instructions**. This is the deliberate free-tier-first tradeoff.
- **Upgrade path:** a deferred **BullMQ worker** would lift this later (skill `bullmq-specialist` is pre-vetted but **deferred** by the free-tier-first decision); the **$0 full-stack** lifts it *now* for free via an **Oracle Always-Free ARM worker + GitHub Actions** ([hosting-options.md](./hosting-options.md)) without adding recurring cost.
- **Gates:** Se + Lv. **Risk:** M. **Deps:** X02.

### X04 — Results delivery
Getting results to the two client surfaces.

- **Web:** **SSE / websocket** → the live run console (W05).
- **Mobile:** **Expo push** → "run finished / value changed" (the "results to your phone" mechanism).
- **Ephemeral by default:** results **and cookies are not persisted server-side** (F18 posture); cookies are **encrypted in transit and used ephemerally**. Persistence happens only if the user opts into the vault (X06).
- **Gates:** Se. **Risk:** M. **Deps:** X01.

### X05 — Monitors service (the killer mobile feature)
F20 (change-monitoring) productized + Vercel Cron.

- A user **subscribes**: template + inputs + schedule.
- **Cron run** on schedule → **F02 diff** vs the last result → **on change, Expo push**: "Bernhardt K1325 → \$X", "back in stock", "new filing appeared".
- This is the **consumer wedge** — the notification *is* the value; the user never opens a browser.
- **Gates:** Se + Lv. **Risk:** M. **Deps:** X03, F02/F20.
- **$0 note:** under the recommended free stack, **GitHub Actions scheduled workflows** run the monitor cron for free (unlimited minutes on public repos); Vercel Cron is the Vercel-native default.

### X06 — Encrypted cookie transit + optional per-user vault
The credentials boundary (F13 / ADR-05).

- Cookies **encrypted in transit**, used ephemerally by default.
- **Optional per-user encrypted vault** — opt-in only — for users who want saved sessions (mobile "saved cookies", web Account).
- **ADR-05 boundary (hard):** **app-connections** = login *profile/session dirs* (browser identity); **vault** = *encrypted secrets*. Separate stores; the cloud vault is the multi-tenant F13.
- **Gates:** **Se (blocks)**. **Risk:** H. **Deps:** F13, ADR-05.

### X07 — Registry mirror / cache DB (Postgres)
Fast catalog + search without hammering git/jsDelivr.

- A **Postgres mirror** of the git registry, **synced** from the source, powering the web/mobile **catalog, search, filters, badges, run-counts**.
- jsDelivr remains the raw source of truth; the mirror is the read-optimized cache.
- **Gates:** — (no security block; standard review). **Risk:** L. **Deps:** registry.
- **Cache layer:** `vercel:runtime-cache` for hot catalog reads.

---

## 3. Safety posture (Security-Reviewer gates every X)

Every X## PR passes the Security-Reviewer. The non-negotiables:

- **Registry-only** — never execute arbitrary user code, only community templates from the registry.
- **Sandbox intact** — Vercel Sandbox microVM / `@sparticuz/chromium`; a template can't escape.
- **Network allowlist** — outbound egress restricted (item-5); no exfiltration/pivot.
- **Rate-limit + WAF** at the edge (X01).
- **Zero-persist default** — results and cookies not stored server-side unless the user opts into the vault.
- **Strict per-user isolation** — **never** share cookies or results across users; cache keys and job records are per-user.

These map directly to the Security-Reviewer's charter (gates all of X##, plus engine F00/F04/F06/F11/F12/F13/F16/F18 and any sandbox/allowlist change).

---

## 4. Data flow (end to end)

```
[web run console / mobile Run screen]
        │  POST /api/run {templateId, targetUrl?, cookieString?}   (Clerk auth, rate-limited)
        ▼
   X01 gateway ──► X02 runtime (sandbox/microVM, registry-only, allowlisted)
        │                │
        │                ├─ light / static-http (F15): inline sync result within timeout
        │                └─ multi-step / monitor: X03 Workflow (retries, pause/resume)
        │                          │
        │                          └─ too heavy for tier ─► "run on self-host" + deep-link
        │                                                    (or Oracle worker under $0 stack)
        ▼
   X04 delivery ──► web: SSE/ws live console   ──► mobile: Expo push
        │
        └─ ephemeral: results + cookies NOT persisted (unless X06 vault opt-in)

   X05 monitors:  cron ─► X02 run ─► F02 diff vs last ─► on change ─► Expo push
   X07 mirror:    git registry ─► Postgres cache ─► fast catalog/search/badges (web + mobile)
```

---

## 5. Free hosting matrix (answers "is there another free layer to run the whole thing")

The locked posture ⑦ (Vercel free-tier-first) punts heavy templates to self-host. But several **genuinely-free** layers combine to run *everything* — heavy templates + monitors included — at **\$0**. This matrix is summarized here because it is part of the cloud architecture decision; the **full deep-dive, decision guidance, signup steps, and paid upgrade path live in [hosting-options.md](./hosting-options.md)**.

| Layer | Free option(s) | Runs | Caveat |
|---|---|---|---|
| Web / site | **Vercel Hobby** or **Cloudflare Pages** | the Next.js site | Vercel non-commercial hobby terms |
| DB + auth + storage | **Supabase free** (Postgres+auth+storage+edge fns) or **Cloudflare D1+R2** | X07, W07, accounts | Supabase pauses idle projects |
| Light execution | **Cloudflare Browser Rendering** (free Playwright-at-edge) or Vercel fn + `@sparticuz/chromium` | static-http + quick templates | edge CPU/time limits |
| **Heavy + always-on** | ⭐ **Oracle Cloud Always-Free** (permanent ARM VM, 4 cores / 24 GB — runs the full APImeMCP engine + a queue worker forever, free) | 1000-comment-class templates, the whole engine | one free signup; ARM arch |
| On-demand + cron runner | ⭐ **GitHub Actions** (free; *unlimited* minutes on public repos) — `workflow_dispatch` to run a template, scheduled workflows for monitors + nightly-verify (F03), result via artifact / webhook / `repository_dispatch` | monitors, nightly re-verify, on-demand heavy runs | ~job-start latency; unlimited only on public repos |
| Push | **Expo Push** + **FCM** | mobile delivery | free |

**Recommended \$0 full-stack:** Vercel/Cloudflare (web) + Supabase (DB/auth) + Cloudflare Browser Rendering or `@sparticuz/chromium` (light exec) + **Oracle Always-Free ARM worker** (heavy exec = the engine) + **GitHub Actions** (cron monitors + nightly-verify) + Expo Push. This runs the *entire* two-track product — **every community API from the phone, heavy ones included** — at **no recurring cost**, and it **lifts the heavy→self-host fallback while staying \$0**.

Adopting the **Oracle worker + GitHub Actions** is a small, free owner-signup step that **strictly upgrades decision ⑦** (still \$0): decision ⑨. It does not change the Vercel-native default — it adds a free heavy-execution tier so the "too heavy for the cloud tier" message becomes rare instead of routine.

> **Skill note:** no ≥1K-install skill exists for Cloudflare / serverless-Chromium / Oracle. Per the skill-quality bar (reject <100 installs; the vetted Cloudflare/serverless-Chromium/Playwright community skills top out at 142/75/63 installs), the Cloud/Infra Builder uses **`context7` + official vendor docs** for these areas rather than a weak skill.

---

## 6. Feature map (which X## builds what) + client dependents

| Capability | Feature | Wave | Deps | Web dependent | Mobile dependent |
|---|---|---|---|---|---|
| Execution API gateway | **X01** | P1 | F18 | W05, W08 | M04 |
| Safe registry-only runtime (+ spike) | **X02** | P1 | F18, F15, item-5 | W05 | M04 |
| Durable jobs + heavy fallback | **X03** | P2 | X02 | W05 | M04 |
| Results delivery (SSE/ws + push) | **X04** | P2 | X01 | W05 | M04, M05 |
| Monitors service (cron + diff + push) | **X05** | P3 | X03, F02/F20 | W07 | M05 |
| Encrypted cookies + vault | **X06** | P2 | F13, ADR-05 | W07 | M06 |
| Registry mirror/cache DB | **X07** | P1 | registry | W03, W04 | M03 |

**Sequencing:** Program 2's **P0** (W01, W02, X07, the X02 feasibility spike) runs in parallel with Program 1 Waves 1–2. The "run community APIs" core (X01/X02 → W05/M04) lands **after F18, F15, F03** are ready. Monitors (X05 → M05) are P3, after diff (F02→F20) exists.
