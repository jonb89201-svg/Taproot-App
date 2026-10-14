// Seal tests. node test/seal.test.mjs
//   Offline part: always runs.
//   Fork part: needs anvil (Foundry) and network to https://sepolia.base.org. It forks
//   Base Sepolia, reads the real Chainlink ETH/USD feed, sends a real anchor transaction
//   and checks ERC-1271 and ERC-6492 signatures. When anvil is missing it prints SKIP
//   and the run exits 2, so it can never be counted as a pass.
// Keys: anvil's public, well-known test keys only. Nothing here holds value.
import fs from "fs";
import path from "path";
import { spawn, execSync } from "child_process";
import { fileURLToPath } from "url";
import {
  createPublicClient, createWalletClient, http, getAddress, keccak256, toHex,
  encodeAbiParameters, encodeFunctionData, concat, getContractAddress, parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as S from "../seal-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS " + m); } else { fail++; console.log("  FAIL " + m); } };
const throws = async (f, re, m) => { try { await f(); ok(false, m + " (did not throw)"); } catch (e) { ok(re.test(e.message), m + " -> " + e.message.slice(0, 80)); } };

const K0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const K1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const K2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const A0 = privateKeyToAccount(K0), A1 = privateKeyToAccount(K1), A2 = privateKeyToAccount(K2);
const CHAIN = 84532;

async function signed(seal, ...accts) {
  const s = structuredClone(seal);
  for (const a of accts) s.signatures.push({ signer: a.address, signature: await a.signTypedData(S.typedDataFor(s)) });
  return s;
}

console.log("Seal: offline");
const doc = new TextEncoder().encode("Possessio test document\n");
const docHash = await S.sha256Hex(doc);
ok(docHash === "0x" + execSync("sha256sum", { input: doc }).toString().slice(0, 64), "docHash equals sha256sum of the same bytes");

const base = S.newSeal({ chainId: CHAIN, docHash, title: "Lease, unit 4", sealedAt: 1791900000 });
const two = await signed(base, A0, A1);

let r = await S.verifySeal(two, { fileHash: docHash });
ok(r.ok && r.checks.length === 4, "two plain-wallet signatures verify offline, file matches");
r = await S.verifySeal({ ...two, title: "Lease, unit 5" });
ok(!r.ok, "changing the title breaks every signature");
r = await S.verifySeal(two, { fileHash: await S.sha256Hex(new TextEncoder().encode("other")) });
ok(!r.ok && r.checks.find((c) => c.name === "document").ok === false, "a different file is reported as not matching");
const forged = structuredClone(two); forged.signatures[1].signer = A2.address;
r = await S.verifySeal(forged);
ok(!r.ok, "a signature claimed for the wrong signer fails");
const otherChain = structuredClone(two); otherChain.chainId = 8453;
r = await S.verifySeal(otherChain);
ok(!r.ok, "a signature does not carry over to another chain (domain binds chainId)");

await throws(() => S.validateSeal({ ...base, docHash: "0x1234" }), /docHash/, "rejects a short docHash");
await throws(() => S.validateSeal({ ...base, title: "x".repeat(S.TITLE_MAX + 1) }), /title/, "rejects an over-long title");
await throws(() => S.validateSeal({ ...base, chainId: 1 }), /chainId/, "rejects an unsupported chain");
await throws(() => S.validateSeal({ ...two, signatures: [two.signatures[0], two.signatures[0]] }), /duplicate/, "rejects a duplicate signer");
await throws(() => S.validateSeal({ ...base, signatures: [{ signer: "0xnope", signature: "0x00" }] }), /signer/, "rejects a malformed signer");

const link = S.toLink("https://taproot.possessio.io/seal.html", two);
ok(JSON.stringify(S.fromFragment(new URL(link).hash)) === JSON.stringify(two), "share link round-trips the seal exactly");
await throws(async () => S.fromFragment("#seal=" + Buffer.from(JSON.stringify({ ...two, seal: 9 })).toString("base64url")), /format/, "a link carrying a bad seal is rejected");

