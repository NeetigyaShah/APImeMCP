# 00 — Vision: the radical idea, the two-track model, the flywheel, the markets

> **Thesis in one line.** For thirty years, you got a programmatic interface to a
> system only if its *vendor* chose to build one. APImeMCP makes the
> interface **crowd-and-agent-supplied** instead of vendor-supplied — and that
> single inversion turns the ~99% of the web and enterprise software that has
> *no* API into an open, self-growing, universal API layer.

This is the north-star document for the whole pipeline. Every feature in the two
programs — the engine (`F00–F25`) and the consumer platform (`W01–W08` /
`X01–X07` / `M01–M07`) — is a means to the end described here. When a design
choice is genuinely ambiguous, this document is the tiebreaker: **prefer the
option that yields more crystallized coverage, more determinism, a lower cost to
contribute, and broader reach.**

APImeMCP today is a local-first TypeScript MCP server (`@neetigyashah/apimemcp`,
v1.5.0). That server is the *seed*. What follows is the tree.

---

## 1. The inversion

**The world you live in.** A programmatic interface to a system is a privilege
the vendor grants. Stripe has an API because payments are Stripe's business.
Twitter has (had) an API because a platform strategy needed one. But the vendor
builds an API for the vendor's reasons — partners, monetization, a developer
funnel — and withdraws it for the same reasons: deprecations, rate limits,
paywalls, "we've sunset that endpoint." Below the thin crust of software that
*is* an API company, the overwhelming majority of systems have no API at all and
never will, because no one whose job it is to build one has any incentive to:

- the county records portal, the court docket, the permit system;
- the commercial-banking dashboard, the supplier invoicing portal, the EDGAR
  filing page;
- the healthcare payer portal, the prior-authorization system, the eligibility
  checker;
- the carrier's shipment-tracking screen, the customs portal, the port system;
- ten thousand internal enterprise tools that will outlive three CEOs before
  anyone funds an API for them.

For all of these, the *only* interface is a screen built for a human. The data
is public or authorized — it is simply trapped behind a rendering meant for eyes
and a mouse, not a program.

**The inversion.** APImeMCP moves the locus of API creation from the vendor to
the *consumer and the agent*. It does this by making one thing a first-class,
distributable artifact: **the template — a portable, versioned, verified unit of
"programmatic access to a screen."** A template is a standalone extraction script
plus a manifest: it says *what site*, *what shape of data comes out* (its JSON
Schema output contract, `F01`), and *how it was verified* (a live-network
re-check, badged nightly, `F03`). It is:

- **Portable** — a self-contained `.mjs` you can run on your laptop, in a cloud
  Function, or hand to another agent; nothing proprietary, no vendor's blessing.
- **Versioned** — semver plus changelog and contributor reputation (`F24`), so a
  template is a maintained asset, not a throwaway macro.
- **Verified** — its output shape is contract-checked every run and re-verified
  against the live site every night; a template that has silently rotted is
  *known* to have rotted, not discovered at 3am by the thing that depended on it.

Once "programmatic access to a screen" is a portable, versioned, verified unit,
who supplies it stops being fixed. A developer can write one. An **agent** can
write one — that is the whole point of the agent-native authoring path (`F05`,
`F06`, `F21`). The crowd can contribute one to a shared registry. **The API
economy inverts:** access is no longer rationed downward by vendors; it is
*supplied outward* by everyone who needs it and every agent capable of solving a
screen once. The long tail that would never earn a vendor API gets one anyway —
built by the people and agents who actually want the data.

---

## 2. The moat — determinism vs. computer-use

The obvious 2026 objection: *"Won't a general LLM computer-use agent just do all
of this? Point it at the screen, let it click."* It can — and that is precisely
why APImeMCP wins, because **computer-use and APImeMCP are complements, not
competitors, and APImeMCP is the layer that captures the durable value.**

Computer-use is a *discovery* mechanism. It is astonishing at solving a novel,
unmapped screen *once*: read the DOM, reason about it, click the right things,
pull the data. But it pays the full cost of that reasoning on **every single
run** — and that cost is threefold:

| | LLM computer-use (every run) | APImeMCP template (after crystallization) |
|---|---|---|
| **Latency** | seconds to minutes of model round-trips per page | **milliseconds** — a deterministic script |
| **Cost** | dollars of tokens per run, forever | ~free per run; the model cost is paid **once** |
| **Determinism** | output shape varies run to run; no guarantees | **contract-checked** identical shape every run (`F01`) |
| **Provenance** | none — "the model said so" | **signed receipt**: content hash + version + schema-valid (`F11`) |
| **Auditability** | opaque chain of clicks | a readable, versioned script anyone can inspect |

APImeMCP's move is to **crystallize** the expensive, nondeterministic act into a
cheap, deterministic artifact. An agent (or a developer, or a computer-use agent,
`F06`) solves the site *once*; the successful path is captured and frozen into a
template that then runs in milliseconds, deterministically, forever. **You pay
for the intelligence once and amortize it across every future run.** The
nondeterministic thing runs rarely; the deterministic thing runs constantly.

