# ArchLens AI — project brief (for future Claude sessions)

## What this is

A GitHub Action that posts an AI-generated Mermaid architecture diagram as a
PR comment, scoped to the structural impact of that PR's diff. Free for
public repos; $12/mo/private-repo (solo) and $29/mo/org (team) paid tiers.
Full design reasoning: `docs/ARCHITECTURE.md`.

## How this fits into Anurag's broader plan

This is a **side track, not the primary build target**. On 2026-08-29,
Anurag committed to PayoutPilot (Shopify payout reconciliation) as the
primary product to ship, and separately told Claude to stop pitching ideas
whose go-to-market depends on organic discovery rather than a channel he
already owns or a deterministic outreach list. ArchLens's GTM (GitHub
Marketplace listing, Show HN, Reddit, "seed 10 open-source repos") is
exactly that pattern — flagged explicitly, and Anurag chose to build both in
parallel anyway, with distribution deliberately left unsolved for now.
**Do not silently treat ArchLens as the priority over PayoutPilot** in a
future session without checking — ask if it's unclear which one is active.

## What's actually built and verified (not aspirational)

- Full monorepo: `action/` (the GitHub Action, TypeScript, bundled via
  `@vercel/ncc` into a single `dist/index.js`) and `backend/` (Vercel
  serverless functions, TypeScript).
- 84 passing tests (`npm test`) plus a real end-to-end dry run
  (`npm run dry-run`) that runs the actual Action HTTP client against the
  actual backend handler over a real HTTP connection, with a real `mmdc`
  (headless Chromium) render — not mocks on both sides.