// Merkle
for (const n of [1, 2, 3, 4, 5, 7, 8, 13]) {
  const leaves = Array.from({ length: n }, (_, i) => keccak256(toHex("leaf" + i)));
  const root = S.merkleRoot(leaves);
  ok(leaves.every((l, i) => S.verifyProof(l, S.merkleProof(leaves, i), root)), "every proof verifies in a batch of " + n);
  if (n > 1) ok(!S.verifyProof(keccak256(toHex("intruder")), S.merkleProof(leaves, 0), root), "an outside leaf fails in a batch of " + n);
}
const lA = S.sealLeaf(two), lB = S.sealLeaf(await signed(base, A0));
ok(lA !== lB, "the leaf commits to the signatures, not just the document");

// Fee arithmetic: $0.02 at the feed's price, rounded up
const now = 1791941676;
const feeAt = (answer) => S.feeWeiFrom({ answer, decimals: 8, updatedAt: now - 60, now, maxAgeS: 3600 });
ok(feeAt(200000000000n) === 10000000000000n, "$2,000/ETH -> 0.00001 ETH (10,000,000,000,000 wei)");
ok(feeAt(400000000000n) === 5000000000000n, "ETH doubles -> the fee in ETH halves, still $0.02");
const f = feeAt(249901457008n);
ok(f * 249901457008n >= 2000000n * 10n ** 18n && (f - 1n) * 249901457008n < 2000000n * 10n ** 18n, "rounds up: the fee is never under $0.02");
await throws(() => S.feeWeiFrom({ answer: 0n, decimals: 8, updatedAt: now, now, maxAgeS: 3600 }), /non-positive/, "a zero price is refused");
await throws(() => S.feeWeiFrom({ answer: 200000000000n, decimals: 8, updatedAt: now - 7200, now, maxAgeS: 3600 }), /stale/, "a stale price is refused");

// Anchor calldata
const root = S.merkleRoot([lA, lB]);
const data = S.anchorCalldata(root);
ok(data.startsWith(S.ANCHOR_MAGIC) && data.endsWith(S.BUILDER_SUFFIX.slice(2)), "calldata = SEAL magic + root + Builder Code suffix");
ok(S.decodeAnchor(data) === root, "decodeAnchor recovers the root");
ok(S.decodeAnchor("0xdeadbeef" + root.slice(2)) === null, "other calldata is not read as an anchor");
await throws(() => S.buildAnchorTx({ chainId: 8453, seals: [two], feeWei: 1n }), /not enabled/, "mainnet anchoring stays off until the fee address is set");
await throws(() => S.buildAnchorTx({ chainId: CHAIN, seals: [base], feeWei: 1n }), /signed/, "an unsigned seal cannot be anchored");

// ---------- fork ----------
let anvilBin = null;
for (const p of [process.env.ANVIL, path.join(process.env.HOME || "", ".foundry/bin/anvil"), "anvil"]) {
  if (!p) continue;
  try { execSync(p + " --version", { stdio: "ignore" }); anvilBin = p; break; } catch {}
}
if (!anvilBin) {
  console.log("Seal: fork  SKIP (anvil not found)");
  console.log(`RESULT: ${pass}/${pass + fail} PASS, fork part SKIPPED`);
  process.exit(fail ? 1 : 2);
}

