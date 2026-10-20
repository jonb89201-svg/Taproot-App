// A real WalletConnect round trip for seal.html when the browser has no wallet of its own (a phone's Safari).
//   cd test/walletconnect && npm ci && node e2e.mjs [--mutants]
// The page runs in headless Chromium through HTTPS_PROXY, served as https://taproot.possessio.io from this repo, so
// the relay and WalletConnect's domain check see the real origin. The wallet is wallet-entry.mjs in a second browser
// profile: it pairs over the live relay and signs with a throwaway key. Nothing is anchored and nothing holds value.
// Needs network to relay.walletconnect.org, api.web3modal.org, verify.walletconnect.org, cdn.jsdelivr.net, esm.sh and
// mainnet.base.org (the page re-verifies each signature on Base). --mutants plants breaks that must each fail.
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { recoverTypedDataAddress } from "viem";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const ORIGIN = "https://taproot.possessio.io";
const PROJECT_ID = /WC_PROJECT_ID = "([0-9a-f]{32})"/.exec(fs.readFileSync(path.join(root, "seal.html"), "utf8"))[1];
const pwPath = process.env.PLAYWRIGHT_MODULE || "/opt/node-tools/node_modules/playwright";
const { chromium } = await import(pathToFileURL(path.join(pwPath, "index.mjs")).href);
const S = await import(pathToFileURL(path.join(root, "seal-core.mjs")).href);

// the test wallet, bundled for the browser
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seal-wc-"));
execFileSync(path.join(here, "node_modules/.bin/esbuild"), ["wallet-entry.mjs", "--bundle", "--format=esm", "--platform=browser",
  "--define:process.env.NODE_ENV=\"production\"", "--define:global=globalThis", "--log-level=error", "--outfile=" + path.join(tmp, "wallet.mjs")], { cwd: here });

const MIME = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(ctx, overrides = {}) {
  await ctx.route(/^https:\/\/taproot\.possessio\.io\//, (route) => {
    let p = new URL(route.request().url()).pathname;
    if (p === "/seal") p = "/seal.html";
    if (overrides[p] !== undefined) return route.fulfill({ status: 200, contentType: MIME[path.extname(p)] || "text/html", body: overrides[p] });
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: MIME[path.extname(f)] || "application/octet-stream", body: fs.readFileSync(f) });
  });
}

// One full attempt: create a seal, tap "Add my signature", pair the wallet through the picker, return what happened.
async function attempt(browser, { walletMode = "good", sealHtml } = {}) {
  const page = { ctx: await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" }) };
  const wallet = { ctx: await browser.newContext({ serviceWorkers: "block" }) };   // its own storage: two WalletConnect clients must not share it
  try {
    await serve(page.ctx, sealHtml ? { "/seal.html": sealHtml } : {});
    await serve(wallet.ctx, {
      "/__e2e-wallet.html": '<!doctype html><meta charset="utf-8"><script type="module" src="/__e2e-wallet.mjs"></script>',
      "/__e2e-wallet.mjs": fs.readFileSync(path.join(tmp, "wallet.mjs")),
    });
    const w = await wallet.ctx.newPage();
    await w.goto(ORIGIN + "/__e2e-wallet.html");
    await w.waitForFunction(() => window.walletReady, null, { timeout: 30000 });
    const address = await w.evaluate((o) => window.walletStart(o), { projectId: PROJECT_ID, mode: walletMode });

    const p = await page.ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(ORIGIN + "/seal");
    await p.waitForFunction(() => window.__seal, null, { timeout: 30000 });
    const noWallet = await p.evaluate(() => typeof window.ethereum === "undefined");
    const doc = Buffer.from("Seal WalletConnect e2e document\n");
    await p.setInputFiles("#doc", { name: "doc.txt", mimeType: "text/plain", buffer: doc });
    await p.waitForFunction(() => document.getElementById("doc-hash").textContent.startsWith("0x"));
    await p.fill("#title", "WalletConnect e2e");
    await p.click("#create");
    await p.click("#sign");

    let uri = null;
    for (let i = 0; i < 60 && !uri; i++) {
      await p.waitForTimeout(500);
      uri = await p.locator("wui-qr-code").first().getAttribute("uri", { timeout: 200 }).catch(() => null);
    }
    if (!uri) return { address, noWallet, uri: null, msg: await p.textContent("#seal-msg"), errors };
    await w.evaluate((u) => window.walletPair(u), uri);
    await p.waitForFunction(() => /Signed\./.test(document.getElementById("seal-msg").textContent) || /err/.test(document.getElementById("seal-msg").className), null, { timeout: 90000 });
    return {
      address, noWallet, uri,
      msg: await p.textContent("#seal-msg"),
      seal: await p.evaluate(() => window.__seal.state.seal),
      who: await p.textContent("#who"),
      walletLog: await w.evaluate(() => window.walletLog),
      errors,
    };
  } finally {
    await page.ctx.close();
    await wallet.ctx.close();
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium", proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS " + m); } else { fail++; console.log("  FAIL " + m); } };

