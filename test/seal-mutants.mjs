// Planted breaks for seal-core.mjs. node test/seal-mutants.mjs
// Each mutant changes one thing the Seal relies on. The suite must go red for every
// one of them; a mutant that survives means a test has no teeth.
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = fs.readFileSync(path.join(root, "seal-core.mjs"), "utf8");

const MUTANTS = [
  ["leaf ignores signatures", "return keccak256(concat([sealDigest(s), sigsHash]));", "return keccak256(concat([sealDigest(s), keccak256(\"0x\")]));"],
  ["fee rounds down", "return (num + den - 1n) / den;", "return num / den;"],
  ["fee skips staleness", "if (now - Number(updatedAt) > maxAgeS)", "if (false)"],
  ["merkle pairs unsorted", "return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));", "return keccak256(concat([a, b]));"],
  ["anchor drops Builder Code", "return concat([ANCHOR_MAGIC, root, BUILDER_SUFFIX]);", "return concat([ANCHOR_MAGIC, root]);"],
  ["domain drops chainId", 'return { name: "Seal", version: "1", chainId };', 'return { name: "Seal", version: "1" };'],
  ["on-chain check always passes", "ok = await client.verifyTypedData(", "ok = true || await client.verifyTypedData("],
  ["anchor root not compared", "else if (!onChainRoot || onChainRoot !== a.root.toLowerCase())", "else if (false)"],
  ["anchor recipient not checked", "const toFeeWallet = !!chain.feeAddress && !!tx.to && tx.to.toLowerCase() === chain.feeAddress.toLowerCase();", "const toFeeWallet = true;"],
  ["anchor fee not checked", "const paid = tx.value * 10_000n >= owed.wei * (10_000n - FEE_TOLERANCE_BPS);", "const paid = true;"],
  ["anchor fee tolerance widened", "export const FEE_TOLERANCE_BPS = 500n;", "export const FEE_TOLERANCE_BPS = 2000n;"],
  ["anchor fee priced at today's block", "const owed = await quoteFee(client, seal.chainId, Number(block.timestamp), rc.blockNumber);", "const owed = await quoteFee(client, seal.chainId, Number(block.timestamp));"],
  ["signatures checked at today's state", "const at = anchorBlock !== undefined ? { blockNumber: anchorBlock } : {};", "const at = {};"],
  ["mainnet fee gate removed", 'if (!c.feeAddress) throw new Error("anchoring is not enabled on " + c.name + " yet");', ""],
  ["unsigned seals anchorable", 'if (!s.signatures.length) throw new Error("a seal must be signed before it is anchored");', ""],
  ["contract fee address accepted", 'if (code && code !== "0x") throw new Error("the fee address "', 'if (false) throw new Error("the fee address "'],
  ["smart-wallet sender accepted", 'if (code && code !== "0x" && !EIP7702_DELEGATION.test(code)) throw new Error(ANCHOR_SENDER_HINT', 'if (false) throw new Error(ANCHOR_SENDER_HINT'],
  ["a 7702 account refused as a contract", 'if (code && code !== "0x" && !EIP7702_DELEGATION.test(code)) throw new Error(ANCHOR_SENDER_HINT', 'if (code && code !== "0x") throw new Error(ANCHOR_SENDER_HINT'],
  ["smart-account report ignored", 'if (smartAccountFrom(capabilities, chainId)) throw', 'if (false) throw'],
  ["atomic 'ready' read as a smart account", 'c.atomic?.status === "supported"', 'c.atomic?.status !== "unsupported"'],
  ["link drops smart-wallet signers", "w.u8(plain ? 0 : 1);\n    w.raw(plain ? signer.subarray(0, SIGNER_CHECK) : signer);", "w.u8(0);\n    w.raw(signer.subarray(0, SIGNER_CHECK));"],
  ["link skips the signer check", "if (check && !signer.toLowerCase().startsWith(check)) throw damaged;", ""],
  ["link writes no signer check", "w.raw(plain ? signer.subarray(0, SIGNER_CHECK) : signer);", "if (!plain) w.raw(signer);"],
  ["version-2 links no longer open", "version !== LINK_VERSION && version !== LINK_UNCHECKED", "version !== LINK_VERSION"],
  ["link accepts any anchor flag", 'if (anchored > 2) throw new Error("invalid seal link: bad anchor flag");', ""],
  ["old JSON links no longer open", "if (legacy) return validateSeal(", "if (false) return validateSeal("],
  ["link accepts extra bytes", 'if (!r.end()) throw new Error("invalid seal link: unexpected bytes at the end");', ""],
  // Solana anchors
  ["base58 drops leading zeros", 'for (const b of u8) { if (b !== 0) break; out = "1" + out; }', ""],
  ["solana memo match loosened", "const m = /^SEAL1:(0x[0-9a-f]{64})$/.exec(", "const m = /SEAL1:(0x[0-9a-fA-F]{64})/.exec("],
  ["solana fee rounds down", "const den = 100n * p;\n  return (num + den - 1n) / den;", "const den = 100n * p;\n  return num / den;"],
  ["solana fee skips staleness", "if (Math.abs(now - Number(publishTime)) > maxAgeS)", "if (false)"],
  ["solana transfer amount mis-encoded", "for (let i = 0; i < 8; i++) { out.push(Number(x & 255n)); x >>= 8n; }", "for (let i = 0; i < 8; i++) { out.unshift(Number(x & 255n)); x >>= 8n; }"],
  ["solana memo marked as signer", "3, ...shortvec(0), ...shortvec(memo.length), ...memo,", "3, ...shortvec(1), 0, ...shortvec(memo.length), ...memo,"],
  ["solana mainnet fee gate removed", 'if (!n.feeAddress) throw new Error("anchoring is not enabled on " + n.name + " yet");', ""],
  ["solana payer may be the fee wallet", 'if (base58Encode(P) === base58Encode(F)) throw', 'if (false) throw'],
  ["solana unsigned seals anchorable", '    if (s.anchor) throw new Error("this seal is already anchored");\n    if (!s.signatures.length) throw new Error("a seal must be signed before it is anchored");', '    if (s.anchor) throw new Error("this seal is already anchored");'],
  ["solana failed transaction accepted", "if (!tx.meta || tx.meta.err !== null) return add(", "if (false) return add("],
  ["solana other transaction accepted", "tx.transaction.signatures[0] !== a.signature) return add(", "false) return add("],
  ["solana root not compared", "if (!roots.includes(a.root.toLowerCase())) return add(", "if (false) return add("],
  ["solana recipient not checked", "      if (keys[ix.accounts[1]] !== n.feeAddress) continue;\n", ""],
  ["solana fee not checked", "const ok = paid * 10_000n >= owed.lamports * (10_000n - FEE_TOLERANCE_BPS);", "const ok = true;"],
  ["solana fee priced now", "const owed = await quoteSolanaFee(getJson, a.network, time, time);", "const owed = await quoteSolanaFee(getJson, a.network, time);"],
  ["solana anchor never read", "const at = await checkSolanaAnchor(a, add, solana);", "const at = null;"],
  ["solana link loses the network", "w.u8(2); w.u8(SOLANA[seal.anchor.network].code);", "w.u8(2); w.u8(0);"],
  ["solana anchor network unchecked", 'if (!SOLANA[a.network]) fail("unsupported anchor network " + a.network);', ""],
  ["solana wallet handed other bytes", "return { serialize: () => Uint8Array.from(b) };", "return { serialize: () => Uint8Array.from(b).subarray(65) };"],
  ["solana wallet signature not checked", "if (!b || b.length !== 64) throw new Error(\"the wallet returned no transaction signature", "if (false) throw new Error(\"the wallet returned no transaction signature"],
  ["solana wallet address not checked", 'solanaKey(address, "the wallet\'s address");', ""],
  ["fee wallet changed", 'feeAddress: "0x9Ce4cb26A5F7B50826B07eb8B2C065F0Bb37a6c9",\n  },\n  84532', 'feeAddress: "0x19495180FFA00B8311c85DCF76A89CCbFB174EA0",\n  },\n  84532'],
];

