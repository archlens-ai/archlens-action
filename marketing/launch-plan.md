# ArchLens AI — launch plan

**Status: distribution is explicitly unsolved.** Anurag chose to proceed on
the product despite having no owned channel for this specific launch — this
document is written honestly on that basis, not pretending Show HN/Reddit
posts are a real growth plan. Treat everything under "Day-one posts" as
low-probability-of-success filler to have ready, not the actual strategy.
If a real channel (a community he's already active in, a newsletter, a
direct list of maintainers) shows up later, that's the plan worth running —
see "What would actually work" at the bottom.

## Positioning

Competitive landscape checked directly (not assumed) before writing this:

- **Swark** (github.com/swark-io/swark) — closest existing tool. VS Code
  extension, free/open-source (AGPL), runs locally via GitHub Copilot, no PR
  integration. ArchLens's whole value proposition is the opposite of this:
  zero developer action, lives in the review, not the editor.
- **ArchToCode** (archtocode.com) — whole-repo-to-Mermaid conversion on a
  credit-based free tier. Snapshot tool, not diff-triggered, no confirmed PR
  posting.
- **CodeSee** — did roughly this category (codebase maps + PR context),
  acquired by GitKraken, effectively discontinued as a standalone product.
  Read as a caution about the category's standalone viability, not proof it
  doesn't work — CodeSee's diagrams were manually maintained maps, not
  automatically regenerated per-diff, and it front-loaded a heavy
  onboarding/mapping step ArchLens doesn't have.

One-line positioning: **"The only tool that draws what this specific PR
changed, automatically, in the review itself — not a wiki page that goes
stale in a week."**

## Unit economics (rough, verify before setting live pricing)

- gpt-4o-mini input is cheap per call, but a real PR diff after compression
  could still run several hundred to a few thousand tokens for a
  multi-file, high-churn PR. The `max-diff-bytes` cap (default 60KB
  pre-compression) and the content-hash cache (skips re-generation on
  unchanged diffs) are the two levers keeping this bounded — see
  `docs/ARCHITECTURE.md`.
- Before setting live pricing confidently: run 20-30 real PRs from a few
  different repos through the pipeline with a real `OPENAI_API_KEY`, log
  actual token counts and cost per call, and compare against the assumed
  "$12/mo private repo" margin. Don't trust the brief's "$5,700 total launch
  cost / 3 paid teams for profitability" numbers until this is measured —
  they were never modeled against real diff sizes.

## GitHub Marketplace listing copy (draft)

> **ArchLens AI — Architecture diagrams, generated on every PR**
>
> Stop reconstructing the system dependency graph in your head every time a
> PR touches 10 files across schemas, endpoints, and workers. ArchLens reads
> the diff, generates a Mermaid diagram of what actually changed and how it
> connects, and posts it as a PR comment — automatically, on every push.
>
> - Free for public repos
> - $12/mo per private repo (solo/small team)
> - $29/mo per GitHub org (teams)
> - No code stored beyond the diff needed to generate one diagram; SVGs
>   cached by content hash, never re-billed for an unchanged diff
>
> [Get started →](https://archlens.dev)

## Day-one posts (low-confidence, have-ready-but-don't-rely-on-these)

**Show HN**

> Show HN: ArchLens – auto-generates an architecture diagram on every PR
>
> I got tired of opening a 10-file PR and spending 15 minutes redrawing the
> system dependency graph in my head before I could actually review it. This
> GitHub Action reads the diff, asks an LLM for a Mermaid diagram of what
> changed structurally (new endpoints, schema changes, call flow), renders
> it, and posts it as a PR comment. Free for public repos.
>
> [30-second demo GIF/video link]

**r/ExperiencedDevs / r/DevOps** — post the demo GIF with a short
non-promotional writeup framed around the actual pain (large PR review
cognitive load), link in a comment rather than the post body if the
subreddit's rules require that, and be upfront it's a paid tool for private
repos.

## What would actually work (the honest alternative)

Cold Show HN/Reddit posts for a brand-new account/tool have a low hit rate
without an existing audience — this is exactly the organic-discovery
pattern Anurag flagged as his own recurring failure mode. A materially
better plan, when he's ready to invest in it instead of hoping this works:

1. **Direct outreach to maintainers of specific mid-size, active open-source
   repos** (not "seed 10 random repos" — a short list, hand-picked for high
   PR volume and multi-file PRs where the pain is real), offering to install
   it as a PR to their repo. A merged PR with the diagram already showing is
   both a real install and a live showcase — much higher intent than a cold
   post.
2. Anurag already runs Kith (kith.space) and does SEO/content work there —
   if there's any developer-adjacent audience overlap (even a personal
   Twitter/LinkedIn/Indie Hackers presence used for PayoutPilot's launch),
   cross-posting ArchLens there is a real channel, not a hope. Worth
   checking before the Show HN post, not after it flops.
3. A working demo (a public repo with ArchLens actually installed, showing
   real diagrams on real merged PRs) is worth more than any copy on a
   landing page — build that first, then the launch posts get to link to
   evidence instead of a promise.