**Self-healing closes the durability gap — which is the whole moat.** The
standard objection to any scraper is "sites change, so it breaks." APImeMCP
answers this structurally. Every run is diffed against the template's output
contract (`F02` drift detection over the `F01` schema). When a site changes and a
template drifts, the engine captures **forensic DOM + the old script** and hands
them back to a calling agent, which repairs the path, re-verifies it live, and
opens a registry PR (`F04` — and it *never* auto-merges; a human or a gate
approves). So the rare, expensive, intelligent act (re-solving) is triggered
*only* when a site actually changes, and only for the one template affected —
while the cheap deterministic act (running) covers the other 99.99% of the time.
Nightly re-verification (`F03`) makes drift visible before a consumer ever hits
it.

Now the moat is clear. A pure computer-use competitor re-derives the same path
millions of times, paying the full latency-cost-nondeterminism tax on every run
in perpetuity. APImeMCP derives each path **once** and accumulates it into a
corpus of crystallized, self-maintaining access. That corpus is an asset that
**appreciates** (usage tells you which paths matter) and **self-repairs** (drift
+ self-heal keep it alive as the web moves under it). Intelligence is the
commodity that gets cheaper every year; **the crystallized, verified, self-healing
corpus of "how to get X out of screen Y" is the scarce, compounding thing.** That
is what APImeMCP owns.

---

## 3. The two-track model

One substrate, two products, two audiences — deliberately not collapsed into one.

**Track A — Self-host (the MCP server).** Full power, no compromises. Arbitrary
*local* templates, the machine's own Playwright, real session cookies and
credentials that **never leave the device**, heavy paginated runs with no cloud
timeout. The audience is developers and agents — anyone who can run an MCP server
and wants the whole engine. This is what exists today at v1.5.0, and it keeps the
original promises intact: full control, zero trust boundary, no recurring cost.

**Track B — Cloud / consumer (website + mobile app + cloud execution).**
Registry-only community templates, sandboxed and network-allowlisted, phone-first.
The audience is *everyone* — a person with a phone who has never heard of
Playwright and never needs to. They browse a catalog of community APIs, tap Run,
and get results; they subscribe to a monitor and get a push. No install, no code.

**The bridge is mandatory, and it is the safe scope.** Phones and browsers cannot
run Playwright, so a **cloud execution layer (`X01`/`X02`) is not optional — it is
the load-bearing bridge** between the community registry and every thin client.
Crucially, the cloud runs **only registry (community, verified) templates — never
arbitrary user code.** That single constraint is what makes the cloud tier safe
to sandbox: the productized, hardened scope of the hosted endpoint (`F18` →
`X01`/`X02`) is *exactly* "run a vetted community template in a microVM behind a
network allowlist." Web and mobile are thin clients of that cloud API; results
stream back to the browser console and, on mobile, arrive as a push.

**The shared substrate is the community registry.** Both tracks read the same
registry manifest. The self-host engine and the consumer platform live in
separate repositories (`apimemcp`, `apimemcp-templates`, `apimemcp-platform`) and
share **only** two things: the registry manifest shape and the published npm
types (`ADR-06`). The platform never imports engine internals; it consumes the
same contract everyone else does. This keeps the two tracks decoupled enough to
evolve independently, yet coherent enough that a template contributed from a
laptop is instantly runnable from a phone.

**Why two tracks and not one.** The self-host track preserves full power, the
zero-trust-boundary guarantee, and the no-recurring-cost promise for builders.
The cloud track trades some of that power (registry-only, sandboxed, tiered
compute) for something the self-host track can never have: reach to anyone,
anywhere, with no install. Neither cannibalizes the other. They are two front
doors to **one growing corpus**, and every use of either door feeds that corpus.

---

## 4. The flywheel

The system is designed to grow *itself*. The loop:

1. **Contribution.** Agents and developers contribute templates as registry PRs.
   Each is gated by live-network re-verification (`F03`) and lint (`F19`) before
   it can merge — so the catalog's floor is "actually works against the real
   site," not "someone claims it works."
2. **Instant availability.** A merged template is *immediately* usable in the web
   app and the mobile app, with **zero per-template client work.** The registry
   mirror (`X07`) plus the generic run console and result views (`W05` / `M04`)
   surface any new template automatically — its schema becomes its docs, its
   inputs become its form.
3. **Consumption.** Consumers run templates (web `W05`, mobile `M04`) and, more
   importantly, **subscribe to monitors** (`X05` / `M05`) — a scheduled run whose
   diff triggers a push.
4. **Signal.** Usage is measured — run-count, success-rate SLA (`F14`),
   contributor reputation (`F24`). The signal tells the whole system *which
   templates matter*: which to prioritize for maintenance, which to surface as
   trending, where demand is concentrated.
