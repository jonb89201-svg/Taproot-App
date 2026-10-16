// Drives seal.html in headless Chromium against an anvil fork of Base Sepolia.
// node test/seal.e2e.mjs
// Needs: anvil (Foundry), Chromium + the playwright package (PLAYWRIGHT_MODULE may
// point at it), and network to sepolia.base.org and cdn.jsdelivr.net. The wallet is
// a stub that forwards to anvil's unlocked public test accounts. Nothing holds value.
import fs from "fs";
import http from "http";
import path from "path";
import { spawn, execSync, execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { createPublicClient, http as vhttp, parseEther } from "viem";
import * as S from "../seal-core.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pwPath = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(pwPath.startsWith("/") ? pathToFileURL(path.join(pwPath, "index.mjs")).href : pwPath);
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS " + m); } else { fail++; console.log("  FAIL " + m); } };

const ACC = ["0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "0x90F79bf6EB2c4f870365E785982E1f101E93b906"]; // anvil #2, #3
const anvilBin = process.env.ANVIL || path.join(process.env.HOME || "", ".foundry/bin/anvil");
const PORT = 8900 + Math.floor(Math.random() * 90);
const RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn(anvilBin, ["--fork-url", "https://sepolia.base.org", "--port", String(PORT), "--silent"], { stdio: "ignore" });

const MIME = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".png": "image/png", ".json": "application/json" };
const server = http.createServer((q, r) => {
  const p = path.join(root, decodeURIComponent(new URL(q.url, "http://x").pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" }); fs.createReadStream(p).pipe(r);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const WEB = `http://127.0.0.1:${server.address().port}`;

const pub = createPublicClient({ transport: vhttp(RPC) });
let browser;
try {
  for (let i = 0; i < 60; i++) { try { await pub.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium" });
  const ctx = await browser.newContext({ acceptDownloads: true });
  // CDN modules are fetched with curl (which honours the environment's proxy) and
  // handed to the page byte-for-byte: same pinned URLs the live page loads.
  const cdn = new Map();
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|esm\.sh)\//, async (route) => {
    const url = route.request().url();
    if (!cdn.has(url)) cdn.set(url, execFileSync("curl", ["-sfL", url], { maxBuffer: 1 << 26 }));
    await route.fulfill({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: cdn.get(url) });
  });
  await ctx.addInitScript(({ rpc, accounts }) => {
    window.__acct = accounts[0];
    let id = 0;
    window.ethereum = {
      async request({ method, params }) {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [window.__acct];
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        if (method === "wallet_getCapabilities") {         // a plain wallet does not offer it; a test can make it report a smart account
          if (window.__caps) return window.__caps;
          const e = new Error("unsupported method"); e.code = 4200; throw e;
        }
        if (method === "eth_sendTransaction") params = [{ ...params[0], from: window.__acct }];
        const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
        const j = await res.json();
        if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; }
        return j.result;
      },
      on() {}, removeListener() {},
    };
  }, { rpc: RPC, accounts: ACC });

  // Lets a test hold the price-feed reply back, to force a quote to land late.
  let slowFeed = false;
  await ctx.route(RPC, async (route) => {
    if (slowFeed && /eth_call/.test(route.request().postData() || "")) await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(WEB + "/seal.html");
  await page.waitForFunction(() => window.__seal, null, { timeout: 30000 });
  await page.evaluate((rpc) => { window.__seal.S.CHAINS[84532].rpc = rpc; }, RPC);
  console.log("Seal page: e2e on an anvil fork of Base Sepolia");
  ok(true, "page loaded viem from the pinned CDN build and booted");
  ok((await page.inputValue("#chain")) === "8453", "Base mainnet is the default network");
  await page.selectOption("#chain", "84532");              // this run seals and anchors on the Sepolia fork

  // 1. create and sign twice
  const docBytes = Buffer.from("Taproot e2e lease document\n");
  await page.setInputFiles("#doc", { name: "lease.txt", mimeType: "text/plain", buffer: docBytes });
  await page.waitForFunction(() => document.getElementById("doc-hash").textContent.startsWith("0x"));
  const shown = await page.textContent("#doc-hash");
  ok(shown === "0x" + execSync("sha256sum", { input: docBytes }).toString().slice(0, 64), "the page hashes the file on-device to its SHA-256");
  await page.fill("#title", "Lease, unit 4");
  await page.click("#create");
  await page.click("#sign");
  await page.waitForFunction(() => /Signed\./.test(document.getElementById("seal-msg").textContent) || /err/.test(document.getElementById("seal-msg").className), null, { timeout: 30000 });
  ok(/Signed\./.test(await page.textContent("#seal-msg")), "first signer signs (EIP-712, no transaction)");
  await page.evaluate((a) => { window.__acct = a; }, ACC[1]);
  await page.click("#sign");
  await page.waitForFunction(() => window.__seal.state.seal.signatures.length === 2 || /err/.test(document.getElementById("seal-msg").className), null, { timeout: 30000 });
  const seal = await page.evaluate(() => window.__seal.state.seal);
  ok(seal.signatures.length === 2 && seal.signatures[1].signer.toLowerCase() === ACC[1].toLowerCase(), "second signer adds a signature to the same seal");
  await page.click("#sign");
  await page.waitForTimeout(300);
  ok(/already signed/.test(await page.textContent("#seal-msg")), "the same wallet cannot sign twice");

  ok((await page.evaluate(() => location.hash)).startsWith("#s="), "the page keeps the compact link in its address bar");

  // 2. the share link opens the seal in a fresh page, and an old JSON link still does
  const link = await S.toLink(WEB + "/seal.html", seal);
  const p2 = await ctx.newPage();
  await p2.goto(link);
  await p2.waitForFunction(() => window.__seal && window.__seal.state.seal);
  ok((await p2.textContent("#s-title")) === "Lease, unit 4" && (await p2.$$eval("#s-sigs .sig", (x) => x.length)) === 2, "the share link opens the seal with both signatures");
  await p2.goto(WEB + "/seal.html#seal=" + Buffer.from(JSON.stringify(seal)).toString("base64url"));
  await p2.reload();
  await p2.waitForFunction(() => window.__seal && window.__seal.state.seal);
  ok((await p2.textContent("#s-title")) === "Lease, unit 4" && (await p2.$$eval("#s-sigs .sig", (x) => x.length)) === 2, "an old JSON link (#seal=) still opens in the page");
  // a version-2 link (2026-10-15, before the signer check) still opens; throwaway signer
  await p2.goto(WEB + "/seal.html#s=ArSUBdlGakNJRu5-KCVxpMguKkZ-OdfdT4uP6qNqJBcmtoZNzeXD1gYjU2VhbCB0ZXN0IDIwMjYtMTAtMTUgKEJhc2UgU2Vwb2xpYSkBAEEs8es3Uau4VnF0-bG2t6lSXBJOSld-QM1YjFaolE40Mmz3Ik1yd3Z8EC9Jz8od3IznC49WHMfQ6dfaCFKTGgWHHAA");
  await p2.reload();
  await p2.waitForFunction(() => window.__seal && window.__seal.state.seal);
  ok((await p2.textContent("#s-sigs .sig")) === "0xB7180B747D2f4786ae676e25c1C2bFA2C6A5f97d", "a version-2 short link still opens in the page");
  // one changed character: refused as damaged, never shown under a stranger's address
  const at = link.length - 12, damaged = link.slice(0, at) + (link[at] === "A" ? "B" : "A") + link.slice(at + 1);
  await p2.goto(damaged);
  await p2.reload();
  await p2.waitForFunction(() => window.__seal);
  ok(/damaged or changed/.test(await p2.textContent("#top-msg")) && !(await p2.evaluate(() => window.__seal.state.seal)), "a link with one changed character is refused as damaged");
  await p2.close();

  // 3. hostile title through a link is shown as text, never run
  const evil = structuredClone(seal); evil.title = '<img src=x onerror="window.__pwned=1">'; evil.signatures = [];
  const p3 = await ctx.newPage();
  await p3.goto(await S.toLink(WEB + "/seal.html", evil));
  await p3.waitForFunction(() => window.__seal && window.__seal.state.seal);
  await p3.waitForTimeout(300);
  ok((await p3.evaluate(() => window.__pwned)) === undefined && (await p3.textContent("#s-title")) === evil.title, "markup in a seal title is shown as text, never executed");
  await p3.close();

  // 4. anchor on the fork
  await page.click('.tabs button[data-tab="anchor"]');
  await page.setInputFiles("#a-files", { name: "seal.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(seal)) });
  await page.waitForFunction(() => !document.getElementById("a-go").disabled, null, { timeout: 30000 });
  const feeText = await page.textContent("#a-fee");
  ok(/\$0\.02 = 0\.0000\d+ ETH/.test(feeText), "the page quotes $0.02 in ETH from the live feed: " + feeText.slice(0, 70));
  ok(/to the Seal fee wallet 0x9Ce4…a6c9, swept into the STEEL Treasury \(0x1949…4EA0\)/.test(feeText), "the fee line names the fee wallet and the STEEL Treasury");
  const feeTo = S.CHAINS[84532].feeAddress;
  const before = await pub.getBalance({ address: feeTo });
  await page.click("#a-go");
  await page.waitForFunction(() => /Anchored in block|err/.test(document.getElementById("a-msg").textContent + " " + document.getElementById("a-msg").className), null, { timeout: 60000 });
  const aMsg = await page.textContent("#a-msg");
  ok(/Anchored in block \d+\. Re-verified on-chain\./.test(aMsg), "anchor transaction lands and the page re-verifies it: " + aMsg);
  const delta = (await pub.getBalance({ address: feeTo })) - before;
  const quoted = parseEther(/= ([0-9.]+) ETH/.exec(feeText)[1]);
  ok(delta === quoted, "the fee address received exactly the quoted fee (" + delta + " wei)");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#a-done button")]);
  const anchored = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
  const tx = await pub.getTransaction({ hash: anchored.anchor.txHash });
  ok(tx.input.toLowerCase().endsWith(S.BUILDER_SUFFIX.slice(2)) && tx.to.toLowerCase() === feeTo.toLowerCase(), "the transaction went to the fee address and carries the Builder Code");

  // 5. verify the downloaded anchored seal in the page, with the document
  await page.click('.tabs button[data-tab="verify"]');
  await page.setInputFiles("#v-seal", { name: "a.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(anchored)) });
  await page.setInputFiles("#v-doc", { name: "lease.txt", mimeType: "text/plain", buffer: docBytes });
  await page.click("#v-run");
  await page.waitForFunction(() => /Every check passed|Some checks failed|err/.test(document.getElementById("v-msg").textContent + document.getElementById("v-msg").className), null, { timeout: 30000 });
  const lis = await page.$$eval("#v-out li", (x) => x.map((l) => l.className + ": " + l.textContent));
  ok(/Every check passed/.test(await page.textContent("#v-msg")) && lis.length === 6 && lis.every((l) => l.startsWith("ok")), "Verify passes all 6 checks (format, document, 2 signatures, proof, transaction)");
  await page.setInputFiles("#v-doc", { name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("tampered") });
  await page.click("#v-run");
  await page.waitForFunction(() => /Some checks failed|Every check/.test(document.getElementById("v-msg").textContent), null, { timeout: 30000 });
  ok(/Some checks failed/.test(await page.textContent("#v-msg")), "a different document is caught by Verify");

  // 5b. smart-wallet senders are refused before anything is sent: their anchor can't be verified, and the Builder
  //     Code wouldn't count (MEASURED on the mainnet fork in test/seal.test.mjs)
  const refusedBefore = async (setup, re, name) => {
    await page.evaluate(setup);
    await page.click('.tabs button[data-tab="anchor"]');
    await page.setInputFiles("#a-files", { name: "seal.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(seal)) });
    await page.waitForFunction(() => !document.getElementById("a-go").disabled, null, { timeout: 30000 });
    const [bal, blk] = [await pub.getBalance({ address: feeTo }), await pub.getBlockNumber()];
    await page.click("#a-go");
    // wait for any outcome (refused, or sent and anchored), so a missing guard fails here instead of timing out
    await page.waitForFunction(() => /err/.test(document.getElementById("a-msg").className) || /Anchored in block/.test(document.getElementById("a-msg").textContent), null, { timeout: 60000 });
    const m = await page.textContent("#a-msg");
    ok(re.test(m) && (await pub.getBalance({ address: feeTo })) === bal && (await pub.getBlockNumber()) === blk, name + ": " + m.slice(0, 60) + "…");
  };
  await refusedBefore(() => { window.__caps = { "0x14a34": { atomic: { status: "supported" } } }; }, /Anchor from a regular wallet.*runs as a smart account/, "a wallet that reports a smart account is refused, and nothing is sent");
  await refusedBefore((feed) => { window.__caps = null; window.__acct = window.__seal.S.CHAINS[84532].ethUsdFeed; }, /Anchor from a regular wallet.*has contract code/, "a sender with contract code is refused, and nothing is sent");
  await page.evaluate((a) => { window.__acct = a; }, ACC[0]);
  ok(/Anchor from a regular wallet/.test(await page.textContent("#tab-anchor")), "the Anchor tab says to anchor from a regular wallet");

  // 6. a network without a fee address stays closed, even when another network's quote lands after the switch
  await page.evaluate(() => { window.__seal.S.CHAINS[8453].feeAddress = null; });
  await page.setInputFiles("#a-files", { name: "seal.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(seal)) });
  slowFeed = true;
  await page.click('.tabs button[data-tab="anchor"]');   // starts a (held-back) Sepolia quote
  await page.waitForTimeout(200);
  await page.selectOption("#chain", "8453");               // switch while it is in flight
  await page.waitForTimeout(3500);                         // the late quote has now landed
  slowFeed = false;
  ok(/opens once its fee address is set/.test(await page.textContent("#a-fee")) && (await page.isDisabled("#a-go")), "a network without a fee address keeps Anchor off, even after a late quote from another network lands");

  // 7. a fee address with contract code keeps Anchor off: an anchor sent to it would revert after the gas is paid
  await page.evaluate(() => { const S = window.__seal.S; S.CHAINS[84532].feeAddress = S.CHAINS[84532].ethUsdFeed; });
  await page.selectOption("#chain", "84532");
  await page.waitForFunction(() => /Anchoring is off|Fee:/.test(document.getElementById("a-fee").textContent), null, { timeout: 30000 });
  ok(/is a contract/.test(await page.textContent("#a-fee")) && (await page.isDisabled("#a-go")), "a fee address with contract code keeps Anchor off");

  ok(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
} finally {
  if (browser) await browser.close();
  server.close(); anvil.kill();
}
console.log(`RESULT: ${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
