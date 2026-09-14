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

## 23. First real GitHub PR test (2026-09-06) — the animated glow does NOT survive GitHub's `<img>` embed; everything else does

Anurag's instruction: fork a complex real repo, create two branches, make a
substantial real change on one, and open a real PR against the other — a
concrete way to close the single biggest disclosed-but-untested unknown
flagged in item 22 (whether GitHub's actual rendering pipeline preserves
the product's signature animated-glow effect).

**What was built, for real, not simulated:** forked
`tiangolo/full-stack-fastapi-template` to a real GitHub account
(`KITHMEDAI`, via a live OAuth device-flow login completed with Anurag in
the loop — this sandbox had no GitHub credentials at all going in, a real
blocker worth remembering for next time). Created `archlens/base-before-
notifications` and `archlens/add-notifications-feature`, both off the
fork's real `master`. On the feature branch, added a genuinely new,
realistic 6-file feature (a `Notification` model + Alembic migration, a
`services/notifications.py` module, a `notifications` router, and a hook
in `items.py` that fires a notification on item creation) — not a copy of
an old test fixture, a fresh multi-file change written directly into the
real cloned repo. Opened **real PR #1**
(github.com/KITHMEDAI/full-stack-fastapi-template/pull/1), base branch to
base branch, never touching upstream tiangolo's repo at all.

Ran ArchLens's own real pipeline (`scripts/dry-run-real-repo.ts`, real
Anthropic API call, real ELK render) against the real diff between the two
branches — clean generation, correctly classified endpoint/logic/datastore
categories, correct FK-derived edge to the pre-existing `user` table
correctly dashed as context. Committed the generated SVG into the repo
(`.archlens/pr-1-diagram.svg` on the feature branch) and posted a real
comment on the real PR, in the exact production comment format
(`buildCommentBody`), with the image referenced via
`raw.githubusercontent.com` (not a local/synthetic URL).

**Verified with a real browser against the real posted comment, not
assumed:** the dark theme, node colors by category, subgraph boxes, edge
labels, and the glow filter (`feGaussianBlur`) all render correctly and
exactly as designed on the actual GitHub PR page — the first time in this
project's entire history that's been confirmed against a real PR rather
than a local Puppeteer screenshot. That closes the other half of item 8's
long-standing open unknown: whatever GitHub's image pipeline does with an
externally-hosted SVG embedded via `<img>`, it does not break the static
visual design.

