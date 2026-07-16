# 06 — Creative Ideas: the moonshot idea bank (unscheduled)

> **What this file is.** A holding pen for the ideas that are *too big, too
> early, or too speculative* to sit in the wave schedule — but too good to lose.
> Nothing here has an `F##`/`W##`/`X##`/`M##` id, a gate, an owner, a wave, or a
> row in `05-tracking/`. Every entry instead names the **shipped feature it
> builds on** and the **promotion trigger** that would graduate it into a real,
> scheduled feature. This is the pipeline's imagination, kept deliberately
> separate from its commitments.

The ~48 planned features (`F00–F25`, `W01–W08`, `X01–X07`, `M01–M07`) are the
*known* road to the north star. This document is the *unknown* road — the moves
that only make sense once the corpus exists, the ones that turn a
deterministic-extraction engine into something the plan can only gesture at
today. They are recorded here so that when a shipped feature suddenly makes one
of them cheap, an agent reading the tracker can find the idea already thought
through, promote it, and give it an id.

---

## How to read this bank — the promotion rule

The one discipline this file enforces on itself: **an idea leaves the bank the
moment it earns a spec, not before.** Concretely:

1. **Nothing here is scheduled.** These ideas are invisible to the wave DAG, the
   gate pipeline (`G0–G8`), and the Excel tracker. A builder subagent never gets
   handed one of these. That is on purpose — speculative work does not contend
   for the three engine-builder slots or the shared `types.ts`/`engine.ts`/
   `index.ts` surface.
2. **Each entry states what it *builds on*.** Almost every moonshot is a thin
   layer over one or two *already-planned* features. That is the tell that it is
   real and not fantasy: it is not "and then magic," it is "once `F04` lands,
   this is a weekend."
3. **Each entry states its *promotion trigger*.** When that trigger fires —
   usually "the feature it depends on shipped, and real usage proved the demand"
   — the idea graduates: it gets an `F##`/`W##`/`X##`/`M##` id, a one-page spec
   from the per-feature template, a wave slot, gates, and a tracker row. At that
   point it is deleted from this file and lives in `02a`/`02b` like any other
   feature. **This file only ever shrinks by graduation or grows by inspiration.**
4. **Grounding beats cleverness.** Per `00-vision.md`'s tiebreaker: an idea earns
   its place here only if it moves toward *more crystallized coverage, more
   determinism, a lower cost to contribute, or broader reach.* Clever ideas that
   do none of those are not moonshots, they are distractions, and they are not
   listed.

The eleven ideas below come, in spirit, verbatim from the master plan's seed
list; they are grouped into four themes and expanded. A short **Further sparks**
section at the end holds one-line ideas not yet worth a full write-up.

---

# Theme A — Make the corpus feel like a real API surface

*Today an agent reaches a template through one generic call,
`execute_native_extraction(id)`. These three ideas turn the accumulated corpus
into something an agent perceives as a first-class, typed, discoverable API —
which is the difference between "a tool that can scrape" and "a thousand APIs
that happen to be crystallized screens."*

## 1. Self-describing MCP — every template becomes its own typed tool

Right now a template is data passed to one polymorphic tool: an agent calls
`execute_native_extraction({ templateId: "bernhardt-products" })` and has to
*know* out-of-band that the template exists and what it returns. The moonshot:
at MCP-server startup, **iterate the manifest and register each template as its
own named MCP tool** — `get_bernhardt_products()`, `track_maersk_shipment(bol)`,
`search_edgar_filings(cik)` — each with a real input schema (its target-URL /
cookie / argument shape) and a real *output* schema (`F01`'s
`ManifestEntry.outputSchema`). The agent's tool list stops being "one scraper"
and becomes "the actual API surface of everything the corpus can do."

This is the single highest-leverage way to make APImeMCP feel less like a tool
and more like the universal API layer the vision names. An agent doing tool
selection sees `get_county_permit_status` sitting next to `stripe.charges.create`
and treats them identically — which is exactly the inversion `00-vision.md`
describes, made literal in the tool list. It also composes perfectly with
`F25` (OpenAPI export): the same schema that renders an OpenAPI operation renders
an MCP tool.

