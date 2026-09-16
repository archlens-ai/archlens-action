# GitHub Marketplace listing — ArchLens AI

Ready-to-submit copy and a checklist for publishing `archlens-ai/archlens-action`
to the GitHub Marketplace, once the repo is pushed and public (step 6 of the
release checklist — see `CLAUDE.md` item 38). This replaces the older draft
in `launch-plan.md`, which predates the Anthropic/Razorpay rewrite (items 21,
36-37) — that file's copy referenced gpt-4o-mini and Stripe, both stale.

## How GitHub Marketplace billing actually works for this listing

GitHub Marketplace only runs its own billing for **GitHub Apps**, not for
plain Actions. An Action listing is a **free, discovery-only** listing —
GitHub doesn't charge on our behalf and there's no "pricing plan" step in
the Marketplace publish flow itself. Our actual billing (Solo $12/mo, Team
$29/mo, via Razorpay) happens entirely on our own site (`archlens.dev`) and
inside the Action itself (the `archlens-api-key` input gates private-repo
usage against our own backend's quota check). This matches
`docs/ARCHITECTURE.md`'s "Deployment topology" section and is intentional,
not a limitation to work around.

## Submission checklist

1. Repo must be **public** (done — `archlens-ai/archlens-action`).
2. `action.yml` must have `name`, `description`, and `branding` (done —
   icon `share-2`, color `purple`).
3. Create a real semver **release/tag** (`v1.0.0` or `v1`) — GitHub only
   offers "Publish this Action to the Marketplace" on the repo's Releases
   page once at least one release exists. This has to happen after the
   push, and after `npm run build` has produced a committed `action/dist/
   index.js` (the Action runs the bundled dist file directly, not source —
   confirm `dist/` is committed, not gitignored, before tagging).
4. Pick 1-2 **categories** at publish time — best fit: **"Code quality"**
   as primary, **"Documentation"** as secondary (no "Architecture" or
   "Diagrams" category exists on GitHub Marketplace as of this writing).
5. Paste the listing description below into the publish form's description
   field (GitHub renders it as Markdown).
6. Upload 2-3 real screenshots at publish time — use actual rendered PR
   comments, not mockups. The real PR #1 comment
   (`github.com/KITHMEDAI/full-stack-fastapi-template/pull/1`, see
   CLAUDE.md item 23) and a fresh render of the 10-file scale example are
   the two strongest available: one shows a real, small, everyday PR; the
   other shows the product handling a genuinely complex multi-layer change,
   which is the actual pitch. Don't reuse a stale screenshot — regenerate
   both fresh right before submitting, per this project's own established
   discipline (CLAUDE.md items 15, 22 on stale-screenshot mistakes).

## Listing description (paste into the Marketplace publish form)

> ## Architecture diagrams, generated on every pull request
>
> Stop reconstructing a system's dependency graph in your head every time a
> PR touches ten files across schemas, endpoints, and workers. ArchLens
> reads the diff, asks an LLM to identify what actually changed
> structurally — new endpoints, schema changes, call flow, pub/sub wiring —
> and posts a clean, dark-themed Mermaid diagram straight into the PR
> comment. No setup beyond adding the workflow step; no diagram to
> maintain by hand.
>
> **What it draws:**
> - A flowchart for structural changes (new/modified/removed
>   endpoints, services, and datastores), color-coded by category, with
>   changed vs. pre-existing context visually distinguished
> - A sequence diagram for call-flow-shaped changes, with new message
>   exchanges highlighted against the existing flow
> - Publish/subscribe relationships drawn distinctly from direct calls, so
>   "definitely wired up" and "wired up if something else publishes this
>   event" don't look identical
>
> **Pricing** (billed on archlens.dev, not through GitHub Marketplace):
> - **Free** for public repositories
> - **$12/month** per private repository (solo / small team)
> - **$29/month** per GitHub organization (team, multiple private repos)
>
> No source code is stored beyond the diff needed to generate one diagram.
> Generated diagrams are cached by content hash, so re-running CI on an
> unchanged diff never re-bills or re-calls the model.
>
> [Get a key at archlens.dev →](https://archlens.dev)

## Short tagline (for the Marketplace card, ~125 char limit)

> AI-generated architecture diagrams, posted straight to your PR comments — free for public repos.

## Not yet done, sequenced after this

Actually publishing requires the repo pushed (waiting on the PAT — see
CLAUDE.md item 38) and a tagged release with a committed `dist/`. Both are
mechanical once the push lands; nothing here is blocked on Anurag beyond
that.
