// One-off helper: screenshots a rendered SVG exactly the way GitHub embeds
// it in a PR comment (an <img src="http://..."> tag, real HTTP, real
// headless Chromium, waited for full image decode) — NOT via sharp/librsvg
// rasterization and NOT via a file:// load, both of which were established
// this project as unreliable stand-ins for GitHub's actual rendering.
import http from "node:http";
import { readFileSync } from "node:fs";
import puppeteer from "/home/claude/.npm-global/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const [, , svgPath, outPngPath] = process.argv;
if (!svgPath || !outPngPath) {
  console.error("usage: node screenshot-svg.mjs <svg-path> <out-png-path>");
  process.exit(1);
}
const svg = readFileSync(svgPath, "utf8");

// GitHub's actual PR-comment body renders inside a definite-width column
// (~768px content width in the classic single-column layout, up to
// ~1236px in the wide layout), with markdown CSS applying
// `img { max-width: 100%; }` to embedded images. A bare, unconstrained
// <body><img> (what an earlier version of this script did) gives the
// SVG's own `width="100%"` no basis to resolve against, so Chromium falls
// back to the CSS2.1 default replaced-element size (300x150) instead of
// anything resembling a real GitHub comment — that's a test-harness bug,
// not a finding about GitHub. This version reproduces the real container
// width so the screenshot actually shows what a reviewer would see.
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
const box = await page.evaluate(() => {
  const img = document.getElementById("img");
  const rect = img.getBoundingClientRect();
  return {
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    renderedWidth: rect.width,
    renderedHeight: rect.height,
  };
});

// Bug fixed here (2026-08-31): the previous version took a fixed-viewport
// `fullPage: true` screenshot, which captures max(viewport height, content
// height) — for any diagram shorter than the viewport, that pads the image
// with a huge block of blank page below the actual content (exactly the
// "big dull page, mostly empty white" the user flagged). GitHub itself
// never does this — it just displays the image at its own natural size.
// Screenshotting the specific container element instead crops exactly to
// its real rendered bounding box, no matter how tall or short it is.
const frame = await page.$("#frame");
await frame.screenshot({ path: outPngPath });

await browser.close();
server.close();
console.log(
  `✓ wrote ${outPngPath} — source SVG natural size ${box.naturalWidth}x${box.naturalHeight}, ` +
    `rendered at GitHub comment width as ${box.renderedWidth.toFixed(0)}x${box.renderedHeight.toFixed(0)}`
);