The reason it is a moonshot and not just `F26`: dynamic per-template tool
registration means the tool list *changes as the corpus changes*, which stresses
MCP clients that assume a static tool set, and it wants `F01` output schemas
present on enough templates to be worth it. `ADR-02`'s per-tool-module
convention is the enabling groundwork — a registrar that loops the manifest is a
natural extension of "`index.ts` is an append-only list of `registerXxxTool`
calls."

**Builds on:** `F01` (output schema → tool I/O contract), `ADR-02`
(tool-module registrar pattern), `F25` (OpenAPI export shares the schema),
`register_extraction_template` / `findTemplateByUrl` (the manifest is already
the source of truth).
**Promote when:** `F01` schemas are populated across the registry *and* agents
are demonstrably tripping over the `execute_native_extraction(id)` indirection —
then it becomes an engine feature with a spec and a "does the client tolerate a
dynamic tool set?" live-verify gate.

## 2. Auto-generated agent skills — a template teaches itself to every agent

The plan already treats **skills as durable, shared, cross-agent memory** (see
`08-skills-matrix.md` and the context-bounded-workflow model). Turn that on the
corpus itself: from any registered template, **emit a `SKILL.md`** — name,
one-line capability, input/output schema (`F01`), an example call, and the
verification badge (`F03`) — and publish it to the same skills channel the build
agents already `npx skills check`. Now *any* agent, anywhere, discovers "there is
a crystallized API for tracking FedEx shipments" the same way it discovers
"there is a skill for Expo push," without ever having queried our registry.

This is distribution by osmosis. Instead of every agent needing to know APImeMCP
exists and go look, the *capability* propagates into the ambient skill memory
that agents already consult. It is the flywheel's "instant availability" step
(`00-vision.md` §4) extended from *our* clients to the entire agent ecosystem: a
template merged tonight is a skill an unrelated agent stumbles onto tomorrow.

Kept in the bank because it needs a stable `SKILL.md` schema-to-skill generator,
a publishing target, and a curation story (you do not want ten thousand
auto-skills drowning hand-written ones) — all of which get much easier once
`F22` (semantic discovery) exists to rank and cluster them.

**Builds on:** `F01` (schema → skill front-matter), `F03` (badge → the skill's
trust signal), `F22` (discovery ranks/clusters the generated skills), the
existing `.agents/` skills library + `skills-lock.json` conventions.
**Promote when:** the registry is large enough that discovery is the bottleneck,
and the skills publishing format has stabilized — then a small `F##` "skill
emitter" ships behind `F22`.

## 3. Shareable cross-site recipes — pipelines, not just templates, in the registry

