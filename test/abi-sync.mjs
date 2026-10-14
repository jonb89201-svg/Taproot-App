// Checks the Payments panel in index.html against the fixed contract ABI.
// node test/abi-sync.mjs  -> exit 0 in sync, exit 1 on any drift.
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

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

if (errs.length) { console.error("ABI SYNC FAIL\n  " + errs.join("\n  ")); process.exit(1); }
console.log("ABI SYNC PASS: " + pay.functions.length + " panel entries, every contract write covered, rail off the pre-fix factory");
