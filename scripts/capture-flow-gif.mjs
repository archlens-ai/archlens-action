// Captures a short burst of frames of a rendered SVG (embedded exactly as
// GitHub would, via <img>) to prove the animated "data flow" edges
// actually move -- a static PNG can't show motion, so this renders real
// frames over ~2.5s and lets a follow-up ffmpeg call assemble them into a
// GIF. Reuses the same GitHub-comment-width container as screenshot-svg.mjs.
import http from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import puppeteer from "/home/claude/.npm-global/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const [, , svgPath, outDir, frameCountArg, intervalMsArg] = process.argv;
const frameCount = Number(frameCountArg ?? 15);
const intervalMs = Number(intervalMsArg ?? 120);
mkdirSync(outDir, { recursive: true });

const svg = readFileSync(svgPath, "utf8");
const WIDTH = 640;

const server = http.createServer((req, res) => {
  if (req.url === "/diagram.svg") {
    res.writeHead(200, { "content-type": "image/svg+xml" });
    res.end(svg);
  } else {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><html><body style="margin:0;background:#ffffff">` +
        `<div id="frame" style="width:${WIDTH}px;padding:16px;box-sizing:border-box;background:#ffffff;display:inline-block">` +
        `<img id="img" src="/diagram.svg" style="max-width:100%;display:block">` +
        `</div></body></html>`
    );
  }
});
const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

const browser = await puppeteer.launch({
  executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH,
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: WIDTH + 32, height: 500 });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle0" });
await page.waitForFunction(() => {
  const img = document.getElementById("img");
  return img && img.complete && img.naturalWidth > 0;
});

// Same fix as screenshot-svg.mjs: screenshot the #frame element itself
// rather than the fixed-size viewport/page, so short diagrams don't get
// padded with blank space below them in every frame.
const frame = await page.$("#frame");
for (let i = 0; i < frameCount; i++) {
  await frame.screenshot({ path: `${outDir}/frame-${String(i).padStart(3, "0")}.png` });
  await new Promise((r) => setTimeout(r, intervalMs));
}

await browser.close();
server.close();
console.log(`✓ captured ${frameCount} frames to ${outDir}`);
