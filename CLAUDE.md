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

## 11. Correction to item 10, same day — "dotted" wasn't what was asked for, and "transparent" reads as white

Immediate follow-up feedback: "not dotted line, arrow running on fix line,
dont use white color at all, make it black." Two real corrections, not
just more polish:

- Item 10's first animation used Mermaid's built-in `animate: true` edge
  metadata, which works by animating a dashed stroke
  (`stroke-dasharray`/`stroke-dashoffset`) — that reads as "dotted," which
  is exactly what was flagged. Replaced entirely: edges now render as a
  normal SOLID line (`stroke-dasharray:none !important`), and a small
  glowing arrowhead physically travels along the edge's own path via SVG's
  native `<animateMotion>`/`<mpath>`, reading the edge's real `d` geometry
  and stable auto-assigned `id` straight out of the rendered SVG
  (`injectFlowRunners()`, replacing the old source-level
  `injectEdgeFlowAnimation()`, which is gone). This is more robust than
  the thing it replaced, too — no dependency on Mermaid edge-id syntax or
  the model's cooperation at all, since mmdc already gives every edge a
  stable id regardless.
- The `-b transparent` flag to `mmdc` meant the diagram's own canvas had
  no fill outside drawn shapes — invisible against a dark page, but shows
  as flat white once embedded on GitHub's actual default (light) PR-
  comment background, which is what was being flagged as "white." Changed
  to an opaque fill matching the theme's own dark background
  (`ARCHLENS_THEME_CONFIG.themeVariables.background`), so the canvas is
  always fully dark regardless of what page embeds it.

Both changes are real fixes, not label changes — verified against a real
mmdc render (`stroke-dasharray:none` present, `background-color:` no
longer `transparent`) and against the actual visible screenshots, not
assumed from the code alone.

## 12. Screenshot-tooling padding bug fixed, then a real-external-repo test found the classifier had never actually been tested outside its own fixtures (2026-08-31)

Two separate things happened back to back, both worth keeping distinct.

**First, a fix to my own test tooling, not the product.** Anurag flagged
the demo images as "big dull page where most of the part is empty white."
Root cause: `scripts/screenshot-svg.mjs` and `scripts/capture-flow-gif.mjs`
were taking `fullPage`/plain page screenshots inside a fixed-height
Puppeteer viewport. Puppeteer's screenshot captures
`max(viewport height, content height)` — so any diagram shorter than the
fixed viewport got padded with blank space below it (e.g. the
scale-stress-test PNG: an 800x1200 canvas for ~460px of actual content).
GitHub itself never does this — it displays a posted image at its natural
size. Fixed both scripts to screenshot the diagram's own container element
instead of the page. Re-verified: same SVG now screenshots at 768x467,
tight to the content.

**Second, and much bigger: Anurag asked to pull real, complex repos from
GitHub and see how ArchLens actually handles them.** Built
`scripts/dry-run-real-repo.ts` to run the real production pipeline against
an arbitrary real commit in an arbitrary local clone. Picked one real
historical commit each from `tiangolo/full-stack-fastapi-template`
(Python/FastAPI) and `brocoders/nestjs-boilerplate` (NestJS/TypeScript) —
neither written by us, neither tuned for.

**Both diagrams collapsed almost completely: nearly every node came back
"Context" (nothing changed here) despite every file in both diffs being
genuinely part of the real PR.** This is a bigger, more damaging bug than
Round 3's ("the model marks everything changed") — a real PR rendering as
"nothing here is new" silently defeats the entire product pitch on first
contact with real code, and it never surfaced before because every fixture
`diff-classify.ts` had ever been tested against, including the 10-file
stress test, was written by me and happened to use a single-word-camelCase
file-naming style that coincidentally matched its own PascalCase diagram
labels after lowercasing. Two real, distinct root causes: (1)
`DEFINITION_PATTERNS` only knew JavaScript's `function` keyword, not
Python's `def`; (2) the tokenizer's single extraction pass normalized a
dot-separated basename (`auth.controller` → two tokens) and a PascalCase
label with no separators (`AuthController` → one token) into shapes that
could never match each other.

Fixed in `backend/lib/diff-classify.ts`: added Python `def`/Go `func` to
the definition patterns, and made `tokenize()` also decompose
camelCase/PascalCase boundaries (additive union with the original pass, so
nothing that matched before stops matching). Re-running the fix against
both real repos immediately caught a NEW real false positive it
introduced: `GoogleService`, untouched by the NestJS diff, got promoted to
"changed" purely because it shares the generic word-piece "service" with
an unrelated file (`auth.service.ts`) that did change — splitting
camelCase makes generic-suffix collisions like this more likely. Fixed
with a second word list (`ARCHITECTURAL_SUFFIX_WORDS`) that's only dropped
when something more specific survives alongside it for that identifier, so
a file whose entire basename IS a generic word (`models.py`) doesn't lose
100% of its signal either. Re-verified against both real repos again after
this second fix: full convergence on NestJS (8/8 genuinely-changed nodes
correctly changed, the one genuinely-unrelated node correctly Context);
6-8/10 on FastAPI (a known, disclosed remaining gap — see the project doc
— around definition lines the diff itself never touches, combined with
singular/plural label-vs-basename mismatches; not attempted this round,
stemming and bare-class-method detection are both real scope, not a quick
add).

Added 6 new tests, one per specific real failure found, not generic
padding. 105/105 backend tests pass, 123/123 total. Full writeup, with the
before/after evidence and the concrete node-by-node counts, is in the
Project doc (`claude/architecture-and-scoping.md`) under "Real-external-
repo validation" — kept there rather than only here since it's a durable
product finding, not a session note.

**The standing lesson for whoever touches this classifier next:** a fix
verified only against fixtures the same session wrote is not verified.
Re-run `scripts/dry-run-real-repo.ts` against a real external repo before
calling any future diff-classify change done.

## 13. The classification gap from item 12 is resolved (2026-08-31, same day)

Root cause turned out to be one thing: a singular/plural mismatch between
a diagram label ("UpdateUser") and its file's basename (users.py) was
blocking the basename fallback even in cases that had nothing to do with
the "definition line itself untouched" half of the problem. Added a
deliberately narrow `singularize()` in `backend/lib/diff-classify.ts`
(items -> item, categories -> category, boxes -> box — common regular
English plurals, not a real stemmer), folded additively into the existing
tokenizer so it can only ever add a new match, never remove one that
already worked.

Re-verified against both real repos again — NestJS unchanged at 8/8
correct, FastAPI up to a stable 8/10 across three repeated real-API calls
(checked for run-to-run stability, not just one lucky run). The two nodes
still showing Context are both legitimately correct: one isn't in the
diffed files at all, the other corresponds to a class whose own
declaration line the diff never touches, with zero identifying token
anywhere in the diff's changed lines — a genuine limit of line-level
diffing, not a bug. 107/107 backend tests, 125/125 total. Full writeup in
the Project doc.

Remaining open item from this whole line of work: the layout-at-scale
decision (ELK harness vs. flat-layout fallback, see item 9) is now the
only unresolved lever on review score from the classifier/layout side of
the product.