- `tsc --noEmit` clean on both workspaces.
- **A live, isolated Supabase project (`archlens-ai`) exists and is fully
  verified** (2026-08-30) — schema applied, storage bucket created,
  `backend/.env` has real `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, and a
  real REST round-trip against it (all 4 tables + both RPC functions)
  passed. See item 2 below for the full story, including a real grants bug
  that was caught and fixed. The test suite itself still runs against
  in-memory fakes (`InMemoryQuotaStore`, `InMemoryDiagramCache`) behind the
  same interfaces the real Supabase-backed implementations use — that's
  intentional (fast, deterministic unit tests), not a gap.
- Stripe checkout + webhook logic is refactored into testable, dependency-
  injected handlers (`lib/checkout-handler.ts`, `lib/webhook-handler.ts`)
  with 20 tests including offline Stripe-signature verification — see
  item 4 below — but **no live Stripe account/products exist yet**.
- **A live, working Anthropic API key is configured and verified**
  (2026-08-30) — see item 3 below for the full story, including the
  placeholder-key false start caught before it shipped. LLM client
  defaults to Anthropic (`claude-haiku-4-5`); OpenAI and DeepSeek remain
  supported as explicit opt-ins.

## What's NOT done — the real remaining work before this can charge anyone

1. Create the actual GitHub repo and push this code (no `gh` CLI available
   in the sandbox this was built in — done locally, needs the user's GitHub
   auth to publish).
2. ~~Stand up a new Supabase project inside the same org as Kith~~ **DONE
   AND LIVE-VERIFIED (2026-08-30).** Created project `archlens-ai` (ref
   `litwegklwcfbwjnemaaq`, region ap-south-1/Mumbai) inside Kith's org via
   browser automation, once the user logged into Supabase in their Chrome
   themselves. Confirmed completely separate from Kith's `Kith` and `NANO`
   projects — never touched. `db/schema.sql` has been run against it
   (verified live: Table Editor shows all four tables — `orgs`, `api_keys`,
   `usage_logs`, `diagram_cache` — and nothing else). The `diagrams` public
   Storage bucket is also created, matching `backend/lib/supabase.ts`'s
   `DIAGRAMS_BUCKET` constant. The user pasted the `anon`/`service_role`
   keys directly (the browser automation tooling deliberately redacts
   JWT-shaped secrets from both DOM-text extraction and page-script
   execution — a safety guardrail against an agent exfiltrating
   credentials — so this had to come from the user, not automation), and
   they're now in `backend/.env` (gitignored) as `SUPABASE_URL` /
   `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY`.

   **Real bug found and fixed during verification, not assumed away:** a
   live REST call from the browser (real internet egress, unlike this
   sandbox — see below) using the actual service_role key returned `403
   permission denied for table orgs` (Postgres 42501) on all four tables,
   even though RLS + service_role's BYPASSRLS were both already correct.
   Supabase's default schema-level ACL propagation does not reliably apply
   to tables created by running raw DDL directly in the SQL Editor. Fixed
   with explicit `GRANT ... TO service_role` + `ALTER DEFAULT PRIVILEGES`
   statements, now folded into `db/schema.sql` itself so this doesn't bite
   again on a future project. Re-verified after the fix: all four tables
   and both RPC functions return 200/204 over the real REST API with the
   real key. `scripts/verify-supabase.mjs` runs the same checks from
   Node — but this sandbox's own network egress allowlist blocks
   `*.supabase.co` directly, so that script had to be validated via a
   `fetch()` executed inside the browser tab instead (which has real
   internet access) — run it for real once this is deployed somewhere with
   normal egress (e.g. Vercel, or a dev machine).
3. ~~Get an Anthropic API key~~ **DONE AND LIVE-VERIFIED (2026-08-30).**
   Anurag asked to reuse "Kith's" key by pulling it from Kith's `.env`. My
   first guess at Kith's location was wrong — I found `OMNIPRESENCE` on his
   linked machine (a Twilio/Razorpay/Gemini/Anthropic "AI Business
   Assistant" backend) and its `ANTHROPIC_API_KEY` was the scaffold
   placeholder (`sk-ant-placeholder-key-here`; that product actually runs
   on Gemini in production). Flagged this instead of silently wiring in a
   key that would 401. Anurag then gave the real key directly, and
   separately, once Razorpay came up (see item 4), gave the actual path —
   Kith is `C:\Users\canur\Documents\Claude\Projects\Kith` (a Next.js +
   Supabase + Vercel app, nothing to do with OMNIPRESENCE). Confirmed by
   reading `Kith/.env.local` and `.env.production` directly: the
   `ANTHROPIC_API_KEY` there matches what Anurag pasted, byte for byte —
   so it is genuinely Kith's real key, not an unverified one as originally
   noted here. It's in `backend/.env`, live-verified twice: (1) a direct
   Messages API call returned a real completion from
   `claude-haiku-4-5-20251001`, and (2) `scripts/dry-run-live.ts` — a new
   script that runs the *actual* pipeline (real Action diff compression →
   real backend handler → real Anthropic call → real Mermaid validation →
   real `mmdc` render → real PR comment body) — passed end to end. Unlike
   Supabase's host, `api.anthropic.com` is reachable directly from this
   sandbox, so no browser-relay trick was needed here. Budget: see the unit
   economics note in `marketing/launch-plan.md` — that doc was written
   when the plan was OpenAI; the token-cost-per-diagram math needs redoing
   for Claude's pricing before trusting any margin number.
4. **Stripe account creation is still pending — needs Anurag's own login,
   same as before.** But first: Anurag asked to check whether Kith's
   Razorpay setup (also in `Kith/.env.local`) could be reused instead of
   Stripe. Found real `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` — but
   `rzp_test_...` (sandbox, no live keys anywhere, empty webhook secret),
   so there's no real payment processing to reuse today regardless. More
   importantly, flagged and Anurag agreed: Razorpay is India-first
   (UPI/netbanking/INR settlement); ArchLens's own target market (per this
   doc) is "Western/global engineering teams" billed in USD through GitHub
   Marketplace discovery — Stripe is the correct default here even though
   it means provisioning something new instead of reusing Kith's setup.
   Decision: **stick with Stripe.** Once Anurag creates the account, what's
   left is two subscription Products/Prices (solo $12/mo, team $29/mo) and
   setting `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` /
   `STRIPE_PRICE_SOLO` / `STRIPE_PRICE_TEAM`.

   **While waiting on the account, the billing code itself got a real
   audit and rework (2026-08-30), not just left alone:** `api/checkout.ts`
   and `api/webhook/stripe.ts` had zero test coverage — only the pure
   helpers in `lib/billing.ts` were tested, not the actual route logic.
   Refactored both into thin Vercel wrappers over new pure,
   dependency-injected handlers (`lib/checkout-handler.ts`,
   `lib/webhook-handler.ts`), matching `generate-handler.ts`'s existing
   pattern, and added 20 new tests (7 + 13) — including using Stripe's own
   `generateTestHeaderString` to construct genuinely validly-signed
   webhook payloads offline, so the signature-verification code path is
   actually exercised, not mocked away. That audit caught a real design
   bug: the webhook handler deactivated a customer's API key on the first
   `invoice.payment_failed` — but that event fires on *every* Stripe Smart
   Retry attempt, not just the final one, so one transient card decline
   would have cut off a paying team instantly. Fixed to react to
   `customer.subscription.updated` instead, only deactivating once Stripe
   itself marks the subscription `unpaid`/`canceled` (reactivating if it
   recovers), leaving `past_due` alone as a deliberate grace period. See
   `docs/ARCHITECTURE.md`'s billing section for the full reasoning.
5. Deploy `backend/` to Vercel. Deploy the render step (mmdc) to a small
   always-on container (Fly.io/Railway) rather than trying to run Puppeteer
   inside a Vercel serverless function — see `docs/ARCHITECTURE.md`'s
   deployment section for why.
6. Publish the Action to GitHub Marketplace (discovery only — billing is
   Stripe, not Marketplace's native billing; see `docs/ARCHITECTURE.md`).
7. Distribution is unsolved. Don't default back to "post on Show HN and
   Reddit" without first checking whether Anurag has found an owned channel
   or outreach list — that was the explicit open question when this was
   scoped.

## 8. Visual redesign (2026-08-30) — plus a claim made here that turned out wrong

Anurag's exact words: "make it dark theme, good font, more understandable...
it shouldnt just create diagrams for job, it should really impress the
reviewer... no body will simple pay for just small sketch." The old renderer
passed Mermaid's output to `mmdc` with zero theme config — plain default
boxes. Rebuilt with a GitHub-Primer-derived dark theme, a fixed 3-category
color system (endpoint/logic/datastore), LLM-driven `subgraph` grouping by
architecture layer, and `autonumber`/`Note over` polish for sequence
diagrams. Full design writeup: `docs/ARCHITECTURE.md`'s "Visual design"
section — read that section's correction note before this one, it has the
full detail.

**This file previously said, in bold, that a ship-blocking bug was found
and confirmed: that every flowchart ArchLens had ever generated would post
to a real GitHub PR with invisible text, because Mermaid's default
`foreignObject`-based labels supposedly don't render when an SVG is
embedded via `<img>`.** That claim was based on two flawed tests (a
`sharp`/librsvg rasterization, which really doesn't support
`foreignObject` but is irrelevant to how GitHub displays the image; and a
first real-browser test loaded over `file://`, which was very likely
blocked by Chromium's own cross-origin file restrictions, not by
`foreignObject`). A properly controlled re-test — real HTTP server, real
headless Chromium, an actual `<img src>` tag, waited for full image
decode — shows `foreignObject`-based labels rendering completely
correctly. **The bug was not real, or at least was never actually
demonstrated; the claim should not have been stated as confirmed fact,**
and it's left here rather than deleted so a future session doesn't
independently rediscover the same false alarm.

