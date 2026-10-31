// Seal core: everything the Seal page does that can be tested without a browser.
// The page loads this file with an import map that points "viem" at a pinned CDN build;
// the tests load the same file with viem from node_modules. Same code, both places.
//
// What a seal is:
//   docHash   SHA-256 of the document's bytes, computed on the signer's device.
//   title     a short human label.
//   sealedAt  unix seconds.
// Each signer signs the same EIP-712 message (domain "Seal", version "1", chainId).
// Signing and verifying are free. Anchoring posts a Merkle root of seals on Base in
// one transaction, which carries a $0.02 fee in ETH (priced live from Chainlink
// ETH/USD) and the Taproot Builder Code.

import {
  hashTypedData,
  keccak256,
  concat,
  toHex,
  isHex,
  isAddress,
  getAddress,
  recoverTypedDataAddress,
  createPublicClient,
  http,
  parseAbi,
  formatEther,
} from "viem";

export const SEAL_FORMAT = 1;

// Fees go to a plain fee wallet, the Architect's 0x9Ce4…a6c9, which the Architect sweeps into the STEEL
// Treasury Safe (STEEL_TREASURY_SAFE). The Safe can't take an anchor itself: an anchor is ETH plus data, and
// Safe 1.4.1 reverts on that, while a plain transfer into it succeeds (MEASURED 2026-10-15 on a fork of Base
// mainnet). So assertPlainFeeAddress() refuses any fee address that has contract code.
// A network whose feeAddress is null cannot anchor. Base Sepolia moves test ETH only.
export const CHAINS = {
  8453: {
    name: "Base",
    rpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
    ethUsdFeed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    maxFeedAgeS: 3600, // ~20 min heartbeat
    feeAddress: "0x9Ce4cb26A5F7B50826B07eb8B2C065F0Bb37a6c9",
  },
  84532: {
    name: "Base Sepolia",
    rpc: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
    ethUsdFeed: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
    maxFeedAgeS: 86400,
    feeAddress: "0x9Ce4cb26A5F7B50826B07eb8B2C065F0Bb37a6c9", // the same fee wallet; test ETH only
  },
};

// Where swept fees end up: the STEEL Treasury Safe on Base mainnet (Safe 1.4.1, 2-of-4). Shown on the page;
// never used as a transaction target here.
export const STEEL_TREASURY_SAFE = "0x19495180FFA00B8311c85DCF76A89CCbFB174EA0";

export const FEE_USD_CENTS = 2n; // $0.02 per anchor transaction, however many seals it carries

// A verifier accepts an anchor that paid at least this share of the fee, at the ETH/USD price in force at the
// anchor's block. The page quotes moments before the wallet sends, and the price can move before the block that
// takes the anchor. 500 bps of $0.02 is a tenth of a cent.
export const FEE_TOLERANCE_BPS = 500n;

// ERC-8021 data suffix for Builder Code "bc_ovheoidh" (same bytes as index.html's BUILDER).
export const BUILDER_SUFFIX = "0x62635f6f7668656f6964680b0080218021802180218021802180218021";

// Anchor calldata: "SEAL" (0x5345414c) + format byte + 32-byte Merkle root + Builder suffix.
export const ANCHOR_MAGIC = "0x5345414c01";

export const SEAL_TYPES = {
  Seal: [
    { name: "docHash", type: "bytes32" },
    { name: "title", type: "string" },
    { name: "sealedAt", type: "uint64" },
  ],
};

export const TITLE_MAX = 200;
export const SIGNERS_MAX = 20;
export const BATCH_MAX = 256;

const B32 = /^0x[0-9a-fA-F]{64}$/;

export function sealDomain(chainId) {
  return { name: "Seal", version: "1", chainId };
}

// ---------- document hashing ----------

export async function sha256Hex(bytes) {
  const d = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(d));
}

// ---------- the seal object ----------

export function newSeal({ chainId, docHash, title, sealedAt }) {
  const seal = {
    seal: SEAL_FORMAT,
    chainId,
    hashAlg: "sha256",
    docHash: String(docHash).toLowerCase(),
    title,
    sealedAt,
    signatures: [],
  };
  validateSeal(seal);
  return seal;
}

// The page and the verifier both run every seal through this before using it.
// A seal comes from a link or a file, so nothing in it is trusted.
export function validateSeal(s) {
  const fail = (m) => { throw new Error("invalid seal: " + m); };
  if (!s || typeof s !== "object" || Array.isArray(s)) fail("not an object");
  if (s.seal !== SEAL_FORMAT) fail("unknown format " + s.seal);
  if (!CHAINS[s.chainId]) fail("unsupported chainId " + s.chainId);
  if (s.hashAlg !== "sha256") fail("hashAlg must be sha256");
  if (typeof s.docHash !== "string" || !B32.test(s.docHash)) fail("docHash must be 32 bytes hex");
  if (typeof s.title !== "string" || s.title.length === 0 || s.title.length > TITLE_MAX) fail("title must be 1-" + TITLE_MAX + " chars");
  if (!Number.isSafeInteger(s.sealedAt) || s.sealedAt <= 0) fail("sealedAt must be a positive integer");
  if (!Array.isArray(s.signatures) || s.signatures.length > SIGNERS_MAX) fail("signatures must be a list of at most " + SIGNERS_MAX);
  const seen = new Set();
  for (const g of s.signatures) {
    if (!g || typeof g.signer !== "string" || !isAddress(g.signer)) fail("bad signer");
    if (typeof g.signature !== "string" || !isHex(g.signature) || g.signature.length < 132) fail("bad signature for " + g.signer);
    const k = g.signer.toLowerCase();
    if (seen.has(k)) fail("duplicate signer " + g.signer);
    seen.add(k);
  }
  if (s.anchor !== undefined) {
    const a = s.anchor;
    if (!a || typeof a !== "object") fail("bad anchor");
    if (a.network !== undefined) {
      // An anchor on another network: the same root, written there. Only Solana so far.
      if (!SOLANA[a.network]) fail("unsupported anchor network " + a.network);
      if (a.txHash !== undefined) fail("a Solana anchor carries a signature, not a txHash");
      let sig = null;
      try { sig = base58Decode(String(a.signature || "")); } catch { /* reported below */ }
      if (!sig || sig.length !== 64) fail("anchor.signature must be a 64-byte base58 Solana transaction signature");
    } else if (!B32.test(a.txHash || "")) fail("anchor.txHash must be 32 bytes hex");
    if (!B32.test(a.root || "")) fail("anchor.root must be 32 bytes hex");
    if (!Array.isArray(a.proof) || a.proof.length > 16 || !a.proof.every((p) => B32.test(p))) fail("bad anchor.proof");
  }
  return s;
}

