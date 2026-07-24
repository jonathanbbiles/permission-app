/* ============================================================
   Permission — smoke + logic tests (no deps, run with: npm test)
   Validates the pieces most likely to break the live app:
   pronoun templating, prompt tagging + inclusivity sweep, the
   hand-rolled PDF byte offsets, the drawing coordinate fix, and
   that the removed Tapping feature leaves no remnants.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "www/index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  — " + extra : "")); }
}
function section(t){ console.log("\n" + t); }

/* --- helper: slice real source verbatim from a start marker up to an
       end anchor (brace-counting is unsafe here: fillTokens contains
       "{" inside string/regex literals). --- */
function sliceTo(src, startMarker, endAnchor) {
  const s = src.indexOf(startMarker);
  if (s < 0) return null;
  const e = src.indexOf(endAnchor, s + startMarker.length);
  if (e < 0) return null;
  return src.slice(s, e).trimEnd();
}

/* ============================================================ */
section("1) Tapping feature fully removed");
ok("no 'tapping' word", !/tapping/i.test(html));
ok("no tab bar", !/permTabbar|__permTab|class="tabbar"/.test(html));
ok("no external feed fetch", !/FEED_URL|wp-json\/tapping/.test(html));
ok("no tapping player", !/tapPlayer|v-tapping/.test(html));
ok("tapping-config.js gone", !fs.existsSync(path.join(ROOT, "www/tapping-config.js")));
ok("tapping-sample.json gone", !fs.existsSync(path.join(ROOT, "www/tapping-sample.json")));

/* ============================================================ */
section("2) Single script block parses");
const scripts = html.match(/<script>/g) || [];
ok("exactly one inline <script>", scripts.length === 1, "found " + scripts.length);
const jsMatch = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
ok("script body extracted", !!jsMatch);
if (jsMatch) {
  const tmp = path.join(ROOT, "test", ".extracted.js");
  fs.writeFileSync(tmp, jsMatch[1]);
  let syntaxOk = true;
  try { execSync(`node --check "${tmp}"`, { stdio: "pipe" }); }
  catch (e) { syntaxOk = false; console.error(String(e.stderr || e)); }
  fs.unlinkSync(tmp);
  ok("inline JS passes node --check", syntaxOk);
}

/* ============================================================ */
section("3) Prompts tagged by depth + inclusive");
const promptsSrc = html.match(/var PROMPTS=\[([\s\S]*?)\n  \];/);
ok("PROMPTS array found", !!promptsSrc);
const entries = [...(promptsSrc ? promptsSrc[1] : "").matchAll(/\{t:"(quick|deep|playful)",\s*q:"((?:[^"\\]|\\.)*)"\}/g)]
  .map(m => ({ t: m[1], q: m[2] }));
ok("parsed many prompts", entries.length >= 80, "got " + entries.length);
const byType = t => entries.filter(e => e.t === t).length;
ok("has Quick prompts", byType("quick") >= 10, byType("quick") + "");
ok("has Deep prompts", byType("deep") >= 40, byType("deep") + "");
ok("has Playful prompts", byType("playful") >= 8, byType("playful") + "");

// Inclusivity sweep: no gendered/heteronormative assumptions in prompt text.
// (Pronoun tokens {they}/{them} are allowed; "he"/"she" only inside tokens elsewhere.)
const banned = /\b(woman|women|girl|girls|good girl|husband|wife|boyfriend|girlfriend)\b/i;
const offenders = entries.filter(e => banned.test(e.q));
ok("no gendered/heteronormative terms in prompts", offenders.length === 0,
   offenders.map(o => o.q).join(" | "));
// prompts that address a partner should stay neutral
ok("uses inclusive 'someone you love' not gendered partner", /someone you love/.test(html));

