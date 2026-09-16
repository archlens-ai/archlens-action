# ArchLens AI

Turns a pull request's structural diff into an AI-generated architecture
diagram, posted as a PR comment. Free for public repos; paid for private
repos and orgs. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how
it's built and why.

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
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | yes | Billing — runs through Kith's existing, internationally-activated Razorpay account, not a separate ArchLens merchant account |
| `RAZORPAY_PLAN_SOLO`, `RAZORPAY_PLAN_TEAM` | yes | Maps Razorpay Plan IDs to internal plans |
| `PUPPETEER_EXECUTABLE_PATH` | recommended | Points the render step at its Chromium binary |

## Status

Core product logic (diff compression, generation pipeline, quota/caching,
billing provisioning, PR commenting) is built and tested — 264 passing
tests plus a real end-to-end dry run. A live Supabase project and Anthropic
API key are already provisioned. **Not yet done:** the public GitHub org
this repo will live in, a deployed Vercel project, live Razorpay Plans, and
a GitHub Marketplace listing — see `docs/ARCHITECTURE.md`, `CLAUDE.md`
(item 36), and `marketing/` for what's scoped versus what's live.
