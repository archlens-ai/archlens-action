// Controlled follow-up experiment: the real PR round-trip found the CSS
// offset-path animation does NOT play when GitHub embeds the SVG via
// <img>, exactly like SMIL didn't -- even though the same file animates
// fine loaded as a standalone document. curl'ing the served SVG showed
// GitHub sends `content-security-policy: default-src 'none';
// style-src 'unsafe-inline'; sandbox` on raw.githubusercontent.com
// responses. This reproduces that exact header on a local HTTP server
// (not just the local screenshot-svg.mjs harness, which sends no CSP at
// all) to test whether the `sandbox` CSP directive is the actual
// mechanism suppressing the animation in <img>-embed context.
import http from "node:http";
import { readFileSync } from "node:fs";
import puppeteer from "/home/claude/.npm-global/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const svg = readFileSync("scripts/.dry-run-output/css-flow-diagram.svg", "utf8");
const GITHUB_COMMENT_WIDTH = 768;

const server = http.createServer((req, res) => {
  if (req.url === "/diagram.svg") {
    res.writeHead(200, {
      "content-type": "image/svg+xml",
      // The exact CSP GitHub sends for raw.githubusercontent.com SVGs.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
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

console.log(`With GitHub's CSP header replicated: shot1 === shot2 (byte-identical): ${shot1 === shot2}`);
console.log(
  shot1 === shot2
    ? "=> NO motion -- matches the real GitHub PR finding. The `sandbox` CSP directive is a strong candidate root cause."
    : "=> Motion detected -- the CSP header is NOT the mechanism; something else about GitHub's real embed differs."
);
