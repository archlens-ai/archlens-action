// Live-render harness for eyeballing the legend footer itself, in the same
// spirit as scripts/dry-run-live-scale.ts: unit tests confirm swatch counts
// and label strings, but only an actual rendered SVG (screenshotted via
// scripts/screenshot-svg.mjs) can catch a real visual regression -- e.g. the
// round-13 CSS-cascade bug that no string assertion would have caught.
// Written for the round-14 legend simplification (9 -> 6 swatches); kept
// around since any future legend change should re-run this same check.
//
// Usage:
//   ARCHLENS_TEST_CHROMIUM_PATH=<path to chrome> npx tsx scripts/legend-check.ts
//   node ../scripts/screenshot-svg.mjs scripts/.dry-run-output/legend-check.svg scripts/.dry-run-output/legend-check.png
import { renderMermaidToSvg } from "../lib/mermaid";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const { svg } = await renderMermaidToSvg(
    'flowchart TD\n' +
      '  A["LoginController"] --> B["AuthService"]\n' +
      '  B --> C[("UsersTable")]\n' +
      '  B --> D["EmailProvider"]\n' +
      '  class A endpoint\n' +
      '  class B logic\n' +
      '  class C datastoreContext\n' +
      '  class D externalContext\n',
    { executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH }
  );
  const outDir = path.join(process.cwd(), "scripts", ".dry-run-output");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "legend-check.svg"), svg);
  console.log("wrote svg, length", svg.length);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
