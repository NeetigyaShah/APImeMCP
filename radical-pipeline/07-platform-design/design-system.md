# 07-platform-design / design-system.md

**Scope:** one cross-surface token system shared by **web** (shadcn theme) and **mobile** (RN theme). **Owned by:** the **Design Lead** (blocks UI PRs that break identity or a11y — gate **G3b**). **Built by:** W02 (web) + M02 (mobile). **Derived from:** the established phosphor/void "compiler/terminal" identity. **Consumed by:** every UI surface in [website-design.md](./website-design.md) and [mobile-app-design.md](./mobile-app-design.md).

> Plan only. This defines the token architecture and the brand-derived starting values. Exact intermediate shades/scales are the Design Lead's to finalize and tune per platform — the values below are a coherent, a11y-checked starting point, not a frozen spec.

---

## 1. Principle: one token system, two platform adapters

There is **one** source-of-truth token set (color / type / space / motion) living in `packages/shared`. Each platform **adapts** it:

- **Web:** tokens → CSS variables → **shadcn/Tailwind theme** (`vercel:shadcn`).
- **Mobile:** the same tokens → an **RN theme** object (Tamagui / RN-Paper / custom, per M02).

Both derive from the **same phosphor/void identity**, so a template row, a run result, or a verification badge reads as the *same product* whether on a laptop or a phone. The Design Lead owns the source set; W02 and M02 are the two adapters, and they must not diverge (G3b enforces parity).

**Token layering (three-layer, per `ui-ux-pro-max:design-system`):** primitive (raw values) → semantic (role-named: `bg`, `fg`, `primary`, `border`, `success`…) → component (button, badge, table-row…). UI code references **semantic/component** tokens, never raw hex — so a brand tune touches one layer.

---

## 2. Color

### Anchors (locked brand facts)
| Token | Value | Role |
|---|---|---|
| `--void` | **`#14100a`** | the ground — app background |
| `--phosphor` | **`#ffb627`** | the signal — primary accent / brand |

This is a **dark-first, single-accent** identity: warm near-black ground, one phosphor-amber signal. Amber is used for emphasis, focus, primary actions, and "live/verified" signals — **not** as body-text color at small sizes (contrast; see a11y below).

### Derived scale (starting point — Design Lead tunes)
A coherent set derived from the two anchors. These are proposed, a11y-sane defaults; the Design Lead finalizes exact values.

| Semantic token | Starting value | Use |
|---|---|---|
| `bg` | `#14100a` (void) | app/page background |
| `bg-raised` | `#1e1810` | cards, ledger rows, terminal panel |
| `bg-inset` | `#0d0a06` | wells, code blocks, input fields |
| `border` | `#2c241a` | hairlines, table rules, dividers |
| `fg` | `#f2e9d8` | primary body text (warm off-white — passes contrast on void, unlike raw amber) |
| `fg-muted` | `#a99a80` | secondary text, metadata, timestamps |
| `primary` | `#ffb627` (phosphor) | primary action, brand marks, focus, links-as-emphasis |
| `primary-fg` | `#14100a` | text/icon on an amber fill (dark-on-amber for contrast) |
| `success` | `#69d083` | verified badge (F03), "run OK", "in stock" |
| `warn` | `#ffb627` (phosphor) | in-review, drift-flagged (F02), attention |
| `danger` | `#ff5c5c` | failed run, blocked, "out of stock" |
| `info` | `#6fb3ff` | in-progress, neutral status |

**Status-cell parity with the tracker:** the same status semantics used by the Excel Progress heat-map (grey=N/A, white=Todo, blue=In-Prog, amber=In-Review, red=Blocked, green=Done) map onto these `info/warn/danger/success` tokens, so status reads consistently from tracker → web dashboard → mobile.

---

## 3. Typography

**Locked:** **IBM Plex Mono** (machine output) + **IBM Plex Sans** (interface copy). The mono/sans split is a brand device, not decoration — use it semantically.