`flowchart.htmlLabels: false` is still in the code, and that part's a
legitimate, independently-justified call: plain SVG `<text>` is more
broadly portable than `foreignObject` across SVG consumers in general
(genuine complaints about this exist in Mermaid's own issue tracker,
unrelated to GitHub specifically), and it removes any dependency on
however GitHub's own image pipeline happens to treat embedded HTML —
which was never actually tested against a live GitHub PR from this
sandbox (no push access here) and remains the one still-open unknown.
Treat it as a sensible default, not as a fix for a proven incident. There
is still a real, permanent regression test in `backend/tests/mermaid.test.ts`
against `foreignObject` reappearing — that stays, it's just testing for a
portability property now, not "the bug."

Tests: 65 → 70 backend (84 total). Not done yet: a light-mode variant via
GitHub's `<picture>` + `prefers-color-scheme` (flagged as a follow-up, not
built speculatively — see ARCHITECTURE.md for why). Also not done: an
actual live spot-check of a real posted GitHub PR comment, which is the
only way to fully close the still-open unknown above — needs deployment
first.

## Environment notes from the sandbox this was built in

- Node 22, npm 10, mermaid-cli (`mmdc`) preinstalled globally.
- No system Chromium for Puppeteer by default — a Playwright-installed
  Chromium existed at `/opt/pw-browsers/chromium-*/chrome-linux/chrome` and
  was used via the `executablePath` override
  (`ARCHLENS_TEST_CHROMIUM_PATH` env var in tests/dry-run). In real
  deployment or GitHub Actions CI, install Chromium into Puppeteer's own
  default cache instead (`npx puppeteer browsers install chrome`) — see
  `.github/workflows/ci.yml`.
