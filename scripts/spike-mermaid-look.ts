/**
 * Spike test, not a production change: mermaid 11.14.0 (already the
 * version this project runs) exposes a `look` config key
 * (classic/handDrawn/neo, confirmed by reading
 * node_modules/mermaid/dist/config.type.d.ts directly, not assumed from
 * docs) independent of theme colors -- this changes the actual node/edge
 * SHAPE rendering, not just the palette. Testing whether it's compatible
 * with our ELK layout + custom ArchLens styling before considering it for
 * production, using the EXACT real mermaid source from the last live
 * 10-file scale test (scripts/.dry-run-output/live-scale-comment.md) so
 * this is a fair comparison against the already-shipped baseline, not a
 * synthetic example.
 *
 * Usage: tsx scripts/spike-mermaid-look.ts
 */
import { writeFile, mkdir } from "node:fs/promises";
import { renderMermaidToSvg } from "../backend/lib/mermaid.js";

const REAL_SOURCE = `flowchart TD
subgraph API["API Layer"]
  Routes["orders.ts + refunds.ts routes"]
  Controllers["ordersController + refundsController"]
end
class Routes,Controllers endpoint

subgraph Logic["Business Logic"]
  OrderSvc["orderService.ts"]
  InventorySvc["inventoryService.ts"]
  RefundSvc["refundService.ts"]
  RefundWorker["refundWorker.ts"]
end
class OrderSvc,InventorySvc,RefundSvc,RefundWorker logic

subgraph Data["Database"]
  Tables["orders + refunds tables"]
end
class Tables datastore

EventBus["EventBus"]
PaymentGateway["PaymentGateway"]
NotificationService["NotificationService"]
class EventBus,PaymentGateway,NotificationService externalContext

Routes --> Controllers
Controllers -->|createOrder| OrderSvc
Controllers -->|reserveStock| InventorySvc
Controllers -->|issueRefund| RefundSvc
OrderSvc -->|insert order| Tables
OrderSvc -->|publish order.created| EventBus
RefundSvc -->|insert refund| Tables
RefundSvc -->|refund charge| PaymentGateway
RefundWorker -->|subscribe refund.issued| EventBus
RefundWorker -->|sendRefundConfirmation| NotificationService
`;

async function main() {
  await mkdir("scripts/.dry-run-output", { recursive: true });

  for (const look of ["classic", "neo", "handDrawn"] as const) {
    console.log(`\n=== look: ${look} ===`);
    try {
      const { svg } = await renderMermaidToSvg(REAL_SOURCE, {
        executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH,
        look,
      });
      await writeFile(`scripts/.dry-run-output/spike-look-${look}.svg`, svg, "utf8");
      console.log(`✓ rendered ${svg.length} bytes -> scripts/.dry-run-output/spike-look-${look}.svg`);
    } catch (err) {
      console.log(`✗ FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