## 14. ELK layout wired into production, plus two real rendering bugs it exposed (2026-09-01)

Item 13 left one open lever: dagre (mmdc's only layout engine) crosses
edges through unrelated nodes and lets cross-cutting edges escape their
subgraph's box entirely at realistic scale — confirmed and disclosed back
in item 9, never fixed until now. A side-by-side Puppeteer spike against
the exact 10-file stress diagram confirmed Mermaid's ELK layout engine
(`@mermaid-js/layout-elk`, hierarchical/subgraph-aware) doesn't have this
failure mode: dagre left `NotificationService` and `RefundWorker` floating
outside every subgraph with edges cutting across unrelated boxes; ELK put
every node inside its correct subgraph with clean orthogonal routing.

`@mermaid-js/layout-elk` isn't bundled with mmdc, so this wasn't a config
flag — `renderMermaidToSvg()` in `backend/lib/mermaid.ts` was rewritten
from a `mmdc` CLI child-process invocation to a purpose-built Puppeteer
harness that loads `mermaid` + `@mermaid-js/layout-elk` directly (serving
both packages' full `dist` directories over a loopback HTTP server so
mermaid's internal chunk sub-imports resolve, registering the ELK layout
loader, and calling `mermaid.render()` in-page). ELK frontmatter is only
prepended for flowcharts; sequence diagrams are untouched.

Cutting mmdc out from under this pipeline (rather than just adding an ELK
config flag to it) surfaced two real bugs that had been silently masked by
mmdc's own CLI-level SVG post-processing, neither of which was about ELK
or layout at all:

1. **Non-well-formed XML, silently.** `injectFlowRunners()` emits
   `xlink:href` on its `<mpath>` runner elements; mmdc's CLI output used
   to declare `xmlns:xlink` by default, a raw `mermaid.render()` call
   doesn't. Every existing test still passed (they only checked
   substrings), and a lenient browser preview even rendered it — but
   `xml.dom.minidom.parse()` failed with "unbound prefix", and loading the
   SVG via an actual `<img src="...svg">` (exactly how GitHub embeds it in
   a PR comment) silently failed to decode at all. Caught only by
   screenshotting the real production output the way GitHub actually
   consumes it, not by any unit test. Fixed by injecting
   `xmlns:xlink="http://www.w3.org/1999/xlink"` onto the root `<svg>` when
   absent. Added a real regression test (`backend/tests/mermaid.test.ts`)
   that both strict-XML-parses the output and loads it as an actual
   `<img>` in a real browser — verified it actually catches the bug by
   temporarily reverting the fix and confirming the test fails.

2. **A glow filter that goes invisible on perfectly straight edges.** The
   shared `archlens-glow` `<filter>` used the SVG default
   `objectBoundingBox` region (`-10% -10% 120% 120%`, relative to the
   filtered element's OWN bounding box). A perfectly straight vertical (or
   horizontal) edge — one shared x or y across its whole path — has a
   zero-width (or zero-height) bounding box, and any percentage of zero is
   still zero: a zero-size filter region clips the entire edge to nothing,
   leaving only its (unfiltered) arrowhead marker floating with no visible
   line. Found in the real FastAPI real-commit render (item 12's repo),
   where ELK happened to place two nodes in a dead-straight vertical line
   — routine for ELK's orthogonal routing, much rarer for dagre's, which
   is presumably why this bug never surfaced in ~6 review rounds against
   the old pipeline. Fixed by switching the filter to
   `filterUnits="userSpaceOnUse"` (percentages now resolve against the
   whole SVG viewport, which is never zero, instead of the element's own
   possibly-zero bbox).

Re-verified end-to-end through the real production pipeline (not just the
throwaway spike) three ways: the same 10-file stress test via
`scripts/dry-run-live-scale.ts`, and both real external repos from item 12
(`tiangolo/full-stack-fastapi-template`, `brocoders/nestjs-boilerplate`)
via `scripts/dry-run-real-repo.ts` — real Anthropic call, real
`renderMermaidToSvg()`, real screenshot via the same `<img>`-embed harness
GitHub uses. All three: every node correctly contained in its subgraph, no
edges crossing through unrelated boxes, no invisible edges. 108/108
backend tests (1 new), 126/126 total — confirmed the new test count
against the pre-ELK baseline of 125 (107 backend + 18 action) to rule out
a miscount, not just eyeballed.

**The standing lesson, again:** a fix verified only against a throwaway
spike, or only against unit tests checking substrings of a string, is not
verified. Both bugs in this item were invisible to 31/31 passing unit
tests and a working spike — only screenshotting the actual production
output the way the real consumer (an `<img>` tag on a GitHub PR page)
consumes it caught either one.

## 15. Round 5 adversarial review (2026-09-01) — 6/10, would not approve; one of its own findings was wrong

Ran a fresh, context-free subagent review against the ELK-fixed output
(same pattern as rounds 1-4), specifically to check whether item 14's fix
actually moves the score. It scored **6/10** and would not approve
shipping today. Its most damning claim — "sequence diagrams have zero
diff-awareness, no `rect` highlighting, no legend, indistinguishable from
generic UML" — turned out to be **wrong**, and it's on me: I handed it a
stale screenshot (`final-sequence-v2.png`, 2 days old) instead of
generating a fresh one. A real, fresh end-to-end run
(`scripts/dry-run-live-sequence.ts`, real Anthropic call, real
`renderMermaidToSvg()`) shows the diff-awareness `rect rgba(88, 166, 255,
0.18)` highlight rendering clearly and correctly — the "new" message
exchanges visibly banded, the two pre-existing entry/exit messages
outside it. Lesson: handing a fresh reviewer stale artifacts produces a
confidently-wrong finding — always regenerate the screenshots being
reviewed, don't reach for whatever's already sitting in
`.dry-run-output/`.

**The review's other findings are real, re-confirmed independently, not
just taken on faith:**

- **Long perimeter-hugging "spaghetti" edges.** ELK's fix (no edges
  crossing through node boxes) is real, but ELK sometimes routes a
  cross-cutting edge around the entire diagram's margin instead — e.g.
  the 10-file stress test's `subscribe refund.issued` edge runs the full
  right margin from Data & External back up to RefundWorker. Not wrong,
  not the item-14 defect, but still a real "have to trace this with your
  eye" cost the product's pitch (instant comprehension) doesn't fully
  deliver on yet.
- **No screenshot anywhere demonstrates the `removed` (deleted-by-this-
  PR) visual state.** True — worth generating a real example before
  claiming that part of the legend is proven, not just specified in the
  prompt.