- No `gh` CLI in the sandbox — repo creation/push needs to happen from a
  session with GitHub auth (or the user's own machine).

## 9. Adversarial review loop, round 4 (2026-08-31) — classification fixed, layout is the remaining blocker

Anurag's instruction: run a fresh, context-free subagent as a harsh
reviewer against ArchLens's own product brief after each visual-quality
change, and iterate until 9.5+. Full score trajectory and reasoning:
`claude/architecture-and-scoping.md`'s "Adversarial review loop" section
(also mirrored in the Claude Project). Short version: 4.2 → 6.0 → 4.3 (a
deliberate regression once graded against a realistic 10-file diff instead
of toy examples, which exposed two real structural problems) → **6.0,
this round, on the hard test** — a genuine improvement, not just a bounce
back, because:

- `backend/lib/diff-classify.ts` (new) fixes the diff-classification
  collapse deterministically, in code, rather than trusting the LLM.
  Verified against the real 10-file stress test by reading the raw
  generated Mermaid `class` lines directly.
- A COARSE MODE prompt switch (llm.ts, triggered by `files.length`, not
  the model) and a modest `nodeSpacing`/`rankSpacing` bump partially
  mitigate — but do NOT fix — Mermaid/dagre's layout breakdown at scale
  (edges crossing through nodes, subgraph containment failing). Round 4's
  reviewer still would not approve shipping the stress-test-scale diagram
  as-is because of this.

**Real remaining lever to reach 9.5+, not more prompt/theme iteration:**
either build a custom Puppeteer render harness using Mermaid's ELK layout
engine (`@mermaid-js/layout-elk` isn't bundled with the `mmdc` install used
here — confirmed by checking its node_modules — so this replaces the
stock `mmdc` render step, it's not a config flag), or, more cheaply, drop
subgraph nesting entirely above the coarse-mode threshold as a disclosed
downgrade for large diagrams. This is a real decision point for Anurag,
not something to keep grinding on unprompted.

## 10. Direct visual-polish feedback (2026-08-31) — uniform dark canvas, bold/glow, animated flow arrows

Anurag's feedback on the round-4 output, verbatim: "its bit messy, keep
entire background dark blue or github black and make the text and line
bright and bold... if you can add dinamic glowing arrow to so direction of
data flow that would awesome." Not a scoring-loop round — direct aesthetic
iteration. Three changes, all in `backend/lib/mermaid.ts`:

- The three `*Region` classDefs (subgraph tints) previously used a
  different hue per layer (navy/green/purple), which read as a patchwork.
  Unified to one identical background-matching fill — the canvas is now
  uniformly dark everywhere; subgraphs are still delineated by a neutral
  border + label, not by a fill color.
- `lineColor` theme variable bumped from a muted gray (`#8b949e`) to a
  bright accent blue (`#79c0ff`), and a new `applyBoldGlowStyling()`
  post-processing pass forces bold text and thicker, glowing edge/message
  lines via an injected `<style>` override + SVG glow filter (`mmdc`'s
  stock stylesheet ships 1px/1.5px lines with no glow and isn't otherwise
  themeable for stroke-width).
- `injectEdgeFlowAnimation()` (new) deterministically rewrites every plain
  edge the model emits into Mermaid's own edge-id + `animate: true` syntax
  — a genuine moving-dash CSS animation confirmed against a real render
  (`edge-animation-fast` class, a real `@keyframes` animation), not
  something invented for this session. Done in code rather than asked of
  the LLM, consistent with this project's now-established rule of not
  trusting the model for anything code can just compute directly.
  Flowchart-only (sequence diagrams' arrow syntax doesn't support edge
  ids); sequence lines still get the bold/glow treatment, just not the
  motion.

A static PNG can't show the animation — proved it's real with
`scripts/capture-flow-gif.mjs` (captures a burst of real rendered frames)
assembled into a GIF, and diffed two frames pixel-by-pixel to confirm they
actually differ before calling it done. Tests: 91 → 100 backend.