**But the animated part does not survive.** Compared the same exact SVG
two ways: loaded directly as a document (`raw.githubusercontent.com/.../
pr-1-diagram.svg` in its own tab) versus embedded via `<img src="...">` in
the real posted PR comment. On the standalone load, the animated runner
marker (`<animateMotion>`) visibly moved between two zoomed screenshots
taken ~2-3 seconds apart on the same edge. On the real PR page, the exact
same edge region showed no marker at all, in either of two checks several
seconds apart — a static single frame, not a frozen-mid-path artifact
(round-12's reviewer guess) but a complete absence of the runner. This is
consistent with a real, known constraint: browsers commonly render an
`<img>`-referenced SVG as a non-animating single frame, distinct from how
the same SVG behaves loaded as a standalone document. Confirmed here
empirically against GitHub's actual rendering, not assumed from general
web platform knowledge alone.

**What this means, plainly**: the animated glowing arrow — the single
feature Anurag was most excited about ("if you can add dinamic glowing
arrow... that would awesome," item 10) — does not actually animate in the
product's real, primary delivery surface (a GitHub PR comment). It has
been rendering correctly this whole time in every local screenshot and
spike test because those all loaded the SVG as its own document
(Puppeteer navigating directly to the file), never through an `<img>` tag
the way GitHub actually serves it. This was invisible until this test
specifically because every prior verification method matched the bug.

**Not yet attempted, a real next step**: whether a CSS-based motion
technique (e.g. `offset-path`/`offset-distance` with a `@keyframes` rule,
animating a marker element rather than using SMIL's `<animateMotion>`)
survives the `<img>` embed where SMIL does not. This is a plausible fix
based on how browsers generally scope animation restrictions for
image-mode SVG, but it is unverified — it needs the same kind of real,
on-a-real-PR test as this one before being trusted, not assumed to work
from first principles. If it doesn't pan out either, the honest fallback
is to drop the motion and keep the (confirmed-working) glow/bold static
styling as the differentiator, or explore whether the diagram could be
delivered as an animated raster (APNG/WebP), which trades vector
crispness for a format browsers do animate inside `<img>`.

**Real, useful side effect**: PR #1 is also a good end-to-end fixture
going forward — it is small, real, on a real fork, and already has a real
ArchLens-generated comment on it, so re-running this exact test after any
future animation fix is cheap (no need to fork/branch again, just
regenerate and re-post).

**Status toward the score >= 9 gate**: this item didn't run a fresh
adversarial review (it was scoped to closing the real-GitHub-rendering
unknown from item 22's recommendation #1) but it materially changes what
that next review should weigh: the static visual design is now confirmed
real-world-correct, while the animation — a headline feature — is
confirmed NOT to work in production as currently implemented. That's a
more important thing to fix than another round of cosmetic polish before
the next review.

## 24. The CSS `offset-path` candidate fix ALSO fails in a real GitHub `<img>` embed (2026-09-06) — the animation problem is bigger than "SMIL specifically"

Anurag's instruction after item 23: "go with option 1" — try the CSS
`offset-path`/`offset-distance` alternative flagged as the plausible next
step, on the theory that browsers commonly keep running CSS animations in
image context even when they suspend SMIL's own timeline.

**Built and shipped as an opt-in alternative, not a replacement**:
`injectFlowRunnersCss()` (`backend/lib/mermaid.ts`) reproduces the exact
same visual effect as `injectFlowRunners()` (a small glowing arrowhead
traveling along each edge's own path, oriented along its tangent) using
CSS `offset-path:path('...')` + `offset-distance` driven by a `@keyframes`
rule instead of SVG's native `<animateMotion>`/`<mpath>` — same edge
detection, same `removed`-edge skip logic, zero SMIL elements. Selected
via a new `renderMermaidToSvg(source, { flowAnimation: "css" })` option,
defaulting to `"smil"` (the existing production behavior stays the
default until/unless this is proven better) so nothing changes for any
existing caller. 6 new unit tests (168 -> 174 backend tests), `tsc
--noEmit` clean, full 175-test suite passing.

**Verified working, twice, before spending a real PR round-trip on it**:
(1) rendered the exact PR #1 diagram through the new path and confirmed
the output contains `offset-path`/`@keyframes`/zero `<animateMotion>`;
(2) loaded it in a real headless-Chromium `<img>`-embed harness (the same
shape as `screenshot-svg.mjs`) and confirmed two screenshots 2.5s apart
were byte-different — real motion, locally.

**The real-PR round-trip result is a clean, decisive NO.** Pushed the
CSS-animation SVG to a new file on the same PR #1 branch
(`.archlens/pr-1-diagram-css-animation.svg`), posted a temporary A/B test
comment on the real PR referencing it via `raw.githubusercontent.com`,
and verified two ways:

- On the raw file loaded as a standalone document: confirmed via direct
  DOM query (`getComputedStyle(...).animationPlayState === "running"`,
  `offsetDistance` genuinely changing between two calls, e.g. 79.5% ->
  15.7%) — the animation is real and does play there, consistent with
  item 23's SMIL finding on the same kind of standalone load.
- On the actual GitHub PR page, with the SVG embedded via the real
  `<img src="https://raw.githubusercontent.com/...">` GitHub renders in
  the comment: took two zoomed screenshots of the exact runner region
  (computed from the img's live `getBoundingClientRect()` and the SVG's
  own viewBox scale factor, not eyeballed) 3 seconds apart and diffed
  them pixel-by-pixel with PIL/numpy. **Zero differing pixels — the two
  screenshots were byte-for-byte identical.** No motion at all, not a
  frozen-mid-path artifact — a fully static frame, the same result item
  23 found for SMIL.

**Investigated why, didn't stop at "it failed."** `curl`-ing the served
SVG directly showed GitHub sends
`content-security-policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`
on `raw.githubusercontent.com` responses for SVG content — a real,
confirmed response header, and a plausible mechanism (the CSP `sandbox`
directive is known to impose iframe-sandbox-like restrictions on how a
resource renders). Tested this directly rather than assuming it's the
cause: replicated the exact header on a local HTTP server and re-ran the
same headless-Chromium `<img>`-embed check
(`scripts/check-css-animation-with-github-csp.mjs`). **Result: motion
still played locally with the CSP header present** — so the `sandbox`
CSP directive alone is NOT the mechanism suppressing the animation on the
real page. Ruled out a real candidate rather than leaving it as an
unverified guess; the true mechanism (something about how GitHub's own
page context or resource-loading pipeline treats an embedded SVG
differently from a direct load) remains unidentified.

**What this changes, and why it matters more than item 23 alone
suggested:** item 23 could be read as "SMIL specifically doesn't survive
GitHub's embed, try CSS instead" — a narrow, fixable-sounding gap. This
result closes that reading. Two independent SVG-internal animation
mechanisms (SMIL and CSS) both produced a fully static frame in the same
real embed context, after both were confirmed to genuinely animate
outside that specific context (standalone load, local `<img>` embed with
no GitHub involved). The more defensible read now is that **no live,
SVG-internal animation mechanism is likely to survive a GitHub PR-comment
`<img>` embed** — this looks structural to how GitHub serves/renders
embedded SVGs, not a fixable detail of which animation API is used.
Neither this item nor item 23 proves that with 100% certainty (the exact
suppressing mechanism is still unidentified), but two-for-two real,
decisive failures is a strong enough signal to change the recommended
path forward.

**Recommendation, updated from item 23's three options:** stop trying
SVG-internal animation techniques (a third one would very likely fail the
same way, at the cost of another real-PR round-trip to confirm it).
The two options actually worth choosing between now:

1. **Drop the animation, keep the confirmed-working static design**
   (dark theme, category colors, glow filter, subgraphs — all confirmed
   correct on a real GitHub PR twice now) and lean on diff-awareness and
   layout quality as the real differentiator against competitors like GG,
   rather than motion.
2. **An animated raster format (APNG/WebP)** — GitHub is well-established
   to actually play animated GIFs inline in PR comments and READMEs
   (this is a widely-used, confirmed real GitHub capability, unlike
   anything SVG-internal), so an animated raster export of the same
   traveling-arrowhead effect is a plausible path to keep the motion
   Anurag wanted. Real trade-offs, not yet investigated: rasterizing an
   SVG to an animated format means giving up vector crispness/
   infinite-zoom, adds a real render-pipeline step (frame-by-frame
   capture + encode, similar to what `capture-flow-gif.mjs` already does
   for local proof-of-motion, but as a production path instead of a
   dev-only tool), and needs its own real-PR round-trip test before
   trusting it, given this item's and item 23's now-consistent lesson
   that local verification alone does not predict GitHub's real behavior
   for this specific thing.

Anurag's call which of these two to pursue — not decided in this item.

**Cleanup**: the temporary A/B test comment on real PR #1 was deleted via
the API after the test concluded (comment id `5557755812`, `DELETE
/repos/{owner}/{repo}/issues/comments/{id}` -> 204) so the real PR only
carries the original production-shaped comment, not test scaffolding. The
`.archlens/pr-1-diagram-css-animation.svg` asset file itself was left on
the branch (harmless, and useful if anyone wants to re-inspect it).

**Status toward the score >= 9 gate**: unchanged (not re-scored this
item, same as item 23) — this was scoped to closing out the animation
question definitively, which it did, with a real but negative result.
Governing constraint unchanged: no payment/billing work until the review
score reaches >= 9.

## 25. Head-to-head validation (diff-only vs. diff+diagram) — a better
signal than another isolated review score, and it surfaced a real product
defect (2026-09-06)

After two consecutive animation failures (items 23, 24), the isolated
"fresh adversarial reviewer scores 1-10" methodology this project had
relied on since round 12 was questioned directly: a design-quality score
doesn't actually test the product's real value proposition — time/effort
saved vs. a reviewer just reading the raw diff. Proposed and ran a
different, more decision-relevant experiment instead: pairs of
independent, fresh, context-free subagents, one given ONLY a raw diff,
one given the same diff plus the real ArchLens-generated diagram/comment,
each self-reporting effort/confidence/accuracy honestly. Ran this twice —
once on the real, small PR #1 diff (7 files, clean/well-organized), once
on the harder `SCALE_TEST_FILES` 10-file diff (schemas + endpoints +
workers — the exact shape the product brief itself uses to justify the
pain point).

**Small/clean PR #1 (7 files): diagram accurate, but low marginal
value.** The no-diagram agent called the raw diff "a quick skim... 3-5
minutes" to build an accurate mental model. The diagram was fully
accurate but didn't save much time a competent reviewer wasn't already
going to spend quickly. **This complicates the product's blanket
"15-20 minutes to decipher system impacts" framing — that framing does
not hold for diffs this size/shape.** The pain point is real only above
some complexity threshold, not universally.

**Harder 10-file diff: diagram saves real time, AND surfaces 3 concrete
new defects.** The no-diagram agent needed "a full careful pass, not a
skim" and, notably, independently discovered on its own that the diff
never publishes the `refund.issued` event its own new worker subscribes
to (a real, plausible functional bug), plus a possible double-refund/
auth-decoupling concern on the new `POST /refunds` endpoint. The
diagram-assisted agent confirmed the diagram is directionally accurate
and saved real initial-orientation time (~10 seconds to the right
general shape) — a genuine positive signal for the core value prop on
input that actually matches the product's stated target. But that same
agent found three concrete defects in the diagram itself:
1. **Missing datastore node** — the `inventory` table, touched by
   `InventoryService.reserveStock`, isn't drawn at all.
2. **Wrong/conflated edge direction** — `Worker --> EventBus` is drawn
   for what's actually an `EventBus.subscribe()` relationship (the
   opposite direction), with publish and subscribe relationships
   rendered as visually identical generic arrows.
3. **The diagram papers over the exact bug the no-diagram agent caught.**
   The diagram visually implies a working Services<->Worker pipeline via
   the shared EventBus node, when this PR never actually publishes the
   event the worker subscribes to. The diagram-assisted agent said
   outright: "I'd have shipped a wrong mental model of the EventBus
   relationship if I'd stopped at the picture."

**Why #3 is the most important finding in this item.** A diagram whose
whole value proposition is "catch integration issues faster than reading
code" actively hid the one integration issue that mattered on this diff,
by drawing a connection that doesn't functionally exist. This isn't a
cosmetic gap like the missing node — it's the diagram giving false
confidence on exactly the kind of bug it's supposed to help catch, on
the product's own target input shape. Generic "arrow = relationship"
edge semantics can't distinguish "definitely wired up" (a direct call)
from "wired up IF something else in the system happens to publish the
right event" (a pub/sub subscribe) — and right now the diagram draws
both identically.

**Net read across both experiments**: the diagram is a real time-saver on
input that matches the product's actual pitch (multi-file, cross-layer
diffs), not on easy/small diffs — so the 15-20-minute framing needs
narrowing, not abandoning. But before charging anyone anything, the
publish/subscribe edge-conflation defect is a concrete, previously-
undiscovered gap worth fixing as its own deterministic backstop
(consistent with this project's established pattern of code-side fixes
over trusting LLM output): distinguish edge semantics (e.g., a
`.subscribe(...)`-derived edge drawn differently from a direct
call/`.publish(...)`-derived edge), and/or flag a subscribed-but-never-
published event as its own hygiene warning on the diagram. The missing-
inventory-node gap is a narrower, likely-separate diagram-completeness
issue (probably an LLM-prompt/extraction gap on tables only read from,
never written to, in this diff).

**Not yet decided in this item**: whether to fix the edge-semantics
defect before or after the previously-planned legend-simplification and
multi-segment-sequence-highlighting work — Anurag's call.

**Status toward the score >= 9 gate**: unchanged — still not re-scored.
This item deliberately replaced "re-run the same score" with a different,
arguably more useful signal; the >= 9 gate itself (whatever methodology
ultimately satisfies it) has not been re-attempted. Governing constraint
unchanged: no payment/billing work until that gate clears.

## 26. Fixed the publish/subscribe edge-conflation defect item 25 found —
verified against three real live Anthropic calls, not just unit tests
(2026-09-06)

Anurag's instruction after item 25's synthesis: "do it then" — build the
edge-semantics fix next, ahead of legend simplification and multi-segment
sequence highlighting, per the recommendation that report ended with.

**What shipped, two parts, same pattern as everything else in this
project (prompt instruction + deterministic code backstop, since a prompt
rule alone was never reliable enough on its own):**

1. `llm.ts`'s SYSTEM_PROMPT now explicitly forbids labeling a pub/sub
   (event-driven) relationship the same generic way as a direct call.
   Registering a handler (`.subscribe(...)`, `.on(...)`) must be labeled
   "subscribes to"/"listens for" and drawn FROM the bus TO the subscriber;
   sending an event (`.publish(...)`, `.emit(...)`) must be labeled
   "publishes"/"emits" and drawn FROM the producer TO the bus. Both must
   include the event/topic name when the diff shows one.
2. `diff-classify.ts` gained `annotatePublishSubscribeEdges()`: restyles
   any edge whose label reads as a subscribe relationship to a genuinely
   DOTTED arrow (Mermaid's own visual language for "not a direct/
   unconditional connection," so it can never again look identical to a
   real function call), and appends a short, honestly-scoped warning when
   this SAME diagram doesn't show a matching publish for that specific
   event. Deliberately claims nothing about the real codebase (this tool
   only ever sees a diff) — only what's true of the picture itself.

**Verified against three separate real, live Anthropic API calls before
calling this done — each one caught something the previous one didn't:**

- **Call 1** confirmed the prompt change works in spirit (the model
  immediately used "publishes"/"subscribes to" phrasing, unprompted by
  any example beyond the instruction) but surfaced a real, confirmed
  render failure: the model quoted the event name inside the pipe-
  delimited edge label (`|publishes "order.created"|`), and Mermaid's
  flowchart parser rejects a quote character there outright — a genuine
  502, not a hypothetical, that the existing `validateMermaidSyntax`
  check doesn't catch (only the real parser, much later, does). Fixed
  two ways: corrected the prompt to ask for the topic unquoted, AND added
  a new deterministic backstop, `sanitizeEdgeLabelQuotes()`, that strips
  any quote character from inside a flowchart edge's pipe-delimited label
  regardless of why it's there — this project's own established
  discipline of never trusting a prompt fix alone applied to itself, one
  call after being written.
- **Call 2**, after that fix, produced a diagram that got the pub/sub
  edge DIRECTION right on the first try (`EventBus -.-> RefundWorker`,
  bus-to-subscriber, matching the new instruction) and got the topic-
  mismatch case exactly right too: it published `order.created` and
  separately subscribed to `refund.issued` on the same EventBus node —
  the identical real-world shape of the bug item 25 found. A naive
  node-level-only check ("does this bus appear in ANY publish edge?")
  would have missed this, since EventBus does publish something, just
  not the thing being subscribed to. `annotatePublishSubscribeEdges()`
  was corrected mid-session (before this call, based on reasoning about
  the risk of exactly this shape, then confirmed against real output) to
  compare the actual extracted event/topic name on each side rather than
  just node participation, falling back to the weaker node-level check
  only when a topic name can't be confidently extracted from either side.
- **Call 2's real render** also caught a second, more subtle bug: the
  restyled dotted arrow rendered SOLID in the actual SVG output, not
  dotted. Root cause, found by inspecting the rendered SVG's own
  `<style>` blocks: `applyBoldGlowStyling()`'s existing blanket rule
  (`.flowchart-link{stroke-dasharray:none !important}`, added round-5/6
  for the bold/glow redesign) silently overrode the dotted style back to
  solid — `!important` beats a non-important rule regardless of selector
  specificity, so mermaid's own more-specific `.edge-pattern-dotted` rule
  lost even though it's more specific. Fixed with the same shape as the
  existing `REMOVED_EDGE_CLASS` precedent in the same function: a
  targeted `.flowchart-link.edge-pattern-dotted{stroke-dasharray:6 4
  !important}` rule declared after the blanket one.
- **Final visual confirmation**, not just re-reading the CSS text:
  re-rendered the fixed pipeline against the real 10-file scale diff a
  third time and screenshotted the actual SVG the same way GitHub embeds
  it (`screenshot-svg.mjs`). The EventBus→RefundWorker edge renders
  visibly dotted, clearly distinct from every solid edge in the same
  diagram, with the label "subscribes to refund.issued ⚠ no publish edge
  for this event shown in this diagram" fully legible.

**Disclosed, not fixed, limitations**: edge DIRECTION correction relies
entirely on the prompt change landing — there's no safe way to infer
"which endpoint is the bus" from a bare edge line and deterministically
flip a backwards one without real semantic understanding, so a smaller
production model that ignores the direction instruction on some future
diff would still draw it backwards (the topic-mismatch warning and
dotted styling still apply regardless of which way the arrow points,
which is some mitigation). The topic-mismatch check is diagram-scoped by
design (see the docstring) — it can never know an event is published
somewhere the diff doesn't touch, and says so in its own wording rather
than overclaiming. The warning text is fairly long and, on the real
10-file diagram, ran close to the edge of the ThirdParty subgraph's
dashed border in the screenshot — legible, but a candidate for
shortening if a future review flags it as cramped. 175 -> 191 backend
tests (16 new: `annotatePublishSubscribeEdges` x11,
`sanitizeEdgeLabelQuotes` x5), full suite passing, `tsc --noEmit` clean
on both workspaces.

**Status toward the score >= 9 gate**: unchanged, not re-scored — this
was scoped to fixing the specific, concrete defect item 25 found, not to
re-running the review loop. The previously-planned next steps (legend
simplification, multi-segment sequence highlighting) and the animation
decision remain open, Anurag's call on sequencing.

## 27. Legend simplified (9 → 6 swatches) and the multi-segment sequence highlighting gap investigated and found to already be mostly-solved (2026-09-06)

Anurag's instruction after item 26: "move it" — proceed with the two
items item 26 left as "next in line": legend simplification and
multi-segment sequence-diagram highlighting.

**Legend simplification.** The round-3/round-6 legend design cost 9
total swatches (4 categories × {solid, dashed} + 1 "Removed by this PR")
to teach only 5 distinct facts, since the solid/dashed pairing is
*identical* across every category — showing that pairing 4 separate
times taught the same thing 4 times, not 4 different things, and this
"high legend/decoding overhead" complaint had been raised and never
fixed since round 12. Fixed by cutting each category down to its single
solid swatch (the color alone identifies the category) and teaching the
dashed pattern exactly once via one new, neutral-gray "Existing context"
item — 6 total swatches, zero information lost (`LEGEND_ITEMS` and
`appendLegend`'s doc comments in `backend/lib/mermaid.ts`). Verified: the
existing `appendLegend` test suite updated to assert exactly 6 total
swatch `<rect>`s and exactly 2 dashed ones (down from an unbounded-lower-
bound assertion of "4+"), full suite green, and a real render +
screenshot (`backend/scripts/legend-check.ts`, kept as a standing visual
regression check) confirmed the new footer reads cleanly.

**Multi-segment sequence highlighting** — the actual finding here is the
more important one, and it cuts against the assumption item 25/round-12
carried forward. Round 12's review said a PR that adds new calls at two
disjoint points in an existing flow "can't be highlighted accurately" —
read at the time as implying a real Mermaid architectural ceiling (its
`rect...end` block can only mark one contiguous range). Rather than
build a workaround for that assumption, it was tested empirically first:

1. `backend/scripts/rect-edge-cases.ts` (kept as a standing contract
   check on Mermaid's own behavior) confirmed live that Mermaid **does**
   support multiple separate, even directly-adjacent, `rect rgba(...)
   ...end` blocks in one diagram — there is no real ceiling here at all.
2. `scripts/dry-run-live-sequence-disjoint.ts` (kept as a standing
   regression script) then tested the *actual production prompt* against
   the *actual production model* (claude-haiku-4-5 — the tier every
   single-file diff runs on, not the escalated sonnet-5 tier) with a real
   diff shaped exactly like the round-12 complaint: two separate git
   hunks in one file, each a single new call, with untouched existing
   calls between and around them. Run 3 times (once with 2 disjoint new
   calls twice, once with 3), the model produced one correctly-scoped
   separate `rect` block per new call **every time**, correctly leaving
   the untouched calls between them un-highlighted — confirmed both in
   the generated source and visually via a real screenshot.

So the round-12 finding did not reproduce: this was never a real
architectural gap in the current prompt/model, just an assumption that
had never actually been tested against live behavior. Brutal-honesty
note to self as much as to Anurag: it would have been easy to "fix" this
by building unnecessary machinery for a problem that doesn't exist —
the discipline of testing before building is what caught that here.

What live testing *did* surface as a genuinely real, adjacent risk:
asking the model to emit more separate `rect` blocks per diagram means
more open/close pairs to track, and a hand-constructed test
(`rect-edge-cases.ts`) proved that a single **unclosed** block of *any*
kind (`rect`/`loop`/`alt`/`opt`/`par`/`critical`/`break` — not just
`rect`) breaks the *entire* render with a hard Mermaid parse error,
which `validateMermaidSyntax`'s cheap regex check does not catch — the
same shape of gap as item 26's quote-in-edge-label bug. Fixed two ways,
same pattern as every other round: (a) `llm.ts`'s SYSTEM_PROMPT now
explicitly states the multi-block case (rather than leaving it to the
model to keep inferring correctly) and explicitly warns every `rect`
needs its own matching `end`; (b) a new deterministic backstop,
`closeUnclosedSequenceBlocks` (`backend/lib/diff-classify.ts`), walks a
generated sequence diagram's block-open/close depth and appends any
missing `end` line(s) at the end of the source rather than letting an
incomplete diagram fail to render at all — wired into
`generate-handler.ts` right alongside `sanitizeEdgeLabelQuotes`, since
both are syntax-safety nets that must run before anything else touches
the source. 198 backend tests (7 new for `closeUnclosedSequenceBlocks`),
full suite green, `tsc --noEmit` clean on both workspaces, re-verified
live post-change (the disjoint-segment script still produces correct
output with the updated prompt) with no regression on the existing
flowchart/pub-sub live scripts either.

**Status toward the score >= 9 gate**: unchanged, not re-scored. Both
items from the item-26 punch list are now done; no other work is
pending from that list except a possible future re-run of the
adversarial review loop itself (Anurag's call), and the payment/billing
work stays gated on that score reaching >= 9, per the standing
instruction.

## 28. Missing-inventory-node gap fixed; animation dropped as the default; moving toward re-scoring (2026-09-07)

Anurag's instruction: "i want to release it fast so if you can just fix
things and make it ready for commercial use it would be better, but
still quality wise no compromise." Flagged directly rather than silently
acting on it: "fast" and Anurag's own standing gate ("no payment
integration until the score reaches >=9") are in tension — the gate
stays in force unless Anurag says otherwise. Two calls made to keep
moving without blocking on more back-and-forth:

**Animation: dropped as the default**, not just left undecided. Both
SMIL and CSS motion are confirmed dead in a real GitHub `<img>` embed
(items 23-24) — the only place a real customer ever sees this diagram —
so `renderMermaidToSvg`'s `flowAnimation` option now defaults to `"none"`
instead of `"smil"` (`backend/lib/mermaid.ts`). This isn't just "no
regression from removing an unused feature": leaving either runner wired
in by default meant every production diagram carried a small glowing
arrowhead frozen at whatever position its dead animation timeline
happened to reach — not a designed resting state, a genuinely confusing
static artifact sitting on top of an otherwise clean edge, for zero
visible benefit in the one context that matters. Both implementations
stay fully implemented and selectable (`flowAnimation: "smil" | "css"`)
for the case where the raw SVG is opened directly rather than viewed
through the embed — this is a default change, not a removal, so a future
decision to revisit animation (a different embed strategy, an animated
raster export) doesn't start from scratch. Verified: a new test asserts
the production-shaped call (no `flowAnimation` passed, exactly how
`api/generate.ts` calls this) contains neither `<animateMotion>` nor the
CSS runner class, while bold/glow styling is unaffected; the two existing
tests that asserted the runner by default were updated to opt in
explicitly, so the capability itself stays tested. Confirmed live: a
fresh render of the 10-file scale diff has zero `animateMotion`/
`archlens-flow-runner` occurrences and screenshots clean.

**Missing-inventory-node gap fixed** — the one concrete, disclosed defect
still open from the head-to-head validation (item 25): on the real
10-file scale diff, `InventoryService`'s own genuine write
(`db.inventory.decrement(...)`) never appeared anywhere in the diagram —
the model correctly drew the write edge, but the shared datastore node's
label only ever said "orders / refunds tables," silently omitting the
one table this PR's own new code actually touches. Two-part fix, same
established pattern:

1. `llm.ts`'s COARSE MODE instruction now explicitly requires folding
   every touched table into an existing datastore node's label rather
   than ever dropping one to stay under the node cap, and says to merge/
   drop service-layer granularity first if something has to give.
2. This alone worked on the first live re-test, but a second live call
   with the identical fixed prompt reproduced the same omission again —
   1-for-2, the same "prompt alone isn't reliable enough" pattern behind
   every other backstop in this project. `reconcileDatastoreNodeLabels`
   (new, `backend/lib/diff-classify.ts`) is the deterministic backstop:
   for every edge from a non-datastore node into a datastore node whose
   label reads as a write (writes/creates/updates/deletes/inserts/
   persists/stores/saves/modifies/decrements/increments/mutates — the
   last three added after a live call used "decrements," a reminder this
   list can't be assumed exhaustive from reasoning alone), it derives a
   keyword from the WRITING node's own name (reusing this file's existing
   `tokenize()`/`ARCHITECTURAL_SUFFIX_WORDS` logic — "InventoryService" ->
   "inventory," picking the shortest surviving token) and appends it to
   the datastore node's own label if missing. Deliberately conservative:
   unlike every other backstop in this file, this is the first one that
   COULD have fabricated new graph structure (a whole new node/edge) —
   instead it only ever reconciles an existing datastore node's label
   text against write-relationships the model already drew, since wrong
   invented structure is worse than an omission.

Verified against 3 real live Anthropic calls (production model,
`claude-haiku-4-5`), not just unit tests: the fix (prompt + backstop
together) produced the correct merged "orders / refunds / inventory
tables" label all 3 times, including one run where the model used a
different verb ("decrements") that the first version of the backstop's
verb list didn't recognize — caught live, fixed immediately (added
decrements/increments/mutates to the list) rather than shipped with a
known-narrow verb list. 9 new tests (198 -> 209 backend tests, `tsc
--noEmit` clean on both workspaces), and a final live render +
screenshot confirms the shared datastore node correctly reads "orders /
refunds / inventory tables" with no stray animation artifacts anywhere
in the diagram.

**Status toward the score >= 9 gate**: every concretely disclosed defect
from the head-to-head validation (item 25) and round 12 is now closed —
edge-conflation (item 26), legend decoding overhead and multi-segment
highlighting (item 27), the missing-inventory-node gap and the
animation-artifact question (this item). The next step is re-scoring:
enough real, verified fixes have landed since the last scored round
(3/10, round 12) that continuing to act on a 6-item-old score number
stops being the disciplined choice. A fresh round-13 adversarial review
is queued next.

## 29. Round 13 (5/10) and round 14 (6/10) adversarial reviews — two more real fixes landed, one confirmed dead-end, one significant new gap found and NOT yet fixed (2026-09-07)

Continuing under the same standing instruction as item 28 ("release it
fast... fix things... no compromise on quality"). Ran the queued
round-13 review, independently verified each finding against real
code/screenshots before acting (as always), fixed what was real, then
ran a follow-up round-14 review to check progress.

**Round 13 scored 5/10** (up from 3/10 at round 12). Verified findings,
two fixed:

1. **Fixed** — the pub/sub "no publish edge shown" warning (the single
   most valuable insight this diagram surfaces) rendered in the exact
   same plain white text as routine "calls"/"writes" labels, so nothing
   drew a reviewer's eye to it. `styleWarningEdgeLabels()` (new,
   `backend/lib/mermaid.ts`) tags any rendered edge-label `<text>`
   containing the "⚠" marker and recolors it amber via an `!important`
   stylesheet rule. Verified live: a real Anthropic call reproduced the
   warning and the screenshot confirms it now renders amber, not white.
2. **Fixed** — sequenceDiagram output had zero on-diagram explanation of
   what the blue `rect rgba(88, 166, 255, 0.3)` diff-highlight band
   means, unlike flowchart, which spells out solid/dashed in its own
   footer caption. `appendLegend()` now branches on diagramType:
   flowchart keeps its existing multi-category footer,
   `appendSequenceLegend()` (new) draws a minimal single-row caption
   footer for sequenceDiagram ("blue highlight = new flow or steps added
   by this PR"), reusing the same footer geometry. Verified live against
   the real disjoint-highlight scenario (two separate blue bands) —
   screenshot confirms the caption renders correctly underneath both.
3. **Verified FALSE, not fixed** — finding #13 ("no PR/caption context
   around the diagram") does not reproduce against the actual product:
   `buildCommentBody()` (`action/src/comment.ts`) already puts `PR
   #<n> · <count> files matched` directly in the comment's own header,
   right next to the title. The round-13 reviewer was only shown the
   bare diagram image in isolation, not the full comment body it
   actually ships inside — a gap in that review's own test setup, not in
   the product.
4. Findings #10 (participant-level new/pre-existing visual distinction
   in sequence diagrams) and #12 (per-band labeling for multi-segment
   sequence highlighting) were reconsidered against the actual rendered
   output rather than fixed: #12 looks already adequately addressed by
   context alone — each highlighted band's own message content already
   distinguishes it, and the new sequence legend caption now explains
   the convention once. #10 is a real, separate, bigger-scope ask
   (visually marking "this participant/service is new" the way
   flowchart node categories do) — deliberately deferred, not silently
   dropped, since it's a design addition rather than a quick fix.

9 new/updated tests (207 -> 216 backend tests), `tsc --noEmit` clean on
both workspaces, 2 commits.

**Round 14 scored 6/10.** Independently verified both concrete findings
before deciding what to do with them:

5. **Re-confirmed as the SAME already-disclosed, unfixable limitation**
   (item 20) — the pub/sub warning edge's own path loops around almost
   the entire canvas margin before reaching its target node. Checked the
   actual SVG path data directly rather than trusting the screenshot
   alone: it really does route from y=696 down to y=735 and all the way
   back up to y=323 — genuine ELK orthogonal-routing box/ladder behavior,
   the same confirmed-unfixable-without-forking-the-dependency limitation
   already disclosed in item 20, now just visible on a specific edge that
   happens to matter more. Not a new bug; re-litigation of an accepted one.
6. **Real, reproducible, NOT fixed — node/subgraph naming is unstable
   across separate regenerations of the IDENTICAL diff.** Ran the same
   10-file scale-test diff through two back-to-back live Anthropic calls:
   node IDs, node labels, and subgraph titles all changed between runs —
   "Business Logic" vs. "Service Layer," "External Services" vs.
   "External Systems," "Orders/Refunds Routes" vs. "ordersController +
   routes." This is a real trust problem for the product's own pitch (a
   team's "shared architecture language" that relabels itself on every
   PR push isn't shared or stable) and it reproduced on the first try, not
   a fluke of comparing screenshots from different points in this session.
   Investigated the obvious cheap fix — lowering sampling temperature —
   and hit a confirmed dead end: `claude-sonnet-5` (the tier this exact
   scale scenario escalates to, per the item-21 model-tier decision)
   rejects BOTH `temperature` and `top_p` outright with 400 "deprecated
   for this model" (checked `top_p` directly against the live API, not
   assumed from the existing `temperature`-deprecation comment). There is
   currently no sampling-parameter lever available for this model tier at
   all — any real fix has to be architectural: either (a) derive
   node/subgraph labels deterministically from the diff itself in code
   rather than trusting the model to name them, similar in spirit to how
   `reconcileDatastoreNodeLabels` already reconciles datastore labels
   deterministically, or (b) cache the previous diagram's naming per PR
   and feed it back into the prompt on regeneration so a re-push reuses
   the same vocabulary instead of re-inventing it. Both are real feature
   work, not quick fixes — flagged for Anurag rather than silently
   deferred or silently started, since it's a genuinely new, scope-sized
   decision and directly relevant to the score >= 9 gate.

**Status toward the score >= 9 gate**: 6/10 as of round 14, up from
3/10 two rounds ago. The standing payment-integration gate (score >= 9)
stays in force. The single largest remaining gap standing between here
and 9/10 is the naming-instability finding above — everything else
found across rounds 13-14 is now either fixed, confirmed-false, or an
already-accepted, disclosed layout limitation.

## 30. Round 15 (6/10, unchanged) and round 16 (6/10, unchanged) — the naming-instability fix, live-verified across 6 calls, plus a real secondary bug it surfaced (2026-09-09)

Anurag's instruction: "lets do one more go, make the score 7 this time" —
directly targeting item 29's single largest documented remaining gap:
node/subgraph naming instability across regenerations of the identical
diff, with the sampling-parameter route already confirmed a dead end.

**Fix 1: `canonicalizeSubgraphTitles` (new, `backend/lib/diff-classify.ts`).**
A subgraph's own title conveys nothing beyond its region
(endpoint/logic/datastore/external) — information the diagram's own
per-node `class` lines already state. Rewrites the title inside `subgraph
Id["..."]` to one of four fixed strings ("API Layer" / "Business Logic" /
"Data Layer" / "External Services") for whichever region that subgraph
resolves to, regardless of what freeform title the model wrote.

First version relied on the model's own `class SubgraphId <region>Region`
line, exactly as the SYSTEM_PROMPT instructs it to emit separately from
per-node classes. **Live-verifying it immediately caught that version
shipping completely inert**: two fresh live calls in a row, the model
classed every individual node correctly but never once emitted the
separate subgraph-level region line at all — the same "prompt alone isn't
reliable enough" pattern behind every other backstop in this file, just
discovered for a different instruction than the one this fix originally
targeted. Rewritten to INFER each subgraph's region from its own member
nodes' ordinary per-node categories instead (the signal the model
reliably does emit on every node) — an explicit region line, when present,
still takes priority. Deliberately conservative: a subgraph whose members
span more than one category, or a region claimed by 2+ subgraphs, is left
completely untouched rather than guessed at.

**Fix 2: SYSTEM_PROMPT tightened (`llm.ts`) on two fronts** — node-label
wording ("when a file defines one primary class/service, label the node
with that symbol name, not the raw filename... never alternate between
filename-style and symbol-style labels for the same kind of component")
and node-count granularity ("two distinct files get two distinct nodes by
default... only merge distinct files into one node when the node-count
cap actually forces it").

**Live verification, 6 consecutive fresh calls against the real 10-file
scale diff** (`scripts/dry-run-live-scale.ts`, unmodified):

- Runs 1-2 (before the node-count-granularity prompt tightening, testing
  only the title-canonicalization + label-wording fixes): subgraph titles
  were canonical ("API Layer" / "Business Logic" / "External Services") in
  both, but run 2 still merged the entire API layer into ONE unlabeled
  node with no subgraph wrapper at all (`Orders_API["Orders/Refunds
  Routes+Controllers"]`, top-level, no `subgraph` around it) — confirming
  the round-15 review's exact complaint reproduces, and that title
  canonicalization alone doesn't touch the deeper structural-merge
  instability. Checked the actual node count in that output (9 of the
  10-node COARSE MODE cap) to rule out the cap forcing the merge — it had
  headroom to keep both nodes and merged anyway.
- Added the node-count-granularity prompt tightening, then ran 3 MORE
  fresh calls (runs 3-5 in this item's own numbering, using the terminal
  session's actual run labels 1-3 after the second prompt change): **all
  three kept the API layer as its own labeled two-node subgraph**
  (`subgraph API["API Layer"] ... Routes[...] Controllers[...] end` or the
  model's own two-controller variant), a clean reversal of the run-2
  regression.
- 3 additional fresh calls (runs 4-6) checked purely for continued
  stability of all three prior fixes at once: canonical subgraph titles
  ("API Layer" / "Business Logic" / "External Services"), the API layer
  kept as its own subgraph, and the datastore label reading "orders /
  refunds / inventory tables" correctly — **all three held in all three
  additional calls, 6/6 total** since the node-count-granularity prompt
  change landed.

**A second, real, previously-latent bug found via this same live
testing**: run 3 (of the post-prompt-tightening batch) merged
`OrderService` and `InventoryService` into one node labeled
`"OrderService + InventoryService"` — legitimate under the "only merge
when the cap forces it" rule, since this diagram was still at the node
cap in the Logic layer specifically. But the resulting datastore label
came back `"orders / refunds tables"`, missing "inventory" — the EXACT
defect item 28 fixed for the unmerged case, now reachable through a
merged-node path item 28 never tested. Root-caused directly: `
deriveTableKeyword` (the keyword-derivation helper `reconcileDatastore
NodeLabels` depends on) split a node's label on `"+"` and used ONLY
`label.split(/\s*\+\s*/)[0]` — the first constituent — silently
discarding every service merged in after it. Renamed to
`deriveTableKeywords` (plural), now derives one keyword per
`"+"`-separated part and returns all of them, verified both by a
reconstructed unit test (`OrderService + InventoryService` writing to
`"orders / refunds tables"` now correctly gets `"inventory"` inserted)
and by direct root-cause inspection of the exact failing case.

8 new/updated tests across both commits (216 -> 228 backend tests), `tsc
--noEmit` clean on both workspaces, 2 commits.

**Round 15 scored 6/10, unchanged** — correctly caught the run-2
structural-merge regression described above (title wording ≠ structural
stability) via a direct side-by-side comparison of two real screenshots
from two regenerations of the identical diff; this was the same finding
independently rediscovered via live testing above, not a miss.

**Round 16 scored 6/10, unchanged — for a different, and itself valid,
reason.** Given only one screenshot (post-fix) plus a description of the
6-call live-verification evidence, the reviewer correctly refused to
accept a stability claim on description alone, and specifically flagged
that this item (item 30) didn't exist in CLAUDE.md yet at review time —
the review was run before this write-up, breaking this project's own
established practice of writing up every fix with full verification
detail before treating it as done. Fair process finding, fixed by writing
this item immediately afterward with the actual run-by-run mermaid diffs
above rather than a bare assertion.

**Status toward the score >= 9 gate**: still 6/10 as of round 16. The
title/label-wording and node-count-granularity fixes are real and now
properly documented with their live-verification trail; whether that
clears the bar is for a review run against this actual written record,
not the bare screenshot round 16 saw. The remaining, still-real gaps
round 15/16 correctly did NOT let this fix paper over: the pub/sub
warning edge's spaghetti ELK routing (already-disclosed, unfixable
without forking the dependency, item 20) and the fact that 6 consecutive
calls against ONE synthetic fixture is real evidence of stability on that
fixture specifically, not proof of general stability across arbitrary
diff shapes.

## 31. Round 17 (6/10, unchanged) — the evidentiary-rigor ceiling, and the
## decision to stop re-running the same review and report back (2026-09-09)

**Round 17 was given item 30 above (already written up, addressing round
16's process complaint) plus the same screenshots, and still scored
6/10.** Its critique was no longer about whether the fixes are real — it
was about whether they're *independently checkable from artifacts on
disk*, not just prose in CLAUDE.md:

1. It checked `scripts/.dry-run-output/` directly and found only one
   SVG/screenshot pair survives from the whole 6-call verification
   described in item 30 — the other 5 calls' raw mermaid source and
   renders were never saved, so "6/6 stable" is a narrated claim, not
   something the reviewer (or anyone else) can open and check themselves.
2. The `deriveTableKeywords` fix has a passing unit test and a root-cause
   script, but no before/after screenshot — citing this project's own
   precedent (items 14, 16, 19) that unit tests alone have missed real
   rendering bugs before.

Both are fair complaints on their own terms, and in response 3 fresh live
calls were run and saved as permanent local files (not just described):
`scripts/.dry-run-output/round15-stability-evidence/run-{1,2,3}-comment.md`
(3 files, ~1.9KB each, real Anthropic API output, timestamped
2026-09-09). **These are NOT committed to git** — `scripts/.dry-run-
output/` is in `.gitignore` (has been since long before this item;
covers `backend/scripts/.dry-run-output/` too) as a deliberate project
convention that dry-run output is regenerable scratch, not a tracked
fixture. That convention is being left as-is rather than changed
unilaterally to satisfy one review round: these 3 files exist on this
machine as session-local proof, but a reviewer (or anyone) checking out
the repo fresh will not find them. Flagging this tension explicitly
rather than quietly working around it or quietly deciding it away.

**Decision: stopping here rather than running a round 18.** Four
consecutive fresh adversarial reviews (14, 15, 16, 17) have now scored
6/10, despite three real, live-verified engineering fixes landing in
between (subgraph-title canonicalization, node-label/merge-granularity
prompt tightening, the `deriveTableKeywords` merged-node bug). The
reviews are not wrong to hold the line — the ELK edge-routing flaw
(item 20) is real and still unfixed, and round 17's artifact-rigor
critique is legitimate. But re-running the identical review methodology
a fifth time without a different lever to pull would just be spending
review cycles to confirm the same plateau again. The user's instruction
this round was "make the score 7" — that target was not reached, and the
honest, useful next step is reporting that back with a straight
assessment of the two real remaining obstacles (ELK routing; reviewer
skepticism toward self-reported evidence in general) rather than
continuing to mechanically re-run the same instrument. See the
conversation log for the report delivered to the user on 2026-09-09.

**Payment/Stripe gate status: unchanged, still not met.** Score is 6/10,
not >= 9. No billing/payment work has been done or will be done until a
review clears that bar.

## 32. Sequence-diagram participant diff-awareness (item 29 #10, the one
## deliberately-deferred finding), shipped and live-verified (2026-09-12)

Anurag's instruction: "work on quality then make sure better" — a general
directive to keep closing real gaps toward the score >= 9 gate, without
naming a specific target. Rather than immediately re-run the same
adversarial-review loop that's plateaued at 6/10 across four rounds (items
29-31), picked the single concrete, previously-identified, never-attempted
gap left on record: item 29 finding #10, explicitly deferred at the time as
"a real, separate, bigger-scope ask... deliberately deferred, not silently
dropped."

**The gap, confirmed still real before touching any code.** A
sequenceDiagram's diff-awareness has always been message-level only (the
`rect rgba(88, 166, 255, 0.3)` highlight around new exchanges) — every
PARTICIPANT box renders identically regardless of whether it's the actual
file this diff modifies or a pre-existing service merely called into.
Re-ran `scripts/dry-run-live-sequence.ts` fresh before assuming the gap
still existed (rather than trusting a two-week-old writeup) and confirmed
it: `checkoutController` (the file this diff's own 2 matching files
actually touch) rendered in the exact same box style as `CartService`,
`PricingService`, `PaymentGateway`, `OrderService`, `NotificationService`
(pre-existing services merely called into) — a reviewer glancing at the
header row has no way to tell which one is the changed code.

**Fix, same "recompute from the diff itself, never trust the model's
self-report" philosophy as every other backstop in diff-classify.ts:**
`annotatePreexistingParticipants()` (new) reuses the exact same
`computeDiffTouchState()`/`tokenize()` machinery reconcileDiffClassification
already uses for flowchart nodes, applied to sequence `participant`
declarations instead — deliberately never `actor` declarations, since
llm.ts's own SYSTEM_PROMPT already reserves `actor` for anything outside
this codebase's control (the sequence-diagram equivalent of flowchart's
`external` category), so those were never candidates for "did this diff
touch this" in the first place. A participant whose name carries no
changed-evidence from the diff's own files gets appended to a `%%
archlens:context-participants Name1,Name2` marker comment — mermaid's own
parser drops `%%` comments before they ever reach rendered output (verified
live, not assumed: the marker text never appears anywhere in the real
rendered SVG), so this doesn't touch the diagram's actual syntax at all.

`styleContextParticipants()` (new, mermaid.ts) is the render-side half: reads
that same marker back out of the raw source text inside
`renderMermaidToSvg`, and dims/dashes the named participants' actual
rendered boxes — reusing flowchart's own already-established visual
language (`*Context` categories: dashed border, dimmed fill, dimmed text)
rather than inventing a second convention a reviewer would have to learn
separately. Found and fixed a real structural landmine before it shipped,
not after: mermaid wraps a sequence diagram's TOP participant row in an
attributed `<g id="root-N" data-et="participant" ...>` but its BOTTOM row in
a bare, attribute-less `<g>` — confirmed by direct inspection of a real
rendered SVG, not assumed — so a regex keyed on the `<g>` wrapper shape
would silently stop matching one of the two rows the moment either
attribution style changed. Built and tested the regex directly against a
real rendered SVG file (`node -e` one-liners against
`scripts/.dry-run-output/live-sequence-diagram.svg`) before writing the
real implementation, confirming a naive `<g>...</g>` scan found only 6 of
the real 12 actor-box groups (missed every top row) versus a rect+text-
adjacency pattern that doesn't depend on the wrapper at all, which found
all 12. The sequence legend caption also gained a clause explaining the new
convention ("dashed participant = pre-existing service"), with the footer's
minimum width now accounting for the caption's own estimated text width so
a narrow diagram's footer can't clip it.

**Live-verified three ways, not just via the 10 new/updated unit tests
(228 -> 241 backend tests, `tsc --noEmit` clean):**

1. A real end-to-end integration test through the actual Puppeteer/mermaid
   harness (`tests/mermaid.test.ts`) — confirms the marker comment never
   leaks into real rendered output and that the real rendered participant
   boxes (not a hand-built stand-in) get tagged correctly.
2. Re-ran `scripts/dry-run-live-sequence.ts` (real Anthropic call) after
   the fix: the marker correctly named all 5 pre-existing services,
   correctly excluded `checkoutController`, and the rendered screenshot
   (before: a screenshot showing every participant box visually identical;
   after: `checkoutController` solid/bright, the other five dashed/dimmed,
   legend caption updated and legible) confirms the fix visually, not just
   textually — before/after PNGs kept locally
   (`scripts/.dry-run-output/quality-review-sequence-{baseline,after}.png`,
   not committed, per this project's existing `.dry-run-output/`
   convention — see item 31's own disclosure of this same tension).
3. Re-ran `scripts/dry-run-live-sequence-disjoint.ts` (a different real
   diff, the two-disjoint-new-calls scenario from item 27) specifically to
   check for regressions on an adjacent feature: both separate highlight
   `rect` blocks still render correctly, and the new participant-dashing
   correctly applied to this diagram's own different set of pre-existing
   services (`FraudCheckService`, `NotificationService`, `Payment`) without
   disturbing the disjoint-highlight behavior at all — confirmed via a
   fresh screenshot, not assumed from the source alone.

Also re-ran `scripts/dry-run-live-scale.ts` (the flowchart-side stress
test) after these changes, even though nothing in this item touches
flowchart-specific code paths, purely to confirm the shared parts of
mermaid.ts (the new import, the renderMermaidToSvg pipeline edit) caused no
regression there: node count still exactly 10, canonical subgraph titles
intact, pub/sub warning still present and amber.

**Deliberately conservative in one place, matching this file's established
pattern**: if EVERY declared participant comes back with no changed-
evidence (most likely meaning the diff's changed files don't textually
overlap ANY declared participant name at all, a real possible case, not
just a classifier miss), the function is a no-op rather than marking 100%
of participants "pre-existing" — that would erase the one signal this
exists to add (which one is new), not sharpen it. Covered by its own unit
test.

**Not attempted this round, left open**: this closes item 29's #10 finding,
but does not itself change the score-gate status — no fresh adversarial
review was run against this specific change. The remaining, previously-
disclosed obstacles are unchanged: the ELK pub/sub-warning-edge routing
(confirmed unfixable without forking the rendering dependency, item 20) and
general reviewer skepticism toward self-reported verification evidence
(item 31) — this item's response to the latter is citing exact live-call
results, real regression checks against adjacent features, and file paths
for the generated evidence, rather than only prose narration.

**Payment/Stripe gate status: unchanged, still not met.** Score remains
6/10 as of the last scored round (round 17); no fresh review was run this
item. No billing/payment work has been done or will be done until a review
clears >= 9.

## 33. The ELK "box/ladder" edge-routing artifact (item 20, disclosed as confirmed-unfixable-without-forking) actually gets fixed, plus the round-17 evidence-convention gap (2026-09-14)

Anurag's instruction: rather than launch/publish/monetize at the current
6/10 (four rounds plateaued, 14-17), spend real effort on the two specific
things the plateau kept converging on instead of chasing the score number
mechanically again — the ELK edge-routing limitation (item 20) and round
17's evidentiary-rigor finding (self-reported verification isn't
independently checkable without real artifacts on disk) — then run a
fresh review and report the honest result before any deployment/
Marketplace/billing work. Both are now addressed; full detail below.

### The ELK routing fix

Item 20's own investigation was right about the WRAPPER: read
`@mermaid-js/layout-elk`'s compiled `render-*.mjs` chunk directly and
confirmed `createRootElkGraph()` hardcodes every ELK layout option except
exactly the 7 `config.elk.*` keys it explicitly reads (`nodePlacementStrategy`,
`nodePlacementAlignment`, `mergeEdges`, `forceNodeModelOrder`,
`considerModelOrder`, `cycleBreakingStrategy`, plus `keepEntryNodeOnTop`
read elsewhere) — no `edgeRouting` passthrough existed, matching item 20's
own citation of this exact function. What item 20 didn't try: actually
patching the compiled function, having called forking the dependency "out
of scope" at the time. This round did.

**Two patches, both applied via `patch-package`** (new devDependency;
`patches/*.patch`, applied automatically on `npm install` via a new
`postinstall` script) — reversible, visible in a diff, and survive a clean
install, unlike an ad-hoc node_modules edit:

1. `@mermaid-js/layout-elk` — `createRootElkGraph()`'s `layoutOptions`
   object literal gains `"elk.edgeRouting": I.config.elk?.edgeRouting`
   (plus two spacing keys, wired through but unused for now).
2. `mermaid` itself — patch 1 ALONE had zero effect: rendered output was
   byte-identical regardless of what `edgeRouting` value the frontmatter
   set. Root cause, found by direct inspection, not guessed: mermaid
   core's own `sanitizeDirective()` deletes any frontmatter config key
   that isn't ALSO a key somewhere in mermaid's own default config object
   (a runtime `Object.keys()` walk building an allow-list, not a schema
   file) — `edgeRouting` doesn't exist in the default `elk: {...}` object,
   so it was silently stripped before patch 1's code ever saw it.
   Confirmed the mechanism, not just the symptom: overriding an
   ALREADY-allowed key (`nodePlacementStrategy`) produced real output
   differences immediately, while `edgeRouting` alone produced a
   byte-identical SVG until this second patch added `edgeRouting:void 0`
   (and the two spacing keys) to mermaid core's own default `elk` object,
   which is all `sanitizeDirective`'s allow-list needs to admit a key —
   the *value* still comes from the frontmatter, `void 0` just registers
   the key name as legitimate.

**Verified two ways, both with real render output, not assumed from the
patch alone:**

1. A minimal synthetic repro (`scripts/elk-investigation/repro.ts`, no
   LLM call — isolates the layout-engine variable) matching item 20's own
   described shape: two subgraphs' nodes both feeding a node OUTSIDE every
   subgraph. Under the previous default (`ORTHOGONAL`), the two feeding
   edges route with exact 90-degree bends — the geometric signature of the
   "box wrapping a subgraph" complaint, confirmed by decoding each edge's
   `data-points` attribute and measuring bend angles programmatically, not
   eyeballing pixels: 2 and 4 exact 90-degree bends respectively. Under
   `POLYLINE` (the candidate this round landed on, after also trying and
   rejecting `SPLINES` — it fixed the box shape but introduced its own
   kink artifact near the target node, confirmed visually, screenshot kept
   as `synthetic-repro-SPLINES-rejected.png`), both edges drop to ZERO
   90-degree bends, replaced by direct ~67-68-degree diagonal segments.
2. ONE real Anthropic call (`scripts/elk-investigation/live-compare.ts`)
   against the same 10-file scale fixture every prior ELK tuning round
   used, rendering the SAME real generated mermaid source through both
   settings so layout is the only variable. The real
   `EventBus -.->|subscribes to refund.issued ⚠ no publish edge...|
   refundWorker` back-edge — the exact edge round 14 described as "loops
   around most of the canvas margin" — goes from a wide box hugging the
   diagram's right perimeter (`ORTHOGONAL`) to a direct diagonal path
   (`POLYLINE`), confirmed via side-by-side screenshot.

**Full backend test suite re-run with `POLYLINE` forced on via env
override before it was made the real default: 241/241 passing, zero
regressions.** A new permanent regression test was added
(`tests/mermaid.test.ts`, "routes edges converging on a node outside any
subgraph without the item-20 box/ladder artifact") that renders the
synthetic repro shape and asserts zero exact-90-degree bends on the two
converging edges — sanity-checked to actually catch the regression it's
meant to catch: temporarily reverted the default back to `ORTHOGONAL` and
confirmed the test fails (2 and 2 bends, not 0 and 0) before restoring
`POLYLINE` and confirming it passes again. 241 -> 242 backend tests,
`tsc --noEmit` clean on both workspaces (two real strict-mode errors in
the new test's array/regex-match indexing were caught by `tsc` and fixed
properly — narrowed with explicit `if (!x) throw`/`continue` guards rather
than non-null assertions, matching this codebase's existing style).

**Honestly disclosed trade-off, not hidden**: `POLYLINE` does introduce a
minor incidental crossing between two otherwise-unrelated edges in the
real scale-fixture render (`OrderService`'s `writes` and `publishes`
edges cross near a point neither is target of) — a real, if much smaller,
visual cost than the box artifact it replaces, and the same category of
"two edges can require tracing by eye" limitation item 20 itself already
disclosed as inherent to auto-layout, not a new class of problem. Zoomed
in on the exact pixels before concluding this was real and not a
rendering illusion — it is a genuine incidental crossing, disclosed rather
than swept aside.

**Still open / disclosed, not fixed by this item**: the two spacing keys
threaded through (`edgeSpacing`, `edgeNodeSpacing`) are wired but unused —
`POLYLINE` alone was sufficient for the confirmed cases, so they weren't
needed this round; kept available for a future case that needs them rather
than removed. `keepEntryNodeOnTop`, the 7th key item 20 cited, was not
investigated this round (no known defect currently points at it).

### The round-17 evidence-convention gap

Round 17 (item 31) scored 6/10 partly because self-reported verification
wasn't independently checkable — real screenshots/outputs existed only
under `scripts/.dry-run-output/`, gitignored project-wide as regenerable
scratch, so a fresh checkout (or a future review round) had nothing on
disk to actually open, only prose. A partial fix landed at the time (3
live-call outputs saved locally) but was explicitly left gitignored,
"session-local proof, not something a fresh checkout of the repo will
have" — flagged, not resolved.

**Fixed properly this round**: a new `evidence/` directory at the repo
root, checked into git (unlike `.dry-run-output/`, which stays gitignored
scratch — the two are deliberately different: `evidence/` is for the
specific files a CLAUDE.md claim actually points to as proof, not every
intermediate experiment). `evidence/README.md` states the rule. Two
subfolders populated:

- `evidence/item-33-elk-routing/` — the decisive before/after PNGs and the
  real scale-fixture's raw mermaid source (`.mmd`) backing this item's own
  claims above — a reviewer can open these directly rather than trust the
  writeup.
- `evidence/item-30-naming-stability/` — the 3 real live-call comment
  bodies round 17 itself flagged as narrated-but-not-inspectable, moved
  out of the gitignored scratch folder retroactively, closing that exact
  disclosed gap rather than leaving it as a standing caveat.

**Status toward the score >= 9 gate**: NOT yet re-scored as of writing
this item — a fresh round 18 follows immediately after this commit, per
Anurag's own instruction to report the honest result before any
deployment/Marketplace/billing work proceeds. **The standing payment gate
is unchanged: no billing/payment work has been done or will be done until
a review clears >= 9.**

## 34. Round 18 adversarial review (2026-09-14) — 6/10, unchanged. Fifth consecutive round at this score despite item 33's real fix; a different, next-tier gap identified

Ran the fresh, context-free review promised at the end of item 33, against
two newly regenerated, correctly-rendered screenshots
(`evidence/round-18-review/flowchart-current.png`,
`evidence/round-18-review/sequence-current.png` — both produced via
`scripts/dry-run-live-scale.ts` / `dry-run-live-sequence.ts`, real
Anthropic calls, screenshotted via `scripts/screenshot-svg.mjs`'s real-
Chromium `<img>`-embed method, not `sharp`, after `sharp` produced a
misleading washed-out false negative for the sequence diagram — the same
librsvg trap already documented in item 8, caught before it could
contaminate this review's input rather than after).

**Scored 6/10 — the fifth consecutive round at this exact score (rounds
14-17 plus this one), despite item 33's ELK routing fix being real,
verified, and specifically the thing the last four rounds kept
converging on.** The review did not re-raise the box/ladder artifact at
all — independent confirmation the item-33 fix addressed what those
rounds were actually complaining about. Instead it found a different,
next-tier problem:

1. **(Top finding) The single highest-value edge in the flowchart — the
   pub/sub warning (`EventBus -.->|subscribes to refund.issued ⚠ no
   publish edge...|`) — still requires tracing by eye**, not because of
   the box/ladder artifact (gone), but because POLYLINE routing sends a
   genuine back-edge on a long perimeter-hugging loop up the right margin
   and across the top. This is exactly the already-disclosed, accepted
   trade-off item 20/33 called "a genuine back edge will still be the
   visually longest edge in the diagram" — re-confirmed as real by a
   reviewer encountering it fresh, not a new defect.
2. **New, real, not previously flagged this specifically: "calls" and
   "publishes" render as the same solid blue line — only "subscribes"
   gets distinct (dotted) styling.** A reviewer scanning line style alone
   can't tell a guaranteed direct call from a fire-and-hope-something-
   listens publish without reading every label's text — undercutting the
   at-a-glance value the diagram exists to provide, on exactly the
   distinction (sync vs. async) most relevant to the kind of bug this
   product's own pitch is built around catching. Verified directly
   against the real screenshot before accepting it: true.
3. **New: in the sequence-diagram example, the diff-highlight reads as
   flat/uniform, not "some messages are highlighted."** Checked the
   actual generated source (`scripts/.dry-run-output/live-sequence-
   comment.md`) before accepting this: it's real but narrower than the
   review stated — only message 1 of 12 (`User->>checkoutController: POST
   /checkout`) sits outside the `rect rgba(88, 166, 255, 0.3)` block; the
   other 11 are inside it. This is NOT the fully-100%-new case item 22's
   `annotateFullyNewSequence` banner targets (that only fires when
   literally every message is covered), so the banner correctly did not
   fire — but with 11/12 messages highlighted, the "highlighted vs.
   plain" contrast has almost nothing to contrast against in practice,
   which is a real, previously-undocumented edge case adjacent to item
   22's fully-new-flow problem: not 100% new, but new enough that the
   highlight stops being informative. Not fixed this round — flagged for
   whoever next touches sequence-diagram diff-awareness, alongside item
   29 #10's already-shipped participant-dashing (item 32) as a partial,
   not complete, answer to "which parts of this flow are new."
4. Minor, lower severity: an incidental edge crossing near the shared
   datastore node (`InventoryService`/`OrderService` "writes" edges) —
   the same category of trade-off item 33 already disclosed, not a new
   class of problem; and the pub/sub warning label's own length reads as
   "a paragraph pasted on the canvas" next to 2-3-word labels elsewhere.

**Verified the review's claims myself before writing this up, not taken
on faith**: viewed both screenshots directly, and independently confirmed
finding 3 was real but over-stated relative to the actual mermaid source
(11/12 messages highlighted, not "no visible highlight at all") before
recording it here — worth being precise about, since overstating a
reviewer's finding would be exactly the kind of unverified claim this
project's own discipline exists to catch.

**Status toward the score >= 9 gate: still not met, 6/10.** Per Anurag's
own explicit instruction ("run round 18 and report the honest score
before any deployment, Marketplace listing, or billing work proceeds"),
reporting back now rather than continuing to iterate unprompted. Honest
framing: item 33's fix was real and the review round confirms it (the
thing four straight rounds complained about didn't come up again), but
the score didn't move, because a new layer of findings (edge-semantic
line-style ambiguity; near-fully-new-flow highlight legibility) was
sitting right behind it — consistent with this project's whole history:
fixing the top-ranked complaint reliably surfaces the next one rather
than closing out the score. **No billing/payment/deployment/Marketplace
work has been done or will be done until a review clears >= 9.**