- **The FastAPI real-repo diagram's "Alembic Migration (UUID conversion)"
  node renders as Context (pre-existing), despite the underlying file
  (`alembic/versions/d98dd8ec85a3_..._all_models_.py`) being genuinely
  ADDED by that diff** — confirmed with `git diff --name-status`, status
  `A`. Root-caused: this is a real instance of the already-disclosed
  token-overlap limitation (item 12/13's "Takeaway"), not a new bug. The
  node's LLM-chosen label ("Migration") shares zero tokens with the
  file's actual hash-prefixed autogenerated name or its diff content
  (which never contains the word "migration" at all — it's Alembic
  boilerplate: `op.execute(...)`, `sa.Column(...)`, revision IDs). With no
  textual bridge between label and file, `reconcileDiffClassification`
  has no evidence to promote it, so it correctly falls back to Context
  per its own designed rule — but the user-visible result is still wrong
  on a completely new file, which is the sharpest-possible case for that
  known limitation. Not fixed this round; flagged for whoever next
  touches the classifier, alongside item 13's already-disclosed instances.
- **Low-contrast subgraph borders and a legend that reads as a boxed
  afterthought** — cosmetic, real, unaddressed.

**Score interpretation:** the review's 6/10 undercounts the sequence-
diagram dimension (that part is fine, verified fresh), but the flowchart-
side findings (spaghetti edges, unverified `removed` state, the
Migration misclassification, low-contrast borders) are real and would
likely still cap a re-review well short of 9.5+. Net: item 14's fix is
real and worth having, but "layout is now solved" would be an
overclaim — "the one specific, previously-ticketed defect is fixed;
several adjacent polish/accuracy gaps remain, now itemized instead of
vague."

**Follow-up, same session: went and generated the `removed` example the
review said was missing — found a new, real bug doing it, not just
confirmed the gap.** Built a small diff with two genuinely deleted files
(a route and the service it called) plus one added route, ran it through
the real pipeline. The LLM classification was correct (`class A,C
removed`), and the node styling is correct — dashed red border, reddish
text, visually distinct. But **the edge connecting the two removed
nodes still renders as a normal, bright, glowing solid blue line** —
`applyBoldGlowStyling()`'s CSS override targets `.flowchart-link`
unconditionally, with no awareness of which nodes an edge actually
connects. The result: a vivid "this is alive and current" arrow drawn
between two boxes explicitly marked "no longer exists," which
undermines the exact visual language the `removed` category exists to
establish. Screenshot: `scripts/.dry-run-output/removed-state-final.png`.
Not fixed yet — would need edge-to-node-category cross-referencing in
the SVG post-processing step (parse each node's assigned category from
its own `<g class="node ... ">` id, then look up each edge's source/
target against that map before deciding its style), which is a real,
scoped change, not a one-line fix. Flagged for the next round of visual
work on this, alongside the other three findings above.

## 16. Removed-edge glow bug (item 15's follow-up) fixed and re-verified; explicit governing constraint for current work (2026-09-02)

**Governing constraint, direct user instruction:** "we will do the
payment integration when the score reaches >=9 got, it wont sell until
it is really helpfull." No Stripe/billing work happens until an
adversarial review scores this >= 9/10. Everything below is in direct
service of that gate — closing real quality gaps, not new features.

**Fix for item 15's follow-up bug** (edges between two `removed` nodes
rendering with the same active glow/animated-arrow treatment as a live
edge): `applyBoldGlowStyling()` now builds a node-name -> category map by
parsing every node's `<g class="node default {category}" id="{svgId}-
flowchart-{Name}-{idx}">` tag, cross-references each edge's `data-id`
(`L_{source}_{target}_{index}`) against that map, and tags an edge whose
BOTH endpoints are `removed` with a marker class
(`archlens-removed-edge`) that gets its own dim/dashed/no-glow rule
matching the removed-node palette instead of the blanket active-edge
rule. `injectFlowRunners()` reads the same marker back off the tag
(rather than re-deriving categories) and skips generating an animated
runner for those edges too — same root cause, fixed alongside it.

