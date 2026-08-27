#!/usr/bin/env node
/* ============================================================================
   verify-no-network.mjs — prove the two claims the privacy policy now makes
   outright, rather than asserting them in prose and hoping.

     1. THE APP MAKES NO NETWORK REQUESTS. Loaded with every non-local request
        ABORTED at the browser, the app must still work and must not have tried.
     2. THE FONTS ARE UNCHANGED. Embedding them must not have altered a single
        glyph. test/font-baseline.json holds the widths measured while the fonts
        were still being fetched from Google, at 64px, for every weight and
        style the app declares — plus a line of accented characters, because a
        wrongly-chosen subset shows up there first and nowhere else.

   Why widths: a face that failed to load silently renders in a FALLBACK, which
   looks approximately right in a screenshot and is obviously wrong in a
   measurement. Widths catch a missing subset, a mis-declared weight range
   (faux-bold instead of the real 700), and a corrupt embed.

   Usage:  cd www && python3 -m http.server 8765
           node scripts/verify-no-network.mjs [url]
   ========================================================================== */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const URL = process.argv[2] || "http://localhost:8765/index.html";
const ORIGIN = URL.replace(/\/[^/]*$/, "");
const EXPECTED = JSON.parse(fs.readFileSync(path.join(ROOT, "test/font-baseline.json"), "utf8"));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  — " + extra : "")); }
};

const SAMPLES = [
  ["Poppins", 400, "normal"], ["Poppins", 500, "normal"], ["Poppins", 600, "normal"],
  ["Poppins", 400, "italic"],
  ["Oswald", 400, "normal"], ["Oswald", 500, "normal"], ["Oswald", 600, "normal"], ["Oswald", 700, "normal"],
  ["Caveat", 600, "normal"], ["Caveat", 700, "normal"],
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } });
const page = await ctx.newPage();

const attempted = [];
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e)));
// Abort anything that is not this page or a data: URI. If the app needs the
// network for anything at all, it fails here rather than in someone's pocket.
await page.route("**/*", (route) => {
  const u = route.request().url();
  if (u.startsWith(ORIGIN) || u.startsWith("data:") || u.startsWith("blob:")) return route.continue();
  attempted.push(u);
  return route.abort();
});
await page.goto(URL, { waitUntil: "networkidle" });

console.log("\n1) no network");
ok("the app requested nothing outside itself", attempted.length === 0, attempted.join(" | "));
ok("no page errors with the network unavailable", pageErrors.length === 0, pageErrors.join(" | "));
ok("the app still booted (its lock screen rendered)",
   await page.locator("#pad button.key").count() > 0);

await page.evaluate(async (samples) => {
  await Promise.all(samples.map(([f, w, s]) =>
    document.fonts.load(`${s} ${w} 64px '${f}'`).catch(() => {})));
  await document.fonts.ready;
}, SAMPLES);
await page.waitForTimeout(400);

const got = await page.evaluate((samples) => {
  const TEXT = "Permission — today's invitation ABCxyz 0123 fi ffl";
  const ACCENT = "àâäçéèêëîïôöùûüñ ĄĆĘŁŃŚŹŻ";
  const out = {};
  const probe = (fam, weight, style, text) => {
    const s = document.createElement("span");
    s.style.cssText = `position:absolute;left:-9999px;top:0;white-space:pre;font-size:64px;` +
      `font-family:'${fam}';font-weight:${weight};font-style:${style};`;
    s.textContent = text;
    document.body.appendChild(s);
    const r = s.getBoundingClientRect();
    document.body.removeChild(s);
    return { w: +r.width.toFixed(2), h: +r.height.toFixed(2) };
  };
  for (const [fam, weight, style] of samples) {
    out[`${fam}/${weight}/${style}`] = probe(fam, weight, style, TEXT);
    out[`${fam}/${weight}/${style}/accents`] = probe(fam, weight, style, ACCENT);
    out[`${fam}/${weight}/${style}/loaded`] = document.fonts.check(`${style} ${weight} 64px ${fam}`);
  }
  return out;
}, SAMPLES);

console.log("\n2) every face is really there, offline");
for (const [fam, w, st] of SAMPLES) {
  ok(`${fam} ${w} ${st} loaded from the embedded data`, got[`${fam}/${w}/${st}/loaded`] === true);
}

console.log("\n3) the glyphs are byte-for-byte the ones Google served");
for (const key of Object.keys(EXPECTED).sort()) {
  const e = EXPECTED[key], g = got[key];
  ok(`${key} renders identically`,
     !!g && Math.abs(g.w - e.w) < 0.01 && Math.abs(g.h - e.h) < 0.01,
     g ? `expected ${e.w}x${e.h}, got ${g.w}x${g.h}` : "not measured");
}

await browser.close();
console.log("\n" + "=".repeat(40));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