export function sealMessage(s) {
  return { docHash: s.docHash, title: s.title, sealedAt: BigInt(s.sealedAt) };
}

// The EIP-712 digest every signer signs.
export function sealDigest(s) {
  return hashTypedData({ domain: sealDomain(s.chainId), types: SEAL_TYPES, primaryType: "Seal", message: sealMessage(s) });
}

export function typedDataFor(s) {
  return { domain: sealDomain(s.chainId), types: SEAL_TYPES, primaryType: "Seal", message: sealMessage(s) };
}

// The anchored leaf commits to the message AND the signatures, in order, so an
// anchor proves these signatures existed by that block, not just the document hash.
export function sealLeaf(s) {
  const sigs = s.signatures.map((g) => g.signature);
  const sigsHash = keccak256(sigs.length ? concat(sigs) : "0x");
  return keccak256(concat([sealDigest(s), sigsHash]));
}

// ---------- Merkle batch (sorted-pair keccak; an odd node is carried up) ----------

function hashPair(a, b) {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export function merkleRoot(leaves) {
  if (!leaves.length) throw new Error("no leaves");
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return level[0];
}

export function merkleProof(leaves, index) {
  if (index < 0 || index >= leaves.length) throw new Error("index out of range");
  const proof = [];
  let level = leaves.slice();
  let i = index;
  while (level.length > 1) {
    const sib = i ^ 1;
    if (sib < level.length) proof.push(level[sib]);
    const next = [];
    for (let j = 0; j < level.length; j += 2) next.push(j + 1 < level.length ? hashPair(level[j], level[j + 1]) : level[j]);
    level = next;
    i = i >> 1;
  }
  return proof;
}

export function verifyProof(leaf, proof, root) {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}

// ---------- fee: $0.02 in ETH at the moment of anchoring ----------

const FEED_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

// Pure part, so the arithmetic is testable on its own. Rounds UP: never under-charge.
export function feeWeiFrom({ answer, decimals, updatedAt, now, maxAgeS, cents = FEE_USD_CENTS }) {
  if (typeof answer !== "bigint" || answer <= 0n) throw new Error("price feed returned a non-positive price");
  if (now - Number(updatedAt) > maxAgeS) throw new Error("price feed is stale (" + (now - Number(updatedAt)) + "s old)");
  // fee_usd = cents/100; price_usd = answer / 10^decimals; wei = fee_usd / price_usd * 1e18
  const num = cents * 10n ** BigInt(decimals) * 10n ** 18n;
  const den = 100n * answer;
  return (num + den - 1n) / den;
}

// `blockNumber`, when given, reads the feed as it stood at that block: the fee an anchor in that block owed.
export async function quoteFee(client, chainId, now = Math.floor(Date.now() / 1000), blockNumber) {
  const c = CHAINS[chainId];
  if (!c) throw new Error("unsupported chain " + chainId);
  const [decimals, round] = await Promise.all([
    client.readContract({ address: c.ethUsdFeed, abi: FEED_ABI, functionName: "decimals", blockNumber }),
    client.readContract({ address: c.ethUsdFeed, abi: FEED_ABI, functionName: "latestRoundData", blockNumber }),
  ]);
  const answer = round[1], updatedAt = round[3];
  const wei = feeWeiFrom({ answer, decimals, updatedAt, now, maxAgeS: c.maxFeedAgeS });
  return { wei, answer, decimals: Number(decimals), updatedAt: Number(updatedAt) };
}

// ---------- anchor transaction ----------

export function anchorCalldata(root) {
  if (!B32.test(root)) throw new Error("root must be 32 bytes hex");
  return concat([ANCHOR_MAGIC, root, BUILDER_SUFFIX]);
}

// Returns the root, or null if this calldata is not a Seal anchor.
export function decodeAnchor(data) {
  if (typeof data !== "string") return null;
  const d = data.toLowerCase();
  const m = ANCHOR_MAGIC.slice(2);
  if (!d.startsWith("0x" + m) || d.length < 2 + m.length + 64) return null;
  return "0x" + d.slice(2 + m.length, 2 + m.length + 64);
}

export function buildAnchorTx({ chainId, seals, feeWei }) {
  const c = CHAINS[chainId];
  if (!c) throw new Error("unsupported chain " + chainId);
  if (!c.feeAddress) throw new Error("anchoring is not enabled on " + c.name + " yet");
  if (!seals.length || seals.length > BATCH_MAX) throw new Error("batch must hold 1-" + BATCH_MAX + " seals");
  for (const s of seals) {
    validateSeal(s);
    if (s.chainId !== chainId) throw new Error("every seal in a batch must be for chain " + chainId);
    if (!s.signatures.length) throw new Error("a seal must be signed before it is anchored");
  }
  const leaves = seals.map(sealLeaf);
  const root = merkleRoot(leaves);
  return { root, leaves, tx: { to: getAddress(c.feeAddress), value: feeWei, data: anchorCalldata(root) } };
}

// The fee address must be a plain wallet. A contract wallet such as a Safe reverts on ETH plus data, and the
// anchor would fail after the signer paid gas. Checked on-chain before every anchor; returns the fee address.
export async function assertPlainFeeAddress(client, chainId) {
  const c = CHAINS[chainId];
  if (!c || !c.feeAddress) throw new Error("anchoring is not enabled on " + (c ? c.name : "chain " + chainId) + " yet");
  const code = await client.getCode({ address: c.feeAddress });
  if (code && code !== "0x") throw new Error("the fee address " + getAddress(c.feeAddress) + " is a contract; an anchor sent to it would revert");
  return getAddress(c.feeAddress);
}

// ---------- who may send an anchor ----------
// An anchor must come from a regular wallet (an EOA). A smart wallet wraps the call in its own execute(). The fee
// still moves, but the transaction no longer starts with the anchor, so the seal can't be verified, and the
// Builder Code sits under ABI padding, so Base doesn't count it. MEASURED 2026-10-15 on a fork of Base mainnet
// with a Coinbase Smart Wallet. Signing a seal with a smart wallet is unaffected.
export const ANCHOR_SENDER_HINT = "Anchor from a regular wallet. Smart wallets, a Base Account for one, can sign seals, but an anchor sent from one can't be verified and its Builder Code doesn't count.";

// EIP-5792: a wallet that reports atomic "supported" for this chain runs calls as a smart account. "atomicBatch"
// is the earlier name of that capability, and "0x0" holds capabilities that apply to every chain.
export function smartAccountFrom(capabilities, chainId) {
  if (!capabilities || typeof capabilities !== "object") return false;
  for (const key of ["0x" + Number(chainId).toString(16), "0x0"]) {
    const c = capabilities[key];
    if (c && (c.atomic?.status === "supported" || c.atomicBatch?.supported === true)) return true;
  }
  return false;
}

// Refuses a smart-wallet sender: one with contract code, or one its wallet reports as a smart account. An undeployed
// Base Account has no code yet, so the wallet's report is what catches it. An EIP-7702 account (its code is only
// 0xef0100 + a delegate address) is still a regular wallet that sends its own transactions, and its anchors verify
// (MEASURED 2026-10-15 on the Base mainnet fork, where the public test accounts are 7702-delegated). So that marker
// alone doesn't refuse it; its wallet's report still does if it runs calls as a smart account.
const EIP7702_DELEGATION = /^0xef0100[0-9a-fA-F]{40}$/;
export async function assertPlainSender(client, sender, capabilities, chainId) {
  const code = await client.getCode({ address: sender });
  if (code && code !== "0x" && !EIP7702_DELEGATION.test(code)) throw new Error(ANCHOR_SENDER_HINT + " (" + getAddress(sender) + " has contract code.)");
  if (smartAccountFrom(capabilities, chainId)) throw new Error(ANCHOR_SENDER_HINT + " (Your wallet reports that it runs as a smart account.)");
}

// After the transaction lands, write each seal's own proof into it.
export function attachAnchor(seals, leaves, root, txHash) {
  return seals.map((s, i) => ({ ...s, anchor: { txHash, root, proof: merkleProof(leaves, i) } }));
}

// ---------- verification ----------

export function clientFor(chainId, rpc) {
  const c = CHAINS[chainId];
  return createPublicClient({ transport: http(rpc || c.rpc) });
}

// Checks a seal. `client` is a viem public client on the seal's chain; without one,
// only plain-wallet (EOA) signatures can be checked, and the anchor is not looked up.
// `fileHash`, when given, is the SHA-256 of a document to compare against docHash.
//
// An anchored seal is judged at its anchor. The transaction must have gone to the Seal fee wallet, carry this
// batch's root, and pay the fee its block owed ($0.02 at the ETH/USD price in force at that block, within
// FEE_TOLERANCE_BPS); and every signature is checked against the chain's state AT THAT BLOCK, not today's. A smart
// wallet's owners can change after the fact, or before it: the anchor fixes the moment the signatures have to hold.
// (KupiaSec, 2026-10-15: the verifier read neither the recipient nor the value, so the fee was optional, and it
// checked smart-wallet signatures against today's state.) Both need an RPC that holds state at the anchor's block.
// The public Base and Base Sepolia endpoints do (MEASURED 2026-10-19: eth_call served 20,000,000 blocks behind the
// head on both). Without an anchor there is no such moment, and signatures are checked at the latest block.
//
// A Solana anchor (anchor.network set) is read through `solana`: { rpc, getJson }, a solanaRpc caller for that
// network and a JSON reader for Pyth. Its signatures are still EIP-712 signatures for the seal's chainId, checked
// with `client` at the latest block, because a Solana slot is no moment on Base.
export async function verifySeal(seal, { client, fileHash, solana } = {}) {
  const r = { ok: false, checks: [] };
  const add = (name, ok, detail) => { r.checks.push({ name, ok, detail }); return ok; };
  try { validateSeal(seal); } catch (e) { add("format", false, e.message); return r; }
  const chain = CHAINS[seal.chainId];
  add("format", true, "seal format " + SEAL_FORMAT + ", " + chain.name);

  if (fileHash !== undefined) {
    const same = String(fileHash).toLowerCase() === seal.docHash.toLowerCase();
    add("document", same, same ? "the file matches docHash" : "the file does NOT match docHash");
  }
  if (!seal.signatures.length) add("signatures", false, "no signatures");

  // The anchor first: once it holds, the signatures are checked at its block.
  let anchorBlock;
  if (seal.anchor) {
    const a = seal.anchor;
    const leaf = sealLeaf(seal);
    const inBatch = verifyProof(leaf, a.proof, a.root);
    add("anchor proof", inBatch, inBatch ? "this seal is in the anchored batch" : "this seal is NOT in the batch the anchor names");
    if (a.network !== undefined) {
      if (inBatch && solana) {
        try {
          const at = await checkSolanaAnchor(a, add, solana);
          if (at && typeof at === "object") r.anchoredAt = at;
        } catch (e) { add("anchor transaction", false, "could not read it: " + e.message); }
      }
    } else if (inBatch && client) {
      try {
        const [tx, rc] = await Promise.all([client.getTransaction({ hash: a.txHash }), client.getTransactionReceipt({ hash: a.txHash })]);
        const onChainRoot = decodeAnchor(tx.input);
        const toFeeWallet = !!chain.feeAddress && !!tx.to && tx.to.toLowerCase() === chain.feeAddress.toLowerCase();
        if (rc.status !== "success") add("anchor transaction", false, "transaction reverted");
        else if (!onChainRoot || onChainRoot !== a.root.toLowerCase()) add("anchor transaction", false, "the transaction does not carry this root");
        else if (!toFeeWallet) add("anchor transaction", false, "the transaction did not go to the Seal fee wallet" + (chain.feeAddress ? " " + getAddress(chain.feeAddress) : ""));
        else {
          const block = await client.getBlock({ blockNumber: rc.blockNumber });
          r.anchoredAt = { block: Number(rc.blockNumber), time: Number(block.timestamp) };
          add("anchor transaction", true, "existed by block " + rc.blockNumber + " (" + new Date(Number(block.timestamp) * 1000).toISOString() + "), sent to the Seal fee wallet");
          anchorBlock = rc.blockNumber;
          // The fee that block owed: $0.02 at the ETH/USD round in force when it closed, rounded up as the page rounds.
          try {
            const owed = await quoteFee(client, seal.chainId, Number(block.timestamp), rc.blockNumber);
            const paid = tx.value * 10_000n >= owed.wei * (10_000n - FEE_TOLERANCE_BPS);
            const price = (Number(owed.answer) / 10 ** owed.decimals).toFixed(2);
            add("anchor fee", paid, (paid ? "paid " : "UNDER-PAID: ") + formatEther(tx.value) + " ETH against " + formatEther(owed.wei) + " ETH owed ($0.02 at " + price + " ETH/USD, the price in force at block " + rc.blockNumber + ")");
          } catch (e) { add("anchor fee", false, "could not price the fee at block " + rc.blockNumber + ": " + (e.shortMessage || e.message)); }
        }
      } catch (e) { add("anchor transaction", false, "could not read it: " + (e.shortMessage || e.message)); }
    }
  }

  const td = typedDataFor(seal);
  const at = anchorBlock !== undefined ? { blockNumber: anchorBlock } : {};
  for (const g of seal.signatures) {
    let ok = false, how = "";
    try {
      if (client) {
        // viem's universal check: ERC-6492 (wallet not deployed yet), then ERC-1271
        // (smart wallet), then plain ecrecover. At the anchor's block when there is one.
        ok = await client.verifyTypedData({ address: g.signer, signature: g.signature, ...td, ...at });
        how = "checked on-chain at " + (anchorBlock !== undefined ? "the anchor's block " + anchorBlock : "the latest block") + " (EOA, ERC-1271 or ERC-6492)";
        if (!ok && anchorBlock !== undefined) {
          // An RPC that cannot look back that far fails the check too; say so instead of blaming the signature.
          try { await client.getCode({ address: g.signer, ...at }); }
          catch { how = "this RPC holds no state at block " + anchorBlock + ", so the signature cannot be checked at the anchor; use an RPC that does (the default endpoints do)"; }
        }
      } else {
        ok = (await recoverTypedDataAddress({ ...td, signature: g.signature })).toLowerCase() === g.signer.toLowerCase();
        how = "checked offline (plain wallets only)";
      }
    } catch (e) { how = e.shortMessage || e.message; }
    add("signature " + getAddress(g.signer), ok, ok ? how : "does not verify: " + how);
  }
  r.ok = r.checks.every((c) => c.ok);
  return r;
}

// ---------- Solana: the same root, anchored on another network ----------
// A seal's leaf and its batch's Merkle root don't depend on where they are written, so the same root can be anchored
// on Solana as on Base. Signers still sign the EIP-712 message for the seal's chainId; only the anchor moves.
// A Solana anchor is one legacy transaction from a regular wallet with two instructions:
//   1. System Program transfer of the fee, in lamports, to the Seal's Solana fee wallet;
//   2. Memo Program v2 instruction whose text is "SEAL1:" + the root in lowercase hex.
// The fee is $0.02 in SOL, priced from Pyth's SOL/USD feed (Hermes). A verifier prices it again at the
// transaction's block time. The wallet that signed (the fee payer) is recorded as the anchor's sender: on
// Solana the anchoring wallet is on chain too.
// feeAddress null means anchoring is off on that network; a verifier can still check an anchor by the
// address the network pins, so turning anchoring on is one reviewed line.
export const SOLANA = {
  "solana-mainnet": {
    name: "Solana",
    code: 0,                                          // the network's byte in a share link
    rpc: "https://api.mainnet-beta.solana.com",
    explorer: "https://solscan.io",
    feeAddress: null,                                 // the Architect's Solana fee wallet, once chosen
    maxPriceAgeS: 120,
  },
  "solana-devnet": {
    name: "Solana Devnet",
    code: 1,
    rpc: "https://api.devnet.solana.com",
    explorer: "https://solscan.io/?cluster=devnet",
    feeAddress: null,
    maxPriceAgeS: 120,
  },
};

export const SOLANA_SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const SOLANA_MEMO_PROGRAM = "MemoSq4gqABAXKMs4rnUd8uyyhK7Q2RcA4EovdH9Uep";
export const SOLANA_MEMO_PREFIX = "SEAL1:";
export const PYTH_HERMES = "https://hermes.pyth.network";
export const PYTH_SOL_USD = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const LAMPORTS_PER_SOL = 1_000_000_000n;

// Base58 (Bitcoin alphabet), as Solana writes keys and signatures.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Encode(u8) {
  let n = 0n;
  for (const b of u8) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of u8) { if (b !== 0) break; out = "1" + out; }
  return out;
}
export function base58Decode(str) {
  if (typeof str !== "string" || !/^[1-9A-HJ-NP-Za-km-z]*$/.test(str)) throw new Error("not base58");
  let n = 0n;
  for (const c of str) n = n * 58n + BigInt(B58.indexOf(c));
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of str) { if (c !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
function solanaKey(k, what) {
  let b = null;
  try { b = base58Decode(k); } catch { /* reported below */ }
  if (!b || b.length !== 32) throw new Error(what + " must be a 32-byte base58 Solana address");
  return b;
}

export function solanaMemo(root) {
  if (!B32.test(root)) throw new Error("root must be 32 bytes hex");
  return SOLANA_MEMO_PREFIX + root.toLowerCase();
}
// Returns the root, or null if this memo text is not a Seal anchor. Exact match only.
export function decodeSolanaMemo(text) {
  const m = /^SEAL1:(0x[0-9a-f]{64})$/.exec(typeof text === "string" ? text : "");
  return m ? m[1] : null;
}

// Pure part of the fee, testable on its own. Pyth gives price * 10^expo USD per SOL. Rounds UP.
export function feeLamportsFrom({ price, expo, publishTime, now, maxAgeS, cents = FEE_USD_CENTS }) {
  const p = BigInt(price);
  if (p <= 0n) throw new Error("price feed returned a non-positive price");
  if (!Number.isInteger(expo) || expo > 0 || expo < -18) throw new Error("price feed returned an unexpected exponent " + expo);
  if (Math.abs(now - Number(publishTime)) > maxAgeS) throw new Error("price is " + Math.abs(now - Number(publishTime)) + "s from the moment it prices");
  // fee_usd = cents/100; price_usd = p * 10^expo; lamports = fee_usd / price_usd * 1e9
  const num = cents * LAMPORTS_PER_SOL * 10n ** BigInt(-expo);
  const den = 100n * p;
  return (num + den - 1n) / den;
}

// `getJson(url)` returns parsed JSON (the page passes fetch; tests pass a stub). `at`, unix seconds, prices the fee
// as it stood then (Hermes keeps every update); without it, the latest price.
export async function quoteSolanaFee(getJson, network, now = Math.floor(Date.now() / 1000), at) {
  const n = SOLANA[network];
  if (!n) throw new Error("unsupported Solana network " + network);
  const path = at === undefined ? "latest" : String(Math.floor(at));
  const j = await getJson(PYTH_HERMES + "/v2/updates/price/" + path + "?ids[]=" + PYTH_SOL_USD + "&parsed=true");
  const feed = (j && Array.isArray(j.parsed) ? j.parsed : []).find((f) => "0x" + String(f.id).replace(/^0x/, "").toLowerCase() === PYTH_SOL_USD);
  if (!feed || !feed.price) throw new Error("no SOL/USD price in the reply");
  const { price, expo, publish_time } = feed.price;
  const lamports = feeLamportsFrom({ price, expo, publishTime: publish_time, now: at === undefined ? now : at, maxAgeS: n.maxPriceAgeS });
  return { lamports, price: BigInt(price), expo, publishTime: Number(publish_time) };
}

// Solana's compact-u16, the length prefix of every list in a transaction.
function shortvec(n) {
  const out = [];
  for (;;) { let b = n & 127; n >>= 7; if (n) { out.push(b | 128); } else { out.push(b); return out; } }
}
function u64le(v) {
  const out = []; let x = BigInt(v);
  for (let i = 0; i < 8; i++) { out.push(Number(x & 255n)); x >>= 8n; }
  return out;
}

// The message the wallet signs: a legacy message with the payer, the fee wallet and the two programs.
export function solanaAnchorMessage({ payer, feeAddress, lamports, recentBlockhash, root }) {
  const P = solanaKey(payer, "payer"), F = solanaKey(feeAddress, "fee address");
  const H = solanaKey(recentBlockhash, "recent blockhash");
  if (base58Encode(P) === base58Encode(F)) throw new Error("the payer can't be the fee wallet");
  const fee = BigInt(lamports);
  if (fee <= 0n || fee >= 2n ** 64n) throw new Error("fee must be a positive u64 of lamports");
  const memo = new TextEncoder().encode(solanaMemo(root));
  const out = [
    1, 0, 2,                                          // 1 signature (the payer); 2 read-only unsigned (the programs)
    ...shortvec(4), ...P, ...F, ...solanaKey(SOLANA_SYSTEM_PROGRAM, "system"), ...solanaKey(SOLANA_MEMO_PROGRAM, "memo"),
    ...H,
    ...shortvec(2),
    2, ...shortvec(2), 0, 1, ...shortvec(12), 2, 0, 0, 0, ...u64le(fee),   // System transfer (index 2), payer -> fee wallet
    3, ...shortvec(0), ...shortvec(memo.length), ...memo,                  // Memo (index 3), no signer accounts
  ];
  return Uint8Array.from(out);
}

// The unsigned transaction: one empty signature slot, then the message. A wallet fills the slot and sends it.
export function solanaAnchorTransaction(args) {
  const m = solanaAnchorMessage(args);
  return Uint8Array.from([...shortvec(1), ...new Uint8Array(64), ...m]);
}

export function buildSolanaAnchorTx({ network, seals, lamports, payer, recentBlockhash }) {
  const n = SOLANA[network];
  if (!n) throw new Error("unsupported Solana network " + network);
  if (!n.feeAddress) throw new Error("anchoring is not enabled on " + n.name + " yet");
  if (!seals.length || seals.length > BATCH_MAX) throw new Error("batch must hold 1-" + BATCH_MAX + " seals");
  for (const s of seals) {
    validateSeal(s);
    if (s.anchor) throw new Error("this seal is already anchored");
    if (!s.signatures.length) throw new Error("a seal must be signed before it is anchored");
  }
  const leaves = seals.map(sealLeaf);
  const root = merkleRoot(leaves);
  const args = { payer, feeAddress: n.feeAddress, lamports, recentBlockhash, root };
  return { root, leaves, message: solanaAnchorMessage(args), transaction: solanaAnchorTransaction(args) };
}

export function attachSolanaAnchor(seals, leaves, root, network, signature) {
  if (!SOLANA[network]) throw new Error("unsupported Solana network " + network);
  return seals.map((s, i) => ({ ...s, anchor: { network, signature, root, proof: merkleProof(leaves, i) } }));
}

// The payer's wallet. Inside a Farcaster mini app the host offers a Solana wallet (sdk.wallet.getSolanaProvider()),
// the same one Taproot's earlier Solana leg connected to. Its signAndSendTransaction takes { transaction }, where the
// transaction only needs serialize(): the SDK base64s what serialize returns and the host rebuilds it with web3.js
// (@farcaster/miniapp-core 0.6.0, solanaWire, which miniapp-sdk 0.3.0 pins). So Seal hands it the hand-built bytes
// and the page needs no Solana library. test/solana/crosscheck.mjs runs that exact wire code on these bytes.
export function solanaWalletTransaction(bytes) {
  const b = Uint8Array.from(bytes);
  return { serialize: () => Uint8Array.from(b) };
}

// Connects and returns the wallet's address. Hosts have handed over three shapes (measured inside Farcaster,
// 2026-08-05, by Taproot's earlier Solana leg): phantom-style connect(), Wallet Standard, and request-only.
export async function connectSolanaWallet(provider) {
  if (!provider) throw new Error("no Solana wallet here");
  let res, acct;
  if (typeof provider.connect === "function") { res = await provider.connect(); acct = res?.publicKey ?? provider.publicKey; }
  else if (typeof provider.features?.["standard:connect"]?.connect === "function") {
    res = await provider.features["standard:connect"].connect();
    const a = res?.accounts?.[0] || provider.accounts?.[0]; acct = a?.address ?? a?.publicKey;
  } else if (typeof provider.request === "function") { res = await provider.request({ method: "connect" }); acct = res?.publicKey ?? provider.publicKey; }
  else throw new Error("this Solana wallet is a shape Seal doesn't know how to connect to");
  const address = acct && typeof acct.toBase58 === "function" ? acct.toBase58() : String(acct ?? "");
  solanaKey(address, "the wallet's address");
  return address;
}

// Hands the unsigned anchor to the wallet to sign and send; returns the transaction's signature. Not retried: if the
// wallet answers oddly, the transaction may already be on chain, so the error says so.
export async function sendSolanaAnchor(provider, transaction) {
  if (!provider || typeof provider.signAndSendTransaction !== "function") throw new Error("this Solana wallet can't send transactions");
  const sent = await provider.signAndSendTransaction({ transaction: solanaWalletTransaction(transaction) });
  const sig = typeof sent === "string" ? sent : sent?.signature;
  let b = null;
  try { b = base58Decode(String(sig ?? "")); } catch { /* reported below */ }
  if (!b || b.length !== 64) throw new Error("the wallet returned no transaction signature; it may or may not have sent. Check the wallet before trying again.");
  return sig;
}

// A JSON-RPC caller for a Solana endpoint: `call(method, params)` returns the result or throws.
export function solanaRpc(url, fetchImpl = globalThis.fetch) {
  let id = 0;
  return async (method, params) => {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || "RPC error");
    return j.result;
  };
}

// Reads a Solana anchor's transaction and checks it the way the Base anchor is checked: it succeeded, it is this
// anchor's transaction, a memo carries this root, it paid the fee wallet, and it paid the fee owed at its block time.
// `rpc` is a solanaRpc caller; `getJson` reads Pyth. Adds checks through `add`; returns what it learned.
async function checkSolanaAnchor(a, add, { rpc, getJson }) {
  const n = SOLANA[a.network];
  const tx = await rpc("getTransaction", [a.signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
  if (!tx) return add("anchor transaction", false, "no finalized transaction " + a.signature + " on " + n.name);
  const msg = tx.transaction && tx.transaction.message;
  const keys = (msg && msg.accountKeys) || [];
  const ixs = (msg && msg.instructions) || [];
  const prog = (ix) => keys[ix.programIdIndex];
  const roots = ixs.filter((ix) => prog(ix) === SOLANA_MEMO_PROGRAM).map((ix) => {
    try { return decodeSolanaMemo(new TextDecoder("utf-8", { fatal: true }).decode(base58Decode(ix.data))); } catch { return null; }
  });
  let paid = 0n;
  if (n.feeAddress) {
    for (const ix of ixs) {
      if (prog(ix) !== SOLANA_SYSTEM_PROGRAM || !Array.isArray(ix.accounts) || ix.accounts.length < 2) continue;
      let d; try { d = base58Decode(ix.data); } catch { continue; }
      if (d.length !== 12 || d[0] !== 2 || d[1] || d[2] || d[3]) continue;          // SystemInstruction::Transfer
      if (keys[ix.accounts[1]] !== n.feeAddress) continue;
      let v = 0n; for (let i = 11; i >= 4; i--) v = v * 256n + BigInt(d[i]);
      paid += v;
    }
  }
  if (!tx.meta || tx.meta.err !== null) return add("anchor transaction", false, "transaction failed");
  if (!Array.isArray(tx.transaction.signatures) || tx.transaction.signatures[0] !== a.signature) return add("anchor transaction", false, "the RPC returned a different transaction");
  if (!roots.includes(a.root.toLowerCase())) return add("anchor transaction", false, "the transaction does not carry this root");
  if (!n.feeAddress) return add("anchor transaction", false, "no Seal fee wallet is set for " + n.name + ", so this anchor can't be checked");
  if (paid === 0n) return add("anchor transaction", false, "the transaction did not pay the Seal fee wallet " + n.feeAddress);
  const time = Number(tx.blockTime);
  const anchoredAt = { slot: Number(tx.slot), time, network: a.network, by: keys[0] };
  add("anchor transaction", true, "existed by slot " + tx.slot + " (" + new Date(time * 1000).toISOString() + ") on " + n.name + ", sent by " + keys[0] + " to the Seal fee wallet");
  try {
    const owed = await quoteSolanaFee(getJson, a.network, time, time);
    const ok = paid * 10_000n >= owed.lamports * (10_000n - FEE_TOLERANCE_BPS);
    add("anchor fee", ok, (ok ? "paid " : "UNDER-PAID: ") + paid + " lamports against " + owed.lamports + " owed ($0.02 at the SOL/USD price at " + new Date(time * 1000).toISOString() + ")");
  } catch (e) { add("anchor fee", false, "could not price the fee at " + time + ": " + e.message); }
  return anchoredAt;
}

// ---------- share links (the seal travels in the URL fragment, never to a server) ----------
// The compact link (#s=) carries the seal's fields as bytes, then base64url: about 40% of the length of the old JSON
// link (#seal=), which still opens. A plain-wallet signature drops its signer, because the signer is recovered from
// the signature. The link keeps the first 4 bytes of that signer's address, so a damaged or changed link is refused
// instead of recovering a stranger's address. Any other signature (a smart wallet's) keeps its whole signer. Nothing
// in a link is trusted: the seal goes through validateSeal(), and verifySeal() checks every signature again.
// Version 2 links (live for about an hour on 2026-10-15) carry no signer check. They still open.
const LINK_VERSION = 3;
const LINK_UNCHECKED = 2;
const SIGNER_CHECK = 4;
const b64uEncode = (u8) => { let bin = ""; for (const b of u8) bin += String.fromCharCode(b); return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const b64uDecode = (str) => { const b64 = str.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(b64 + "===".slice((b64.length + 3) % 4)), (c) => c.charCodeAt(0)); };
const hexBytes = (h) => Uint8Array.from(h.slice(2).match(/../g) || [], (x) => parseInt(x, 16));
const bytesHex = (u8) => "0x" + Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");

function linkWriter() {
  const out = [];
  const w = {
    u8: (b) => out.push(b & 255),
    varint(n) { let v = BigInt(n); do { let b = Number(v & 127n); v >>= 7n; if (v) b |= 128; out.push(b); } while (v); },
    raw: (u8) => { for (const b of u8) out.push(b); },
    chunk: (u8) => { w.varint(u8.length); w.raw(u8); },
    done: () => Uint8Array.from(out),
  };
  return w;
}
function linkReader(u8) {
  let i = 0;
  const need = (n) => { if (i + n > u8.length) throw new Error("invalid seal link: it is cut short"); };
  const r = {
    u8: () => { need(1); return u8[i++]; },
    varint() { let n = 0n, shift = 0n; for (;;) { const b = r.u8(); n |= BigInt(b & 127) << shift; if (!(b & 128)) return n; shift += 7n; if (shift > 63n) throw new Error("invalid seal link: bad number"); } },
    raw: (n) => { need(n); const b = u8.slice(i, i + n); i += n; return b; },
    chunk: (max) => { const n = Number(r.varint()); if (n > max) throw new Error("invalid seal link: a field is too long"); return r.raw(n); },
    end: () => i === u8.length,
  };
  return r;
}

export async function toLink(base, seal) {
  validateSeal(seal);
  const w = linkWriter(), td = typedDataFor(seal);
  w.u8(LINK_VERSION); w.varint(seal.chainId); w.raw(hexBytes(seal.docHash)); w.varint(seal.sealedAt);
  w.chunk(new TextEncoder().encode(seal.title));
  w.varint(seal.signatures.length);
  for (const g of seal.signatures) {
    let recovered = null;
    try { recovered = await recoverTypedDataAddress({ ...td, signature: g.signature }); } catch { /* not a plain signature */ }
    const plain = recovered !== null && recovered.toLowerCase() === g.signer.toLowerCase();
    const signer = hexBytes(getAddress(g.signer));
    w.u8(plain ? 0 : 1);
    w.raw(plain ? signer.subarray(0, SIGNER_CHECK) : signer);
    w.chunk(hexBytes(g.signature));
  }
  if (seal.anchor && seal.anchor.network !== undefined) {
    w.u8(2); w.u8(SOLANA[seal.anchor.network].code); w.raw(base58Decode(seal.anchor.signature)); w.raw(hexBytes(seal.anchor.root));
    w.varint(seal.anchor.proof.length); for (const p of seal.anchor.proof) w.raw(hexBytes(p));
  } else if (seal.anchor) {
    w.u8(1); w.raw(hexBytes(seal.anchor.txHash)); w.raw(hexBytes(seal.anchor.root));
    w.varint(seal.anchor.proof.length); for (const p of seal.anchor.proof) w.raw(hexBytes(p));
  } else w.u8(0);
  return base + "#s=" + b64uEncode(w.done());
}

// A plain signer comes back from its signature. Version 3 also matches it against the address bytes the link carries,
// so one changed byte in the signed fields or the signature is refused.
async function recoveredSigner(td, signature, check, k) {
  const damaged = new Error(`invalid seal link: signature ${k + 1} does not match its signer (the link was damaged or changed)`);
  if (signature.length !== 130 && signature.length !== 132) throw damaged;     // a plain signature is 64 or 65 bytes
  let signer;
  try { signer = await recoverTypedDataAddress({ ...td, signature }); } catch { throw damaged; }
  if (check && !signer.toLowerCase().startsWith(check)) throw damaged;
  return signer;
}

export async function fromFragment(hash) {
  const legacy = /(?:^#|&)seal=([A-Za-z0-9_-]+)/.exec(hash || "");
  if (legacy) return validateSeal(JSON.parse(new TextDecoder().decode(b64uDecode(legacy[1]))));
  const m = /(?:^#|&)s=([A-Za-z0-9_-]+)/.exec(hash || "");
  if (!m) return null;
  const r = linkReader(b64uDecode(m[1]));
  const version = r.u8();
  if (version !== LINK_VERSION && version !== LINK_UNCHECKED) throw new Error("invalid seal link: unknown version");
  const chainId = Number(r.varint()), docHash = bytesHex(r.raw(32)), sealedAt = Number(r.varint());
  const title = new TextDecoder("utf-8", { fatal: true }).decode(r.chunk(TITLE_MAX * 4));
  const seal = { seal: SEAL_FORMAT, chainId, hashAlg: "sha256", docHash, title, sealedAt, signatures: [] };
  validateSeal(seal);                                   // chainId, title and time first: recovery needs them
  const n = Number(r.varint());
  if (n > SIGNERS_MAX) throw new Error("invalid seal link: too many signatures");
  const td = typedDataFor(seal);
  for (let k = 0; k < n; k++) {
    const kind = r.u8();
    if (kind > 1) throw new Error("invalid seal link: unknown signature kind");
    const explicit = kind === 1 ? getAddress(bytesHex(r.raw(20))) : null;
    const check = kind === 0 && version === LINK_VERSION ? bytesHex(r.raw(SIGNER_CHECK)) : null;
    const signature = bytesHex(r.chunk(4096));
    seal.signatures.push({ signer: explicit || (await recoveredSigner(td, signature, check, k)), signature });
  }
  const anchored = r.u8();
  if (anchored > 2) throw new Error("invalid seal link: bad anchor flag");
  if (anchored === 2) {
    const code = r.u8();
    const network = Object.keys(SOLANA).find((k) => SOLANA[k].code === code);
    if (!network) throw new Error("invalid seal link: unknown anchor network");
    const signature = base58Encode(r.raw(64)), root = bytesHex(r.raw(32)), np = Number(r.varint());
    if (np > 16) throw new Error("invalid seal link: proof too long");
    const proof = []; for (let k = 0; k < np; k++) proof.push(bytesHex(r.raw(32)));
    seal.anchor = { network, signature, root, proof };
  } else if (anchored === 1) {
    const txHash = bytesHex(r.raw(32)), root = bytesHex(r.raw(32)), np = Number(r.varint());
    if (np > 16) throw new Error("invalid seal link: proof too long");
    const proof = []; for (let k = 0; k < np; k++) proof.push(bytesHex(r.raw(32)));
    seal.anchor = { txHash, root, proof };
  }
  if (!r.end()) throw new Error("invalid seal link: unexpected bytes at the end");
  return validateSeal(seal);
}