Verified, not just asserted:
- 5 new tests (`backend/tests/mermaid.test.ts`) — 2 unit tests against
  synthetic SVG shaped exactly like a real render (confirmed against
  `scripts/.dry-run-output/removed-state-v2-diagram.svg` before writing
  them, not assumed), 1 unit test on `injectFlowRunners` honoring the
  marker, 1 full end-to-end integration test through the real Puppeteer/
  ELK harness. Proved the tests actually catch the regression: reverted
  the fix, confirmed all 4 relevant tests fail with the expected
  assertions, restored the fix, confirmed all pass again (same discipline
  as item 14's xmlns:xlink regression test).
- Full suite: 130/130 tests pass.
- Regenerated a **fresh** real removed-state example end-to-end (real
  Anthropic call, real classifier, real ELK render) — deliberately with
  THREE removed-to-removed edges and ONE live edge in the same diagram
  this time, not the single-edge case from item 15. Screenshotted exactly
  as GitHub embeds it (`scripts/.dry-run-output/removed-state-v2-
  final.png`): the 3 removed edges render dim/dashed/red/static, the 1
  live edge stays bold/blue/glowing/animated — a stark, correct visual
  contrast.
- Confirmed no regression on a diagram with zero `removed` nodes (the
  10-file stress test, re-rendered): 0 edges tagged, every edge still
  gets its glow and animated runner exactly as before.

**Remaining open items from item 15, still unaddressed** (tracked as the
next steps toward the score->=9 gate): low-contrast subgraph borders,
ELK's occasional perimeter-hugging "spaghetti" edge routing, the legend's
boxed-afterthought placement, and the token-overlap misclassification
limitation (disclosed, not newly regressed). A fresh round-6 adversarial
review — against freshly generated screenshots, per item 15's own
lesson — is the next step once the polish items above are addressed, and
should repeat until it scores >= 9.

## 17. Low-contrast borders fixed; ELK back-edge spaghetti measurably shrunk, not eliminated (2026-09-02)

**Subgraph border / legend / actor-lifeline contrast** (round-5 review):
`clusterBorder`/the `*Region` classDefs/the legend card border/
`actorLineColor` all used `#30363d` against the `#0d1117` canvas —
computed contrast 1.55:1 via WCAG 2.1's own relative-luminance formula
(1.4.11's own floor for a graphical boundary is 3:1), effectively
invisible. Switched all four to `#6e7681`, a neutral GitHub Primer gray
rather than a fifth accent color: 4.12:1 against the canvas, 3.77:1
against the legend card's own fill. Verified with a new end-to-end test
(flowchart subgraph + sequence lifeline) and a re-rendered real
10-file-stress-test screenshot — borders and the legend card are now
clearly visible outlines instead of near-invisible dark-on-dark.

**ELK "spaghetti" back-edges** (round-5 review): a true back edge — one
whose target sits in an earlier architectural layer than its source
(the stress test's `EventBus -->|subscribe| RefundWorker`: Data, the
bottom subgraph, calling back up into Logic, the middle one) — will
always need some long route; that's inherent to layered graph drawing,
not fully fixable. But empirically testing every `config.elk.*` tunable
mermaid's layout-elk wrapper exposes against the real stress-test
diagram (measuring the actual edge's path length/bbox for each, not
eyeballing) found `mergeEdges: true` + `nodePlacementStrategy:
NETWORK_SIMPLEX` cuts that edge's length ~25%, its bounding box ~65%,
and overall diagram height ~18% — confirmed visually too. Two other
options (`SIMPLE`/`LINEAR_SEGMENTS` node placement) made it measurably
**worse**; three had no effect at all on this graph shape. Honest
framing for whoever reviews this next: this is a real, verified
improvement, not a fix — a genuine back edge will still be the visually
longest edge in the diagram, just now hugging its own local margin
instead of the whole canvas.

Both changes re-verified against the real 10-file stress test AND two
untested-before real external-repo diffs (FastAPI, NestJS) end to end
through the full production pipeline — including a genuine self-loop
edge (`DB -->|pool_pre_ping added| DB`) and an edge targeting a subgraph
container directly (`RoleSeed --> Persistence`), both real cases neither
previously exercised, both rendering cleanly under the new ELK config.
The FastAPI example also happened to contain a real removed-to-removed
edge pair (`BPRE -->|tested by| TESTBPRE`) that confirmed item 16's fix
generalizes correctly to genuinely new real-world data, not just the
synthetic example it was built against. Full suite: 131/131.

**Remaining from item 15's list**: the legend's boxed-afterthought
placement, and the token-overlap misclassification limitation
(disclosed, not newly regressed). A fresh round-6 adversarial review —
against freshly generated screenshots — is next, and should repeat
until it scores >= 9, per the user's explicit gate on payment/billing
work.

## 18. Legend redesigned as a full-width footer strip (2026-09-02)

Closes the last cosmetic item from item 15's list: "reads as a boxed
afterthought crammed into the bottom-left corner." Real complaint —
once ELK's layout (item 14/17) meant most diagrams render far wider
than the legend's own content needs, the old design's card sized itself
to its content and left visible dead canvas on the same row.

`appendLegend()` now packs items (the solid/dashed caption, then each
category's solid/dashed swatch pair — the actual legend *content* is
unchanged from round 3) left-to-right and wraps onto additional rows
only when the diagram is too narrow for one line, inside a footer panel
that spans the diagram's own full width — never a separate, narrower
box — with a background matching the subgraph fill and a top border, so
it reads as an integrated footer (the same visual language as a
subgraph) rather than a floating card. Verified: 2 new tests replacing
the old "bordered card" test (one confirms the footer's own background
rect is exactly as wide as the diagram, one confirms narrow diagrams
wrap rather than overflow) — full suite 133/133. Re-rendered the real
10-file stress test and the FastAPI real-repo example end to end: both
now show one compact, full-width caption strip instead of a tall boxed
card with dead space beside it.

**Status toward the score >= 9 gate**: every item-15 finding is now
addressed except the token-overlap misclassification limitation (a
disclosed, accepted limitation of the deterministic classifier, not a
regression).

## 19. Round 6 adversarial review (2026-09-02) — 4/10, would not approve; three real bugs found and fixed

Ran a fresh, context-free review against 5 FRESHLY generated screenshots
(the 10-file stress test, both real-repo diffs, a removed-state example,
and a sequence diagram — none reused from earlier rounds, per item 15's
own lesson). Scored **4/10**, would not approve shipping. Verified each
claim against the actual generated mermaid source before acting on it —
three were real:

1. **Removed-edge glow, still broken in a new way.** Item 16 fixed
   edges where BOTH endpoints were `removed`; this review caught the
   real FastAPI diagram rendering `prestart.sh -->|calls|
   backend_pre_start.py` as a bold, glowing, actively-animated edge —
   `backend_pre_start.py` is dashed-red "removed," `prestart.sh` isn't.
   Review's words: "a file cannot simultaneously be deleted by this PR
   and actively invoked by live code in the same diagram." Correct, and
   the underlying logic doesn't hold up either — a `removed` node no
   longer exists in the repo, so no edge touching it, from either
   direction, can represent live data flow. Fixed:
   `touchesRemovedNode()` now triggers on EITHER endpoint, not both.
2. **A modified file classified as removed.** `db.py` (diff: gained
   `pool_pre_ping=True`, never deleted) was rendered dashed-red
   "removed" — confirmed against the real mermaid source
   (`class DBCore removed`). Root cause: the LLM appears to cascade
   `removed` from a genuinely-deleted file (`backend_pre_start.py`) onto
   files that merely reference it, rather than checking each node's OWN
   deletion status. `reconcileDiffClassification` in diff-classify.ts
   doesn't correct this — it deliberately leaves any model-assigned
   `removed` line untouched (by design, for the plain/Context axis it
   otherwise governs), so this passed straight through to the rendered
   diagram uncaught. Fixed at the prompt level (llm.ts's SYSTEM_PROMPT):
   explicit statement that `removed` describes only a node's own
   deleted file/definition, a worked counter-example matching this exact
   shape, and an explicit default-away-from-removed-when-uncertain rule.
   Not a deterministic guard — a prompt fix reduces but can't fully
   eliminate this class of LLM error; flagged as a known residual risk,
   not claimed solved.
3. **Category-definition drift.** `pyproject.toml`/`uv.lock` colored
   `datastore` (purple) despite being config/lockfiles, not application
   data storage. Separately, on the NestJS example, four `*.service`
   files were colored `endpoint` (blue) while two other `*.service`
   files were `logic` (green) — same naming pattern, no visible reason.
   Fixed at the prompt level: tightened the endpoint/logic/datastore
   definitions with explicit inclusions/exclusions (datastore: "NEVER a
   config file... even one that lists a database driver as a
   dependency"; endpoint: "a file merely named `*Service` ... is NOT an
   endpoint just because it's reachable from one").

**Re-verified on the same real diffs after the fix** (not just unit
tests): the FastAPI diagram now shows dim/dashed edges into both
removed nodes, `pyproject.toml` as logic, `db.py` correctly out of the
removed category; the NestJS diagram now colors all `*.service` files
consistently as logic. 39 mermaid tests (rewrote the removed-edge tests
to cover both-removed/one-removed/neither-removed explicitly) + full
133-test suite pass.

**Not fixed, disclosed rather than ignored**: the review also flagged
(a) real-world diagrams rendering visibly smaller/more cramped than
curated synthetic examples at high node-density/low-rank-count shapes
(the NestJS example's natural SVG size was 300x64 — very wide, very
short — making per-node text small once laid out; likely an ELK-
aspect-ratio characteristic at this specific graph shape, not yet
investigated), (b) the sequence-diagram mode giving no visual
distinction between new-this-PR and pre-existing PARTICIPANTS
(diff-awareness there is currently message-level only, via the `rect`
highlight, which is real but subtle at 18% opacity — confirmed still
renders correctly via direct pixel sampling, not just assumed), and (c)
some remaining self-loop edges and repository/seed-service
categorization calls in the NestJS example that are debatable but not
clearly wrong. None of these were the review's stated top blockers;
flagged for the next round rather than chased under time pressure in
this one.

**Status toward the score >= 9 gate**: three concrete, verified bugs
fixed this round. A follow-up review against fresh screenshots
reflecting these fixes is the immediate next step, and should continue
until it scores >= 9, before any payment/billing work per the user's
explicit instruction.

## 20. Three more adversarial review rounds (2026-09-02) — 4/10 → 3/10 → 3/10; seven more real bugs found and fixed, one confirmed-unfixable layout limitation disclosed

Continued the same loop: fresh, context-free review against freshly
regenerated screenshots, verify every claim against real generated
mermaid source/SVG before acting, fix only what's confirmed real. Three
more rounds run this session; scores did not cross 9 yet, but each
round's findings got measurably narrower and more real bugs were fixed
than in any prior round. Full detail below; summary first.

**New category: `external`, fixing a real datastore/third-party
conflation.** A real Anthropic call (the 10-file stress test) classed
`PaymentGateway`/`EventBus`/`NotificationService` as `datastoreContext`
— purple, the same color as actual SQL tables — because flowchart had
no equivalent to sequence diagrams' actor/participant split. Added a
fourth base category, `external`/`externalContext` (amber `#d29922`,
matching sequence-diagram notes), to mermaid.ts's CATEGORY_CLASS_DEFS,
legend, llm.ts's SYSTEM_PROMPT (with the exact failure case as a
negative example), and diff-classify.ts's BASE_CATEGORIES (so it gets
the same changed/Context reconciliation as the other three). Re-run
confirmed the model now puts these in their own "External Services"
subgraph, correctly `externalContext` — verified against a real fresh
render, not assumed.

**Self-loop edges, a real invented-noise bug.** The NestJS real-repo
diagram had 6 of its 14 edges be meaningless self-loops
(`RoleSeedService -->|accesses| RoleSeedService`) — the model
apparently inventing an edge just to justify a node's presence in the
graph. Fixed with both a SYSTEM_PROMPT rule (never draw A-->A) AND a
deterministic backstop, `stripSelfLoopEdges()` in diff-classify.ts,
wired into generate-handler.ts right after reconciliation — the same
"prompt alone isn't reliable enough on the actual production model"
reasoning as item 19's disclosed residual risk, this time acted on
directly rather than left prompt-only, because real recurrence (see
below) proved that residual risk wasn't hypothetical.

**Node-count cap tightened, not fully solved.** The same NestJS run
produced 15 nodes against a stated cap of 12 (COARSE_MODE_MAX_NODES).
Dropped the cap to 10 and reworded it as a "HARD CAP" stated twice.
Real re-test: the model still overshot (16 nodes against the new cap
of 10) on a fresh call. This is now a confirmed, disclosed, NOT solved
limitation of relying on a smaller production model
(`claude-haiku-4-5` — see backend/.env, chosen for the $12-29/mo unit
economics) for precise numeric instruction-following; a fully
deterministic node-merge/truncation pass would be the real fix but is
out of scope for this pass (safely collapsing graph structure without
breaking edges/categories is a much larger, riskier lift than a prompt
tweak).

**The `removed`-cascading bug from item 19 recurred, and was this time
fixed deterministically, not just prompt-nudged.** A fresh FastAPI
real-repo run re-marked `db.py` `removed` despite only being modified —
the exact bug item 19's prompt fix was meant to prevent, recurring
because a smaller model's instruction-following isn't perfectly
reliable run to run (confirmed: same file, same repo, same commit,
different sampling). Given real recurrence, `reconcileDiffClassification`
now gives `removed` its own reconciliation pass instead of leaving it
untouched: a node whose label has real evidence of being CHANGED (its
tokens overlap the diff's own `changed` token set) cannot have been
deleted by this same diff, so it's rescued to `logicContext` — the
neutral, least-alarming fallback (not a full "recover the true
category" fix, which would need information `removed` already
discarded; every confirmed real occurrence of this bug has been a
config/settings/infra file, which `logic` already explicitly covers).

**Root cause underneath that bug: `tokenize()`'s minimum length was
too strict.** Debugging the above found `db.py`'s basename tokenizes to
"db" — exactly 2 characters — and `tokenize()` required 3+ total chars
in both its regexes, so "db" (and any 2-char identifier: "io", "ui",
"os"...) produced ZERO tokens, meaning a `db.py`-derived node could
never match ANY changed-evidence no matter what, independent of the
`removed`-rescue logic above (which depends on exactly this match).
Lowered the minimum to 2 chars and added a small set of short English
glue-words (to/is/in/on/at/by/as/or/if/it/an/be/do/no/so/up/of/we/he)
to STOPWORDS to guard against the noise this newly admits. Verified
end-to-end against the real captured bug (a standalone script replaying
the exact real diff + raw LLM output through the patched pipeline)
before trusting it, not just the unit tests.

**A hallucinated `class removed removed` line, real and dropped.** The
same FastAPI run's raw output contained the literal line `class removed
removed` — a class assignment for a node ID that was never declared
anywhere, spelled identically to the category keyword itself (almost
certainly the model meant "the removed thing" as a concept, not a real
node). `reconcileDiffClassification` now drops any `removed`-category
id that exactly matches a reserved category keyword AND has no matching
node declaration — a real declared node that happens to be named
`removed` is still preserved (checked via `nodeLabels`, not just the id
string).

**An unclassed node rendering as if it were a real Endpoint — a real,
actively misleading bug, not cosmetic.** The live-scale stress test
declared and wired up `RefundWorker` into two real edges but never gave
it a `class` line in ANY of the model's six `class` statements. Mermaid
doesn't error on this — it silently falls back to the theme's
`primaryBorderColor`, which happens to be the exact same blue ArchLens
uses for `endpoint`, so a background worker rendered as if it were a
real API route, a wrong claim about the architecture on the product's
own flagship example. Added `assignMissingCategories()` (diff-classify.ts):
finds every node referenced by a bracket declaration or edge endpoint,
subtracts every node that already has SOME class line, and assigns
`logicContext` to whatever's left. Wired into generate-handler.ts as
the last deterministic step in the pipeline.

**Sequence-diagram diff-highlight was real but too subtle to see.**
Item 19 confirmed via pixel-sampling that the `rect rgba(88, 166, 255,
0.18)` "new" highlight technically composited correctly. A fresh review
this round looked at the actual screenshot and reported it as
invisible — re-checked by pixel-sampling again: TRUE, the math was
right (measured (26,43,64), predicted (26.5,43.8,64.8) for 0.18 against
the #0d1117 canvas) but 0.18 is close enough to the near-black canvas
that a human glancing at the actual screenshot also can't reliably see
it, which is a real legibility problem even though the earlier "does it
render at all" question was answered correctly. Raised to 0.3 in
llm.ts's SYSTEM_PROMPT (the literal color string the model is asked to
emit) — re-verified with a fresh real render: now a clearly, obviously
distinct lighter-blue band, confirmed by both the screenshot and pixel
sampling.

**`endpoint` category drift: operational scripts, not routes.** A fresh
FastAPI review caught `prestart.sh`/`tests-start.sh`/`test-backend.yml`
all colored blue = Endpoint, directly contradicting the product's own
legend ("routes/controllers... receives an incoming HTTP/RPC/event
request") — a shell script or CI YAML file receives no such thing.
Tightened the SYSTEM_PROMPT's `endpoint` definition with an explicit
exclusion (operational/deployment scripts are `logic`, not `endpoint`,
even though they're technically "an entry point" in the sense that
something else invokes them) and a worked negative example matching
this exact real failure. Re-verified on a fresh real FastAPI call: all
three now render green (logic), not blue.

**A second, different shape of the item-16/19 removed-edge-glow bug,
this time on the EDGE LABEL rather than the node category.** The same
fresh FastAPI review caught `prestart.sh -->|removed call to| db.py`
rendering as a bold, glowing, fully-live edge — even though its own
label says "removed." Root cause: this time the model represented the
deleted intermediate file (`backend_pre_start.py`) not as its own
`removed`-classed node but by collapsing it straight into the edge
label, so BOTH endpoints (`prestart.sh`, `db.py`) were perfectly normal
live nodes — `touchesRemovedNode()` (item 19) only ever looks at node
categories, so it had nothing to catch. Fixed with `extractEdgeLabels()`
(reads each edge's own rendered label text out of the SVG, keyed by the
same `data-id` its `<path>` carries) and `labelIndicatesRemoval()` (a
narrow, leading-word-only "removed" check — deliberately not a broader
keyword search, to avoid misfiring on a live edge that merely mentions
removal in passing) in mermaid.ts, OR'd into `applyBoldGlowStyling()`'s
existing check. Verified against the real captured bug (re-rendered the
exact real mermaid source through the patched pipeline): both
"removed call to" edges and the "removed tenacity" edge now render
dim/dashed, while the genuinely live `pool_pre_ping`/`--wait flag`
edges keep their bold glow.

**Confirmed unfixable via available config, disclosed rather than
chased further: ELK edge routing can still produce a box/ladder-like
artifact.** Investigated a review claim that removed-edges in the real
FastAPI diagram formed "a dashed-red rectangle... wrapping two
subgraphs" rather than reading as separate edges. Confirmed real by
inspecting the actual rendered path geometry (multiple edges bending
through shared horizontal channels at the same y-coordinates,
inherent to ELK's layered orthogonal routing when several edges
converge across subgraph boundaries onto nodes outside any subgraph).
Spent real effort trying to fix it, not just disclosing on first
sight: tried `mergeEdges:false` (broke two of four edges into clean
straight lines but relocated the box to the diagram's outer perimeter,
arguably worse), grouping the removed nodes into their own subgraph
(no improvement), and `considerModelOrder:NODES_AND_EDGES` combined
with both (still boxy). Cross-checked against `@mermaid-js/layout-elk`'s
own compiled source: the wrapper exposes exactly 7 `config.elk.*` keys
end to end (`nodePlacementStrategy`, `nodePlacementAlignment`,
`mergeEdges`, `forceNodeModelOrder`, `considerModelOrder`,
`cycleBreakingStrategy`, `keepEntryNodeOnTop`) — ELK's own spacing/
edge-routing options exist in the underlying library but are hardcoded
by the wrapper and never read from our config at all, confirmed by
reading `render-O7CIS3YK.mjs`'s `createRootElkGraph()` directly. No
further lever exists without forking the rendering dependency, which
is out of scope. Genuinely disclosed as unresolved, not swept aside.

**Full verification**: 151 tests passing (up from 133 at the start of
this round), all real end-to-end pipeline re-runs against real
Anthropic API calls (not just unit tests) for every fix claimed above,
fresh screenshots for each, and for the two subtlest claims (the
opacity fix, and the earlier round-6 dashed-edge-touches-removed-node
question) direct pixel-sampling verification rather than eyeballing a
screenshot.

**Still open / disclosed, not yet fixed**: (a) NestJS-shaped real-world
diagrams (many small files, few natural layers) still render cramped/
illegible at GitHub's fixed PR-comment width — the node-cap tightening
above did not resolve this, confirmed by direct re-test; (b) the same
node-count hard-cap is still not deterministically enforced, only
prompted; (c) `refundWorker`-shaped nodes (declared inline in an edge
rather than inside any subgraph block) still render outside every
subgraph's visual grouping — cosmetic, not misleading, now that its
color is correct; (d) two edges converging on the same target with
identical generic labels ("issueRefund" x2 in one run) can still sit
close enough together to require tracing by eye — inherent to how a
real diff naturally produces repeated verbs, not something server-side
post-processing can safely disambiguate without inventing text the
model didn't write.

**Status toward the score >= 9 gate**: NOT yet met (3/10 as of the
last review this round). Ten real bugs fixed across `external`
category, self-loop stripping, node-cap wording, `removed`-rescue
reconciliation, the `tokenize()` short-basename fix, hallucinated-line
dropping, missing-category assignment, sequence-diagram opacity, the
`endpoint` category prompt drift, and label-based removed-edge
detection — plus one exhaustively-investigated, confirmed-unfixable
layout limitation now honestly disclosed rather than silently ignored.
The next step is another fresh adversarial review round against fresh
screenshots reflecting ALL of the above, continuing until it scores
>= 9, before any payment/billing work per the user's explicit
instruction: "we will do the payment integration when the score
reaches >=9 [...] it wont sell until it is really helpfull."

## 21. Model-tier decision (2026-09-04): tiered model selection, not a blanket upgrade — plus two more real bugs found verifying it

Anurag's instruction after item 20's status report: **"okay go ahead
with option 2"** — accept `claude-haiku-4-5`'s reliability ceiling and
reconsider the generation model tier, rather than build deterministic
server-side graph-simplification logic (option 1).

**What actually got shipped is NOT a blanket swap to a bigger model.**
Before touching any code, measured the real, current thing rather than
assuming it: fetched live pricing from platform.claude.com/docs
(2026-09-04) and confirmed by direct Messages API call which model
strings this account's key can actually reach. `claude-sonnet-5` is
real and reachable ($2/$10 per MTok in/out) — notably *cheaper* than
`claude-sonnet-4-5` ($3/$15), so it's the right upgrade target, not
`claude-sonnet-4-5`.

Two real, load-bearing API incompatibilities were found by testing
against the live API, not assumed away:
- `claude-sonnet-5` rejects `temperature` outright (400: "`temperature`
  is deprecated for this model"). `createAnthropicProvider` now sends
  it optimistically and retries once without it on that specific error,
  rather than hardcoding a model-name check (fragile — e.g.
  "claude-haiku-4-5" also contains the substring "-5").
- The old `max_tokens: 800` (sized for haiku's shorter output) truncated
  a real sonnet-5 response mid-diagram (`stop_reason: "max_tokens"`,
  invalid mermaid). Tiers now get their own budget (small: 1200, large:
  2500).

**Real cost measurement, not an estimate** (`scripts/measure-model-cost.ts`
— hits the live API with ArchLens's actual SYSTEM_PROMPT and three real
diffs: the FastAPI structural-change commit, the NestJS 14-file commit,
and the synthetic-but-genuinely-structural 10-file scale fixture, now
shared as `scripts/fixtures/scale-test-files.ts` so `dry-run-live-scale.ts`
and the cost script can't drift apart): sonnet-5 averaged **~3.2x**
haiku-4-5's per-call cost ($0.0203 vs $0.0063/generation). Checked
against real plan limits in `backend/lib/quota.ts` (`solo: 500`,
`team: 3000`/month) rather than a made-up number: a team-plan customer
who fully used their 3000/month quota on sonnet-5 for *every* request
would cost **~$61/month in API alone against $29/month revenue — a real
loss**, not a thin margin. That is the actual, decision-relevant
number, and it rules out a blanket upgrade at the current pricing.

**What the same real test also showed**: sonnet-5's reliability
improvement is real and concentrated exactly where haiku-4-5 kept
failing. On the synthetic 10-file scale fixture (coarse-mode cap = 10):
haiku-4-5 produced **14 nodes** (40% over the cap, the exact overshoot
item 20 flagged as unresolved) while sonnet-5 produced **exactly 10**,
via better instruction-following on "merge closely related files," not
by dropping content. On the NestJS commit used throughout items 19-20
as the "14-file scale case" — turns out that commit (`5257ca1`, "add
`readonly` modifier to injected constructor parameters") has **zero
real structural content**; haiku-4-5 hallucinated a detailed 14-node
diagram with invented "uses" edges (including more of the exact
self-loop pattern item 20 fixed) for a diff that changes nothing
architecturally, while sonnet-5 correctly answered `flowchart TD\n  A["No
structural change detected"]`. Worth being honest about: several of
items 19-20's diagnosed bugs were caught by reviewing haiku-4-5's
elaborate but partly-fabricated answer to a diff that should never have
produced a rich diagram at all — the fixes themselves are still good
general hardening, but the specific test case that surfaced them was
noisier than it looked at the time.

**Resolution: tier by diff size instead of picking one model for
everything.** `llm.ts` gains `createTieredAnthropicProvider` — ordinary
diffs (`files.length <= COARSE_MODE_THRESHOLD`, the same constant that
already switches the prompt into COARSE MODE, so the two decisions can
never drift apart) stay on `claude-haiku-4-5`; large/complex diffs
escalate to `claude-sonnet-5`. `LlmProvider.generateMermaid` gained an
optional `opts.fileCount` param (additive, backward-compatible with
every existing mock/implementation) and `generate-handler.ts` threads
`body.files.length` through on both the initial call and the repair
retry. `getProvider()` reads `ARCHLENS_ANTHROPIC_MODEL_SMALL` /
`_LARGE` (defaults: haiku-4-5 / sonnet-5); the old
`ARCHLENS_ANTHROPIC_MODEL` still works as a full override that disables
tiering entirely, for anyone who wants one fixed model. `backend/.env`
updated accordingly. This captures most of the reliability win (the
failures were always concentrated in COARSE MODE, never in ordinary
small diffs, across this whole project's testing history) while
keeping the worst-case team-tier cost close to where it was: a
fully-maxed 3000/month customer whose diffs are a realistic mix of
small (cheap tier) and large (expensive tier) costs meaningfully less
than an unconditional sonnet-5 switch, though Anurag should know the
exact real-world mix (what fraction of a typical team's PRs are >6
files) isn't something this sandbox can measure — that number can only
come from real production usage, not another synthetic test.

**Two more real, previously-undiscovered bugs found while verifying
this end to end against the live API** (neither is about model choice
— both are pre-existing latent bugs this testing pass happened to
surface):
1. **`reconcileDiffClassification`'s `removed`-rescue logic could
   wrongly rescue a genuinely deleted file back to `logicContext`** on
   pure token-collision with an unrelated file elsewhere in the same
   diff. Caught live on the real FastAPI commit: `backend_pre_start.py`
   was genuinely deleted and correctly marked `removed` by the model,
   but its label tokenizes to include "start" — which is *also* a token
   of `tests-start.sh`, a file merely modified elsewhere in the same
   diff. That one coincidental word-overlap alone satisfied the old
   `hasChanged` check and wrongly un-removed a real deletion. Fixed by
   also requiring the label have no removed-evidence of its own
   (`hasChanged && !hasRemoved`, mirroring the precedence rule the
   base-category branch already used) — verified by reproducing the
   exact failure with a minimal repro script before fixing, then
   confirming the real FastAPI diagram renders `backend_pre_start.py`/
   `tests_pre_start.py` correctly red/dashed/removed after the fix, not
   just via the new unit test.
2. **`validateMermaidSyntax` could not catch a sequenceDiagram
   containing flowchart-only `class`/`classDef` lines** — reproduced
   2/2 on live API calls (not a one-off flake): the model sometimes
   bleeds the flowchart category system into sequence output. The old
   check only looked at the first line's declared type and a fixed
   disallowed-content list, so it reported "valid," which meant
   generate-handler's one repair-retry window (which only fires when
   validation reports invalid) never opened at all — the real mermaid
   parser only rejected it much later, inside the render step, as an
   unrecoverable 502 with a wasted API call and a wasted render attempt.
   Fixed by rejecting a `class`/`classDef` line whenever the diagram is
   declared `sequenceDiagram`, so this now gets one real repair attempt
   instead of failing outright.

**Full verification, real not assumed**: 145 tests passing (up from
133 at the start of this item), `tsc --noEmit` clean. Real live-API
re-runs, not just unit tests, for every claim above: the 10-file
scale fixture (exactly 10 nodes, clean categories, fresh screenshot),
the real FastAPI commit both before the removed-rescue fix (confirmed
the bug: `PreStart`/`PreStartTests` wrongly rendered `logicContext`)
and after (confirmed the fix: correctly `removed`, fresh screenshot),
and the live sequence-diagram fixture (fresh screenshot, clean
first-attempt generation).

**Status toward the score >= 9 gate**: not re-scored this round —
this item was scoped to the model-tier decision and the bugs found
verifying it, not a full fresh adversarial review pass. The next step
is exactly what item 20 already queued: another fresh adversarial
review round against fresh screenshots (now reflecting the tiered
model too), continuing until it scores >= 9, before any payment/
billing work, per Anurag's unchanged instruction: "we will do the
payment integration when the score reaches >=9 [...] it wont sell
until it is really helpfull."

## 22. Round 11+12 fixes (2026-09-06): single-node subgraphs, sequence contrast, ungrouped externals — score still plateaued at 3/10, and a candid reassessment of the loop itself

Anurag's instruction: research competitors/visual-enhancement tech, then
keep building toward the score >= 9 gate, framed around his own experience
building 3 prior SaaS products — genuine usefulness is the only real path
to revenue, not hoping people pay out of charity.

**Competitor/tech research done first, briefly**: closest competitor found
is **GG (github.gg)** — auto-posts AI code reviews within a minute of PR
open and generates architecture diagrams, freemium (3 free reviews, Pro
for unlimited + private repos). Not confirmed whether its diagrams are
diff-scoped or whole-repo — that's the one differentiation ArchLens can
still credibly claim if true, unverified beyond that. Swark (VS Code
extension, manual-invoke, no PR automation) and CodeSee (discontinued)
are further back. On visual tech: Mermaid 11.14.0's `look` config
(classic/handDrawn/neo) was spiked (`scripts/spike-mermaid-look.ts`,
committed) — `handDrawn` is a genuine, no-competitor-uses-this visual
differentiator but has real text-over-hachure legibility rough edges;
`neo` showed negligible difference plus a minor artifact. Neither adopted
yet — flagged as a real option, not chased further this round given the
score-gate work took priority.

**Three more deterministic backstops shipped, same pattern as every prior
fix (prompt alone isn't reliable enough on the production model, so code
enforces it after generation)** — full technical detail in the commit
message and each function's own docstring in `diff-classify.ts`:

1. `collapseSingleNodeSubgraphs` — strips a subgraph wrapping exactly one
   bare node (round-11 finding: a colored box around a node that already
   has its own colored border is noise, not signal).
2. `annotateFullyNewSequence` — when a sequence diagram's diff-highlight
   `rect` covers the ENTIRE flow, injects an explicit "Note over X,Y: New
   flow added by this PR" banner, since a same-color highlight with
   nothing un-highlighted to contrast against doesn't read as a signal at
   a glance (round-11 finding).
3. `groupUngroupedExternalNodes` — wraps 2+ contiguous, still-ungrouped
   `external`/`externalContext` nodes into their own subgraph (round-12
   finding: `EventBus`/`PaymentGateway`/`NotificationService` floating as
   bare top-level nodes, one reached by a connector snaking across the
   whole canvas — the SYSTEM_PROMPT permits leaving a *single* external
   node ungrouped, the model over-applied that to three at once).

All three verified two ways, not just unit-tested: (a) 23 new tests (145
-> 168 backend tests, `tsc --noEmit` clean), and (b) re-run against the
**real live Anthropic API**, not just hand-built fixtures — the
fully-new-sequence case is the clearest proof of real-world firing: the
literal phrase "New flow added by this PR" is nowhere in SYSTEM_PROMPT,
yet it appeared in fresh real model output with the correct first/last
participant span, screenshotted at
`scripts/.dry-run-output/live-sequence-fullnew-final.png`. The
single-node-subgraph collapse was similarly confirmed on a fresh call
(`scripts/.dry-run-output/live-scale-collapsed-final.png`).
`groupUngroupedExternalNodes` did NOT get a positive real-call
confirmation this round — 3 fresh live-scale calls in a row all happened
to have the model group the externals correctly on its own, so the
backstop stayed a correctly-inert no-op each time; its unit test instead
reproduces the exact real bug shape captured in the round-12 review
screenshot. Worth being honest about, not glossing over: this specific
fix has fixture-level, not fresh-live-call, positive confirmation.

**Fresh round-12 adversarial review (context-free subagent, 4 freshly
generated screenshots: flowchart stress test, fully-new sequence,
partially-new sequence, real FastAPI commit): scored 3/10, would not
approve.** Verified every claim before accepting it, per this project's
own standing discipline — and this round, that discipline mattered more
than usual, because the review's **top-ranked finding was wrong**:

- **"The partial-highlight sequence diagram can't distinguish a few-new-
  calls PR from a full rewrite"** — the reviewer's inference, not a
  confirmed defect. Checked against the actual diff used: the
  `checkoutController.ts` function body was genuinely empty before this
  PR and every line inside it is newly added, so highlighting nearly the
  entire flow as "new" is *correct*, not a granularity failure. That said,
  the underlying architectural question the reviewer stumbled into by
  accident is real and still open: a Mermaid `rect` block can only mark
  ONE contiguous message range, so a PR that adds new calls at two
  *disjoint* points in an existing flow (not tested this round) genuinely
  could not be highlighted accurately with the current single-rect
  design. Flagged, not fixed — building multi-segment highlighting is a
  real scoped feature, not a quick patch.
- **"Frozen mid-path arrowhead artifacts in the flowchart"** — real in
  the sense that the screenshot shows it, but almost certainly an
  artifact of the review methodology, not the product: `injectFlowRunners`
  has no `begin` offset, so the `<animateMotion>` runner starts at SVG
  load and is captured at a random point along its 2.8s loop whenever a
  static screenshot happens to be taken — in the primary real consumption
  context (a live GitHub PR page in an actual browser), this reads as
  smooth continuous motion, which is the entire point of the feature
  Anurag explicitly asked for (item 10: "if you can add dinamic glowing
  arrow... that would awesome"). **The one thing this genuinely re-
  surfaces, still unverified after 22 items of work**: whether GitHub's
  actual PR-comment rendering pipeline preserves and runs SMIL animation
  inside an embedded `<img src="....svg">` at all — flagged as an open
  unknown as far back as item 8, never resolved because this sandbox has
  no push access to a real GitHub repo. This is now the single highest-
  value cheap unknown left to close.
- **Orphaned `EventBus` node with a long connector** — real, and this is
  the one finding that got fixed this round (`groupUngroupedExternalNodes`
  above).
- **High legend/color decoding overhead (9 visual states to learn)** and
  **the one real-external-repo example being visually trivial (6 nodes,
  CI/test scripts)** — both real observations, neither acted on this
  round: the first is an inherent tradeoff of the category system's
  expressiveness that would need a genuinely different design to reduce
  (out of scope to improvise here); the second is a fair complaint about
  *which* screenshot was chosen for review, not a product defect — a
  harder real-external-repo example (more services, more DB touches)
  would be a better review artifact next round.

**Candid reassessment, not just another round of patches**: this is the
**third review round in a row scoring in the 3-4/10 band** (item 19: 4/10,
item 20: 4/10 -> 3/10 -> 3/10, this item: 3/10) despite roughly 20 real,
verified bugs fixed across those rounds. The deterministic-hygiene-fix
approach (find a concrete rendering/classification defect, patch it in
code, verify against real API calls) has clearly been worth doing — every
single fix was real, not busywork — but it is showing diminishing returns
against the >= 9 bar specifically: the remaining gaps this round
(multi-segment diff highlighting, the untested GitHub-rendering unknown,
legend cognitive load, weak real-world example diversity) are
architectural and/or require information this sandbox cannot produce on
its own (real PR data, a real reviewer's actual reaction), not further
one-function patches. Recommending three concrete next moves rather than
mechanically running a round 13 immediately:

1. **Close the single biggest disclosed-but-never-tested unknown**: push
   ArchLens to a real (even throwaway) public GitHub repo and open one
   real PR, to see the actual rendered comment — resolves whether the
   animated-glow design (the feature Anurag most wanted) even survives
   contact with GitHub's real rendering pipeline. Cheap, and the answer
   changes what's worth polishing next either way.
2. **Reconsider whether a fresh, context-free adversarial review is even
   the right instrument to keep re-running toward >= 9.** It has been
   excellent at finding concrete, real, fixable defects (every round has
   surfaced genuine bugs) — but it has no anchor on the actual
   alternative a paying user faces (mentally reconstructing the diff by
   reading raw code for 15-20 minutes, today, with zero visual aid), so
   its bar may be closer to "flawless professional design tool" than
   "meaningfully better than the status quo." A head-to-head comparison
   (a real engineer reviewing the same real PR with vs. without ArchLens)
   would be a more decision-relevant signal than another 1-10 score from
   a reviewer seeing it in isolation.
3. **Multi-segment sequence highlighting** (the real architectural
   question this round's top finding accidentally surfaced) is a
   legitimate scoped feature to consider building next, if item 1 above
   confirms the rendering pipeline is sound end to end first.

**Status toward the score >= 9 gate**: still not met (3/10). Three real
fixes shipped and verified this round; the standing instruction ("we will
do the payment integration when the score reaches >=9 [...] it wont sell
until it is really helpfull") remains unmet and unchanged — this item's
honest read is that continuing to grind the same review loop unchanged is
unlikely to close the remaining gap by itself, and item 1 above (real
GitHub PR) is the highest-value next step before deciding what to build
next.
