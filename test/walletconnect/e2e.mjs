// A real WalletConnect round trip for seal.html when the browser has no wallet of its own (a phone's Safari).
//   cd test/walletconnect && npm ci && node e2e.mjs [--mutants]
// The page runs in headless Chromium through HTTPS_PROXY, served as https://taproot.possessio.io from this repo, so
// the relay and WalletConnect's domain check see the real origin. The wallet is wallet-entry.mjs in a second browser
// profile: it pairs over the live relay, signs with a throwaway key, and broadcasts the anchor transaction to an anvil
// fork of Base mainnet that both profiles reach as https://anvil.e2e/ (routed to 127.0.0.1; an https page can't fetch
// plain http). Nothing holds value: the throwaway wallet is funded on the fork only. Needs anvil (Foundry), Playwright,
// and network to relay.walletconnect.org, api.web3modal.org, verify.walletconnect.org, cdn.jsdelivr.net, esm.sh and
// mainnet.base.org (the fork's upstream). --mutants plants breaks that must each fail.
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { createPublicClient, http, recoverTypedDataAddress, parseEther } from "viem";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const ORIGIN = "https://taproot.possessio.io";
const FORK_URL = "https://anvil.e2e/";
const PROJECT_ID = /WC_PROJECT_ID = "([0-9a-f]{32})"/.exec(fs.readFileSync(path.join(root, "seal.html"), "utf8"))[1];
const pwPath = process.env.PLAYWRIGHT_MODULE || "/opt/node-tools/node_modules/playwright";
const { chromium } = await import(pathToFileURL(path.join(pwPath, "index.mjs")).href);
const S = await import(pathToFileURL(path.join(root, "seal-core.mjs")).href);

// the fork of Base mainnet the anchor lands on
const anvilBin = process.env.ANVIL || path.join(process.env.HOME || "", ".foundry/bin/anvil");
const PORT = 8700 + Math.floor(Math.random() * 90);
const RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn(anvilBin, ["--fork-url", process.env.SEAL_FORK_RPC_MAINNET || "https://mainnet.base.org", "--port", String(PORT), "--silent"], { stdio: "ignore" });
const pub = createPublicClient({ transport: http(RPC) });
const rpc = async (method, params = []) => { const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); return (await r.json()).result; };

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
  // the fork, reachable from an https page: the route runs in Node and forwards to anvil
  await ctx.route(FORK_URL, async (route) => {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: route.request().postData() || "" });
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: await r.text() });
  });
}

// One full attempt: create a seal, tap "Add my signature", pair the wallet through the picker, then (with anchor) load
// the signed seal into the Anchor tab and anchor it on the fork. Returns what happened.
async function attempt(browser, { walletMode = "good", sealHtml, anchor = false } = {}) {
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
    const address = await w.evaluate((o) => window.walletStart(o), { projectId: PROJECT_ID, mode: walletMode, rpc: FORK_URL });
    await rpc("anvil_setBalance", [address, "0x" + parseEther("1").toString(16)]);   // fork money only

    const p = await page.ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(ORIGIN + "/seal");
    await p.waitForFunction(() => window.__seal, null, { timeout: 30000 });
    await p.evaluate((u) => { window.__seal.S.CHAINS[8453].rpc = u; }, FORK_URL);   // the page's own reads and receipt wait go to the fork
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
    const r = {
      address, noWallet, uri,
      msg: await p.textContent("#seal-msg"),
      seal: await p.evaluate(() => window.__seal.state.seal),
      who: await p.textContent("#who"),
      walletLog: await w.evaluate(() => window.walletLog),
      errors,
    };
    if (!anchor || !r.seal || !r.seal.signatures.length) return r;

    // anchor the signed seal through the same WalletConnect session
    const feeTo = S.CHAINS[8453].feeAddress;
    const before = await pub.getBalance({ address: feeTo });
    await p.click('.tabs button[data-tab="anchor"]');
    await p.setInputFiles("#a-files", { name: "seal.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(r.seal)) });
    await p.waitForFunction(() => !document.getElementById("a-go").disabled, null, { timeout: 60000 });
    r.feeText = await p.textContent("#a-fee");
    await p.click("#a-go");
    await p.waitForFunction(() => /Anchored in block/.test(document.getElementById("a-msg").textContent) || /err/.test(document.getElementById("a-msg").className), null, { timeout: 120000 });
    r.anchorMsg = await p.textContent("#a-msg");
    r.anchorClass = await p.getAttribute("#a-msg", "class");
    r.walletLog = await w.evaluate(() => window.walletLog);
    r.sent = await w.evaluate(() => window.walletSent || null);
    r.feeDelta = (await pub.getBalance({ address: feeTo })) - before;
    r.quoted = /= ([0-9.]+) ETH/.test(r.feeText) ? parseEther(/= ([0-9.]+) ETH/.exec(r.feeText)[1]) : null;
    if (r.sent) { const tx = await pub.getTransaction({ hash: r.sent.hash }); r.txTo = tx.to; r.txInput = tx.input; }
    return r;
  } finally {
    await page.ctx.close();
    await wallet.ctx.close();
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium", proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS " + m); } else { fail++; console.log("  FAIL " + m); } };

