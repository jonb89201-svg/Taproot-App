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
  encodeAbiParameters, encodeFunctionData, concat, getContractAddress, parseAbi, custom,
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

// Share links: the compact form (#s=), the old JSON form (#seal=), and what a link may not carry
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const viaLink = async (x) => {                     // a decode error is a failed check, not a crash
  try { return await S.fromFragment(new URL(await S.toLink("https://taproot.possessio.io/seal", x)).hash); } catch (e) { return { error: e.message }; }
};
const link = await S.toLink("https://taproot.possessio.io/seal", two);
ok(new URL(link).hash.startsWith("#s=") && same(await S.fromFragment(new URL(link).hash).catch((e) => ({ error: e.message })), two), "a compact link round-trips the seal exactly, its signers recovered from their signatures");
const legacy = "https://taproot.possessio.io/seal#seal=" + Buffer.from(JSON.stringify(two)).toString("base64url");
ok(link.length * 2 < legacy.length, `the compact link is under half the length of the old JSON link (${link.length} vs ${legacy.length} chars)`);
ok(same(await S.fromFragment(new URL(legacy).hash), two), "an old JSON link (#seal=) still opens");
await throws(async () => S.fromFragment("#seal=" + Buffer.from(JSON.stringify({ ...two, seal: 9 })).toString("base64url")), /format/, "an old link carrying a bad seal is rejected");
const uni = await signed(S.newSeal({ chainId: CHAIN, docHash, title: "Lease 🦭 unit 4 — ✓ 契約", sealedAt: 1791900000 }), A1);
ok(same(await viaLink(uni), uni), "a title in any script round-trips");
const withSmart = structuredClone(two); withSmart.signatures.push({ signer: getAddress("0x" + "11".repeat(20)), signature: "0x" + "ab".repeat(200) });
ok(same(await viaLink(withSmart), withSmart), "a smart-wallet signature keeps its signer in the link");
const anchoredSeal = { ...two, anchor: { txHash: "0x" + "cd".repeat(32), root: "0x" + "ef".repeat(32), proof: ["0x" + "01".repeat(32), "0x" + "02".repeat(32)] } };
ok(same(await viaLink(anchoredSeal), anchoredSeal), "an anchored seal round-trips with its proof");
const raw = Buffer.from(new URL(link).hash.slice(3), "base64url");
await throws(() => S.fromFragment("#s=" + raw.subarray(0, raw.length - 3).toString("base64url")), /cut short/, "a cut-short link is rejected");
await throws(() => S.fromFragment("#s=" + Buffer.concat([raw, Buffer.from([0])]).toString("base64url")), /unexpected bytes/, "a link with extra bytes is rejected");
const badVersion = Buffer.from(raw); badVersion[0] = 9;
await throws(() => S.fromFragment("#s=" + badVersion.toString("base64url")), /unknown version/, "an unknown link version is rejected");
// One changed byte anywhere (a field, a signer check, a signature) must be refused. Without the signer check, most
// changes recovered a stranger's address and the seal still verified (MEASURED 2026-10-15: 284 of 438).
let accepted = 0;
for (let i = 0; i < raw.length; i++) for (const mask of [0x01, 0x80, 0xff]) {
  const b = Buffer.from(raw); b[i] ^= mask;
  try { await S.fromFragment("#s=" + b.toString("base64url")); accepted++; } catch { /* refused */ }
}
ok(accepted === 0, `every one-byte change to a compact link is refused (${raw.length * 3} changes, ${accepted} accepted)`);
// A version-2 link, made by the page on 2026-10-15 before the signer check, still opens. Throwaway signer.
const V2 = "#s=ArSUBdlGakNJRu5-KCVxpMguKkZ-OdfdT4uP6qNqJBcmtoZNzeXD1gYjU2VhbCB0ZXN0IDIwMjYtMTAtMTUgKEJhc2UgU2Vwb2xpYSkBAEEs8es3Uau4VnF0-bG2t6lSXBJOSld-QM1YjFaolE40Mmz3Ik1yd3Z8EC9Jz8od3IznC49WHMfQ6dfaCFKTGgWHHAA";
const v2 = await S.fromFragment(V2).catch((e) => ({ error: e.message }));   // a decode error is a failed check
ok(v2.title === "Seal test 2026-10-15 (Base Sepolia)" && v2.signatures?.[0].signer === "0xB7180B747D2f4786ae676e25c1C2bFA2C6A5f97d", "a version-2 link (no signer check) still opens");
const v3 = v2.error ? "" : new URL(await S.toLink("https://taproot.possessio.io/seal", v2)).hash;
ok(v3.startsWith("#s=") && Buffer.from(v3.slice(3), "base64url")[0] === 3 && same(await S.fromFragment(v3).catch(() => null), v2), "re-shared, it becomes a version-3 link with the signer check");

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

