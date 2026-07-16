# 07-platform-design / hosting-options.md

**Purpose:** the standalone deep-dive on **where the two-track product runs**, and specifically **the genuinely-free path to run *all* of it — heavy templates and monitors included — at \$0**. This is the file the cloud architecture ([cloud-architecture.md](./cloud-architecture.md) §5) points to for full detail. **Owned by:** Cloud/Infra Builder + Deployment Agent. **Relevant locked decisions:** ⑦ (Vercel-native, free-tier-first), ⑧ (mobile built for both stores, distributed free first), ⑨ (a free-hosting matrix is documented; the Oracle worker + GitHub Actions strictly upgrade ⑦ while staying \$0).

> Plan only. This documents the options and the recommended stack; it provisions nothing.

---

## 1. The question this answers

Locked decision ⑦ makes the cloud **Vercel-native and free-tier-first**, which means **heavy paginated templates** (the "1000-comment" class that exceeds serverless limits) fall back to a *"run on your self-host server"* message (X03). The owner's question: **is there another free layer that can run the *whole* thing — including the heavy templates and the monitors — so nothing has to fall back to self-host, and it still costs \$0?**

**Answer: yes.** Several genuinely-free layers combine into a full-stack that runs every community API from a phone, heavy ones included, at no recurring cost. Adopting the two starred layers (Oracle + GitHub Actions) is a small free signup that **strictly upgrades** decision ⑦ without changing its Vercel-native default (decision ⑨).

---

## 2. The free-hosting matrix (per layer)

Each row is one layer of the stack, its free option(s), what it runs, and the caveat to plan around.

### 2.1 Web / site
- **Free options:** **Vercel Hobby** (the default — matches the Next.js + `vercel:*` skill stack) or **Cloudflare Pages**.
- **Runs:** the Next.js community site ([website-design.md](./website-design.md)).
- **Caveat:** Vercel's Hobby tier is **non-commercial** — fine for the free-first community launch; a commercial launch moves to Vercel Pro or Cloudflare Pages (no such restriction).

### 2.2 DB + auth + storage
- **Free options:** **Supabase free** (Postgres + auth + storage + edge functions in one) or **Cloudflare D1 + R2**.
- **Runs:** the registry mirror/cache (X07), accounts + dashboard (W07), monitor/run records.
- **Caveat:** Supabase **pauses idle projects** on the free tier (a cold-start delay after inactivity; a scheduled ping keeps it warm). D1+R2 has no pause but splits DB (D1) and blobs (R2).
- **Note vs the Vercel-native default:** the Vercel-native stack uses **Neon Postgres + Clerk auth**; Supabase is the **all-in-one \$0 alternative** that folds DB+auth+storage into one free service.

