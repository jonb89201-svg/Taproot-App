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

export async function quoteFee(client, chainId, now = Math.floor(Date.now() / 1000)) {
  const c = CHAINS[chainId];
  if (!c) throw new Error("unsupported chain " + chainId);
  const [decimals, round] = await Promise.all([
    client.readContract({ address: c.ethUsdFeed, abi: FEED_ABI, functionName: "decimals" }),
    client.readContract({ address: c.ethUsdFeed, abi: FEED_ABI, functionName: "latestRoundData" }),
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
export async function verifySeal(seal, { client, fileHash } = {}) {
  const r = { ok: false, checks: [] };
  const add = (name, ok, detail) => { r.checks.push({ name, ok, detail }); return ok; };
  try { validateSeal(seal); } catch (e) { add("format", false, e.message); return r; }
  add("format", true, "seal format " + SEAL_FORMAT + ", " + CHAINS[seal.chainId].name);

  if (fileHash !== undefined) {
    const same = String(fileHash).toLowerCase() === seal.docHash.toLowerCase();
    add("document", same, same ? "the file matches docHash" : "the file does NOT match docHash");
  }
  if (!seal.signatures.length) add("signatures", false, "no signatures");

  const td = typedDataFor(seal);
  for (const g of seal.signatures) {
    let ok = false, how = "";
    try {
      if (client) {
        // viem's universal check: ERC-6492 (wallet not deployed yet), then ERC-1271
        // (smart wallet), then plain ecrecover.
        ok = await client.verifyTypedData({ address: g.signer, signature: g.signature, ...td });
        how = "checked on-chain (EOA, ERC-1271 or ERC-6492)";
      } else {
        ok = (await recoverTypedDataAddress({ ...td, signature: g.signature })).toLowerCase() === g.signer.toLowerCase();
        how = "checked offline (plain wallets only)";
      }
    } catch (e) { how = e.shortMessage || e.message; }
    add("signature " + getAddress(g.signer), ok, ok ? how : "does not verify: " + how);
  }

  if (seal.anchor) {
    const a = seal.anchor;
    const leaf = sealLeaf(seal);
    const inBatch = verifyProof(leaf, a.proof, a.root);
    add("anchor proof", inBatch, inBatch ? "this seal is in the anchored batch" : "this seal is NOT in the batch the anchor names");
    if (inBatch && client) {
      try {
        const [tx, rc] = await Promise.all([client.getTransaction({ hash: a.txHash }), client.getTransactionReceipt({ hash: a.txHash })]);
        const onChainRoot = decodeAnchor(tx.input);
        if (rc.status !== "success") add("anchor transaction", false, "transaction reverted");
        else if (!onChainRoot || onChainRoot !== a.root.toLowerCase()) add("anchor transaction", false, "the transaction does not carry this root");
        else {
          const block = await client.getBlock({ blockNumber: rc.blockNumber });
          r.anchoredAt = { block: Number(rc.blockNumber), time: Number(block.timestamp) };
          add("anchor transaction", true, "existed by block " + rc.blockNumber + " (" + new Date(Number(block.timestamp) * 1000).toISOString() + ")");
        }
      } catch (e) { add("anchor transaction", false, "could not read it: " + (e.shortMessage || e.message)); }
    }
  }
  r.ok = r.checks.every((c) => c.ok);
  return r;
}

// ---------- share links (the seal travels in the URL fragment, never to a server) ----------

export function toLink(base, seal) {
  const bytes = new TextEncoder().encode(JSON.stringify(seal));
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return base + "#seal=" + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromFragment(hash) {
  const m = /(?:^#|&)seal=([A-Za-z0-9_-]+)/.exec(hash || "");
  if (!m) return null;
  const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return validateSeal(JSON.parse(new TextDecoder().decode(bytes)));
}
