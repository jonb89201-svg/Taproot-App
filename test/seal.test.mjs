// Seal tests. node test/seal.test.mjs
//   Offline part: always runs.
//   Fork part: needs anvil (Foundry) and network to https://sepolia.base.org and
//   https://mainnet.base.org. It forks Base Sepolia, reads the real Chainlink ETH/USD feed,
//   sends a real anchor transaction and checks ERC-1271 and ERC-6492 signatures; then it
//   forks Base mainnet and anchors to the real fee wallet. When anvil is missing it prints
//   SKIP and the run exits 2, so it can never be counted as a pass.
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
// The Seal fee wallet, pinned here so that changing where fees go is never an accident.
const FEE_WALLET = "0x9Ce4cb26A5F7B50826B07eb8B2C065F0Bb37a6c9";

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
ok(S.buildAnchorTx({ chainId: 8453, seals: [otherChain], feeWei: 1n }).tx.to === FEE_WALLET, "Base mainnet anchoring is on, and its fee goes to the Seal fee wallet");
ok(S.CHAINS[CHAIN].feeAddress === FEE_WALLET, "Base Sepolia's fee goes to the same wallet");
{
  const saved = S.CHAINS[8453].feeAddress;
  S.CHAINS[8453].feeAddress = null;
  await throws(() => S.buildAnchorTx({ chainId: 8453, seals: [otherChain], feeWei: 1n }), /not enabled/, "a network without a fee address cannot anchor");
  S.CHAINS[8453].feeAddress = saved;
}

// Who may send an anchor: what a wallet reports about itself (EIP-5792 capabilities)
ok(S.smartAccountFrom({ "0x2105": { atomic: { status: "supported" } } }, 8453), "a wallet reporting atomic 'supported' runs as a smart account");
ok(S.smartAccountFrom({ "0x2105": { atomicBatch: { supported: true } } }, 8453), "so does one reporting the earlier atomicBatch capability");
ok(S.smartAccountFrom({ "0x0": { atomic: { status: "supported" } } }, 8453), "a report for every chain (0x0) counts");
ok(!S.smartAccountFrom({ "0x2105": { atomic: { status: "ready" } } }, 8453) && !S.smartAccountFrom({ "0x2105": { atomic: { status: "unsupported" } } }, 8453), "'ready' and 'unsupported' are plain wallets");
ok(!S.smartAccountFrom({ "0x14a34": { atomic: { status: "supported" } } }, 8453), "a report for another chain does not count");
ok(!S.smartAccountFrom(null, 8453) && !S.smartAccountFrom({}, 8453) && !S.smartAccountFrom("x", 8453), "no report means a plain wallet");
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

  ok((await S.assertPlainFeeAddress(pub, CHAIN)) === FEE_WALLET, "the fee wallet has no code, so anchors to it can land");
  {
    const saved = S.CHAINS[CHAIN].feeAddress;
    S.CHAINS[CHAIN].feeAddress = S.CHAINS[CHAIN].ethUsdFeed;                 // any contract
    await throws(() => S.assertPlainFeeAddress(pub, CHAIN), /is a contract/, "a fee address with contract code is refused before anchoring");
    S.CHAINS[CHAIN].feeAddress = saved;
  }

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

