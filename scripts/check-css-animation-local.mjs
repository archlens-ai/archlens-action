// Sanity check, LOCAL ONLY (not a substitute for the real GitHub round-trip
// that follows): loads the CSS-flow-animation SVG via a real <img> tag in a
// real headless Chromium page (the same harness screenshot-svg.mjs uses),
// takes two screenshots of the same region a couple seconds apart, and
// diffs them pixel-by-pixel. If genuinely nothing moved, the runner region
// would be byte-identical between the two shots -- confirms the CSS
// animation at least PLAYS in an <img>-embed context in a real browser,
// before spending a real PR round-trip to check whether GitHub's own
// pipeline behaves the same way.
import http from "node:http";
import { readFileSync } from "node:fs";
import puppeteer from "/home/claude/.npm-global/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const svg = readFileSync("scripts/.dry-run-output/css-flow-diagram.svg", "utf8");
const GITHUB_COMMENT_WIDTH = 768;

const server = http.createServer((req, res) => {
  if (req.url === "/diagram.svg") {
    res.writeHead(200, { "content-type": "image/svg+xml" });
    res.end(svg);
  } else {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><html><body style="margin:0;background:#ffffff">` +
        `<div id="frame" style="width:${GITHUB_COMMENT_WIDTH}px;padding:16px;box-sizing:border-box;background:#ffffff;display:inline-block">` +
        `<img id="img" src="/diagram.svg" style="max-width:100%;display:block">` +
        `</div></body></html>`
    );
  }
});

const port = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

const browser = await puppeteer.launch({
  executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH,
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: GITHUB_COMMENT_WIDTH + 32, height: 800 });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle0" });
await page.waitForFunction(() => {
  const img = document.getElementById("img");
  return img && img.complete && img.naturalWidth > 0;
});

const frame = await page.$("#frame");
const shot1 = await frame.screenshot({ encoding: "base64" });
await new Promise((r) => setTimeout(r, 2500));
const shot2 = await frame.screenshot({ encoding: "base64" });

await browser.close();
server.close();

console.log(`shot1 === shot2 (byte-identical): ${shot1 === shot2}`);
console.log(shot1 === shot2 ? "=> NO motion detected in a real <img> embed (local browser)." : "=> Motion detected -- the runner moved between the two screenshots.");
