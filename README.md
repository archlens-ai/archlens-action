# ArchLens AI

Turns a pull request's structural diff into an AI-generated architecture
diagram, posted as a PR comment. Free for public repos (live today); a
paid tier is planned for private repos and orgs but **billing isn't live
yet** — see Status below. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
for how it's built and why.

## Quick start

```yaml
# .github/workflows/archlens.yml
name: ArchLens AI
on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  diagram:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: archlens-ai/archlens-action/action@v1
        with:
          archlens-api-key: ${{ secrets.ARCHLENS_API_KEY }} # not required on public repos
```

`action.yml` lives at `action/action.yml`, not the repo root (this is a
monorepo — `action/` sits alongside `backend/`, `db/`, `docs/`), so the
`uses:` reference needs the `/action` path segment. Omitting it is a
launch-blocking bug: GitHub resolves a bare `owner/repo@ref` reference
against `action.yml` at the exact repository root and errors immediately
if it's missing. It also means this repo can never appear in GitHub
Marketplace as-is — Marketplace publishing requires `action.yml` at the
root with no subpath support. Restructuring so the Action ships from its
own root-level repo (splitting `backend/`/`db/`/`docs/`/`marketing/` out)
would fix both; not done here — see `marketing/marketplace-listing.md`.

Get a key at `https://archlens.dev/dashboard` (private repos / orgs) or omit
it entirely on a public repo to use the shared, rate-limited free-tier key.

## Repo layout

| Path | What |
|---|---|
| `action/` | The GitHub Action — diff extraction, HTTP client, PR comment poster. Ships as a single bundled `dist/index.js` (no runtime `node_modules` needed). |
| `backend/` | Vercel serverless functions — generation endpoint, quota/cache, Razorpay billing. |
| `db/schema.sql` | Supabase schema: orgs, api_keys, usage_logs, diagram_cache. |
| `scripts/dry-run.ts` | End-to-end smoke test wiring the real Action logic to the real backend logic over real HTTP, with a real `mmdc` render. |
| `docs/ARCHITECTURE.md` | Full design doc and the reasoning behind every non-obvious decision. |
| `marketing/` | Landing page copy, Marketplace listing copy, launch post drafts. |

## Development

```bash
npm install

npm run lint    # tsc --noEmit, both workspaces
npm test        # vitest, both workspaces (264 tests)
npm run build   # bundles action/dist/index.js via @vercel/ncc
npm run dry-run # full pipeline smoke test — needs a local Chromium; see below
```

`npm run dry-run` and the backend's Mermaid render test both shell out to
`mmdc`, which needs a real Chromium binary. If your environment's default
Chromium isn't in Puppeteer's expected cache path, point it at one
explicitly:

```bash
ARCHLENS_TEST_CHROMIUM_PATH=/path/to/chrome npx tsx scripts/dry-run.ts
```

In CI (see `.github/workflows/ci.yml`), Puppeteer's own Chromium is
installed via `npx puppeteer browsers install chrome` before tests run, so
no override is needed there.

## Environment variables (backend)

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | yes | Quota, cache, and SVG storage — its own Supabase **project**, created inside the same org as any other product on the account, never a shared/reused project |
| `ANTHROPIC_API_KEY` | yes (default provider) | Diagram generation — issued under its own Anthropic Console project so spend/usage stays attributable to ArchLens even when the account is shared with another product |
| `ARCHLENS_ANTHROPIC_MODEL_SMALL` | no | Model for ordinary diffs. Defaults to `claude-haiku-4-5` |
| `ARCHLENS_ANTHROPIC_MODEL_LARGE` | no | Model for large/complex diffs (>6 files). Defaults to `claude-sonnet-5` |
| `ARCHLENS_ANTHROPIC_MODEL` | no | Overrides both of the above and forces every request onto one fixed model, disabling tiering entirely |
| `ARCHLENS_LLM_PROVIDER` | no | `anthropic` (default), or `openai`/`deepseek` opt-in |
| `OPENAI_API_KEY` | only if provider=openai | Diagram generation |
| `DEEPSEEK_API_KEY` | only if provider=deepseek | Diagram generation |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | yes (once billing is live) | Billing — intended to run through Kith's existing Razorpay account, not a separate ArchLens merchant account. **Not live yet**: Kith's international-card-payments activation was rejected 2026-09-20 (re-submission not allowed until Dec 16, 2026), so no USD Plan can be created through this account today. See CLAUDE.md item 39. |
| `RAZORPAY_PLAN_SOLO`, `RAZORPAY_PLAN_TEAM` | yes | Maps Razorpay Plan IDs to internal plans |
| `PUPPETEER_EXECUTABLE_PATH` | recommended | Points the render step at its Chromium binary |

## Status

**Live now (2026-09-20): the free tier, for public repos.** The GitHub org
and this repo are public, the Action builds and its CI is green. Point a
public repo's workflow at `archlens-ai/archlens-action/action@v1` (see
Quick start above) and omit `archlens-api-key` to use the shared,
rate-limited free-tier key — no payment involved. This requires the
backend to actually be deployed and connected to a live Supabase project
(the pieces below); check with the maintainer if a public-repo PR isn't
getting a comment.

**Not live yet: paid private-repo/org billing.** The billing code
(`backend/lib/billing.ts` + Razorpay Subscriptions integration) is written
and tested, but there are no live Razorpay Plans to subscribe to —
international card payments on the account this was meant to bill through
were rejected by Razorpay's own review on 2026-09-20, and can't be
resubmitted until December 16, 2026. See `CLAUDE.md` item 39 for the full
story and the options being weighed (PayPal, a separate Stripe account, or
waiting out the Razorpay retry window). Nobody can pay for a private-repo
key yet; don't imply otherwise in any marketing copy pointed at real users
before this is resolved.

Core product logic (diff compression, generation pipeline, quota/caching,
billing provisioning, PR commenting) is built and tested — 264 passing
tests plus a real end-to-end dry run. A live Supabase project and Anthropic
API key are already provisioned. A GitHub Marketplace listing is also not
live yet — blocked by a structural issue, see the Quick start note above
and `marketing/marketplace-listing.md`. See `docs/ARCHITECTURE.md`,
`CLAUDE.md` (items 36-39), and `marketing/` for the full status.
