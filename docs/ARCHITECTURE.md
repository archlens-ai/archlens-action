# ArchLens AI — Architecture

## What it does

On every pull request that touches a structurally significant file (routes,
controllers, SQL/Prisma/GraphQL schema, migrations), ArchLens posts a single
PR comment containing an AI-generated Mermaid diagram of that diff's system
impact, and keeps updating the same comment as the PR changes.

## System diagram

```mermaid
flowchart TD
  Dev["Developer opens/updates a PR"] --> Action["ArchLens GitHub Action\n(runs in the customer's CI)"]
  Action -- "1. list changed files, compress diff" --> Action
  Action -- "2. POST /v1/generate (Bearer API key)" --> API["ArchLens API\n(Vercel serverless)"]
  API -- "3. check API key + quota" --> DB[("Supabase\napi_keys / usage_logs")]
  API -- "4. content-hash cache lookup" --> Cache[("Supabase\ndiagram_cache")]
  Cache -- "cache miss" --> LLM["LLM provider\n(OpenAI gpt-4o-mini, default)"]
  LLM -- "raw Mermaid syntax" --> Validate["Syntax + safety validation"]
  Validate -- "valid" --> Render["Render worker\n(mmdc / headless Chromium)"]
  Render -- "SVG bytes" --> Storage[("Supabase Storage\npublic bucket")]
  Storage -- "public SVG URL" --> API
  API -- "svgUrl + mermaidSource" --> Action
  Action -- "5. upsert PR comment" --> PR["PR comment\n(image + collapsible source)"]
```

## Why this differs from the original brief

The original brief had the Action itself calling an LLM and rendering with
`mermaid-cli` inside the customer's own CI runner. Both of those were
reconsidered:

- **Rendering never happens in the customer's CI.** `mermaid-cli` bundles a
  full headless Chromium via Puppeteer — installing and launching that on
  every single PR run adds real minutes to a customer's CI and is a common
  source of flakiness across differently-configured Ubuntu runner images.
  Rendering happens once, server-side, on infrastructure ArchLens controls,
  and the Action receives back a plain URL to embed. The customer-side
  Action has zero Puppeteer/Chromium dependency at all — confirmed by the
  620KB single-file bundle in `action/dist/index.js`, whose only runtime
  dependencies are `@actions/core`, `@actions/github`, and `minimatch`.
- **The content-hash cache is checked before quota or the LLM call**, not
  after. A PR that gets a trivial follow-up commit (typo fix, rebase, CI
  retry) that doesn't change the content of any matched file produces the
  same hash — so it's served from cache, burns zero quota, and costs zero
  LLM tokens. This is the single biggest lever on unit economics for a
  product whose primary cost driver is inference calls.
- **OpenAI is the default provider, not DeepSeek.** DeepSeek is supported
  (its API is wire-compatible with OpenAI's) but is opt-in only via
  `ARCHLENS_LLM_PROVIDER=deepseek`. Sending a paying customer's private-repo
  diff to a Chinese-domiciled model provider by default is a data-residency
  and trust risk most SMB/enterprise buyers in ArchLens's target market
  (Western/global engineering teams) will not accept without being asked.
- **The Action treats a generation failure as a soft failure by default**
  (posts an explanatory comment, doesn't fail the CI run) unless
  `fail-on-error: true` is set. A red X on a PR because a diagramming tool's
  backend had a bad moment is exactly the kind of friction that gets a tool
  like this uninstalled within a week.

## Security model

PR content is attacker-influenced by definition — anyone can open a PR. That
diff flows through an LLM and the result is rendered and hosted as SVG
embedded in other people's PR pages. `backend/lib/mermaid.ts` treats the
model's output as untrusted input, not as this app's own template:

- Only two diagram declarations are accepted (`flowchart TD/LR/BT/RL`,
  `sequenceDiagram`) — anything else is rejected outright.
- Mermaid `click` bindings (which can invoke arbitrary JS), `<script>`,
  `javascript:`, inline event handlers, and `<foreignObject>` are all
  rejected before rendering is ever attempted.
- Output is capped at 20,000 characters to bound rendering cost and rule out
  abuse via a maximally verbose diagram.
- If the model's first attempt fails validation, one repair attempt is made
  with the exact validation error fed back in; if that also fails, the
  request returns `502 upstream_generation_failed` rather than rendering
  anything.

## Billing model (and why it isn't GitHub Marketplace's built-in billing)

GitHub Marketplace's native metered/subscription billing is wired up for
**GitHub Apps**, not for a plain Action. ArchLens is listed on Marketplace
for discovery only. Actual billing is Stripe Checkout
(`api/checkout.ts`) issuing an `alk_live_...` API key on
`checkout.session.completed` (`api/webhook/stripe.ts`), which the customer
pastes into their workflow as the `archlens-api-key` input (a repo/org
secret). Quota enforcement (`backend/lib/quota.ts`) and content-hash caching
(`backend/lib/cache.ts`) both run against Supabase, gating every request the
Action makes to `/v1/generate`.

## Deployment topology (recommended, not required to run tests)

- **`api/generate.ts`, `api/checkout.ts`, `api/webhook/stripe.ts`**: Vercel
  serverless functions — lightweight, no Chromium dependency.
- **Render step**: Puppeteer/Chromium is a poor fit for Vercel's ephemeral
  serverless functions (cold starts, the ~50MB compressed function size
  limit). Two supported options, both already isolated behind
  `renderMermaidToSvg`'s `executablePath` option:
  1. A small always-on container (Fly.io/Railway/Render.com) running `mmdc`
     directly — simplest, recommended for launch.
  2. `@sparticuz/chromium-min` + `puppeteer-core` inside a Vercel function,
     if consolidating onto one platform matters more than avoiding
     cold-start latency.
- **Supabase**: Postgres (`db/schema.sql`) for `orgs`/`api_keys`/
  `usage_logs`/`diagram_cache`, plus Storage for the rendered SVG bytes.

## Verified, not assumed

`npm test` (53 tests across both workspaces) and `npm run dry-run` are both
green as of this writing. The dry run
(`scripts/dry-run.ts`) is the important one: it runs the Action's real diff
compression and HTTP client against the real backend handler over a real
HTTP connection, with a real `mmdc` render (headless Chromium), and asserts
on the actual rendered SVG bytes and the actual final PR comment markdown —
not two halves of mocked unit tests that never touch each other.
