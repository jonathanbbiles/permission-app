#!/usr/bin/env node
/* ============================================================================
   verify-morning.mjs — DRIVE the 1.9.0 work in a real browser and fail on what
                        a person would notice.

   Usage:  npm run verify:morning            (serves www/ itself)
           node scripts/verify-morning.mjs [shotDir]

   Needs a headless Chromium (Playwright), like check-layout.mjs, so it is not
   part of `npm test`. CHROMIUM_PATH overrides the browser.

   What it walks, with a faked clock so a 2-minute practice takes no time:
     - Home shows one Morning card; it sits above the prompt in the morning and
       below the four tiles in the afternoon;
     - the timer counts down, Pause really stops it, Resume really continues,
       and it is still right after the clock jumps (the app was "put away");
     - at zero it stops on its own and waits — it never advances by itself;
     - affirmations typed today are there on the next visit, and are gone after
       Erase everything;
     - a skipped practice is skipped, and the choice is remembered;
     - Write hands over to the real Write screen with today's invitation;
     - "Keep a note" lands in the journal as an ordinary entry;
     - the brand header is hidden on every sub-screen and back on Home;
     - a voice entry shows the app's player with the MEASURED length (the seed
       recording is unplayable on purpose — exactly the "0:00 / 0:00" case);
     - no page error and no network request beyond the app's own file.
   ========================================================================== */

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WWW = path.join(ROOT, "www");
const SHOTS = process.argv[2] ? path.resolve(process.argv[2]) : null;