let survived = 0;
for (const [name, from, to] of MUTANTS) {
  if (!core.includes(from)) { console.log("STALE  " + name + " (anchor text not found)"); survived++; continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-mut-"));
  fs.mkdirSync(path.join(dir, "test/fixtures"), { recursive: true });
  fs.writeFileSync(path.join(dir, "seal-core.mjs"), core.replace(from, to));
  fs.writeFileSync(path.join(dir, "package.json"), fs.readFileSync(path.join(root, "package.json")));
  fs.copyFileSync(path.join(root, "test/seal.test.mjs"), path.join(dir, "test/seal.test.mjs"));
  fs.copyFileSync(path.join(root, "test/fixtures/SealTestWallets.json"), path.join(dir, "test/fixtures/SealTestWallets.json"));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"));
  const r = spawnSync(process.execPath, ["test/seal.test.mjs"], { cwd: dir, encoding: "utf8", timeout: 300000 });
  const fails = (r.stdout.match(/^ {2}FAIL .*/gm) || []);
  const killed = r.status === 1 && fails.length > 0;
  if (!killed) survived++;
  console.log((killed ? "KILLED " : "ALIVE  ") + name + (killed ? "  <- " + fails[0].trim().slice(5, 90) : "  (exit " + r.status + ")"));
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(survived ? `MUTANTS: ${survived} survived` : `MUTANTS: all ${MUTANTS.length} killed`);
process.exit(survived ? 1 : 0);
