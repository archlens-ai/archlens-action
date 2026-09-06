/**
 * Re-renders the exact Mermaid source already used for the real PR #1 test
 * (CLAUDE.md item 23), but with the new CSS offset-path/offset-distance
 * flow-runner (injectFlowRunnersCss, backend/lib/mermaid.ts) instead of the
 * SMIL <animateMotion> one that item 23 found does not play inside a real
 * GitHub <img> embed. This does NOT call the LLM again -- same diagram,
 * same layout, only the animation mechanism changes -- so the real-PR
 * round-trip that follows is a clean A/B on the animation question alone.
 */
import { readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { renderMermaidToSvg } from "../backend/lib/mermaid.js";

// The exact mermaid source block from
// scripts/.dry-run-output/real-pr-notifications-comment.md (the real PR #1
// comment), copied verbatim.
const MERMAID_SOURCE = `flowchart TD
    subgraph API["API Layer"]
        ItemsRoute["items.py<br/>create_item()"]
        NotificationsRoute["notifications.py<br/>read/mark/delete"]
    end

        NotificationService["notifications.py<br/>notify_item_created()<br/>create_notification()<br/>unread_count()"]

    subgraph Data["Data Layer"]
        NotificationTable["notification<br/>(table)"]
        UserTable["user<br/>(table)"]
    end

        MainRouter["main.py<br/>api_router"]

    ItemsRoute -->|calls| NotificationService
    NotificationService -->|writes| NotificationTable
    NotificationsRoute -->|reads/updates| NotificationTable
    NotificationTable -->|FK constraint| UserTable
    MainRouter -->|includes| ItemsRoute
    MainRouter -->|includes| NotificationsRoute

    class ItemsRoute,NotificationsRoute endpoint
    class NotificationService logic
    class NotificationTable datastore
    class MainRouter logic
class UserTable datastoreContext
`;

async function main() {
  console.log("=== Rendering PR #1's real diagram with the CSS flow-animation candidate fix ===\n");
  const { svg } = await renderMermaidToSvg(MERMAID_SOURCE, {
    executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH,
    flowAnimation: "css",
  });
  console.log(`✓ rendered (${svg.length} bytes)`);
  console.log(`  contains offset-path runner: ${svg.includes("offset-path:path(")}`);
  console.log(`  contains @keyframes archlens-flow: ${svg.includes("@keyframes archlens-flow")}`);
  console.log(`  contains NO <animateMotion>: ${!svg.includes("<animateMotion")}`);

  await mkdir("scripts/.dry-run-output", { recursive: true });
  await writeFile("scripts/.dry-run-output/css-flow-diagram.svg", svg, "utf8");
  console.log("\n✓ wrote scripts/.dry-run-output/css-flow-diagram.svg");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