console.log("Seal: fork of Base Sepolia");
const PORT = 8600 + Math.floor(Math.random() * 300);
const anvil = spawn(anvilBin, ["--fork-url", process.env.SEAL_FORK_RPC || "https://sepolia.base.org", "--port", String(PORT), "--silent"], { stdio: "ignore" });
const RPC = `http://127.0.0.1:${PORT}`;
const chain = { id: CHAIN, name: "Base Sepolia (fork)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wal = createWalletClient({ account: A2, chain, transport: http(RPC) });
try {
  for (let i = 0; i < 60; i++) { try { await pub.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  ok((await pub.getChainId()) === CHAIN, "anvil forked Base Sepolia (chainId 84532)");

  // Live fee from the real feed (the fork's clock is the forked block's)
  const blk = await pub.getBlock();
  const q = await S.quoteFee(pub, CHAIN, Number(blk.timestamp));
  console.log(`    ETH/USD ${Number(q.answer) / 10 ** q.decimals}, fee ${q.wei} wei`);
  ok(q.decimals === 8 && q.wei > 0n, "quoteFee reads the real Chainlink ETH/USD feed");
  ok(q.wei * q.answer >= 2000000n * 10n ** 18n, "quoted fee is at least $0.02 at that price");

  // Anchor two seals in one transaction
  const s2 = await signed(base, A0);
  const plan = S.buildAnchorTx({ chainId: CHAIN, seals: [two, s2], feeWei: q.wei });
  const feeTo = plan.tx.to;
  const before = await pub.getBalance({ address: feeTo });
  const txHash = await wal.sendTransaction(plan.tx);
  const rc = await pub.waitForTransactionReceipt({ hash: txHash });
  ok(rc.status === "success", "anchor transaction to the plain fee address succeeds (value + data)");
  ok((await pub.getBalance({ address: feeTo })) - before === q.wei, "the fee address received exactly the quoted fee");
  const sent = await pub.getTransaction({ hash: txHash });
  ok(sent.input.toLowerCase().endsWith(S.BUILDER_SUFFIX.slice(2)), "the anchor transaction carries the Builder Code suffix on-chain");

  const anchored = S.attachAnchor([two, s2], plan.leaves, plan.root, txHash);
  for (const [i, a] of anchored.entries()) {
    r = await S.verifySeal(a, { client: pub, fileHash: docHash });
    ok(r.ok && r.anchoredAt && r.anchoredAt.block === Number(rc.blockNumber), `anchored seal ${i + 1} verifies on-chain, existed by block ${rc.blockNumber}`);
  }
  const moved = structuredClone(anchored[0]); moved.title = "Lease, unit 9";
  r = await S.verifySeal(moved, { client: pub });
  ok(!r.ok && r.checks.find((c) => c.name === "anchor proof").ok === false, "an edited seal no longer fits its anchor");
  const wrongTx = structuredClone(anchored[0]);
  wrongTx.anchor.txHash = (await wal.sendTransaction({ to: feeTo, value: 1n })) ;
  await pub.waitForTransactionReceipt({ hash: wrongTx.anchor.txHash });
  r = await S.verifySeal(wrongTx, { client: pub });
  ok(!r.ok && r.checks.find((c) => c.name === "anchor transaction").ok === false, "pointing a seal at a transaction without its root fails");

  // ERC-1271: a deployed smart wallet owned by A1
  const fx = JSON.parse(fs.readFileSync(path.join(here, "fixtures/SealTestWallets.json"), "utf8"));
  const dep = async (name, args) => {
    const h = await wal.deployContract({ abi: fx[name].abi, bytecode: fx[name].bytecode, args });
    return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress;
  };
  const w1271 = await dep("Mini1271", [A1.address]);
  const digest = S.sealDigest(base);
  const sc = structuredClone(base);
  sc.signatures.push({ signer: w1271, signature: await A1.sign({ hash: digest }) });
  r = await S.verifySeal(sc, { client: pub });
  ok(r.ok, "an ERC-1271 smart-wallet signature verifies on-chain");
  const scBad = structuredClone(base);
  scBad.signatures.push({ signer: w1271, signature: await A2.sign({ hash: digest }) });
  r = await S.verifySeal(scBad, { client: pub });
  ok(!r.ok, "the smart wallet rejects a signature from a key that does not own it");
  r = await S.verifySeal(sc);
  ok(!r.ok, "offline, a smart-wallet signature is not claimed as valid");

  // ERC-6492: a wallet that is not deployed yet
  const factory = await dep("Mini1271Factory", []);
  const salt = keccak256(toHex("seal-6492"));
  const initCode = concat([fx.Mini1271.bytecode, encodeAbiParameters([{ type: "address" }], [A1.address])]);
  const cf = getContractAddress({ from: factory, opcode: "CREATE2", salt, bytecode: initCode });
  ok((await pub.getCode({ address: cf })) === undefined, "the counterfactual wallet has no code yet");
  const factoryData = encodeFunctionData({ abi: fx.Mini1271Factory.abi, functionName: "deploy", args: [A1.address, salt] });
  const inner = await A1.sign({ hash: digest });
  const wrapped = concat([encodeAbiParameters([{ type: "address" }, { type: "bytes" }, { type: "bytes" }], [factory, factoryData, inner]), "0x6492649264926492649264926492649264926492649264926492649264926492"]);
  const s6492 = structuredClone(base);
  s6492.signatures.push({ signer: cf, signature: wrapped });
  r = await S.verifySeal(s6492, { client: pub });
  ok(r.ok, "an ERC-6492 signature from a not-yet-deployed wallet verifies");
  ok((await pub.getCode({ address: cf })) === undefined, "verifying it did not deploy the wallet (deployless check)");
} finally {
  anvil.kill();
}

console.log(`RESULT: ${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
