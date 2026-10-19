// Loads the console (index.html) in headless Chromium from a local static server and checks that it comes up
// clean: no uncaught exception, no missing same-origin file, the contract tabs render, and nothing of the
// trading desk is left (removed 2026-10-19). node test/console.smoke.mjs
// Needs Chromium + the playwright package (PLAYWRIGHT_MODULE may point at it). No wallet; the page's own CDN
// loads are the only network. Run it on the page as it stood before the removal and it goes red: that is the
// planted break for a removal.
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pwPath = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(pwPath.startsWith("/") ? pathToFileURL(path.join(pwPath, "index.mjs")).href : pwPath);
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS " + m); } else { fail++; console.log("  FAIL " + m); } };

const MIME = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const server = http.createServer((q, r) => {
  let p = path.join(root, decodeURIComponent(new URL(q.url, "http://x").pathname));
  if (p.startsWith(root) && fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html"); // "/" is the console, as on the live host
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" }); fs.createReadStream(p).pipe(r);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const WEB = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium" });
try {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } }); // a phone
  const errors = [], missing = [];
  page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));
  page.on("response", (res) => { const u = new URL(res.url()); if (u.origin === WEB && res.status() === 404) missing.push(u.pathname); });
  await page.goto(WEB + "/index.html", { waitUntil: "load", timeout: 90000 });
  await page.waitForTimeout(2500); // let the deferred scripts and the first renders settle

  console.log("Console: load");
  ok(errors.length === 0, "no uncaught exception while loading" + (errors.length ? ": " + errors.map((e) => e.slice(0, 100)).join(" | ") : ""));
  ok(missing.length === 0, "every same-origin file the page asks for exists" + (missing.length ? ": missing " + [...new Set(missing)].join(", ") : ""));
  const keys = await page.evaluate(() => (typeof CONTRACTS !== "undefined" ? CONTRACTS.map((c) => c.key) : null));
  ok(Array.isArray(keys) && keys.includes("PAY") && keys.includes("HOOK"), "the contract registry renders with Payments and V3: " + JSON.stringify(keys));
  const text = await page.evaluate(() => document.body.innerText);
  ok(/Payments/.test(text), "the Payments tab is on the page");

  console.log("Console: the trading desk is gone");
  ok(!keys || !keys.some((k) => ["VAULT", "AUTOTARGET", "RAIL"].includes(k)), "no Funding Vault, Auto-Target or Trader Rail in the registry");
  const globals = await page.evaluate(() => ["Desk", "DeskMatch", "deskReport", "PossessioMiniApp", "POSSESSIO_DESK_ALLOW", "POSSESSIO_SOLANA_KEEPER"].filter((k) => k in window));
  ok(globals.length === 0, "no desk globals on window" + (globals.length ? ": " + globals.join(", ") : ""));
  ok(!(await page.$("#desk-view")) && !(await page.$("#mkts-desk")), "no desk view and no desk button in the markets sheet");
  ok(!/AI Assisted Trading|Trading desk|Funding Vault/i.test(text), "no desk wording on the page");
  const src = fs.readFileSync(path.join(root, "index.html"), "utf8");
  ok(!/desk-match\.js|miniapp-solana\.js|\/api\/desk\//.test(src), "index.html references no desk file or desk API");
  ok(!/\bconfig:"vault"/.test(src), "the launch rail offers no vault");

  console.log("Console: the install surface (home screen, Play Store wrapper, Farcaster mini app)");
  const exists = (rel) => fs.existsSync(path.join(root, rel.replace(/^https:\/\/taproot\.possessio\.io/, "").replace(/^\//, "")));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8"));
  ok((await page.$eval('link[rel="manifest"]', (l) => l.getAttribute("href"))) === "/manifest.webmanifest", "the page links the web app manifest");
  ok(manifest.short_name === "Taproot" && manifest.display === "standalone" && manifest.start_url === "/" && manifest.icons.some((i) => i.sizes === "192x192") && manifest.icons.some((i) => i.sizes === "512x512" && i.purpose === "any") && manifest.icons.some((i) => i.purpose === "maskable"), "the manifest is installable: standalone, start_url, 192 + 512 + maskable icons");
  ok(manifest.icons.concat(manifest.screenshots || []).every((i) => exists(i.src)), "every manifest icon and screenshot exists in the repo");
  const reg = await page.evaluate(() => Promise.race([
    navigator.serviceWorker.ready.then((r) => new URL((r.active || r.installing || r.waiting).scriptURL).pathname),
    new Promise((res) => setTimeout(() => res("not active after 20 s"), 20000)),
  ]));
  ok(reg === "/sw.js", "the service worker registered: " + reg);
  const fc = JSON.parse(fs.readFileSync(path.join(root, ".well-known/farcaster.json"), "utf8"));
  const app = fc.miniapp || fc.frame;
  ok(app && app.version === "1" && app.name === "Taproot" && app.homeUrl === "https://taproot.possessio.io" && /^https:\/\/taproot\.possessio\.io\//.test(app.iconUrl), "the Farcaster manifest names Taproot at its own domain");
  ok([app.iconUrl, app.splashImageUrl, app.heroImageUrl, app.ogImageUrl].concat(app.screenshotUrls || []).every(exists), "every image the Farcaster manifest points at exists in the repo");
  ok(app.subtitle.length <= 30 && app.description.length <= 170 && app.tagline.length <= 30 && app.ogTitle.length <= 30 && app.ogDescription.length <= 100 && (app.tags || []).length <= 5 && (app.screenshotUrls || []).length <= 3, "the Farcaster manifest keeps to the field limits");
  const embed = JSON.parse(await page.$eval('meta[name="fc:miniapp"]', (m) => m.getAttribute("content")));
  ok(embed.version === "1" && embed.button.action.type === "launch_miniapp" && embed.button.action.url === app.homeUrl && exists(embed.imageUrl) && embed.button.action.splashImageUrl === app.splashImageUrl, "the fc:miniapp embed launches the same app with the same splash, and its image exists");
} finally {
  await browser.close();
  server.close();
}
console.log(`RESULT: ${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
