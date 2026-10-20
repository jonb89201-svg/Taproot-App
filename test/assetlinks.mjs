// Digital Asset Links: the file that lets the Android wrapper open taproot.possessio.io without Chrome's address bar.
// Every fingerprint in it must be the SHA-256 of a certificate committed under android/certs/ (Play's certificate
// download), so a typed, stale or placeholder fingerprint is caught; the package must be the one the Play Console
// holds; and the Bubblewrap project must agree. `node test/assetlinks.mjs --mutants` plants breaks in memory; each
// must be caught.
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "io.taproot.possessio"; // held by the Play Console since the first accepted bundle (2026-10-20)
const RELATION = "delegate_permission/common.handle_all_urls";
const FP = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

// An X.509 certificate's SHA-256 fingerprint is the SHA-256 of its DER bytes.
function fingerprint(der) {
  return createHash("sha256").update(der).digest("hex").toUpperCase().match(/../g).join(":");
}

function load() {
  const dir = path.join(ROOT, "android/certs");
  const certs = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".der")).sort().map((f) => [f, readFileSync(path.join(dir, f))]));
  return {
    assetlinks: readFileSync(path.join(ROOT, ".well-known/assetlinks.json"), "utf8"),
    twa: readFileSync(path.join(ROOT, "android/twa-manifest.json"), "utf8"),
    certs,
  };
}

export function check({ assetlinks, twa, certs }) {
  const statements = JSON.parse(assetlinks);
  if (!Array.isArray(statements) || statements.length !== 1) throw new Error("assetlinks: expected exactly one statement");
  const [s] = statements;
  if (!Array.isArray(s.relation) || s.relation.length !== 1 || s.relation[0] !== RELATION) throw new Error(`assetlinks: relation ${JSON.stringify(s.relation)}`);
  if (s.target?.namespace !== "android_app") throw new Error(`assetlinks: namespace ${s.target?.namespace}`);
  if (s.target.package_name !== PACKAGE) throw new Error(`assetlinks: package ${s.target.package_name}; the Play Console holds ${PACKAGE}`);
  const fps = s.target.sha256_cert_fingerprints;
  if (!Array.isArray(fps) || fps.length === 0) throw new Error("assetlinks: no fingerprints");
  const byFp = new Map(Object.entries(certs).map(([name, der]) => [fingerprint(der), name]));
  if (byFp.size === 0) throw new Error("android/certs: no certificates");
  for (const fp of fps) {
    if (!FP.test(fp)) throw new Error(`assetlinks: ${JSON.stringify(fp)} is not a SHA-256 fingerprint`);
    if (!byFp.has(fp)) throw new Error(`assetlinks: ${fp} is not the SHA-256 of any certificate in android/certs/`);
  }
  if (new Set(fps).size !== fps.length) throw new Error("assetlinks: duplicate fingerprint");
  for (const [fp, name] of byFp) if (!fps.includes(fp)) throw new Error(`android/certs/${name} (${fp}) is not in assetlinks`);
  const t = JSON.parse(twa);
  if (t.packageId !== PACKAGE) throw new Error(`twa-manifest: packageId ${t.packageId}`);
  const tfps = (t.fingerprints || []).map((f) => f.value);
  for (const fp of fps) if (!tfps.includes(fp)) throw new Error(`twa-manifest: fingerprint ${fp} missing`);
  for (const fp of tfps) if (!fps.includes(fp)) throw new Error(`twa-manifest: fingerprint ${fp} is not in assetlinks`);
  return fps.map((fp) => `${fp}  ${byFp.get(fp)}`);
}

function withStatement(files, edit) {
  const st = JSON.parse(files.assetlinks);
  edit(st[0]);
  return { ...files, assetlinks: JSON.stringify(st) };
}

const MUTANTS = [
  ["package name is the old io.possessio.taproot", (f) => withStatement(f, (s) => (s.target.package_name = "io.possessio.taproot"))],
  ["one hex digit of a fingerprint changed", (f) => withStatement(f, (s) => { const a = s.target.sha256_cert_fingerprints; a[0] = (a[0][0] === "0" ? "1" : "0") + a[0].slice(1); })],
  ["placeholder left in a fingerprint", (f) => withStatement(f, (s) => (s.target.sha256_cert_fingerprints[0] = "<Play app signing SHA-256>"))],
  ["a fingerprint typed in without its certificate", (f) => withStatement(f, (s) => s.target.sha256_cert_fingerprints.push("00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF"))],
  ["a certificate missing from android/certs", (f) => { const certs = { ...f.certs }; delete certs[Object.keys(certs)[0]]; return { ...f, certs }; }],
  ["relation is not handle_all_urls", (f) => withStatement(f, (s) => (s.relation = ["delegate_permission/common.get_login_creds"]))],
  ["twa-manifest packageId drifts", (f) => ({ ...f, twa: f.twa.replace(`"packageId": "${PACKAGE}"`, '"packageId": "io.possessio.taproot.twa"') })],
];

const files = load();
if (process.argv.includes("--mutants")) {
  let caught = 0;
  for (const [name, mutate] of MUTANTS) {
    try { check(mutate(files)); console.log(`SURVIVED  ${name}`); }
    catch (e) { caught++; console.log(`caught    ${name}: ${e.message}`); }
  }
  console.log(`${caught}/${MUTANTS.length} mutants caught`);
  if (caught !== MUTANTS.length) process.exit(1);
} else {
  for (const line of check(files)) console.log(line);
  console.log(`assetlinks ok: ${PACKAGE}`);
}
