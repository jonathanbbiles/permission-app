#!/usr/bin/env node
/* ============================================================================
   check-layout.mjs — render every screen at phone, iPhone Duo and iPad sizes
                      and FAIL on what a reviewer would see as broken.

   Usage:  npm run verify:layout                 (serves www/ itself)
           node scripts/check-layout.mjs [shotDir]

   Needs a headless Chromium (Playwright). Not part of `npm test`, because the
   Codemagic/CI image has no browser; run it before every layout change.
   CHROMIUM_PATH=/path/to/chrome overrides the browser Playwright would pick.

   Per size it checks, on Home, Write, Record, Draw, Notebook, an entry, the
   full journal and the Settings sheet:
     - no horizontal overflow (the page never scrolls sideways);
     - the LAST control of the screen can be scrolled to and sits fully on
       screen (nothing trapped below the fold or under the home indicator);
     - Draw: Discard + Save are on screen without scrolling, the canvas is at
       least 240pt tall, it does not scroll, and a stroke really lands as ink;
     - Notebook: Page PNG + Export PDF on screen without scrolling;
     - from 600pt wide the content uses the width (no phone column), and in
       landscape from 760pt the Home screen really is two columns.

   Sizes (CSS pt):  390x844 iPhone · 466x678 iPhone Duo closed ·
     669x951 / 951x669 Duo open · 820x1180 / 1180x820 iPad Air 11" ·
     1024x1366 / 1366x1024 iPad Pro 13" · 844x390 iPhone sideways.
   ========================================================================== */

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WWW = path.join(ROOT, "www");
const SHOTS = process.argv[2] ? path.resolve(process.argv[2]) : null;

const SIZES = [
  [390, 844], [466, 678], [669, 951], [951, 669],
  [820, 1180], [1180, 820], [1024, 1366], [1366, 1024], [844, 390],
];