### 2.3 Light execution
- **Free options:** **Cloudflare Browser Rendering** (free Playwright-at-edge) or a **Vercel Function + `@sparticuz/chromium`**.
- **Runs:** `static-http` (F15) + quick/light templates — the X02 inline fast path.
- **Caveat:** **edge CPU/time limits** — light templates only; anything heavy exceeds these (that's what the heavy layer is for).

### 2.4 ⭐ Heavy + always-on (the layer that lifts the self-host fallback)
- **Free option:** **Oracle Cloud Always-Free** — a **permanent ARM VM (4 cores / 24 GB)** that runs the **full APImeMCP engine + a queue worker forever, free**.
- **Runs:** the **1000-comment-class heavy templates** and, in fact, **the whole engine** — this is a real always-on server, not a serverless slice, so there are no per-invocation timeout limits.
- **Caveat:** **one free signup**; **ARM architecture** (build/deploy ARM-compatible — the engine is Node/Playwright, both fine on ARM64). Capacity availability in a given Oracle region can vary at signup.
- **Why it matters:** this is the layer that turns the "too heavy for the cloud tier — run on self-host" fallback into "runs in the cloud for free". It *is* a self-host server, but one the owner runs for \$0 on Oracle's permanent free tier rather than on their own hardware.

### 2.5 ⭐ On-demand + cron runner
- **Free option:** **GitHub Actions** — free, with ***unlimited* minutes on public repos**.
- **Runs:** **monitors** (scheduled workflows → the X05 cron), **nightly re-verification** (F03's `verify-registry` / nightly workflow), and **on-demand heavy runs** (`workflow_dispatch` to run a template). Results returned via **artifact / webhook / `repository_dispatch`**.
- **Caveat:** **~job-start latency** (a cold runner takes tens of seconds to spin up — fine for cron/monitors, not for interactive sync runs); **unlimited only on public repos** (private repos have a monthly minute cap).

### 2.6 Push
- **Free option:** **Expo Push + FCM**.
- **Runs:** mobile delivery — the "results to your phone" channel for runs (X04) and monitors (X05/M05).
- **Caveat:** free.

### Matrix summary

| Layer | Free option(s) | Runs | Caveat |
|---|---|---|---|
| Web / site | **Vercel Hobby** or **Cloudflare Pages** | Next.js site | Vercel non-commercial hobby terms |
| DB + auth + storage | **Supabase free** or **Cloudflare D1+R2** | X07, W07, accounts | Supabase pauses idle projects |
| Light execution | **Cloudflare Browser Rendering** or Vercel fn + `@sparticuz/chromium` | static-http (F15) + quick templates | edge CPU/time limits |
| **Heavy + always-on** | ⭐ **Oracle Cloud Always-Free** (ARM 4c/24GB — full engine + worker, forever) | 1000-comment-class templates, whole engine | one free signup; ARM arch |
| On-demand + cron | ⭐ **GitHub Actions** (unlimited mins on public repos) | monitors, nightly-verify (F03), on-demand heavy runs | ~job-start latency; public-repo only for unlimited |
| Push | **Expo Push + FCM** | mobile delivery | free |

---

## 3. Recommended \$0 full-stack

**Vercel/Cloudflare (web) + Supabase (DB/auth) + Cloudflare Browser Rendering or `@sparticuz/chromium` (light exec) + Oracle Always-Free ARM worker (heavy exec = the engine) + GitHub Actions (cron monitors + nightly-verify) + Expo Push.**

This runs the **entire two-track product — every community API from the phone, heavy ones included — at no recurring cost**, and it **lifts the heavy→self-host fallback while staying \$0**.

```
                 ┌──────────────────────────── $0 full-stack ────────────────────────────┐
   web  ─────────►  Vercel Hobby / Cloudflare Pages         (Next.js site)
   data ─────────►  Supabase free                           (X07 mirror, W07 accounts)
   light exec ───►  CF Browser Rendering / @sparticuz/chromium  (F15 + quick templates)
   HEAVY exec ───►  ⭐ Oracle Always-Free ARM VM             (full engine + queue worker)
   cron/on-demand►  ⭐ GitHub Actions                        (X05 monitors, F03 nightly, heavy dispatch)
   push ─────────►  Expo Push + FCM                          (X04/X05 → phone)
                 └───────────────────────────────────────────────────────────────────────┘
```

**How it maps to the cloud components (X##):**
- **X01/X02 light path** → Vercel fn + `@sparticuz/chromium` (or CF Browser Rendering).
- **X02/X03 heavy path** → **Oracle worker** consumes a queue; **GitHub Actions** dispatches on-demand heavy runs. The "too heavy for the tier" message becomes rare instead of routine.
- **X05 monitors** → **GitHub Actions scheduled workflows** run the cron for free (unlimited on public repos); F02 diff runs on the Oracle worker; change → Expo push.
- **X07 mirror** → Supabase Postgres.
- **F03 nightly re-verification** → a GitHub Actions scheduled workflow.

---

## 4. How this upgrades decision ⑦ (decision ⑨)

Decision ⑦ stays the **default**: Vercel-native, free-tier-first. The \$0 full-stack **adds** two free layers on top:

- the **Oracle Always-Free ARM worker** (heavy execution), and
- **GitHub Actions** (free cron + on-demand).

Adopting them is a **small, free owner-signup step** that **strictly upgrades ⑦ while remaining \$0** — it does not replace the Vercel-native path, it removes the one rough edge (heavy templates falling back to self-host) by giving heavy templates a free always-on home. This is exactly decision ⑨: the free-hosting matrix is documented, and the recommended \$0 full-stack lifts the fallback at no cost.

**Owner action to adopt (all free):**
1. Sign up for **Oracle Cloud Always-Free**, provision the ARM VM, deploy the engine + a queue worker.
2. Make the templates/runner repo **public** (or accept the private-repo minute cap) to get **unlimited GitHub Actions** minutes; add the `workflow_dispatch` run workflow + the scheduled monitor/nightly-verify workflows.
3. (Optional) swap Neon+Clerk for **Supabase** if consolidating DB+auth into the free all-in-one is preferred.

None of these are build blockers — the product ships on the Vercel free tier first; the Oracle+Actions layers are a strictly-additive upgrade the owner can adopt whenever.

---

## 5. Paid upgrade path (when \$0 is outgrown)

Free-first is the launch posture; these are the *later* paid steps, called out so the owner knows the ceiling:

| Trigger | Paid step |
|---|---|
| Commercial web launch (Hobby is non-commercial) | **Vercel Pro** (or stay free on Cloudflare Pages) |
| Heavy/interactive execution beyond Actions latency | a dedicated **BullMQ worker** (skill `bullmq-specialist` pre-vetted, **deferred** by ⑦) on a paid VM/container |
| DB beyond free tier / no idle-pause | **Supabase Pro** or **Neon** paid |
| **Public app store launch** (decision ⑧) | **Apple \$99/yr**, **Google \$25** one-time — an owner step, not a build blocker |

Mobile distribution is **free-first** (decision ⑧): EAS internal / TestFlight / Expo Go cost nothing; only the public store listing carries the fees above. See [mobile-app-design.md](./mobile-app-design.md) §4.

---

## 6. Decision guidance (quick chooser)

- **"I want the simplest free path that's Vercel-native"** → Vercel Hobby + Neon + Clerk + `@sparticuz/chromium` light exec; heavy templates fall back to self-host (bare decision ⑦).
- **"I want everything to run free, including heavy templates + monitors"** → the **recommended \$0 full-stack** (§3): add the **Oracle worker + GitHub Actions** (decision ⑨).
- **"I want to consolidate DB+auth+storage into one free service"** → **Supabase** instead of Neon+Clerk.
- **"I'm going commercial / need low latency on heavy runs"** → the **paid upgrade path** (§5).

---

## 7. Skill note (why some layers use context7, not a skill)

Per the skill-quality bar (**prefer ≥1K installs; reject <100**), **no reputable ≥1K-install skill exists** for Cloudflare / serverless-Chromium / Oracle (the vetted community skills top out at **142 / 75 / 63** installs → rejected). So the **Cloud/Infra Builder uses `context7` (live official docs) + the vendors' own docs** for these layers, rather than settling for a weak skill. The Vercel-native layers keep their first-party `vercel:*` skills; Expo push keeps the `expo-react-native-typescript` skill's Notifications coverage.
