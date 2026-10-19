// Checks the console against PossessioPayments v3.0.2 as generated from its source by
// tools/sync-from-possessio.mjs: the Payments panel against the ABI, the launch rail's wiring
// and DeployParams tuple against abi/PossessioPayments.wiring.json, the template artifact's
// codehash against its own bytes, and the treasury card's ABI fragments against the contract.
// node test/abi-sync.mjs  -> exit 0 in sync, exit 1 on any drift.
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { keccak256 } from "viem";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const abi = JSON.parse(fs.readFileSync(path.join(root, "abi/PossessioPayments.abi.json"), "utf8"));

// Cut out the CONTRACTS array literal by bracket depth.
const start = html.indexOf("const CONTRACTS = [");
if (start < 0) throw new Error("CONTRACTS not found");
let i = html.indexOf("[", start), depth = 0, end = -1;
for (; i < html.length; i++) {
  if (html[i] === "[") depth++;
  if (html[i] === "]" && --depth === 0) { end = i + 1; break; }
}
const CONTRACTS = (0, eval)("(" + html.slice(html.indexOf("[", start), end) + ")");
const pay = CONTRACTS.find(c => c.key === "PAY");

const t = x => x.type.startsWith("tuple") ? "(" + x.components.map(t).join(",") + ")" + x.type.slice(5) : x.type;
const sig = (n, ins) => n + "(" + (ins || []).map(t).join(",") + ")";
const fns = abi.filter(x => x.type === "function");
const abiBySig = new Map(fns.map(f => [sig(f.name, f.inputs), f]));

// Callable by the forwarder only: not a console action.
const NOT_IN_PANEL = new Set(["performUpkeep(bytes)"]);

const errs = [];
const appSigs = new Set();
for (const f of pay.functions) {
  const s = sig(f.name, f.inputs);
  appSigs.add(s);
  const a = abiBySig.get(s);
  if (!a) { errs.push("panel calls " + s + ", which the fixed contract does not have"); continue; }
  const ro = a.stateMutability === "view" || a.stateMutability === "pure";
  if (ro !== (f.kind === "read")) errs.push(s + ": panel kind " + f.kind + ", contract " + a.stateMutability);
  if (f.kind === "read") {
    const ao = a.outputs.map(t).join(","), fo = (f.outputs || []).map(t).join(",");
    if (ao !== fo) errs.push(s + ": outputs panel (" + fo + ") vs contract (" + ao + ")");
  }
}
for (const [s, a] of abiBySig) {
  const write = a.stateMutability !== "view" && a.stateMutability !== "pure";
  if (write && !appSigs.has(s) && !NOT_IN_PANEL.has(s)) errs.push("contract write " + s + " is missing from the panel");
}
const names = new Set(pay.functions.map(f => f.name));
const cats = new Set(pay.categories.flatMap(c => c.names));
for (const n of cats) if (!names.has(n)) errs.push("category lists " + n + " with no panel entry");
for (const n of names) if (!cats.has(n)) errs.push(n + " is in no category (it would not render)");

// The launch rail must not point at a factory that pins the pre-fix template.
const PREFIX_FACTORY = "0x0DD06656cb9a38730a7177792C357E48cEdb49Bd";
const m = html.match(/FACTORY:\s*\{([\s\S]*?)\}/);
if (!m) errs.push("rail FACTORY config not found");
else if (/^\s*8453:\s*"0x0DD06656cb9a38730a7177792C357E48cEdb49Bd"/mi.test(m[1])) errs.push("rail FACTORY[8453] is the pre-fix factory " + PREFIX_FACTORY);

// The launch rail encodes DeployParams with the contract's own Base wiring (K-3 pins it at deploy).
const wiringFile = JSON.parse(fs.readFileSync(path.join(root, "abi/PossessioPayments.wiring.json"), "utf8"));
const w = html.match(/var PAY_WIRING=\{([^}]*)\}/);
if (!w) errs.push("rail PAY_WIRING not found");
else {
  const got = Object.fromEntries([...w[1].matchAll(/(\w+):"(0x[0-9a-fA-F]{40})"/g)].map((m) => [m[1], m[2]]));
  for (const [k, v] of Object.entries(wiringFile.wiring)) if ((got[k] || "").toLowerCase() !== v.toLowerCase()) errs.push("rail wiring " + k + " is " + (got[k] || "missing") + ", the contract pins " + v);
  for (const k of Object.keys(got)) if (!(k in wiringFile.wiring)) errs.push("rail wiring has " + k + ", which the contract does not pin");
}
const tuple = "tuple(" + wiringFile.deployParams.map((f) => f.type + " " + f.name).join(",") + ")";
const d = html.match(/var PAY_DEPLOY_PARAMS="([^"]+)"/);
if (!d) errs.push("rail PAY_DEPLOY_PARAMS not found");
else if (d[1] !== tuple) errs.push("rail PAY_DEPLOY_PARAMS is not the contract's DeployParams:\n    rail     " + d[1] + "\n    contract " + tuple);

// The template artifact the rail hashes against factory.templateCodehash() is at least consistent with itself and
// with the wiring file's revision; the chain remains the authority (D2).
const art = JSON.parse(fs.readFileSync(path.join(root, "artifacts/payments.json"), "utf8"));
if (keccak256(art.creationCode) !== art.codehash) errs.push("artifacts/payments.json: codehash is not keccak256(creationCode)");
if (art.possessioRev !== wiringFile.possessioRev) errs.push("artifacts/payments.json and the wiring file come from different Possessio revisions (" + art.possessioRev + " vs " + wiringFile.possessioRev + ")");

// The treasury card's ABI fragments (balances, payee check, the send rows) must be the contract's.
const pm = html.match(/const PAY_ABI = (\[[\s\S]*?\n\]);/);
if (!pm) errs.push("PAY_ABI not found");
else for (const f of (0, eval)("(" + pm[1] + ")")) {
  const a = abiBySig.get(sig(f.name, f.inputs));
  if (!a) errs.push("PAY_ABI has " + sig(f.name, f.inputs) + ", which the contract does not have");
  else if (a.outputs.map(t).join(",") !== (f.outputs || []).map(t).join(",")) errs.push("PAY_ABI " + f.name + ": outputs differ from the contract");
}

if (errs.length) { console.error("ABI SYNC FAIL\n  " + errs.join("\n  ")); process.exit(1); }
console.log("ABI SYNC PASS: " + pay.functions.length + " panel entries, every contract write covered, rail wiring + DeployParams + artifact + treasury fragments match " + wiringFile.contract + "@" + wiringFile.possessioRev + ", rail off the pre-fix factory");
