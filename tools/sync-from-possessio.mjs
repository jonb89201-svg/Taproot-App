// Regenerates what the console takes from the PossessioPayments source, from a Possessio checkout that has been
// built with forge:  node tools/sync-from-possessio.mjs ../Possessio
//   abi/PossessioPayments.abi.json      the ABI the Payments panel is checked against (test/abi-sync.mjs)
//   abi/PossessioPayments.wiring.json   the canonical Base wiring (library BaseWiring) and the DeployParams fields,
//                                       read from the source, so the launch rail never hand-copies an address
//   artifacts/payments.json             the template's creationCode and its keccak256, which the launch rail hashes
//                                       against the factory's templateCodehash on chain before any signature (D2)
// Nothing here is trusted by the console at run time: the chain is the authority; these files are what it compares.
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { keccak256 } from "viem";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const possessio = process.argv[2];
if (!possessio) { console.error("usage: node tools/sync-from-possessio.mjs <path to a built Possessio checkout>"); process.exit(2); }

const artifact = JSON.parse(fs.readFileSync(path.join(possessio, "out/PossessioPayments.sol/PossessioPayments.json"), "utf8"));
const source = fs.readFileSync(path.join(possessio, "src/PossessioPayments.sol"), "utf8");
const rev = execSync("git rev-parse --short HEAD", { cwd: possessio, encoding: "utf8" }).trim();
const dirty = execSync("git status --porcelain -- src/PossessioPayments.sol", { cwd: possessio, encoding: "utf8" }).trim() !== "";

// library BaseWiring { address internal constant NAME = 0x...; ... }
const lib = /library BaseWiring\s*\{([\s\S]*?)\}/.exec(source);
if (!lib) throw new Error("library BaseWiring not found in the source");
const wiring = {};
for (const m of lib[1].matchAll(/address internal constant (\w+)\s*=\s*(0x[0-9a-fA-F]{40});/g)) wiring[m[1]] = m[2];
if (Object.keys(wiring).length !== 8) throw new Error("expected 8 wiring constants, found " + Object.keys(wiring).length);

// struct DeployParams { type name; ... }  -> the tuple the rail encodes as initArgs
const st = /struct DeployParams\s*\{([\s\S]*?)\n\s*\}/.exec(source);
if (!st) throw new Error("struct DeployParams not found in the source");
const deployParams = [];
for (const line of st[1].split("\n")) {
  const m = /^\s*([\w\[\]]+)\s+(\w+);/.exec(line);
  if (m) deployParams.push({ type: m[1], name: m[2] });
}
if (deployParams.length < 10) throw new Error("DeployParams parsed " + deployParams.length + " fields");

const creationCode = artifact.bytecode.object;
const meta = { contract: "PossessioPayments", source: "src/PossessioPayments.sol", possessioRev: rev + (dirty ? " (dirty)" : ""),
               solc: artifact.metadata.compiler.version, optimizer: artifact.metadata.settings.optimizer, generatedAt: new Date().toISOString().slice(0, 10) };

fs.writeFileSync(path.join(root, "abi/PossessioPayments.abi.json"), JSON.stringify(artifact.abi, null, 2) + "\n");
fs.writeFileSync(path.join(root, "abi/PossessioPayments.wiring.json"), JSON.stringify({ ...meta, chainId: 8453, wiring, deployParams }, null, 2) + "\n");
fs.writeFileSync(path.join(root, "artifacts/payments.json"), JSON.stringify({ ...meta, codehash: keccak256(creationCode), creationCode }, null, 2) + "\n");
const fns = artifact.abi.filter((x) => x.type === "function");
console.log(`synced from Possessio ${meta.possessioRev}: ${fns.length} ABI functions, ${Object.keys(wiring).length} wiring addresses, ${deployParams.length} DeployParams fields, creationCode ${(creationCode.length - 2) / 2} bytes, codehash ${keccak256(creationCode)}`);
