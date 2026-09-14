// Standalone, deterministic repro of the item-20 "box/ladder" ELK
// edge-routing artifact: several edges converging across subgraph
// boundaries onto a single node that sits OUTSIDE every subgraph.
// No LLM call needed -- this isolates the layout-engine variable from
// LLM output variance, matching CLAUDE.md item 20's own root-cause
// description verbatim: "multiple edges bending through shared
// horizontal channels at the same y-coordinates... several edges
// converge across subgraph boundaries onto nodes outside any subgraph."
//
// A standing tool, same pattern as backend/scripts/rect-edge-cases.ts and
// legend-check.ts -- kept so a future ELK/mermaid upgrade that changes
// this behavior gets caught by re-running it, not just by luck. The
// backend/tests/mermaid.test.ts test ("routes edges converging on a node
// outside any subgraph...") is the automated version of the same check;
// this script is for visual/manual inspection (render, then convert to
// PNG, e.g. `node -e "require('sharp')('baseline.svg').png().toFile(...)"`).
// The curated before/after evidence from the investigation that led to
// the item-33 fix lives in evidence/item-33-elk-routing/, checked into
// git; this script's own output is gitignored scratch, not tracked.
import { renderMermaidToSvg } from "../../backend/lib/mermaid.js";
import { writeFileSync } from "node:fs";

const SOURCE = `flowchart TD
  subgraph API["API Layer"]
    Route1["POST /orders"]
    Route2["POST /refunds"]
  end
  subgraph Logic["Business Logic"]
    OrderSvc["OrderService"]
    RefundSvc["RefundService"]
  end
  subgraph Data["Data Layer"]
    DB[("orders table")]
  end
  Worker["RefundWorker"]
  Route1 --> OrderSvc
  Route2 --> RefundSvc
  OrderSvc --> DB
  RefundSvc --> DB
  OrderSvc -->|"publishes order.created"| Worker
  RefundSvc -->|"publishes refund.issued"| Worker
  DB -->|"reads via"| Worker
  class Route1,Route2 endpoint
  class OrderSvc,RefundSvc logic
  class DB datastore
  class Worker externalContext
`;

const label = process.argv[2] || "baseline";
const result = await renderMermaidToSvg(SOURCE, {
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
});
writeFileSync(new URL(`./${label}.svg`, import.meta.url), result.svg);
console.log(`wrote ${label}.svg (${result.svg.length} bytes)`);