/* ---- a tiny static server for www/ (no dependency) ---- */
const server = http.createServer((req, res) => {
  const p = path.join(WWW, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html");
  if (!p.startsWith(WWW) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": p.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL = `http://127.0.0.1:${server.address().port}/index.html`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const fail = (msg) => { failed++; console.error("  ✗ " + msg); };

const SAMPLE = [
  ["s1", "text", 40, "What is one thing you long for?", "I want to stop apologising for wanting to be wanted."],
  ["s2", "voice", 1560, "Where in your body do you feel most at home right now?", "My shoulders, oddly."],
  ["s3", "text", 3120, "Name something you gave yourself permission for this week.", "I said no, and the sky did not fall."],
  ["s4", "text", 4440, "What would you say to the version of you from ten years ago?", "That you were not too much."],
  ["s5", "text", 5940, "What does rest actually look like for you?", "Not earning it first."],
  ["s6", "text", 7260, "Where are you being gentler with yourself?", "I let a morning be slow today."],
  ["s7", "text", 9000, "What did your body ask for today?", "Water, and to be left alone for ten minutes."],
];

async function unlock(page) {
  await page.waitForSelector("#pad button.key", { timeout: 15000 });
  const tap4 = async () => { for (let i = 0; i < 4; i++) { await page.click('#pad button.key:has-text("1")'); await sleep(60); } };
  await tap4(); await sleep(450);
  if (await page.locator("#lock").isVisible()) { await tap4(); await sleep(600); }
  if (await page.locator("#onboard").isVisible()) { await page.click("#obSkip"); await sleep(600); }
}

async function seed(page) {
  await page.evaluate(async (rows) => {
    const audio = new Blob([new Uint8Array([0, 0, 0, 32, 102, 116, 121, 112])], { type: "audio/mp4" });
    const db = await new Promise((res, rej) => { const r = indexedDB.open("awaken_db"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => {
      const tx = db.transaction("entries", "readwrite"); const st = tx.objectStore("entries");
      for (const [id, type, off, prompt, body] of rows) {
        const rec = { id, ts: Date.now() - off * 60000, type, prompt };
        if (type === "text") rec.text = body; else { rec.audio = audio; rec.mime = "audio/mp4"; rec.duration = 84; rec.transcript = body; }
        st.put(rec);
      }
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }, SAMPLE);
  await page.evaluate(() => window.Permission.showApp());
  await sleep(600);
}

/* Generic checks for whatever screen is showing. `lastSel` is the control that
   must be reachable at the bottom of the screen. */
async function checkScreen(page, tag, name, lastSel) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(120);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${tag}-${name}.png`) });
  const r = await page.evaluate((sel) => {
    const de = document.documentElement;
    const out = { overflowX: de.scrollWidth > window.innerWidth + 1, sw: de.scrollWidth, iw: window.innerWidth };
    const els = [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null || getComputedStyle(e).position === "fixed");
    const el = els[els.length - 1];
    if (!el) { out.missing = true; return out; }
    el.scrollIntoView({ block: "end" });
    const b = el.getBoundingClientRect();
    out.last = { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height) };
    out.vh = window.innerHeight;
    out.onScreen = b.bottom <= window.innerHeight + 0.5 && b.top >= -0.5 && b.right <= window.innerWidth + 0.5 && b.left >= -0.5;
    return out;
  }, lastSel);
  if (r.overflowX) fail(`${tag} ${name}: horizontal overflow (${r.sw} > ${r.iw})`);
  if (r.missing) fail(`${tag} ${name}: no visible "${lastSel}"`);
  else if (!r.onScreen) fail(`${tag} ${name}: last control ${lastSel} not reachable (${JSON.stringify(r.last)} vh=${r.vh})`);
  await page.evaluate(() => window.scrollTo(0, 0));
}

const exe = process.env.CHROMIUM_PATH || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

for (const [w, h] of SIZES) {
  const tag = `${w}x${h}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: true, colorScheme: "light" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(URL, { waitUntil: "load" });
  await unlock(page);
  await seed(page);
  await sleep(1600);   // let the "Passcode set" toast fade

  /* HOME */
  const home = await page.evaluate(() => {
    const body = document.body.getBoundingClientRect();
    const p = document.querySelector("#v-home .prompt").getBoundingClientRect();
    const l = document.getElementById("homeList").getBoundingClientRect();
    return { bodyW: body.width, sideBySide: l.left >= p.right - 1 };
  });
  if (w >= 600 && home.bodyW < w * 0.85) fail(`${tag} home: content is a ${Math.round(home.bodyW)}pt column on a ${w}pt screen`);
  if (w >= 760 && w > h && !home.sideBySide) fail(`${tag} home: landscape is not two columns`);
  if (h >= w && w < 1100 && home.sideBySide) fail(`${tag} home: portrait unexpectedly two columns`);
  await checkScreen(page, tag, "1-home", "#homeList .entry, .foot a");

  /* WRITE */
  await page.click('.mode[data-mode="text"]'); await sleep(450);
  await checkScreen(page, tag, "2-write", "#tSave");
  await page.click('#v-text .btnrow [data-discard]'); await sleep(450);

  /* RECORD */
  await page.click('.mode[data-mode="voice"]'); await sleep(500);
  await checkScreen(page, tag, "3-record", "#vSave");
  await page.click('#v-voice .btnrow [data-discard]'); await sleep(450);

  /* DRAW — actions on screen without scrolling, canvas a sensible size, ink lands */
  await page.click('.mode[data-mode="draw"]'); await sleep(1000);
  const dw = await page.evaluate(() => {
    const vh = window.innerHeight, vw = window.innerWidth;
    const save = document.getElementById("dSave").getBoundingClientRect();
    const disc = document.querySelector("#drawActions [data-discard]").getBoundingClientRect();
    const c = document.getElementById("drawCanvas").getBoundingClientRect();
    const overlaps = (a) => !(a.right <= c.left || a.left >= c.right || a.bottom <= c.top || a.top >= c.bottom);
    return {
      vh, vw, cw: Math.round(c.width), ch: Math.round(c.height), cBottom: Math.round(c.bottom),
      actionsVisible: save.bottom <= vh && disc.bottom <= vh && save.right <= vw,
      overlap: overlaps(save) || overlaps(disc),
      scrolls: document.documentElement.scrollHeight > vh + 1,
    };
  });
  if (!dw.actionsVisible) fail(`${tag} draw: Discard/Save not on screen`);
  if (dw.overlap) fail(`${tag} draw: actions overlap the canvas`);
  if (dw.ch < 240) fail(`${tag} draw: canvas only ${dw.ch}pt tall`);
  if (dw.cBottom > dw.vh + 1 && h >= 600) fail(`${tag} draw: canvas runs off the bottom (${dw.cBottom} > ${dw.vh})`);
  if (dw.scrolls && h >= 600) fail(`${tag} draw: view scrolls`);
  await page.locator("#drawCanvas").scrollIntoViewIfNeeded();
  const box = await page.locator("#drawCanvas").boundingBox();
  const sx = box.x + box.width * 0.3, sy = box.y + box.height * 0.4;
  await page.mouse.move(sx, sy); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 12 }); await page.mouse.up();
  await sleep(100);
  const ink = await page.evaluate(([x, y]) => {
    const c = document.getElementById("drawCanvas"), r = c.getBoundingClientRect();
    const k = c.width / r.width, ctx = c.getContext("2d");
    const px = ctx.getImageData(Math.round((x - r.left) * k), Math.round((y - r.top) * k), 1, 1).data;
    return px[0] < 200 && px[1] < 200;   // the default pen is a dark plum on white paper
  }, [box.x + box.width * 0.5, box.y + box.height * 0.5]);
  if (!ink) fail(`${tag} draw: a stroke across the canvas left no ink under the finger`);
  console.log(`${tag.padEnd(10)} draw canvas ${dw.cw}x${dw.ch}${ink ? "  ink ✓" : ""}`);
  await checkScreen(page, tag, "4-draw", "#dSave");
  await page.click("#drawActions [data-discard]"); await sleep(500);

  /* NOTEBOOK */
  await page.click("#cardNotebook"); await sleep(1000);
  const nb = await page.evaluate(() => {
    const vh = window.innerHeight, vw = window.innerWidth;
    const row = document.getElementById("nbExportRow").getBoundingClientRect();
    const c = document.getElementById("nbCanvas").getBoundingClientRect();
    return { vh, ok: row.bottom <= vh && row.right <= vw, cw: Math.round(c.width), ch: Math.round(c.height),
      scrolls: document.documentElement.scrollHeight > vh + 1 };
  });
  if (!nb.ok) fail(`${tag} notebook: exports not on screen`);
  if (nb.scrolls && h >= 600) fail(`${tag} notebook: view scrolls`);
  console.log(`${"".padEnd(10)} notebook canvas ${nb.cw}x${nb.ch}`);
  await checkScreen(page, tag, "5-notebook", "#nbExportPdf");
  await page.click("#v-notebook [data-back]"); await sleep(600);

  /* ENTRY + JOURNAL + SETTINGS */
  await page.click("#homeList .entry"); await sleep(600);
  await checkScreen(page, tag, "6-entry", "#eShare");
  await page.click("#entryBack"); await sleep(500);
  await page.evaluate(() => window.Permission.showView("journal")); await sleep(500);
  await checkScreen(page, tag, "7-journal", "#allList .entry");
  await page.evaluate(() => window.Permission.showApp()); await sleep(400);
  await page.click("#btnSettings"); await sleep(600);
  await checkScreen(page, tag, "8-settings", "#setErase");

  if (errors.length) fail(`${tag}: page errors ${errors.slice(0, 3).join(" | ")}`);
  await ctx.close();
}

await browser.close();
server.close();
if (failed) { console.error(`\n${failed} layout problem(s).`); process.exit(1); }
console.log(`\nAll ${SIZES.length} sizes: no horizontal overflow, last controls reachable, drawing works.`);