5. **Pull.** Concentrated demand for one capability pulls contribution of the
   adjacent ones — someone who wanted the shipment-status template now wants the
   customs one; the gap is visible and gets filled.
6. **Preservation.** Drift detection (`F02`), self-healing (`F04`), and nightly
   re-verification (`F03`) keep the *entire accumulated corpus* working as sites
   change underneath it — so value added in month one is still live in year
   three.

**The property that matters: coverage grows itself.** Every contributed template
raises the platform's capability. Every run raises the signal about what to build
and maintain next. Every self-heal *preserves* accumulated value instead of
letting it decay. This is the exact opposite of a vendor API catalog, which rots
the moment the vendor stops investing. Here the corpus is maintained by its own
users, its own contributing agents, and an automated verification mesh that never
sleeps. Value compounds with template count × user count — and, uniquely, the
maintenance cost of that value is borne by the flywheel itself rather than by any
single owner.

---

## 5. Target markets (production-grade)

Each of these is a real market **precisely because the underlying systems have no
API** — or a deliberately partial, hostile one. These are not hypotheticals; they
are where organizations already pay, today, for brittle bespoke automation that
APImeMCP replaces with something versioned, verified, and self-healing.

- **RPA replacement (~$20B).** UiPath, Automation Anywhere, and Blue Prism exist
  to drive screens that have no API — and they do it with recorded macros that
  break silently and cost six figures to maintain. APImeMCP is RPA that is
  agent-authored, versioned, contract-checked, self-healing, and portable: the
  same job, minus the brittleness and the license.
- **Financial data aggregation.** Corporate and commercial banking portals (most
  SMB banking has no consumer-grade API), SEC EDGAR (data-rich but messy),
  government procurement systems (SAM.gov, state and county portals), supplier and
  invoicing portals. Effectively "Plaid for everything Plaid will never cover" —
  with signed provenance (`F11`) for anything that touches an auditor.
- **Healthcare.** Payer portals, prior-authorization systems, eligibility checks —
  a notorious no-API swamp where staff manually re-key data across a dozen
  portals daily. High-value, compliance-sensitive, and exactly where provenance
  receipts (`F11`) and an encrypted credential vault (`F13`) earn their keep.
- **Government / civic data.** County records, court dockets, permit and
  licensing systems, legislative sites — public data trapped behind screens.
  The core substrate for civic tech, investigative journalism, and legal research.
- **Supply-chain / logistics tracking.** Carrier portals, customs systems, port
  and terminal screens — every carrier a different page, no unified API. This is
  where **monitors** shine: a push the moment a shipment's status changes.
- **Compliance-grade provenance.** Regulated industries need attestable "this
  datum came from this source, at this time, unaltered." Signed receipts (`F11`)
  and the provenance-ledger concept give a tamper-evident audit trail no ordinary
  scraper offers.
- **Competitive intelligence.** Pricing, catalog, and availability monitoring
  across competitors' sites — the classic use case, now typed, scheduled, and
  push-on-change instead of a cron job nobody trusts.
- **QA / E2E testing (the Kriya origin).** The project's genesis: driving web
  apps deterministically to test and verify them. CEL conditional branching
  (`F08`), golden-snapshot regression (`F23`), and action sequences make the same
  engine a testing substrate as much as a data one. The determinism that serves
  extraction serves verification identically.

### The consumer wedge: mobile monitors

Most people will never care about "an API," and they never have to. They will
care that their **phone pings them** the moment a specific out-of-stock furniture
piece is back, a flight price drops, a new court filing or building permit or
government notice appears. That is the **monitor**: a scheduled cloud run
(`X05`, Vercel Cron) whose result is diffed against the last (`F02`) and pushed to
the phone the instant it changes (`M05`, Expo Push). **The notification *is* the
product**; the crystallized, self-healing API underneath is invisible.

This is how a developer-tool substrate reaches a billion phones. The engineer's
value proposition ("a deterministic, versioned, self-healing API over any
screen") and the consumer's value proposition ("tell me the moment X happens")
are the *same system* viewed from two ends. The monitor is the mass-market front
door — and every consumer who subscribes to one adds another turn to the
flywheel.

---

## The north star

The end state is a single sentence, and it is worth holding in mind while
building any one of the ~48 features:

> **An open, agent-native, self-growing universal API layer over the ~99% of the
> world's software that has no API — supplied by the crowd and by agents instead
> of by vendors, kept alive by determinism and self-healing, and reachable from
> any phone.**

If a decision moves toward that end state — more crystallized coverage, more
determinism, a lower cost to contribute a template, broader reach for running
one — it is the right decision. If it moves away, it is not, however clever it
looks in isolation.

**Read next:** `08-skills-matrix.md` (what each builder installs), then the
`01-adrs/` contracts your feature touches, then your assigned `02a`/`02b` spec.
Build to the gates; update the tracker; deploy at G8.