const server = http.createServer((req, res) => {
  const p = path.join(WWW, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html");
  if (!p.startsWith(WWW) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": p.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const URL = `${ORIGIN}/index.html`;

let passed = 0, failed = 0;
const ok = (name, cond, why = "") => { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.error("  ✗ " + name + (why ? "  — " + why : "")); } };

const exe = process.env.CHROMIUM_PATH || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

async function open(hour, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, colorScheme: opts.dark ? "dark" : "light" });
  const page = await ctx.newPage();
  const errors = [], foreign = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("request", (r) => { const u = r.url(); if (!u.startsWith(ORIGIN) && !/^(data|blob):/.test(u)) foreign.push(u); });
  await page.clock.install({ time: new Date(2026, 10, 21, hour, 5, 0) });
  await page.goto(URL, { waitUntil: "load" });
  const tick = (ms) => page.clock.runFor(ms);
  await page.waitForSelector("#pad button.key");
  const tap4 = async () => { for (let i = 0; i < 4; i++) { await page.click('#pad button.key:has-text("1")'); await tick(80); } };
  await tap4(); await tick(600);
  if (await page.locator("#lock").isVisible()) { await tap4(); await tick(800); }
  if (await page.locator("#onboard").isVisible()) { await page.click("#obSkip"); await tick(800); }
  await tick(2500);
  return { ctx, page, tick, errors, foreign };
}
const real = (ms) => new Promise((r) => setTimeout(r, ms));   // IndexedDB answers in real time, not faked time
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png") }); };
const text = (page, sel) => page.locator(sel).innerText();
const secs = async (page) => { const [m, s] = (await text(page, "#mTime")).split(":").map(Number); return m * 60 + s; };

/* ------------------------------------------------------------ morning -- */
console.log("\nMorning, at 7:05 in the morning");
{
  const { ctx, page, tick, errors, foreign } = await open(7);
  const order = await page.evaluate(() => [...document.getElementById("v-home").children].map((e) => e.id || e.className.split(" ")[0]));
  ok("one Morning card on Home", (await page.locator("#cardMorning").count()) === 1);
  ok("in the morning it sits above the prompt", order.indexOf("cardMorning") < order.indexOf("prompt") && order.indexOf("cardMorning") > order.indexOf("greet"), order.join(","));
  ok("Home shows the brand header", await page.locator("header").isVisible());
  ok("the card says what it is", /Six quiet practices · about 10 minutes/.test(await text(page, "#morningSub")), await text(page, "#morningSub"));
  await shot(page, "m1-home-morning");

  await page.click("#cardMorning"); await tick(500);
  ok("Morning opens on its setup screen", await page.locator("#mSetup").isVisible() && !(await page.locator("#mRun").isVisible()));
  ok("the brand header is hidden on Morning", !(await page.locator("header").isVisible()));
  ok("Begin shows the total", /Begin · 10 min/.test(await text(page, "#mBegin")), await text(page, "#mBegin"));
  ok("the credit is on the screen", /Hal Elrod/.test(await text(page, ".m-credit")) && /not affiliated/.test(await text(page, ".m-credit")));
  await shot(page, "m2-setup");

  // skip Move, choose 1 minute
  await page.click('.m-step[data-step="move"]'); await page.click('#mMinutes [data-min="1"]'); await tick(100);
  ok("skipping a practice and changing the minutes updates the total", /Begin · 4 min/.test(await text(page, "#mBegin")), await text(page, "#mBegin"));
  await page.click('#mMinutes [data-min="2"]'); await tick(100);

  await page.click("#mBegin"); await tick(300);
  ok("the first practice is Silence, 1 of 5", (await text(page, "#mName")).toUpperCase() === "SILENCE" && /1 of 5/i.test(await text(page, "#mKick")));
  ok("it starts at 2:00", (await secs(page)) === 120, await text(page, "#mTime"));
  await tick(30000);
  const a = await secs(page);
  ok("after 30 seconds it reads about 1:30", a >= 89 && a <= 91, String(a));
  await shot(page, "m3-silence");

  await page.click("#mPause"); await tick(20000);
  ok("Pause really stops the clock", Math.abs((await secs(page)) - a) <= 1 && /Resume/.test(await text(page, "#mPause")), await text(page, "#mTime"));
  await page.click("#mPause"); await tick(10000);
  const b = await secs(page);
  ok("Resume continues from where it stopped", b >= a - 11 && b <= a - 9, `${a} -> ${b}`);

  // the app is put away for 40s: the clock jumps without any timer firing
  const before = await secs(page);
  await page.evaluate(() => { const real = Date.now; const base = real(); Date.now = () => real() + 40000; window.__undo = () => { Date.now = real; }; });
  await tick(300);
  const after = await secs(page);
  ok("the clock is still right after the app was put away for 40s", after >= before - 42 && after <= before - 39, `${before} -> ${after}`);
  await page.evaluate(() => window.__undo());
  await tick(300);

  await tick(125000);
  ok("at zero it reads 0:00 and waits", (await text(page, "#mTime")) === "0:00" && /Silence/i.test(await text(page, "#mName")), await text(page, "#mName"));
  ok("it says so, and Pause is no longer offered", /whenever you.re ready/i.test(await text(page, "#mKick")) && await page.locator("#mPause").isDisabled());
  await tick(60000);
  ok("it never moves on by itself", /Silence/i.test(await text(page, "#mName")));

  await page.click("#mNext"); await tick(300);
  ok("Next goes to Affirm", /Affirm/i.test(await text(page, "#mName")) && await page.locator("#mAffirm").isVisible());
  await page.fill("#mAffirm", "I am allowed to begin.\nI am not behind.");
  await shot(page, "m4-affirm");
  await page.click("#mNext"); await tick(300);
  ok("then Picture", /Picture/i.test(await text(page, "#mName")) && !(await page.locator("#mAffirm").isVisible()));
  await page.click("#mNext"); await tick(300);
  ok("Move was skipped: Read is next", /Read/i.test(await text(page, "#mName")), await text(page, "#mName"));
  await page.click("#mNext"); await tick(300);
  ok("Write is last, with no timer and today's invitation", /Write/i.test(await text(page, "#mName")) && !(await page.locator("#mRing").isVisible()) && (await text(page, "#mInvite")).length > 10);
  const invite = await text(page, "#mInvite");
  await shot(page, "m5-write");
  await page.click("#mNext"); await tick(600);
  ok("Write hands over to the real Write screen, same invitation", await page.locator("#v-text").isVisible() && (await text(page, "#tPrompt")) === invite);
  ok("the brand header is hidden on Write too", !(await page.locator("header").isVisible()));
  await page.click("#v-text .btnrow [data-discard]"); await tick(600);
  ok("back Home, header back", await page.locator("#v-home").isVisible() && await page.locator("header").isVisible());
  ok("the card now says today's is done", /Done for today/.test(await text(page, "#morningSub")), await text(page, "#morningSub"));

  // second visit: choices and affirmations remembered; finish without Write -> keep a note
  await page.click("#cardMorning"); await tick(400);
  ok("the skipped practice is remembered", (await page.locator('.m-step[data-step="move"]').getAttribute("aria-pressed")) === "false");
  await page.click('.m-step[data-step="write"]'); await tick(100);
  await page.click("#mBegin"); await tick(300);
  await page.click("#mNext"); await tick(300);
  ok("yesterday's affirmations are waiting", (await page.inputValue("#mAffirm")) === "I am allowed to begin.\nI am not behind.");
  await page.click("#mNext"); await tick(200); await page.click("#mNext"); await tick(200);
  ok("the last practice says Finish", /Finish/.test(await text(page, "#mNext")) && /Read/i.test(await text(page, "#mName")));
  await page.click("#mNext"); await tick(400);
  ok("the finish screen names what was done", await page.locator("#mDone").isVisible() && /Silence · Affirm · Picture · Read/.test(await text(page, "#mDoneSum")), await text(page, "#mDoneSum"));
  await shot(page, "m6-done");
  await page.click("#mDoneKeep"); await real(400); await tick(600); await real(400); await tick(600);
  ok("Keep a note lands in the journal", await page.locator("#v-home").isVisible() && /Silence · Affirm · Picture · Read/.test(await text(page, "#homeList .entry >> nth=0")));
  await page.click("#homeList .entry >> nth=0"); await real(400); await tick(600);
  ok("it opens as an ordinary entry, affirmations included", /Morning practice/i.test(await text(page, "#ePrompt")) && /I am not behind\./.test(await text(page, "#eContent")));
  ok("the entry screen has its own Lock button and no brand header", await page.locator("#v-entry [data-lock]").isVisible() && !(await page.locator("header").isVisible()));
  await page.click("#v-entry [data-lock]"); await tick(500);
  ok("that Lock button locks the app", await page.locator("#lock").isVisible());
  for (let i = 0; i < 4; i++) { await page.click('#pad button.key:has-text("1")'); await tick(80); }
  await tick(800);

  // leaving mid-practice stops it
  await page.click("#cardMorning"); await tick(300); await page.click("#mBegin"); await tick(300);
  await page.click("#mBack"); await tick(300);
  ok("Back during a practice returns to setup and stops the timer", await page.locator("#mSetup").isVisible() && await page.evaluate(() => document.getElementById("mRun").classList.contains("hidden")));
  await page.click("#mBack"); await tick(500);
  ok("Back again returns Home", await page.locator("#v-home").isVisible());

  // erase everything takes the affirmations too
  page.on("dialog", (d) => d.accept());
  await page.click("#btnSettings"); await tick(500);
  await page.locator("#setErase").scrollIntoViewIfNeeded(); await page.click("#setErase"); await tick(1500);
  ok("Erase everything removes the affirmations and today's mark",
     await page.evaluate(() => localStorage.getItem("perm_affirm") === null && localStorage.getItem("perm_morning_last") === null));

  ok("no page errors", errors.length === 0, errors.join(" | "));
  ok("no request left the app", foreign.length === 0, foreign.join(" | "));
  await ctx.close();
}

console.log("\nHome, at 3:05 in the afternoon (dark theme)");
{
  const { ctx, page, tick, errors } = await open(15, { dark: true });
  const order = await page.evaluate(() => [...document.getElementById("v-home").children].map((e) => e.id || e.className.split(" ")[0]));
  ok("after noon the card sits under the four tiles", order.indexOf("cardMorning") === order.indexOf("modes") + 1, order.join(","));
  await page.locator("#cardMorning").scrollIntoViewIfNeeded(); await tick(200);
  await shot(page, "m7-home-afternoon-dark");
  await page.click("#cardMorning"); await tick(400); await page.click("#mBegin"); await tick(400);
  await shot(page, "m8-silence-dark");
  await page.click("#mBack"); await tick(200); await page.click("#mBack"); await tick(500);

  /* the player, on a voice entry whose file cannot report a length */
  await page.evaluate(async () => {
    const audio = new Blob([new Uint8Array([0, 0, 0, 32, 102, 116, 121, 112])], { type: "audio/mp4" });
    const db = await new Promise((res, rej) => { const r = indexedDB.open("awaken_db"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => { const tx = db.transaction("entries", "readwrite");
      tx.objectStore("entries").put({ id: "v1", ts: Date.now() - 60000, type: "voice", prompt: "Where in your body do you feel most at home right now?", audio, mime: "audio/mp4", duration: 84, transcript: "My shoulders, oddly." });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    window.Permission.showApp();
  });
  await real(400); await tick(800);
  await page.click("#homeList .entry >> nth=0"); await real(400); await tick(700);
  ok("a voice entry shows the app's player", await page.locator("#ePlayer .player .pl-btn").isVisible() && await page.locator("#ePlayer .pl-seek").isVisible());
  ok("no system audio control anywhere", (await page.locator("audio[controls]").count()) === 0);
  ok("it shows the measured length, not 0:00 / 0:00", (await text(page, "#ePlayer .pl-time")) === "0:00 / 1:24", await text(page, "#ePlayer .pl-time"));
  const box = await page.locator("#ePlayer .pl-btn").boundingBox();
  ok("the play button is a 44pt target", box && box.width >= 44 && box.height >= 44);
  await shot(page, "m9-entry-player-dark");
  ok("no page errors", errors.filter((e) => !/NotSupportedError|no supported source/i.test(e)).length === 0, errors.join(" | "));
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