// What a good run must show. Returns the failed checks, so a planted break can be judged by the same rules.
async function judge(r, { anchor = false } = {}) {
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
  check(r.walletLog && r.walletLog[1] === "eth_signTypedData_v4", "the wallet's first request was eth_signTypedData_v4: " + JSON.stringify(r.walletLog && r.walletLog.slice(1)));
  if (anchor) {
    check(/Anchored in block \d+\. Re-verified on-chain\./.test(r.anchorMsg || "") && !/err/.test(r.anchorClass || ""), "the anchor landed and the page re-verified it: " + (r.anchorMsg || "").slice(0, 90));
    check(r.walletLog && r.walletLog.includes("eth_sendTransaction"), "the wallet was asked to send the anchor transaction");
    check(r.quoted != null && r.feeDelta === r.quoted, "the fee wallet received exactly the quoted fee (" + r.feeDelta + " wei)");
    check(r.txTo && r.txTo.toLowerCase() === S.CHAINS[8453].feeAddress.toLowerCase() && (r.txInput || "").toLowerCase().endsWith(S.BUILDER_SUFFIX.slice(2)), "the transaction went to the fee address and carries the Builder Code");
  }
  check(r.errors.length === 0, "no page errors" + (r.errors.length ? ": " + r.errors.join(" | ") : ""));
  return out;
}

try {
  for (let i = 0; i < 60; i++) { try { await pub.getChainId(); break; } catch { await new Promise((res) => setTimeout(res, 500)); } }
  if (!process.argv.includes("--mutants")) {
    console.log("Seal page: WalletConnect round trip (live relay, page served as " + ORIGIN + ", anchor on a fork of Base mainnet)");
    const r = await attempt(browser, { anchor: true });
    const failed = await judge(r, { anchor: true });
    for (const m of ["the browser had no wallet of its own", "the WalletConnect picker opened with a pairing code"]) ok(!failed.includes(m), m);
    const signFails = failed.filter((m) => !/anchor|fee wallet|Builder Code|send the anchor/.test(m) && !/^the browser|^the WalletConnect picker/.test(m));
    ok(signFails.length === 0, signFails.length ? "signing: " + signFails.join("; ") : "paired, signed, accepted, and the signature recovers to the wallet " + r.address);
    const anchorFails = failed.filter((m) => /anchor|fee wallet|Builder Code|send the anchor/.test(m));
    if (anchorFails.length) console.log("  wallet saw: " + JSON.stringify(r.walletLog) + " | a-msg: " + (r.anchorMsg || "").slice(0, 120));
    ok(anchorFails.length === 0, anchorFails.length ? "anchoring: " + anchorFails.join("; ") : "anchored over WalletConnect: " + (r.anchorMsg || "").slice(0, 60) + " fee " + r.feeDelta + " wei to the fee wallet, Builder Code present");
    console.log(`${pass} passed, ${fail} failed`);
  } else {
    const html = fs.readFileSync(path.join(root, "seal.html"), "utf8");
    const plant = (from, to) => { const m = html.replace(from, to); return { sealHtml: m, planted: m !== html }; };
    const mutants = [
      ["the wallet signs with a key other than the one it paired", { walletMode: "wrong-key" }],
      ["seal.html without the WalletConnect fallback", plant("(await getProvider()) || (await walletConnect())", "(await getProvider())")],
      ["Base as a required chain (2.25 drops it from the proposal)", plant("optionalChains: [8453, 84532],", "chains: [8453],\n    optionalChains: [84532],")],
      ["the wallet sends the anchor's ETH to itself and returns that hash", { walletMode: "misroute", anchor: true }],
    ];
    let killed = 0;
    for (const [name, opts] of mutants) {
      if (opts.planted === false) { console.log("NOT PLANTED  " + name); continue; }
      const failed = await judge(await attempt(browser, opts), { anchor: !!opts.anchor });
      if (failed.length) { killed++; console.log(`killed       ${name}: ${failed[0]}`); } else console.log("SURVIVED     " + name);
    }
    console.log(`${killed}/${mutants.length} mutants killed`);
    fail = mutants.length - killed;
  }
} finally {
  await browser.close();
  anvil.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