// ---------- Solana: the same root, anchored on another network (offline) ----------
console.log("Seal: Solana anchor (offline)");
{
  const crypto = await import("node:crypto");
  // A throwaway ed25519 payer made here; nothing holds value. Its public key is the last 32 bytes of the SPKI DER.
  const kp = crypto.generateKeyPairSync("ed25519");
  const payer = S.base58Encode(kp.publicKey.export({ type: "spki", format: "der" }).subarray(-32));
  const feeWallet = S.base58Encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));   // a test address, devnet only
  const blockhash = S.base58Encode(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
  const NET = "solana-devnet";

  // base58: Solana's well-known program ids decode to 32 bytes, and leading zeros survive
  ok(S.base58Decode(S.SOLANA_SYSTEM_PROGRAM).every((b) => b === 0) && S.base58Decode(S.SOLANA_SYSTEM_PROGRAM).length === 32, "the System Program id is 32 zero bytes");
  ok(S.base58Decode(S.SOLANA_MEMO_PROGRAM).length === 32 && S.base58Encode(S.base58Decode(S.SOLANA_MEMO_PROGRAM)) === S.SOLANA_MEMO_PROGRAM, "the Memo Program id round-trips");
  ok(S.base58Encode(Uint8Array.from([0, 0, 1])) === "112" && same([...S.base58Decode("112")], [0, 0, 1]), "base58 keeps leading zero bytes");
  // Bitcoin's base58 test vector: "Hello World!" -> 2NEpo7TZRRrLZSi2U
  ok(S.base58Encode(new TextEncoder().encode("Hello World!")) === "2NEpo7TZRRrLZSi2U", "base58 matches the reference vector");

  // the memo: exact text, nothing looser
  const R = "0x" + "ab".repeat(32);
  ok(S.solanaMemo(R) === "SEAL1:" + R, "the memo is SEAL1: and the root in lowercase hex");
  ok(S.decodeSolanaMemo("SEAL1:" + R) === R, "the memo decodes to its root");
  ok(S.decodeSolanaMemo("SEAL1:" + R + " ") === null && S.decodeSolanaMemo("xSEAL1:" + R) === null && S.decodeSolanaMemo("SEAL1:" + R.toUpperCase().replace("0X", "0x")) === null, "a memo with anything extra, or in upper case, is not a Seal anchor");

  // the fee: $0.02 in SOL, rounded up, refused when the price is far from the moment
  const at150 = (t) => ({ price: "15000000000", expo: -8, publishTime: t });
  ok(S.feeLamportsFrom({ ...at150(1000), now: 1000, maxAgeS: 120 }) === 133334n, "$0.02 at $150/SOL is 133,334 lamports (rounded up)");
  ok(S.feeLamportsFrom({ price: "20000000000", expo: -8, publishTime: 1000, now: 1000, maxAgeS: 120 }) === 100000n, "$0.02 at $200/SOL is exactly 100,000 lamports");
  await throws(() => S.feeLamportsFrom({ ...at150(1000), now: 1121, maxAgeS: 120 }), /from the moment/, "a price 121 s from the moment it prices is refused");
  await throws(() => S.feeLamportsFrom({ price: "0", expo: -8, publishTime: 1000, now: 1000, maxAgeS: 120 }), /non-positive/, "a zero price is refused");
  // Hermes, stubbed: a price at a given time, and today's price, which a verifier must not use for an old anchor.
  const pyth = (price = "15000000000", latest = "15000000000") => async (url) => {
    const t = /\/price\/(\d+)\?/.exec(url);
    if (!t && !/\/price\/latest\?/.test(url)) throw new Error("unexpected " + url);
    return { parsed: [{ id: S.PYTH_SOL_USD.slice(2), price: { price: t ? price : latest, conf: "1", expo: -8, publish_time: t ? Number(t[1]) : 1791900050 } }] };
  };
  ok((await S.quoteSolanaFee(pyth(), NET, 1791900000)).lamports === 133334n, "the live quote reads Pyth's SOL/USD feed");

  // anchoring stays off until a fee wallet is set
  const sealA = await signed(S.newSeal({ chainId: CHAIN, docHash, title: "Callout, block 1", sealedAt: 1791900000 }), A0);
  const sealB = await signed(S.newSeal({ chainId: CHAIN, docHash: "0x" + "cd".repeat(32), title: "Callout, block 2", sealedAt: 1791900001 }), A1);
  await throws(() => S.buildSolanaAnchorTx({ network: "solana-mainnet", seals: [sealA], lamports: 133334n, payer, recentBlockhash: blockhash }), /not enabled on Solana yet/, "Solana mainnet can't anchor until its fee wallet is set");
  S.SOLANA[NET].feeAddress = feeWallet;
  try {
    await throws(() => S.buildSolanaAnchorTx({ network: NET, seals: [base], lamports: 133334n, payer, recentBlockhash: blockhash }), /signed before/, "an unsigned seal can't be anchored on Solana");
    await throws(() => S.buildSolanaAnchorTx({ network: NET, seals: [sealA], lamports: 133334n, payer: feeWallet, recentBlockhash: blockhash }), /payer can't be the fee wallet/, "the fee wallet can't pay itself");
    const plan = S.buildSolanaAnchorTx({ network: NET, seals: [sealA, sealB], lamports: 133334n, payer, recentBlockhash: blockhash });
    const evm = S.buildAnchorTx({ chainId: CHAIN, seals: [sealA, sealB], feeWei: 1n });
    ok(plan.root === evm.root, "the Solana anchor carries the same root as the Base anchor for the same seals");

    // An independent reading of the bytes, the way a Solana node lays them out.
    const tx = plan.transaction;
    ok(tx[0] === 1 && tx.subarray(1, 65).every((b) => b === 0) && same([...tx.subarray(65)], [...plan.message]), "the transaction is one empty signature slot, then the message");
    const m = plan.message; let i = 0;
    const hdr = [m[i++], m[i++], m[i++]]; const nk = m[i++]; const keys = [];
    for (let k = 0; k < nk; k++) { keys.push(S.base58Encode(m.subarray(i, i + 32))); i += 32; }
    const bh = S.base58Encode(m.subarray(i, i + 32)); i += 32;
    const nix = m[i++]; const ixs = [];
    for (let k = 0; k < nix; k++) {
      const programIdIndex = m[i++]; const na = m[i++]; const accounts = [...m.subarray(i, i + na)]; i += na;
      const nd = m[i++]; const data = m.subarray(i, i + nd); i += nd;
      ixs.push({ programIdIndex, accounts, data: S.base58Encode(data), raw: data });
    }
    ok(i === m.length, "the message reads to its last byte");
    ok(same(hdr, [1, 0, 2]) && same(keys, [payer, feeWallet, S.SOLANA_SYSTEM_PROGRAM, S.SOLANA_MEMO_PROGRAM]) && bh === blockhash, "header, account keys and blockhash are laid out as Solana expects");
    ok(ixs.length === 2 && ixs[0].programIdIndex === 2 && same(ixs[0].accounts, [0, 1]) && same([...ixs[0].raw], [2, 0, 0, 0, 0xd6, 0x08, 0x02, 0, 0, 0, 0, 0]), "instruction 1 is a System transfer of 133,334 lamports, payer to fee wallet");
    ok(ixs[1].programIdIndex === 3 && ixs[1].accounts.length === 0 && new TextDecoder().decode(ixs[1].raw) === "SEAL1:" + plan.root, "instruction 2 is the Memo carrying SEAL1: and the root");
    const sig = crypto.sign(null, plan.message, kp.privateKey);
    ok(crypto.verify(null, plan.message, kp.publicKey, sig), "a wallet's ed25519 signature over these message bytes verifies");

    const sigB58 = S.base58Encode(sig);
    // The payer's wallet, as the Farcaster mini app hands it over: three connect shapes, and a send that takes bytes.
    const sendsBack = (answer) => ({ signAndSendTransaction: async ({ transaction }) => { sentBytes = transaction.serialize({ verifySignatures: false }); return answer; } });
    let sentBytes = null;
    ok(await S.sendSolanaAnchor(sendsBack({ signature: sigB58 }), plan.transaction) === sigB58 && same([...sentBytes], [...plan.transaction]), "the wallet is handed exactly the anchor's bytes and its signature comes back");
    await throws(() => S.sendSolanaAnchor(sendsBack({ ok: true }), plan.transaction), /may or may not have sent/, "a wallet that returns no signature is reported, not retried");
    await throws(() => S.sendSolanaAnchor(sendsBack({ signature: "abc" }), plan.transaction), /may or may not have sent/, "a short signature is not taken for one");
    ok(await S.connectSolanaWallet({ connect: async () => ({ publicKey: { toBase58: () => payer } }) }) === payer, "a phantom-style wallet connects");
    ok(await S.connectSolanaWallet({ features: { "standard:connect": { connect: async () => ({ accounts: [{ address: payer }] }) } } }) === payer, "a Wallet Standard wallet connects");
    ok(await S.connectSolanaWallet({ request: async ({ method }) => (method === "connect" ? { publicKey: payer } : null) }) === payer, "a request-only wallet (Farcaster's shape) connects");
    await throws(() => S.connectSolanaWallet({ request: async () => ({ publicKey: "0xnope" }) }), /address/, "a wallet that answers with no Solana address is refused");

    // Verifying against a Solana node, stubbed: the node returns the transaction as getTransaction does.
    const anchored = S.attachSolanaAnchor([sealA, sealB], plan.leaves, plan.root, NET, sigB58);
    const nodeTx = (edit = (x) => x) => edit({
      slot: 400000000, blockTime: 1791900060, meta: { err: null },
      transaction: { signatures: [sigB58], message: { accountKeys: keys, instructions: ixs.map(({ programIdIndex, accounts, data }) => ({ programIdIndex, accounts, data })) } },
    });
    const node = (edit) => async (method, params) => { if (method !== "getTransaction" || params[0] !== sigB58) throw new Error("unexpected " + method); return nodeTx(edit); };
    const sol = (edit, price) => ({ rpc: node(edit), getJson: pyth(price) });
    r = await S.verifySeal(anchored[1], { solana: sol() });
    ok(r.ok && r.anchoredAt && r.anchoredAt.by === payer && r.anchoredAt.slot === 400000000, "a Solana-anchored seal verifies: proof, transaction, fee, signature; the anchoring wallet is named");
    ok(same(await viaLink(anchored[1]), anchored[1]), "a Solana-anchored seal round-trips through a share link");
    const failed = (edit, price) => S.verifySeal(anchored[0], { solana: sol(edit, price) }).then((x) => x.ok);
    ok(!(await failed((x) => ({ ...x, meta: { err: { InstructionError: [0, "Custom"] } } }))), "a failed Solana transaction does not anchor");
    ok(!(await failed((x) => { x.transaction.message.instructions[1].data = S.base58Encode(new TextEncoder().encode(S.solanaMemo("0x" + "00".repeat(32)))); return x; })), "a memo with another root does not anchor");
    ok(!(await failed((x) => { x.transaction.message.accountKeys = [keys[0], payer.slice(0, -1) + (payer.endsWith("A") ? "B" : "A"), keys[2], keys[3]]; return x; })), "a fee sent to another wallet does not anchor");
    ok(!(await failed(undefined, "5000000000")), "an anchor that paid the fee for $150/SOL when SOL was $50 at its block time is under-paid");
    ok(!(await failed(undefined, "14200000000")), "at $142/SOL the same payment is 94.7% of the fee, just outside the 5% tolerance");
    ok(await failed(undefined, "14500000000"), "at $145/SOL the payment is 96.7% of the fee, within the 5% tolerance");
    ok(!(await failed((x) => { x.transaction.signatures = [S.base58Encode(new Uint8Array(64).fill(7))]; return x; })), "an RPC answering with another transaction does not anchor");
    ok(!(await failed(() => null)), "a transaction the node doesn't have does not anchor");
    const moved = structuredClone(anchored[0]); moved.title = "Callout, block 9";
    r = await S.verifySeal(moved, { solana: sol() });
    ok(!r.ok && r.checks.find((c) => c.name === "anchor proof").ok === false, "a changed seal is not in the Solana-anchored batch");
    await throws(() => S.validateSeal({ ...anchored[0], anchor: { ...anchored[0].anchor, network: "solana-testnet" } }), /network/, "an unknown anchor network is rejected");
    await throws(() => S.validateSeal({ ...anchored[0], anchor: { ...anchored[0].anchor, signature: "abc" } }), /signature/, "a short Solana signature is rejected");
  } finally { S.SOLANA[NET].feeAddress = null; }
}

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
  const lower = (x) => JSON.stringify({ ...x, signatures: x.signatures.map((g) => ({ ...g, signer: g.signer.toLowerCase() })) });
  for (const [name, x] of [["ERC-1271", sc], ["ERC-6492", s6492]]) {
    const back = await viaLink(x);
    ok(!back.error && lower(back) === lower(x) && (await S.verifySeal(back, { client: pub })).ok, `a real ${name} smart-wallet seal survives the compact link and still verifies`);
  }
  // ---- The anchor must pay (KupiaSec, 2026-10-15: the verifier read only the calldata and the root, so the fee
  //      was optional). It must go to the fee wallet and pay the fee its block owed, within FEE_TOLERANCE_BPS.
  const check = (res, name) => res.checks.find((x) => x.name === name);
  const anchorTo = async (to, value) => {
    const h = await wal.sendTransaction({ to, value, data: S.anchorCalldata(plan.root) });
    await pub.waitForTransactionReceipt({ hash: h });
    const s = { ...anchored[0], anchor: { ...anchored[0].anchor, txHash: h } };
    return { s, r: await S.verifySeal(s, { client: pub }) };
  };
  r = (await anchorTo(A1.address, q.wei)).r;
  ok(!r.ok && check(r, "anchor transaction").ok === false && /fee wallet/.test(check(r, "anchor transaction").detail), "an anchor with the right root sent anywhere but the fee wallet fails");
  r = (await anchorTo(feeTo, 0n)).r;
  ok(!r.ok && check(r, "anchor transaction").ok === true && check(r, "anchor fee").ok === false, "an anchor to the fee wallet that pays nothing fails the fee check");
  const half = await anchorTo(feeTo, q.wei / 2n);
  ok(!half.r.ok && /^UNDER-PAID/.test(check(half.r, "anchor fee").detail), "half the fee is under-paid");
  r = (await anchorTo(feeTo, (q.wei * 94n) / 100n)).r;
  ok(!r.ok && check(r, "anchor fee").ok === false, "94% of the fee is under-paid (tolerance " + S.FEE_TOLERANCE_BPS + " bps)");
  r = (await anchorTo(feeTo, (q.wei * 96n) / 100n)).r;
  ok(r.ok && check(r, "anchor fee").ok === true, "96% of the fee passes: the price can move between the quote and the block");
  ok(/^paid [0-9.]+ ETH against [0-9.]+ ETH owed \(\$0\.02 at [0-9.]+ ETH\/USD, the price in force at block \d+\)$/.test(check(r, "anchor fee").detail), "the fee check says what was paid, what was owed and the price it used");

  // ---- The fee is judged at the anchor's block, not today's. Hand the feed a doubled price (the fee in ETH halves
  //      today): the half-paid anchor above still fails and the full one still passes, each at its own block's price.
  const mock = await dep("MockFeed", [q.answer * 2n]);
  await pub.request({ method: "anvil_setCode", params: [S.CHAINS[CHAIN].ethUsdFeed, await pub.getCode({ address: mock })] });
  const qNow = await S.quoteFee(pub, CHAIN, Number((await pub.getBlock()).timestamp));
  ok(qNow.answer === q.answer * 2n && qNow.wei <= q.wei / 2n + 1n, "today's quote halves with the doubled price");
  r = await S.verifySeal(half.s, { client: pub });
  ok(!r.ok && check(r, "anchor fee").ok === false, "the half-paid anchor still fails: judged at the price in force at its block");
  r = await S.verifySeal(anchored[0], { client: pub });
  ok(r.ok && check(r, "anchor fee").detail.includes("at " + (Number(q.answer) / 10 ** q.decimals).toFixed(2) + " ETH/USD"), "the full-paid anchor still passes, at its block's price");

  // ---- Signatures are judged at the anchor's block (KupiaSec, 2026-10-15: smart-wallet signatures were checked
  //      against today's state). A smart wallet's owner can change; what counts is who owned it when the anchor
  //      landed. sc is signed by the owner A1, scBad by A2. Anchor both in one batch (an anchor commits bytes, not
  //      validity), then hand the wallet to A2 by swapping in the code of a Mini1271 owned by A2.
  const planW = S.buildAnchorTx({ chainId: CHAIN, seals: [sc, scBad], feeWei: q.wei });
  const hW = await wal.sendTransaction(planW.tx);
  await pub.waitForTransactionReceipt({ hash: hW });
  const [ownerThen, strangerThen] = S.attachAnchor([sc, scBad], planW.leaves, planW.root, hW);
  const sigName = "signature " + getAddress(w1271);
  r = await S.verifySeal(ownerThen, { client: pub });
  ok(r.ok && /at the anchor's block \d+/.test(check(r, sigName).detail), "an anchored smart-wallet seal is checked at the anchor's block");
  const w1271b = await dep("Mini1271", [A2.address]);
  await pub.request({ method: "anvil_setCode", params: [w1271, await pub.getCode({ address: w1271b })] });
  r = await S.verifySeal(sc, { client: pub });
  ok(!r.ok && /at the latest block/.test(check(r, sigName).detail), "after the owner change, the old owner's unanchored seal no longer verifies today");
  r = await S.verifySeal(ownerThen, { client: pub });
  ok(r.ok, "anchored, it still does: at its block, A1 owned the wallet");
  r = await S.verifySeal(scBad, { client: pub });
  ok(r.ok, "today, the new owner's signature verifies on an unanchored seal");
  r = await S.verifySeal(strangerThen, { client: pub });
  ok(!r.ok && check(r, sigName).ok === false, "anchored before the change, it fails: A2 did not own the wallet at that block");

  // ERC-6492 at the anchor's block: the wallet is still not deployed, and the deployless check works there too.
  const plan6 = S.buildAnchorTx({ chainId: CHAIN, seals: [s6492], feeWei: q.wei });
  const h6 = await wal.sendTransaction(plan6.tx);
  await pub.waitForTransactionReceipt({ hash: h6 });
  r = await S.verifySeal(S.attachAnchor([s6492], plan6.leaves, plan6.root, h6)[0], { client: pub });
  ok(r.ok && (await pub.getCode({ address: cf })) === undefined, "an anchored ERC-6492 seal verifies at its block, wallet still undeployed");

  // An RPC without state at the anchor's block can do neither check. It says so, and the seal is not claimed.
  const noHistory = createPublicClient({ chain, transport: custom({ request: async ({ method, params }) => {
    if ((method === "eth_call" || method === "eth_getCode") && params[1] && params[1] !== "latest" && params[1] !== "pending") throw new Error("missing trie node");
    return pub.request({ method, params });
  } }) });
  r = await S.verifySeal(ownerThen, { client: noHistory });
  ok(!r.ok && /holds no state at block/.test(check(r, sigName).detail) && /could not price the fee/.test(check(r, "anchor fee").detail), "an RPC with no state at the anchor's block says so instead of blaming the signature, and the fee is not claimed");
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
