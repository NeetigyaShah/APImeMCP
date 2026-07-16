# 07-platform-design / mobile-app-design.md

**Surface:** Mobile (Program 2). **Stack:** **React Native + Expo** (locked decision ⑤). **Owned by:** Mobile Builder + Design Lead (brand gate G3b). **Repo:** `apimemcp-platform` (`apps/mobile`). **Features:** M01–M07. **Consumes:** the cloud execution API (X01–X07, [cloud-architecture.md](./cloud-architecture.md)) and the shared design system ([design-system.md](./design-system.md)). **Distribution:** free-first (locked decision ⑧).

> Plan only. Specifies what the Mobile Builder builds against. No code here.

---

## 1. The decision: React Native + Expo (and why)

Mobile is **React Native + Expo**, chosen over Flutter and native. The reasoning (this is the "lazy-correct" pick — least new surface, most reuse):

- **(a) Whole stack is TypeScript.** The app **shares the API client, the F01 result types, and validation** with the backend and web via `packages/shared`. One type system end to end — a result shape defined once is typed in the engine, the cloud, the web console, and the phone.
- **(b) Shared React mental model.** Same paradigm as the site — one team, one way of thinking about components and state across web and mobile.
- **(c) Expo EAS = one codebase → native iOS + Android**, plus **OTA updates** and **first-class Expo Push** — the "results to your phone" mechanism across **APNs + FCM with no native plumbing**. Push is the product's headline delivery channel (monitors), so first-class cross-platform push is decisive.
- **(d) Native look** via RN native components + a themed design system (not a webview).

**Rejected alternatives:** **Flutter** = a second language (Dart), no code-share with backend/web. **Native (Swift + Kotlin)** = two codebases. Both cost more for no benefit the product needs. RN + Expo is lazy-correct.

**Skills (pre-vetted, ≥1K installs):** `mindrally/skills@expo-react-native-typescript` (1.6K — M01–M07), `pproenca/dot-skills@expo-react-native-performance` (1K — list virtualization, startup, M-perf). A Swift-native push skill is **not** installed — Expo's own Notifications API covers cross-platform push (decision recorded in the skills matrix).

---

## 2. Screens

Onboarding → Browse → Detail → Run → **Monitors (headline)** → Runs → Account. Each lists purpose, key elements, and the features/cloud it uses.

### 2.1 Onboarding / auth (M01)
- **Purpose:** get the user in with the **same Clerk accounts** as the website.
- **Elements:** sign in / sign up (Clerk), first-run explainer of the value (browse + run + monitor community APIs from your phone).
- **Uses:** Clerk auth (`vercel:auth`), shared accounts with web.

### 2.2 Browse / registry (M03)
- **Purpose:** discover community templates on a phone.
- **Elements:** **search**, **filter**, **verification badges (F03)**, **category**, **trending** (run-count). Native list (virtualized for performance — expo-react-native-performance skill).
- **Uses:** X07 registry mirror/cache (fast catalog/search); F03 badges.

### 2.3 Template detail (M03/M04)
- **Purpose:** everything about one template + entry to run.
- **Elements:** the **F01 schema**, docs, verification/provenance (F03/F11), **Run** entry.
- **Uses:** registry manifest (X07), F01, F03, F11.

### 2.4 Run (M04)
- **Purpose:** run a template and see the result on the phone.
- **Elements:**
  - **Inputs:** target **URL** or **one-tap fixed-target**;
  - **Cookies:** via **paste** now, or later a **"grab from this site" webview** (a first-party in-app browser that captures the session) — the mobile analogue of the extension's cookie bridge;
  - **enqueue → progress → result** delivered **in-app + push**;
  - **result views:** **JSON / table / image gallery / share** (typed by F01; `dataviz` for table/gallery).
- **Uses:** X01 (run), X04 (delivery + push), F01. Heavy templates surface the same "too heavy for the cloud tier — run on self-host" message (X03) or route to the Oracle worker under the $0 stack.

