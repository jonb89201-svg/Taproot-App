// Share cards: the tags X, Open Graph readers and Farcaster use to render a link to the Seal page and
// the console. Every image a tag names must exist in the repo at the size the tag declares, the X card
// must be the large-image kind, and each fc:miniapp embed must parse and launch on the canonical domain.
// `node test/share-tags.mjs --mutants` plants breaks in memory; each must be caught.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://taproot.possessio.io";
const CANONICAL = JSON.parse(readFileSync(path.join(ROOT, ".well-known/farcaster.json"), "utf8")).miniapp.canonicalDomain;

function meta(html, key) {
  // property="og:…" or name="twitter:…", either attribute order is not used here: the pages write key first
  const re = new RegExp(`<meta\\s+(?:property|name)="${key.replace(/[.:]/g, "\\$&")}"\\s+content=(["'])(.*?)\\1`, "s");
  const m = html.match(re);
  return m ? m[2] : null;
}

function pngSize(file) {
  const b = readFileSync(file);
  if (b.toString("ascii", 1, 4) !== "PNG") throw new Error(`${file} is not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function localImage(url, label) {
  if (!url || !url.startsWith(ORIGIN + "/")) throw new Error(`${label}: ${url} is not served from ${ORIGIN}`);
  const file = path.join(ROOT, url.slice(ORIGIN.length + 1));
  if (!existsSync(file)) throw new Error(`${label}: ${url} has no file in the repo`);
  return pngSize(file);
}

export function checkMiniappEmbed(html, page) {
  const raw = meta(html, "fc:miniapp");
  if (!raw) throw new Error(`${page}: no fc:miniapp tag`);
  const e = JSON.parse(raw);
  if (e.version !== "1") throw new Error(`${page}: fc:miniapp version ${e.version}`);
  const img = localImage(e.imageUrl, `${page} fc:miniapp imageUrl`);
  if (img.w * 2 !== img.h * 3) throw new Error(`${page}: fc:miniapp image ${img.w}x${img.h} is not 3:2`);
  const t = e.button?.title ?? "";
  if (!t || t.length > 32) throw new Error(`${page}: button title "${t}" must be 1-32 characters`);
  const a = e.button.action;
  if (a?.type !== "launch_miniapp") throw new Error(`${page}: action type ${a?.type}`);
  if (new URL(a.url).host !== CANONICAL) throw new Error(`${page}: action url ${a.url} is off ${CANONICAL}`);
  const s = localImage(a.splashImageUrl, `${page} splashImageUrl`);
  if (s.w !== 200 || s.h !== 200) throw new Error(`${page}: splash ${s.w}x${s.h}, expected 200x200`);
  return e;
}

export function checkSealCard(html) {
  const page = "seal.html";
  for (const k of ["og:title", "og:description", "og:url", "og:image", "twitter:card", "twitter:title", "twitter:image"]) {
    if (!meta(html, k)) throw new Error(`${page}: missing ${k}`);
  }
  if (meta(html, "twitter:card") !== "summary_large_image") throw new Error(`${page}: twitter:card is not summary_large_image`);
  if (meta(html, "og:url") !== ORIGIN + "/seal") throw new Error(`${page}: og:url ${meta(html, "og:url")}`);
  const img = localImage(meta(html, "og:image"), `${page} og:image`);
  if (String(img.w) !== meta(html, "og:image:width") || String(img.h) !== meta(html, "og:image:height")) {
    throw new Error(`${page}: og:image is ${img.w}x${img.h}, tags say ${meta(html, "og:image:width")}x${meta(html, "og:image:height")}`);
  }
  if (Math.abs(img.w / img.h - 1.91) > 0.02) throw new Error(`${page}: og:image ${img.w}x${img.h} is not ~1.91:1`);
  if (meta(html, "twitter:image") !== meta(html, "og:image")) throw new Error(`${page}: twitter:image and og:image differ`);
  const e = checkMiniappEmbed(html, page);
  if (e.button.action.url !== ORIGIN + "/seal") throw new Error(`${page}: embed opens ${e.button.action.url}, not the Seal page`);
}

const read = (f) => readFileSync(path.join(ROOT, f), "utf8");

if (process.argv.includes("--mutants")) {
  const seal = read("seal.html");
  const mutants = [
    ["og:image names a missing file", seal.replace("seal_card_1200x630.png\" />\n<meta property=\"og:image:width", "seal_card_missing.png\" />\n<meta property=\"og:image:width")],
    ["declared size disagrees with the image", seal.replace('og:image:height" content="630"', 'og:image:height" content="600"')],
    ["small card instead of the large one", seal.replace('content="summary_large_image"', 'content="summary"')],
    ["embed uses the 1.91:1 card", seal.replace('"imageUrl":"https://taproot.possessio.io/assets_base/seal_embed_1200x800.png"', '"imageUrl":"https://taproot.possessio.io/assets_base/seal_card_1200x630.png"')],
    ["button title over 32 characters", seal.replace('"title":"Open Seal"', '"title":"Open the Seal hash-fingerprint now"')],
    ["embed opens the console, not Seal", seal.replace('"url":"https://taproot.possessio.io/seal"', '"url":"https://taproot.possessio.io"')],
    ["embed launches off the canonical domain", seal.replace('"url":"https://taproot.possessio.io/seal"', '"url":"https://evil.example/seal"')],
  ];
  let killed = 0;
  for (const [name, html] of mutants) {
    if (html === seal) { console.log(`NOT PLANTED  ${name}`); continue; }
    try { checkSealCard(html); console.log(`SURVIVED     ${name}`); }
    catch (err) { killed++; console.log(`killed       ${name}: ${err.message}`); }
  }
  console.log(`${killed}/${mutants.length} mutants killed`);
  process.exit(killed === mutants.length ? 0 : 1);
}

checkSealCard(read("seal.html"));
console.log("ok  seal.html share card: og + twitter large image + fc:miniapp embed opening /seal");
checkMiniappEmbed(read("index.html"), "index.html");
console.log("ok  index.html fc:miniapp embed");