// What a good run must show. Returns the failed checks, so a planted break can be judged by the same rules.
async function judge(r) {
  const out = [];
  const check = (c, m) => { if (!c) out.push(m); return c; };
  check(r.noWallet, "the browser had no wallet of its own");
  if (!check(!!r.uri && r.uri.startsWith("wc:"), "the WalletConnect picker opened with a pairing code")) return out;
  check(/Signed\./.test(r.msg), "the page accepted the signature: " + r.msg);
  const sig = r.seal && r.seal.signatures[0];
  check(r.seal && r.seal.signatures.length === 1 && sig.signer.toLowerCase() === r.address.toLowerCase(), "the seal holds one signature, from the paired wallet");
  if (sig) {
    const rec = await recoverTypedDataAddress({ ...S.typedDataFor(r.seal), signature: sig.signature });
    check(rec.toLowerCase() === r.address.toLowerCase(), "the signature recovers to the paired wallet offline");
  }
  check(r.walletLog && r.walletLog[0] === "approved eip155:8453,eip155:84532", "the wallet was offered Base first, then Base Sepolia: " + (r.walletLog && r.walletLog[0]));
  check(r.walletLog && r.walletLog.length === 2 && r.walletLog[1] === "eth_signTypedData_v4", "the wallet was asked for one thing, eth_signTypedData_v4: " + JSON.stringify(r.walletLog && r.walletLog.slice(1)));
  check(r.errors.length === 0, "no page errors" + (r.errors.length ? ": " + r.errors.join(" | ") : ""));
  return out;
}

try {
  if (!process.argv.includes("--mutants")) {
    console.log("Seal page: WalletConnect round trip (live relay, page served as " + ORIGIN + ")");
    const r = await attempt(browser);
    const failed = await judge(r);
    for (const m of ["the browser had no wallet of its own", "the WalletConnect picker opened with a pairing code"]) ok(!failed.includes(m), m);
    if (failed.length) console.log("  wallet saw: " + JSON.stringify(r.walletLog));
    ok(failed.length === 0, failed.length ? "round trip: " + failed.join("; ") : "paired, signed, accepted, and the signature recovers to the wallet " + r.address);
    console.log(`${pass} passed, ${fail} failed`);
  } else {
    const html = fs.readFileSync(path.join(root, "seal.html"), "utf8");
    const plant = (from, to) => { const m = html.replace(from, to); return { sealHtml: m, planted: m !== html }; };
    const mutants = [
      ["the wallet signs with a key other than the one it paired", { walletMode: "wrong-key" }],
      ["seal.html without the WalletConnect fallback", plant("(await getProvider()) || (await walletConnect())", "(await getProvider())")],
      ["Base as a required chain (2.25 drops it from the proposal)", plant("optionalChains: [8453, 84532],", "chains: [8453],\n    optionalChains: [84532],")],
    ];
    let killed = 0;
    for (const [name, opts] of mutants) {
      if (opts.planted === false) { console.log("NOT PLANTED  " + name); continue; }
      const failed = await judge(await attempt(browser, opts));
      if (failed.length) { killed++; console.log(`killed       ${name}: ${failed[0]}`); } else console.log("SURVIVED     " + name);
    }
    console.log(`${killed}/${mutants.length} mutants killed`);
    fail = mutants.length - killed;
  }
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