### 2.5 Monitors + push (M05) — the headline
- **Purpose:** subscribe to a template and **get pushed when the value changes**. This is the consumer wedge — *the notification is the value.*
- **Elements:** **subscribe** (template + inputs + **schedule**); **push-on-change** (Expo Notifications); a **list** with **last value + history** per monitor.
- **Uses:** X05 monitors (cron + F02 diff + push), Expo Push. "Direct results / without going anywhere" = **the push delivers the result/change and deep-links into the app**; for monitors, the notification itself carries the value ("Bernhardt K1325 → \$X", "back in stock", "new filing").

### 2.6 Runs (history) (M06)
- **Purpose:** see past runs and their results.
- **Elements:** run history list, result re-view.
- **Uses:** user data (Postgres), F01 result types.

### 2.7 Account (M06)
- **Purpose:** the user's settings + credentials home.
- **Elements:** **device-encrypted cookies / vault**, **API key**, settings.
- **Uses:** X06 (encrypted cookies, opt-in vault — ADR-05: session dirs vs secrets), device secure storage, `security-and-hardening`.

---

## 3. Native feel (not a webview)

- **RN core components** + a **themed component system** — **Tamagui / RN-Paper / custom** (Design Lead's call in M02), driven by the shared design tokens ([design-system.md](./design-system.md)) adapted to a native RN theme.
- **Expo Router** for navigation.
- **Respects iOS/Android conventions** — native navigation patterns, gestures, and controls; deliberately **not a webview wrapper**.
- **Push** via **Expo Notifications** (APNs + FCM under one API).
- **Offline:** **cache the catalog** so browsing works offline; **runs need connectivity** (they call the cloud). Monitors are server-side (X05) — they fire regardless of whether the app is open, and deliver via push.
- **Real data everywhere** + a11y floor (visible focus/selection state, reduced-motion, sufficient contrast) on device — Design-Lead gated (G3b), verified on **device/simulator** (Live-Verification Gatekeeper).

---

## 4. Distribution (free-first — locked decision ⑧)

Built for **both stores**, distributed **free first**:

- **EAS build** both platforms (one codebase → native iOS + Android).
- **Free channels first:** **EAS internal distribution / TestFlight / Expo Go** — no store fees to get it into testers' hands.
- **Public store launch is a later owner step** (M07 prepares assets; the owner pays the fees when ready): **Apple \$99/yr**, **Google \$25** one-time.
- **M07 app-store prep:** icons / splash / EAS submit config / store listing (`banner-design`, `expo-react-native-performance`). Fees are the owner's step, not a build blocker.

---

## 5. Feature map (which M## builds what)

| Screen / capability | Feature | Wave | Key deps |
|---|---|---|---|
| Expo app scaffold (iOS+Android, Router, EAS, Clerk) | **M01** | P1 | W01, W02 |
| Mobile design-system impl (native-look themed components) | **M02** | P1 | W02, M01 |
| Browse / registry screens | **M03** | P2 | M02, X07 |
| Run screen + result views | **M04** | P2 | M03, X01, X04 |
| Monitors + push (headline) | **M05** | P3 | M04, X05 |
| Run history + account + cookies | **M06** | P3 | M04, X06 |
| App-store prep (icons/splash/submit/listing) | **M07** | P4 | M01–M06 |

**Sequencing:** M01/M02 (scaffold + design system) are P1, parallel to the web pod and Program 1 Waves 1–2. The run core (M04) lands after X01/X04. Monitors (M05) are P3, after X05. The mobile app **depends on Program 1** for its content (registry F03, schema F01 for result typing/views, hosted-exec F18 behind X01, diff F02→F20→X05 for monitors, provenance F11 for trust). See [cloud-architecture.md](./cloud-architecture.md) for the execution layer and [design-system.md](./design-system.md) for the shared tokens M02 implements.
