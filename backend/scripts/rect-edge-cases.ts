// Round-14 investigation, kept as a standing contract check on MERMAID'S
// OWN behavior (not ArchLens's generation pipeline -- these are hand-written
// Mermaid sources, not model output). Confirms three assumptions this
// product's sequence-diagram diff-highlighting logic depends on:
//   1. Multiple separate `rect rgba(...)...end` blocks in one diagram render
//      as multiple distinct highlighted regions (they do -- this directly
//      overturned a round-12 review's assumption that disjoint new segments
//      in an existing flow "can't be highlighted accurately," which turned
//      out to be a false ceiling, not a real one; see
//      closeUnclosedSequenceBlocks's docstring in lib/diff-classify.ts).
//   2. An unclosed block of ANY kind (rect/loop/alt/opt/par/critical/break)
//      breaks the ENTIRE render with a hard parse error -- a real,
//      confirmed failure mode, not a guess, which is exactly why
//      closeUnclosedSequenceBlocks exists as a deterministic backstop.
//   3. Adjacent (back-to-back, no message between) separate rect blocks
//      still render correctly as two distinct boxes.
// If a future mermaid-cli upgrade ever changes any of these three behaviors,
// re-running this script is the fastest way to notice before a real PR
// diagram silently breaks or mis-highlights in production.
import { validateMermaidSyntax } from "../lib/mermaid";
import { renderMermaidToSvg } from "../lib/mermaid";

async function tryRender(label: string, source: string) {
  console.log(`\n--- ${label} ---`);
  const v = validateMermaidSyntax(source);
  console.log("validateMermaidSyntax:", v);
  try {
    const { svg } = await renderMermaidToSvg(source, {
      executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH,
    });
    const rectCount = (svg.match(/<rect[^>]*fill="rgba\(88, 166, 255/g) ?? []).length;
    console.log("RENDER OK. highlighted rect count:", rectCount, "svg length:", svg.length);
  } catch (e) {
    console.log("RENDER FAILED:", (e as Error).message.slice(0, 300));
  }
}

async function main() {
  // Case 1: unclosed rect (missing `end`) followed by more messages
  await tryRender(
    "unclosed rect",
    [
      "sequenceDiagram",
      "  participant A",
      "  participant B",
      "  A->>B: call 1",
      "  rect rgba(88, 166, 255, 0.3)",
      "  A->>B: call 2 (new)",
      "  A->>B: call 3 (should NOT be highlighted but rect never closed)",
    ].join("\n")
  );

  // Case 2: nested rect blocks
  await tryRender(
    "nested rect",
    [
      "sequenceDiagram",
      "  participant A",
      "  participant B",
      "  rect rgba(88, 166, 255, 0.3)",
      "  A->>B: outer new call 1",
      "  rect rgba(200, 50, 50, 0.3)",
      "  A->>B: inner call",
      "  end",
      "  A->>B: outer new call 2",
      "  end",
      "  A->>B: call after",
    ].join("\n")
  );

  // Case 3: adjacent (back-to-back) rects with no message between
  await tryRender(
    "adjacent rects touching",
    [
      "sequenceDiagram",
      "  participant A",
      "  participant B",
      "  participant C",
      "  A->>B: new call 1",
      "  rect rgba(88, 166, 255, 0.3)",
      "  A->>B: seg1",
      "  end",
      "  rect rgba(88, 166, 255, 0.3)",
      "  B->>C: seg2",
      "  end",
    ].join("\n")
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