| Token | Family | Applied to |
|---|---|---|
| `font-mono` | **IBM Plex Mono** | results (JSON/table values), template ids, the registry **ledger** rows, the hero **terminal**, code, `.mjs`, provenance hashes (F11) |
| `font-sans` | **IBM Plex Sans** | nav, buttons, marketing/prose copy, form labels, headings that are "interface" not "output" |

**Type scale (starting, modular):** `xs 12 / sm 14 / base 16 / lg 18 / xl 22 / 2xl 28 / 3xl 36` with line-heights tuned tighter for mono (data density) and looser for sans (readability). Ledger and result tables use `font-mono` at `sm` for scannable density.

**Rule of thumb for builders:** if the text is *something a machine produced or a machine identifier*, it's mono; if it's *the interface talking to a human*, it's sans.

---

## 4. Spacing, radius, elevation

- **Space scale (4px base):** `1=4 · 2=8 · 3=12 · 4=16 · 6=24 · 8=32 · 12=48`. The ledger uses tight vertical rhythm (dense rows); marketing/landing uses generous spacing.
- **Radius:** small and restrained — `sm=4 · md=6 · lg=10`. The terminal/ledger aesthetic favors crisp corners over pill-round; buttons/cards use `md`.
- **Elevation:** dark UI leans on **`bg-raised` + `border`**, not heavy shadows. Where elevation is needed, a subtle amber-tinted glow (`0 0 0 1px border` + faint phosphor bloom) reinforces the "phosphor screen" feel. Reduced-motion and low-glow variants required.

---

## 5. Motion

- **Terminal stream:** the hero's compile→run→stream animation (W08) is the signature motion — a live typing/streaming cadence. It **must honor `prefers-reduced-motion`** (fall back to instant render).
- **Status transitions:** badge/status changes animate briefly (color + subtle scale), reduced-motion → instant.
- **General:** motion is functional (progress, arrival of a result, push landing), never decorative-only. Durations short (120–240ms); easing standard.

---

## 6. Accessibility floor (Design-Lead gated, non-negotiable)

Applies on **both** surfaces; verified on device/preview by the Live-Verification Gatekeeper.

- **Visible focus** — every interactive element has a visible focus/selection state (amber ring on void, meeting contrast). Keyboard-navigable ledger, tables, and forms on web.
- **Reduced motion** — all animation (esp. the terminal stream) respects `prefers-reduced-motion`.
- **Contrast** — body text uses `fg`/`fg-muted` (off-white/tan), **not raw `#ffb627` on `#14100a`** where it would fail small-text contrast. Amber is reserved for large/interactive/emphasis elements that pass. Status colors are distinguishable and not color-only (pair with icon/label).
- **Targets** — mobile tap targets meet minimum size; native controls preferred (respects iOS/Android conventions).

## 7. The "real data everywhere" rule

**No lorem, no mock results, no fake screenshots.** Every rendered result, ledger row, badge, and count is real (from X01/X07). This is a brand + trust rule — the product's entire premise is *real programmatic access*, so the UI must never show data it didn't actually get. Enforced at G3b and in Live-Verify.

---

## 8. Ownership & build map

| Concern | Owner / feature |
|---|---|
| Source token set (color/type/space/motion) + brand direction | **Design Lead** |
| Web adapter (CSS vars → shadcn/Tailwind theme) | **W02** (P0) |
| Mobile adapter (tokens → RN theme, Tamagui/RN-Paper/custom) | **M02** (P1) |
| Brand + a11y gate on every UI PR (**blocks**) | **Design Lead — G3b** |
| Device/preview verification of a11y + real-data | **Live-Verification Gatekeeper — G6** |

**Parity requirement:** W02 and M02 consume the **same** token source; a change to a semantic token must land in both adapters. The Design Lead blocks any UI PR (web or mobile) that breaks identity, a11y floor, or web/mobile parity. See [website-design.md](./website-design.md) and [mobile-app-design.md](./mobile-app-design.md) for how each surface applies these tokens.