/* ============================================================ */
section("4) Pronoun templating resolves + defaults to they/them");
const PRON = sliceTo(html, "var PRON_TABLE=", "function currentPronouns(");
const capFn = sliceTo(html, "function cap(", "\n  // Resolve");
const fillFn = sliceTo(html, "function fillTokens(", "\n\n  /* ===");
ok("templating pieces present", PRON && capFn && fillFn);
if (PRON && capFn && fillFn) {
  // Build an isolated harness with an injectable pronoun choice.
  const make = new Function("__which", `
    ${PRON}
    ${capFn}
    function currentPronouns(){ return PRON_TABLE[__which]; }
    ${fillFn}
    return fillTokens;
  `);
  const fillThey = make("they");
  const fillShe  = make("she");
  const fillHe   = make("he");
  const T = "Picture the you of a year from now. What have {they} finally let {themself} have?";
  ok("they/them resolves", fillThey(T) === "Picture the you of a year from now. What have they finally let themself have?", fillThey(T));
  ok("she/her resolves", fillShe(T) === "Picture the you of a year from now. What have she finally let herself have?", fillShe(T));
  ok("he/him resolves", fillHe(T) === "Picture the you of a year from now. What have he finally let himself have?", fillHe(T));
  ok("capitalized token preserved", fillThey("{They} know") === "They know", fillThey("{They} know"));
  ok("no-token string untouched", fillThey("just you") === "just you");
  // PRON_TABLE completeness
  ok("PRON_TABLE has she/he/they", /she:\{/.test(PRON) && /he:\{/.test(PRON) && /they:\{/.test(PRON));
}

/* ============================================================ */
section("5) Drawing coordinate fix present (rect-offset + scale)");
ok("maps through bounding-rect offset", /cx-rect\.left/.test(html) && /cy-rect\.top/.test(html));
ok("scales CSS size -> logical size (x)", /cw\s*\/\s*\(rect\.width/.test(html));
ok("scales CSS size -> logical size (y)", /ch\s*\/\s*\(rect\.height/.test(html));
ok("retina backing store (dpr)", /canvas\.width=Math\.round\(cw\*dpr\)/.test(html));
ok("uses pointer events", /addEventListener\("pointerdown"/.test(html));

/* ============================================================ */
section("6) Hand-rolled PDF builder produces valid byte offsets");
const buildPdfSrc = sliceTo(html, "function buildPdf(", "\n  // Rasterize all notebook");
ok("buildPdf present", !!buildPdfSrc);
if (buildPdfSrc) {
  const buildPdf = new Function("TextEncoder", buildPdfSrc + "\nreturn buildPdf;")(globalThis.TextEncoder);
  // two fake JPEG "pages"
  const pages = [
    { bytes: new Uint8Array([0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9]), w: 100, h: 140 },
    { bytes: new Uint8Array([0xFF, 0xD8, 9, 8, 7, 6, 0xFF, 0xD9]), w: 100, h: 140 },
  ];
  const pdf = buildPdf(pages);
  const buf = Buffer.from(pdf);
  const txt = buf.toString("latin1");
  ok("starts with %PDF", txt.startsWith("%PDF-1.3"));
  ok("has trailer + EOF", txt.includes("trailer") && txt.trimEnd().endsWith("%%EOF"));
  // parse startxref, then verify each xref offset points at "N 0 obj"
  const sx = txt.match(/startxref\n(\d+)\n%%EOF/);
  ok("startxref present", !!sx);
  if (sx) {
    const xrefStart = parseInt(sx[1], 10);
    ok("startxref points to 'xref'", txt.slice(xrefStart, xrefStart + 4) === "xref", txt.slice(xrefStart, xrefStart + 4));
    const sizeM = txt.match(/\/Size (\d+)/);
    const size = sizeM ? parseInt(sizeM[1], 10) : 0;
    // pull the 'n' entries (skip object 0 free entry)
    const xrefBody = txt.slice(xrefStart);
    const rows = [...xrefBody.matchAll(/(\d{10}) (\d{5}) n /g)].map(m => parseInt(m[1], 10));
    ok("xref has an entry per object", rows.length === size - 1, rows.length + " vs " + (size - 1));
    let allGood = rows.length > 0;
    rows.forEach((off, idx) => {
      const objNum = idx + 1;
      const at = txt.slice(off, off + (objNum + " 0 obj").length);
      if (at !== objNum + " 0 obj") allGood = false;
    });
    ok("every xref offset lands on its 'N 0 obj'", allGood);
  }
}

/* ============================================================ */
section("7) Coordinated features + versioning in place");
ok("dark theme defined", /\[data-theme="dark"\]/.test(html));
ok("theme follows OS by default", /prefers-color-scheme: dark/.test(html));
ok("accent customization", /perm_accent/.test(html) && /var ACCENTS=/.test(html));
ok("profile + pronoun onboarding", /perm_profile/.test(html) && /id="onboard"/.test(html));
ok("gender options include self-describe + prefer not to say", /Self-describe/.test(html) && /Prefer not to say/.test(html));
ok("prompt modes quick/deep/playful selectable", /data-depth="quick"/.test(html) && /data-depth="playful"/.test(html));
ok("low-effort quick chips", /QUICK_CHIPS/.test(html));
ok("notebook multi-page + export", /id="v-notebook"/.test(html) && /buildPdf/.test(html) && /nbExportPdf/.test(html));
ok("brush/eraser/undo/redo tools", /setErasing/.test(html) && /redoOp/.test(html));
ok("website link uses Capacitor Browser.open + window.open fallback",
   /Browser\.open\(\{ url:SITE_URL \}\)/.test(html) && /window\.open\(SITE_URL/.test(html));
ok("in-app rating after success moment, not first launch", /requestReview/.test(html) && /n===3/.test(html));
ok("version bumped to 1.2", /APP_VERSION = "1\.2"/.test(html) && />v1\.2</.test(html));
ok("IndexedDB name preserved for existing users", /indexedDB\.open\("awaken_db"/.test(html));
ok("passcode keys preserved", /"awaken_pin"/.test(html) && /"awaken_face"/.test(html));

/* ============================================================ */
console.log("\n" + "=".repeat(40));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