`F07` makes template *pipelines* (a DAG: read A → transform via `F10` → read B),
and `F09` makes them bidirectional (read A → **write** into B's form). Today the
shareable unit is a single template. The moonshot: make the **pipeline itself a
first-class, versioned, shareable registry artifact** — a "recipe" — so the
community trades whole workflows, not just endpoints. "Pull every open RFP from
SAM.gov, normalize it, and file a tracking row into our vendor portal" becomes
one installable recipe, verified end-to-end, runnable from the web console
(`W05`) or the phone (`M04`).

This is Zapier/IFTTT with the APImeMCP twist that makes it defensible: every step
is a *crystallized, contract-checked, self-healing* template, so a recipe is
deterministic and auditable end-to-end rather than a chain of brittle
integrations that break silently. It is also where the registry stops being a
catalog of *data sources* and becomes a catalog of *outcomes* — a much larger and
stickier surface, and one that pulls contribution of the adjacent single
templates a recipe needs (flywheel §5, "pull").

**Builds on:** `F07` (pipeline DAG + runner), `F09` (bidirectional write),
`F10` (`ADR-03` transform between steps), `F24` (versioning/reputation for the
recipe as a maintained asset), the registry + `add_community_template`.
**Promote when:** `F07` has shipped and users are visibly hand-assembling the
same multi-template flow more than once — that repetition is the signal a recipe
artifact earns an id.

---

# Theme B — Reach a billion phones

*The vision's consumer wedge (`00-vision.md` §"the consumer wedge") is the
monitor: your phone pings you the instant something on a screen changes. These
three ideas push that wedge from a feature (`X05`/`M05`) into a product, a brand,
and a bundle.*

## 4. Monitors-as-a-product — curated vertical monitor packs

`X05` (cron + `F02` diff + push) and `M05` (mobile push) make monitors a
*capability*. This idea makes them a *product line*: curated **vertical monitor
packs** a non-technical person subscribes to in one tap — a "restock watch" pack,
a "government-filing alert" pack (new EDGAR 8-Ks, new county permits, new court
dockets on a docket number), a "competitor pricing" pack, a "grant & RFP
deadline" pack. Each pack is a pre-wired set of templates + schedules + a tuned
diff (you care about *price*, not the session token that changes every load), so
the consumer never sees a template, a schema, or a cron expression — only "tell
me when my thing happens."

The strategic point from the vision holds: **the notification *is* the product**;
the crystallized self-healing API underneath is invisible. Packs are how that
product acquires users who will never care about "an API" — they care that the
Bernhardt K1325 is back in stock, and a pack is the one-tap way to say so. The
existing `schedule_stock_check` tool is the primordial version of exactly this,
one monitor at a time; packs are its consumer-grade, bundled form.

Why unscheduled: it is a *productization and curation* effort layered on top of
`X05`/`M05`, and it should be shaped by which monitors people actually subscribe
to — data you only have *after* `X05`/`M05` ship. Build the capability first,
read the usage, then bundle the winners.

**Builds on:** `X05` (monitor service), `M05` (mobile push), `F20`
(change-monitoring mesh + `F02` diff), the `scheduler` / `notifier` modules and
`schedule_stock_check` tool that already exist.
**Promote when:** `X05`/`M05` are live and monitor-subscription telemetry shows a
handful of verticals dominating — those become the first packs, each a small
`W##`/`M##` curation feature.

## 5. Vertical capability packs — one-command bundles surfaced as app categories

The run-time sibling of idea 4. Where monitor packs bundle *alerts*, capability
packs bundle *templates you run*: a **"US-gov-procurement pack"** (SAM.gov +
state portals + county records + a couple of transforms), a **"carrier-tracking
pack"** (Maersk + FedEx + UPS + customs), a **"healthcare-eligibility pack."**
One command (`apimemcp add pack us-gov-procurement`, extending the `F19` CLI) on
self-host; one category tile in the web/mobile catalog for consumers. The pack is
the unit of *coverage* the vision's target markets (`00-vision.md` §5) are
organized around — each named market becomes a pack.

Packs turn "we support 4,000 individual templates" into "we cover procurement,
logistics, healthcare, and civic data" — a story a buyer and a browsing consumer
can both hold in their head. They also give the flywheel a coarse-grained pull
signal: a half-empty pack is a visible, nameable gap that invites contribution of
exactly the missing templates.

**Builds on:** `F19` (`apimemcp add` CLI → `add pack`), `F22` (discovery groups
templates into candidate packs), the registry + `add_community_template`, the
`W03`/`M03` catalog surfaces (packs = categories).
**Promote when:** a single vertical has enough verified templates to bundle
meaningfully (a pack of three is not a pack) — then a small feature defines the
pack manifest format and the CLI/catalog surfacing.

## 6. "API for the physical world" — monitors + notifier as a consumer brand

The broadest framing, and the one that could carry a consumer brand of its own.
Every idea above is machinery; this is the *positioning*: APImeMCP as **the
internet's missing notification layer for anything that has a screen but no
alert.** "Tell me when concert tickets drop." "Tell me when this apartment lists."
"Tell me when the visa-appointment portal opens a slot." "Tell me when this part
is back at any of these five suppliers." The user names a real-world event; the
system finds or crystallizes the template, schedules it, diffs it, and pushes the
moment it happens — no concept of scraping, APIs, or templates ever surfaces.

This is where the engineer's value proposition and the consumer's collapse into
one sentence, exactly as `00-vision.md` argues: *"a deterministic, versioned,
self-healing API over any screen"* and *"tell me the moment X happens"* are the
same system from two ends. As a brand, this is the mass-market front door — the
thing that reaches phones that will never install an MCP server. It is a moonshot
because it is as much a go-to-market and NL-understanding effort (map a
plain-English wish to a template, or to `F21`'s "make me an API for X" if none
exists) as an engineering one.

**Builds on:** `X05`/`M05` (the delivery mechanism), `F20` (the diff mesh),
`F21` (NL → template, for wishes with no existing template), the `notifier`
module + Expo Push.
**Promote when:** monitor packs (idea 4) have proven consumer retention — brand
and NL-wish intake are worth building only once the underlying monitor is
demonstrably something people keep.

---

# Theme C — Deepen the moat: robustness and autonomy

*The moat is determinism plus self-healing (`00-vision.md` §2). These three ideas
extend the healing further down (when the DOM itself fails), further back in time
(replay history), and further toward autonomy (heal with no calling agent).*

## 7. Multi-modal fallback — when the DOM fails, see the screen

`F04`/`F06` heal a template by handing forensic **DOM** back to a calling agent.
But some screens have no useful DOM: a `<canvas>` chart, a price baked into an
image, a PDF rendered to pixels, a deliberately obfuscated layout. The moonshot:
when DOM extraction fails or drifts irreparably, the engine **screenshots the
rendered page and hands the *image* to the calling agent's vision**, which reads
the value best-effort — and, critically, **crystallizes the successful visual
read** (which region, what OCR/vision prompt) so the next run is cheap again.
This is the crystallization thesis applied one layer below the DOM: pay for
vision once, amortize forever.

It preserves the project's defining constraint — **no embedded paid model**;
APImeMCP uses the *calling* agent's intelligence, here its vision, the same way
`F05`/`F06` use its reasoning. It closes the last "structurally impossible" gap
in coverage: with a vision fallback, there is no screen the corpus categorically
cannot address, only screens that are more or less expensive to crystallize.

Unscheduled because a *reliably crystallizable* visual read (stable region
anchoring, drift detection over an image rather than a schema) is genuinely hard
and should follow `F04`/`F06` proving the DOM-level heal loop first.

**Builds on:** `F04` (self-heal loop + `captureForensics`), `F06` (computer-use
crystallization), the `engine` screenshot path, `F02` (drift — extended to visual
diffs).
**Promote when:** `F04`/`F06` are solid on DOM sites *and* the registry is
hitting a wall of canvas/image/PDF screens that DOM extraction cannot serve —
that wall is the demand signal.

## 8. Time-travel snapshots — replay any extraction against page history

Persist the **rendered DOM (and optionally a screenshot) of every run**, keyed by
template + timestamp, so the corpus accumulates not just *what it can extract* but
*what each page actually said, over time*. Three payoffs fall out of one store:
**offline testing** (re-run an extraction against a frozen snapshot — no network,
deterministic, perfect for `F23` golden-snapshot regression), **provenance you
can re-examine** (`F11` receipts get a re-inspectable body, not just a hash), and
a genuinely new capability — *"what did this page say last Tuesday?"* — historical
query over screens that keep no history of their own.

That last one is a product in itself for the vision's markets: price history on a
page that shows only today's price, the prior text of a since-edited government
notice, the earlier state of a court docket. The web forgets constantly;
snapshots let the corpus remember, which is exactly the kind of compounding asset
`00-vision.md` §2 says APImeMCP should accumulate.

Banked because it is a storage-cost and retention-policy problem (rendered DOM is
heavy; you need TTLs, sampling, and a query layer), best designed once `F11`
provenance and `F23` snapshots exist to define the record format.

**Builds on:** `F23` (golden snapshots — the same capture, retained), `F11`
(provenance — snapshots are the receipt's body), `F02` (diff over the history),
`captureForensics` + `atomicWriteFile` (the capture/write primitives exist).
**Promote when:** `F11` + `F23` have shipped and a customer needs historical
replay or audit re-inspection — retention policy then gets designed against a
real requirement instead of a guess.

## 9. Optional local-LLM autonomous mode — heal with no calling agent

APImeMCP deliberately embeds *no* model: `F05` (author a script), `F04` (heal a
drift), and `F06` (crystallize a computer-use run) all borrow the **calling
agent's** intelligence. That is the right default — it keeps the "no paid API
key" promise. But it means the engine cannot act when *no agent is calling* —
e.g., the nightly self-heal on an unattended worker. The moonshot: an **optional
Ollama (local-LLM) adapter** that supplies just enough on-device reasoning for
`F05`/`F04` to run **fully headless**, so the engine on the recommended Oracle
Always-Free ARM worker (`07-platform-design`/hosting) can re-verify nightly
(`F03`) *and repair its own drift* before a human or consumer ever hits it — at
still-zero recurring cost, because the model is local.

This is the difference between "self-healing when someone asks" and "self-healing
while everyone sleeps." It makes the corpus' maintenance truly autonomous, which
is the strongest possible version of the flywheel's "preservation" step
(`00-vision.md` §4): value added in month one stays live in year three *without
any agent in the loop.* The constraint is honored precisely because Ollama is
local and free — no paid key, opt-in, off by default.

**Builds on:** `F04` (heal loop), `F05` (synthesize), `F06` (crystallize),
`F03` (nightly re-verify is where headless heal pays off), the free Oracle/GitHub
Actions runners in the hosting matrix.
**Promote when:** `F04` is proven *with* a calling agent and there is real demand
for unattended operation (the nightly-worker case) — then the adapter ships as an
optional module, gated so the default stays model-free.

---

# Theme D — Trust, provenance, and the enterprise

*The compliance and enterprise markets (`00-vision.md` §5) need two things a
public scraper cannot offer: attestable provenance and private scope. These two
ideas provide each.*

## 10. Provenance ledger — publish receipts to a tamper-evident public log

`F11` signs each run's receipt (content hash + version + schema-valid). The
moonshot: **append those receipts to a public, tamper-evident log** — a
Merkle/transparency-log structure in the spirit of Certificate Transparency — so
that "this datum came from this source, at this time, unaltered" is verifiable by
a *third party* without trusting APImeMCP or the operator. For regulated data
(the healthcare, financial-aggregation, and compliance markets), that is the
difference between "we assert provenance" and "provenance you can independently
audit."

This turns provenance from a feature into an *institution*. An investigative
journalist, an auditor, or a regulator can point at a ledger entry and verify the
chain themselves; a template's outputs become citable evidence. It is the
strongest possible answer to "how do I trust a crowd-supplied API," and it is
unique to the crystallized-deterministic model — a computer-use agent's opaque
click-chain has nothing to put in a ledger.

Kept in the bank because a public append-only log is real infrastructure plus
governance (who runs it, how entries are gossiped/verified, privacy of what gets
logged), and it is only worth building once `F11` receipts are in wide use and a
compliance customer actually needs third-party attestation.

**Builds on:** `F11` (signed receipts — the ledger's entries), `F03`
(verification badges), idea 8 (snapshots — the re-inspectable body behind a
logged hash).
**Promote when:** `F11` is shipped and in use, and a regulated-data customer's
requirement makes independent auditability worth the infrastructure — that
requirement writes the spec.

## 11. Federated registries — private + public, with precedence

Today there is one community registry (`ADR-06`). Enterprises will not publish
their proprietary internal-tool templates to it — nor should they. The moonshot:
**federation** — an org runs a *private* registry of its own templates that
**overlays** the public one with precedence, so `findTemplateByUrl` resolves an
internal template first and falls through to public. The commercial-banking
dashboard template a bank builds for itself stays inside the bank; the public
"track a UPS package" template it also uses comes from the commons. One resolution
path, two (or many) sources, private-shadows-public precedence.

This is the enterprise on-ramp. It lets APImeMCP into environments that would
never allow a single shared public registry, without forking the product: the
engine, the gates, the self-heal loop, the platform clients all work identically
against a federated set of registries. It also composes cleanly with idea 5
(capability packs) — a private pack of internal-tool APIs sitting next to the
public procurement pack — and with `F24` reputation scoped per-registry.

Unscheduled because `ADR-06` currently defines *the* registry as a single
cross-repo contract; federation means generalizing that contract to an ordered
list of sources with a precedence and trust model, which is a real design effort
best triggered by an actual enterprise requirement rather than built
speculatively.

**Builds on:** `ADR-06` (registry contract — generalized to a source list),
`registry-client` + `findTemplateByUrl` (the resolution path), `add_community_template`
(the private-add analogue), `F24` (per-registry reputation), `F13`/`X06`
(private templates often carry credentials).
**Promote when:** a concrete enterprise needs private templates — that engagement
defines the precedence/trust model and the idea graduates into an engine feature
plus an `ADR-06` amendment.

---

## Further sparks (one-liners, not yet worth a full entry)

Ideas that pass the "moves toward the north star" bar but haven't earned a full
write-up. Each is a candidate to graduate into an entry above, or straight into a
spec, when something makes it cheap.

- **"APIfy this page" browser button.** Extend the existing `extension/` (already
  a cookie bridge / "grab cookies" tool) so one click on any page kicks off
  `F05`/`F21` authoring against the current URL — crystallize the screen you're
  looking at, right now. *Builds on:* `extension/`, `F05`, `F21`,
  `save_template_cookies`.
- **Template → mock server.** Invert `F25`'s OpenAPI export: from a template's
  `F01` schema, spin up a *fake* API returning schema-valid sample data — instant
  test double for anyone building against a template before it's live. *Builds
  on:* `F01`, `F25`.
- **Semantic schema alignment.** A light shared ontology so `price`, `sku`,
  `status` mean the same field across templates — enabling cross-site joins
  ("cheapest of these five suppliers") without per-pair glue. *Builds on:* `F10`
  transform, `F22` discovery.
- **Template bounties / contribution economy.** A visible "wanted" board where
  demand for an uncovered screen (the flywheel's "pull" made explicit) can be
  claimed by a contributing agent or dev; ties to `F24` reputation. *Builds on:*
  `F24`, the registry.
- **Edge/WASM crystallized runtime.** Compile the `F15` `static-http` fast-path to
  WASM so no-JS templates run *client-side* in the browser/phone with zero cloud
  round-trip — the ultimate free tier. *Builds on:* `F15`, `X02`.
- **"Explain this template" docs.** Auto-generate human-readable, example-rich
  docs from a template's `F01` schema + a sample run — the template documents
  itself for the `W04` detail page and the mobile detail screen. *Builds on:*
  `F01`, `W04`/`M03`.
- **Diff-as-signal marketplace.** The monitor diffs (`F20`) are themselves
  valuable data ("prices in this category moved 4% this week") — an aggregate,
  privacy-preserving signal product distinct from any single user's monitor.
  *Builds on:* `F20`, `X05`.

---

## What this file is *not*

To keep the boundary sharp: this is not a backlog, not a roadmap, and not a
promise. A backlog is work someone intends to do; a roadmap is work with dates.
This is a **bank of options** — thought-through enough to promote quickly,
explicitly *not* committed to. The commitments live in `02a`/`02b` and the
tracker; the schedule lives in `03-orchestration`. If you are an agent looking
for the next thing to *build*, this is not that list — read
`05-tracking/tracker-data.json` and pick the next unblocked scheduled feature.
Come here only when a shipped feature just made one of these cheap, and you want
to promote it.

**Read next:** `00-vision.md` (why any of this matters), then the feature the
idea you're promoting builds on (`02a`/`02b`), then the per-feature spec template
to write its now-scheduled spec.
