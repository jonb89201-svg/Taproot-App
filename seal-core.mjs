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
    if (!B32.test(a.txHash || "")) fail("anchor.txHash must be 32 bytes hex");
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
export async function verifySeal(seal, { client, fileHash } = {}) {
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
    if (inBatch && client) {
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
  if (seal.anchor) {
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
  if (anchored > 1) throw new Error("invalid seal link: bad anchor flag");
  if (anchored === 1) {
    const txHash = bytesHex(r.raw(32)), root = bytesHex(r.raw(32)), np = Number(r.varint());
    if (np > 16) throw new Error("invalid seal link: proof too long");
    const proof = []; for (let k = 0; k < np; k++) proof.push(bytesHex(r.raw(32)));
    seal.anchor = { txHash, root, proof };
  }
  if (!r.end()) throw new Error("invalid seal link: unexpected bytes at the end");
  return validateSeal(seal);
}
