# Evidence convention (added item 33, 2026-09-14, fixing round 17's finding)

Round 17's adversarial review (see CLAUDE.md item 31) scored 6/10 partly
because self-reported verification wasn't independently checkable: real
screenshots and outputs existed only under `scripts/.dry-run-output/`,
which is `.gitignore`d project-wide as regenerable scratch — a fresh
checkout of the repo, or a future review round, had nothing on disk to
actually inspect, only prose claiming a fix was verified.

`scripts/.dry-run-output/` stays gitignored — it's genuinely ad-hoc,
regenerated constantly, and not meant to be a tracked history.

This `evidence/` directory is different and IS checked into git. Rule:
**whenever a CLAUDE.md item claims something was "verified against a real
render/call" with a specific measurable before/after, the actual file(s)
that back that claim go here, in a subfolder named after the item** (e.g.
`evidence/item-33-elk-routing/`), not just described in prose. A reviewer
— human or a fresh adversarial-review subagent — can open these files
directly rather than trust the writeup.

What belongs here: the decisive before/after screenshots or SVGs for a
claimed visual fix; raw output (mermaid source, comment bodies) from a
real live API call cited as evidence; anything a skeptical reviewer would
otherwise have to take on faith. What does NOT belong here: every
intermediate experiment run while investigating (those can stay in
`.dry-run-output/` or be discarded) — only the specific artifacts a
CLAUDE.md writeup actually points to as proof.

Existing folders:
- `item-30-naming-stability/` — the 3 real live-call comment bodies item
  31 (round 17) flagged as narrated-but-not-inspectable; moved here
  retroactively from the gitignored scratch folder rather than left as
  the exact gap round 17 described.
- `item-33-elk-routing/` — before/after screenshots (synthetic repro and
  a real 10-file scale fixture) proving the ELK box/ladder-artifact fix;
  see CLAUDE.md item 33 and `backend/lib/mermaid.ts`'s
  `buildElkFrontmatter` comment for the full writeup these files back.