// ---------- fork of Base mainnet: the production fee path ----------
console.log("Seal: fork of Base mainnet");
const MAIN = 8453, PORT2 = PORT + 1;
const anvil2 = spawn(anvilBin, ["--fork-url", process.env.SEAL_FORK_RPC_MAINNET || "https://mainnet.base.org", "--port", String(PORT2), "--silent"], { stdio: "ignore" });
const RPC2 = `http://127.0.0.1:${PORT2}`;
const chainM = { id: MAIN, name: "Base (fork)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC2] } } };
const pubM = createPublicClient({ chain: chainM, transport: http(RPC2) });
const walM = createWalletClient({ account: A2, chain: chainM, transport: http(RPC2) });
try {
  for (let i = 0; i < 60; i++) { try { await pubM.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  ok((await pubM.getChainId()) === MAIN, "anvil forked Base mainnet (chainId 8453)");
  const qM = await S.quoteFee(pubM, MAIN, Number((await pubM.getBlock()).timestamp));
  console.log(`    ETH/USD ${Number(qM.answer) / 10 ** qM.decimals}, fee ${qM.wei} wei`);
  ok(qM.decimals === 8 && qM.wei * qM.answer >= 2000000n * 10n ** 18n, "the mainnet Chainlink feed prices the fee at $0.02 or more");
  ok((await S.assertPlainFeeAddress(pubM, MAIN)) === FEE_WALLET, "on mainnet the fee wallet is a plain wallet (no code)");

  const sM = await signed(S.newSeal({ chainId: MAIN, docHash, title: "Lease, unit 4", sealedAt: 1791900000 }), A0);
  const planM = S.buildAnchorTx({ chainId: MAIN, seals: [sM], feeWei: qM.wei });
  const beforeM = await pubM.getBalance({ address: FEE_WALLET });
  const hM = await walM.sendTransaction(planM.tx);
  const rcM = await pubM.waitForTransactionReceipt({ hash: hM });
  ok(rcM.status === "success" && (await pubM.getBalance({ address: FEE_WALLET })) - beforeM === qM.wei, "a mainnet anchor lands and the fee wallet receives exactly the quoted fee");
  ok((await pubM.getTransaction({ hash: hM })).input.toLowerCase().endsWith(S.BUILDER_SUFFIX.slice(2)), "the mainnet anchor carries the Builder Code");
  r = await S.verifySeal(S.attachAnchor([sM], planM.leaves, planM.root, hM)[0], { client: pubM, fileHash: docHash });
  ok(r.ok && r.anchoredAt.block === Number(rcM.blockNumber), "the mainnet-anchored seal verifies on-chain");

  // Why the fee does not go straight to the STEEL Treasury Safe, and why the sweep works.
  const viaSafe = await walM.sendTransaction({ ...planM.tx, to: S.STEEL_TREASURY_SAFE, gas: 200000n });
  ok((await pubM.waitForTransactionReceipt({ hash: viaSafe })).status === "reverted", "an anchor sent straight to the STEEL Treasury Safe reverts (ETH plus data)");
  const safeBefore = await pubM.getBalance({ address: S.STEEL_TREASURY_SAFE });
  const sweep = await walM.sendTransaction({ to: S.STEEL_TREASURY_SAFE, value: qM.wei });
  ok((await pubM.waitForTransactionReceipt({ hash: sweep })).status === "success" && (await pubM.getBalance({ address: S.STEEL_TREASURY_SAFE })) - safeBefore === qM.wei, "a plain transfer (the sweep) into the Treasury Safe lands");
  {
    const saved = S.CHAINS[MAIN].feeAddress;
    S.CHAINS[MAIN].feeAddress = S.STEEL_TREASURY_SAFE;
    await throws(() => S.assertPlainFeeAddress(pubM, MAIN), /is a contract/, "pointing the fee address at the Treasury Safe is refused before anchoring");
    S.CHAINS[MAIN].feeAddress = saved;
  }

  // A smart-wallet sender: a real Coinbase Smart Wallet (the Base Account contract), from its factory on Base.
  const FACTORY = "0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a";
  const fAbi = parseAbi(["function createAccount(bytes[] owners, uint256 nonce) payable returns (address)", "function getAddress(bytes[] owners, uint256 nonce) view returns (address)"]);
  const swOwners = [encodeAbiParameters([{ type: "address" }], [A2.address])];
  const sw = await pubM.readContract({ address: FACTORY, abi: fAbi, functionName: "getAddress", args: [swOwners, 1n] });
  const passes = async (...a) => { try { await S.assertPlainSender(...a); return true; } catch { return false; } };
  ok((await pubM.getCode({ address: sw })) === undefined && (await passes(pubM, sw, null, MAIN)), "an undeployed smart wallet has no code, so the code check alone lets it through");
  await throws(() => S.assertPlainSender(pubM, sw, { "0x2105": { atomic: { status: "supported" } } }, MAIN), /regular wallet/, "its wallet's own report refuses it");
  await pubM.waitForTransactionReceipt({ hash: await walM.writeContract({ address: FACTORY, abi: fAbi, functionName: "createAccount", args: [swOwners, 1n] }) });
  await throws(() => S.assertPlainSender(pubM, sw, null, MAIN), /contract code/, "a deployed smart wallet is refused by its code, with no report needed");
  ok(/^0xef0100[0-9a-f]{40}$/i.test(await pubM.getCode({ address: A2.address })), "the public test account is EIP-7702-delegated on Base mainnet (anyone holding its known key can do that)");
  ok(await passes(pubM, A2.address, null, MAIN), "a 7702-delegated regular wallet passes: it sends its own transactions, and its anchor above verified");
  ok(await passes(pubM, privateKeyToAccount(keccak256(toHex("seal fresh key"))).address, null, MAIN), "a fresh regular wallet with no code passes");

  // What the guard prevents, measured: the same anchor sent through the smart wallet's execute().
  await pubM.waitForTransactionReceipt({ hash: await walM.sendTransaction({ to: sw, value: 10n ** 16n }) });
  const planSW = S.buildAnchorTx({ chainId: MAIN, seals: [sM], feeWei: qM.wei });
  const feeSW = await pubM.getBalance({ address: FEE_WALLET });
  const hSW = await walM.writeContract({ address: sw, abi: parseAbi(["function execute(address target, uint256 value, bytes data) payable"]), functionName: "execute", args: [planSW.tx.to, planSW.tx.value, planSW.tx.data] });
  const rcSW = await pubM.waitForTransactionReceipt({ hash: hSW });
  const inSW = (await pubM.getTransaction({ hash: hSW })).input.toLowerCase();
  ok(rcSW.status === "success" && (await pubM.getBalance({ address: FEE_WALLET })) - feeSW === qM.wei, "through a smart wallet the fee still moves");
  ok(!inSW.endsWith("80218021802180218021802180218021") && inSW.includes(S.BUILDER_SUFFIX.slice(2)), "but the Builder Code ends up inside, under padding, where Base does not read it");
  r = await S.verifySeal(S.attachAnchor([sM], planSW.leaves, planSW.root, hSW)[0], { client: pubM });
  ok(!r.ok && r.checks.find((c) => c.name === "anchor transaction").ok === false, "and the seal cannot be verified: the transaction does not start with the anchor");
} finally {
  anvil2.kill();
}

console.log(`RESULT: ${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
