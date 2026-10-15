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
  ["link accepts any anchor flag", 'if (anchored > 1) throw new Error("invalid seal link: bad anchor flag");', ""],
  ["old JSON links no longer open", "if (legacy) return validateSeal(", "if (false) return validateSeal("],
  ["link accepts extra bytes", 'if (!r.end()) throw new Error("invalid seal link: unexpected bytes at the end");', ""],
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
