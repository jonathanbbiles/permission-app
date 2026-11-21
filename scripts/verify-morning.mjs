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
     - a first Affirm has a few to start from, a tap adds another, and what is
       typed is there on the next visit and gone after Erase everything;
     - a skipped practice is skipped, and the choice is remembered;
     - Write is done inside Morning: typed text AND handwriting on the pad are
       both kept, by themselves, as ordinary entries under today's invitation;
     - with nothing written the morning is still kept, and the finish screen
       has one button and says "Kept" only once the save has happened;
     - the chime plays when it is switched on and again when time is up;
     - Settings: Done closes it, a change made from Settings returns to it,
       and any accent colour can be picked and stays legible;
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
  await page.addInitScript(() => { window.__plays = 0; const real = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { if (!this.muted) window.__plays++; try { return Promise.resolve(real.call(this)).catch(() => {}); } catch (e) { return Promise.resolve(); } }; });
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
  ok("it says so, and Pause is no longer offered", /Time\. No rush\./i.test(await text(page, "#mKick")) && await page.locator("#mPause").isDisabled());
  await tick(60000);
  ok("it never moves on by itself", /Silence/i.test(await text(page, "#mName")));

  await page.click("#mNext"); await tick(300);
  ok("Next goes to Affirm", /Affirm/i.test(await text(page, "#mName")) && await page.locator("#mAffirm").isVisible());
  ok("a first Affirm has a few to start from", /^I’m allowed to want this\.\nMy body gets to have opinions\./.test(await page.inputValue("#mAffirm")), await page.inputValue("#mAffirm"));
  await page.click('#mAffirmChips .chip:has-text("I am not behind.")'); await tick(100);
  ok("a tap adds another, once", /I am not behind\.$/.test(await page.inputValue("#mAffirm")));
  await page.click('#mAffirmChips .chip:has-text("I am not behind.")'); await tick(100);
  ok("tapping it again does not add it twice", ((await page.inputValue("#mAffirm")).match(/I am not behind\./g) || []).length === 1);
  // What you need lately, opened from Affirm: the clock waits, and it comes back here
  const beforeQ = await secs(page);
  await page.click("#mFit"); await tick(300);
  ok("Make these fit you opens the three questions", await page.locator("#know").isVisible() && (await page.locator("#know .opt").count()) === 19);
  ok("nothing to keep until something is answered", await page.locator("#knUse").isDisabled());
  await page.click('#knLoud .opt:has-text("Feeling behind")'); await page.click('#knWant .opt:has-text("Rest")'); await page.click('#knWant .opt:has-text("Fun")'); await tick(100);
  const gentle = await page.locator("#knOut .ln").allInnerTexts();
  ok("answers turn into affirmations as you tap", gentle.length === 4 && gentle[1] === "I am not behind. I am here." && gentle[2] === "I let myself slow down.", gentle.join(" | "));
  await page.click('#knWant .opt:has-text("Calm")'); await tick(100);
  ok("a third pick replaces the oldest, never more than two", (await page.locator("#knWant .opt.on").count()) === 2 && !(await page.locator('#knWant .opt:has-text("Rest")').evaluate((e) => e.classList.contains("on"))));
  await page.click('#knTone .opt:has-text("Playful")'); await tick(100);
  const playful = await page.locator("#knOut .ln").allInnerTexts();
  ok("the tone changes how it is said, not what it is about", playful[1] === "Nobody is keeping score, including me." && playful.length === 4, playful.join(" | "));
  await shot(page, "m4b-know");
  await tick(30000);
  await page.click("#knUse"); await tick(300);
  ok("Use these puts them in the box, back on Affirm", !(await page.locator("#know").isVisible()) && (await page.inputValue("#mAffirm")) === playful.join("\n"), await page.inputValue("#mAffirm"));
  const afterQ = await secs(page);
  ok("the practice waited while the questions were open", Math.abs(afterQ - beforeQ) <= 1 && /Pause/.test(await text(page, "#mPause")), `${beforeQ} -> ${afterQ}`);
  await page.fill("#mAffirm", "I am allowed to begin.\nI am not behind.");
  await shot(page, "m4-affirm");
  await page.click("#mNext"); await tick(300);
  ok("then Picture", /Picture/i.test(await text(page, "#mName")) && !(await page.locator("#mAffirm").isVisible()));
  await page.click("#mNext"); await tick(300);
  ok("Move was skipped: Read is next", /Read/i.test(await text(page, "#mName")), await text(page, "#mName"));
  await page.click("#mNext"); await tick(300);
  ok("Write is last, with no timer, no Pause, and today's invitation", /Write/i.test(await text(page, "#mName")) && !(await page.locator("#mRing").isVisible()) && !(await page.locator("#mPause").isVisible()) && (await text(page, "#mInvite")).length > 10);
  ok("the page to write on is right there, on the same screen", await page.locator("#mWrite").isVisible() && await page.locator("#v-morning").isVisible() && /Finish/.test(await text(page, "#mNext")));
  const invite = await text(page, "#mInvite");
  await page.fill("#mWrite", "I want a slow morning and I am taking one.");
  await shot(page, "m5-write");
  await page.click('#mWriteMode [data-wmode="draw"]'); await real(250); await tick(300);
  ok("Write by hand shows the pad instead of the keyboard page", await page.locator("#mPadCanvas").isVisible() && !(await page.locator("#mWrite").isVisible()));
  const pb = await page.locator("#mPadCanvas").boundingBox();
  ok("the pad is a real writing surface", pb && pb.height >= 240 && pb.width >= 280, JSON.stringify(pb));
  await page.mouse.move(pb.x + 40, pb.y + 60); await page.mouse.down();
  await page.mouse.move(pb.x + 160, pb.y + 110, { steps: 8 }); await page.mouse.move(pb.x + 250, pb.y + 70, { steps: 8 }); await page.mouse.up();
  await tick(200);
  await shot(page, "m5b-write-by-hand");
  await page.click("#mNext"); await real(500); await tick(500); await real(300); await tick(300);
  ok("Finish goes to the finish screen, still inside Morning", await page.locator("#mDone").isVisible() && await page.locator("#v-morning").isVisible());
  ok("it names what was done", /Silence · Affirm · Picture · Read · Write/.test(await text(page, "#mDoneSum")), await text(page, "#mDoneSum"));
  ok("it says Kept, and there is one button, not a choice", /Kept in your journal\./.test(await text(page, "#mDoneKept")) && (await page.locator("#mDone button").count()) === 1 && /Go have your day/.test(await text(page, "#mDoneClose")));
  await shot(page, "m6-done");
  await page.click("#mDoneClose"); await real(400); await tick(700);
  ok("the button goes Home, header back", await page.locator("#v-home").isVisible() && await page.locator("header").isVisible());
  ok("the card now says today's is done", /Done for today/.test(await text(page, "#morningSub")), await text(page, "#morningSub"));
  const rows = await page.locator("#homeList .entry").count();
  ok("both the typed page and the handwritten one are in the journal", rows === 2, String(rows));
  const kept = await page.evaluate(async () => { const db = await new Promise((res) => { const r = indexedDB.open("awaken_db"); r.onsuccess = () => res(r.result); });
    return await new Promise((res) => { const q = db.transaction("entries").objectStore("entries").getAll(); q.onsuccess = () => res(q.result.map((e) => ({ type: e.type, prompt: e.prompt, text: e.text || "", img: (e.image || "").slice(0, 22), morning: e.morning || "" }))); }); });
  const kt = kept.find((e) => e.type === "text"), kd = kept.find((e) => e.type === "draw");
  ok("the typed page is kept under today's invitation, in the user's words only", kt && kt.prompt === invite && kt.text === "I want a slow morning and I am taking one." && /Write$/.test(kt.morning), JSON.stringify(kt));
  ok("the handwriting is kept as a drawing under the same invitation", kd && kd.prompt === invite && kd.img === "data:image/png;base64,", JSON.stringify(kd));

  // second visit: choices and affirmations remembered; nothing written -> the morning is still kept
  await page.click("#cardMorning"); await tick(400);
  ok("the skipped practice is remembered", (await page.locator('.m-step[data-step="move"]').getAttribute("aria-pressed")) === "false");
  await page.click('.m-step[data-step="write"]'); await tick(100);
  await page.click("#mBegin"); await tick(300);
  await page.click("#mNext"); await tick(300);
  ok("yesterday's affirmations are waiting", (await page.inputValue("#mAffirm")) === "I am allowed to begin.\nI am not behind.");
  await page.click("#mNext"); await tick(200); await page.click("#mNext"); await tick(200);
  ok("the last practice says Finish", /Finish/.test(await text(page, "#mNext")) && /Read/i.test(await text(page, "#mName")));
  await page.click("#mNext"); await real(500); await tick(500); await real(300); await tick(300);
  ok("the finish screen names what was done and says Kept", /Silence · Affirm · Picture · Read\./.test(await text(page, "#mDoneSum")) && /Kept in your journal\./.test(await text(page, "#mDoneKept")), await text(page, "#mDoneSum"));
  await page.click("#mDoneClose"); await real(400); await tick(700);
  ok("a morning with nothing written is still in the journal", /Silence · Affirm · Picture · Read/.test(await text(page, "#homeList .entry >> nth=0")));
  await page.click("#homeList .entry >> nth=0"); await real(400); await tick(600);
  ok("it opens as an ordinary entry, marked Morning, affirmations included", /Morning practice/i.test(await text(page, "#ePrompt")) && /Morning/i.test(await text(page, "#eDate")) && /I am not behind\./.test(await text(page, "#eContent")));
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

  // Home footer: the names they go by
  const foot = await text(page, "#appFoot");
  ok("the footer says Glitoris and Honeywood", /A gift from Glitoris/.test(foot) && /Built by Honeywood/.test(foot) && !/Jessica|jonathanscribbles/.test(foot), foot.replace(/\n/g, " | "));

  // Settings: Done, coming back after a change, any colour
  await page.click("#btnSettings"); await tick(500);
  ok("Settings has a Done button", await page.locator("#sheetDone").isVisible());
  await shot(page, "m10-settings");
  await page.click("#setProfile"); await tick(500);
  ok("You opens from Settings", await page.locator("#onboard").isVisible());
  await page.click("#obSave"); await tick(600);
  ok("saving You returns to Settings, not Home", await page.locator("#settingsSheet").evaluate((e) => e.classList.contains("show")) && !(await page.locator("#onboard").isVisible()));
  const setAccent = async (hex) => { await page.evaluate((h) => { const i = document.getElementById("accentPick"); i.value = h; i.dispatchEvent(new Event("input", { bubbles: true })); }, hex); await tick(100);
    return page.evaluate(() => { const st = document.documentElement.style; return { a: st.getPropertyValue("--accent"), d: st.getPropertyValue("--accent-deep"), on: st.getPropertyValue("--on-accent"), sel: document.querySelector(".aswatch.custom").classList.contains("on") }; }); };
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16), f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255); };
  const deep = await setAccent("#1e6fd0");
  ok("any colour can be picked, and is used as given", deep.a === "#1E6FD0" && deep.sel && deep.on === "#FFFFFF", JSON.stringify(deep));
  const pale = await setAccent("#ffe94d");
  ok("a pale colour flips the text on it to dark ink", pale.a === "#FFE94D" && pale.on === "#3A0E2E", JSON.stringify(pale));
  ok("and its link shade is darkened until it can be read on cream", lum(pale.d) <= 0.23, pale.d + " " + lum(pale.d).toFixed(3));
  await shot(page, "m11-settings-yellow");
  await page.click(".aswatch[data-accent=rose]"); await tick(100);
  ok("going back to a preset restores white on the accent", (await page.evaluate(() => document.documentElement.style.getPropertyValue("--on-accent"))) === "");
  await page.click("#setKnow"); await tick(400);
  ok("Settings opens the questions with the last answers still chosen", await page.locator("#know").isVisible() && (await page.locator("#knTone .opt.on").innerText()) === "Playful" && (await page.locator("#knLoud .opt.on").innerText()) === "Feeling behind");
  await page.click("#knAdd"); await tick(400);
  ok("Add them to mine keeps what was there and returns to Settings", await page.locator("#settingsSheet").evaluate((e) => e.classList.contains("show")) &&
     await page.evaluate(() => { const a = localStorage.getItem("perm_affirm").split("\n"); return a[0] === "I am allowed to begin." && a.includes("Nobody is keeping score, including me.") && new Set(a).size === a.length; }));
  await page.click("#sheetDone"); await tick(500);
  ok("Done closes Settings", !(await page.locator("#settingsSheet").evaluate((e) => e.classList.contains("show"))));

  // erase everything takes the affirmations too
  page.on("dialog", (d) => d.accept());
  await page.click("#btnSettings"); await tick(500);
  await page.locator("#setErase").scrollIntoViewIfNeeded(); await page.click("#setErase"); await tick(1500);
  ok("Erase everything removes the affirmations and today's mark",
     await page.evaluate(() => localStorage.getItem("perm_affirm") === null && localStorage.getItem("perm_morning_last") === null && localStorage.getItem("perm_know") === null));

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
  await page.click("#cardMorning"); await tick(400);
  const p0 = await page.evaluate(() => window.__plays);
  await page.click("#mChime"); await tick(200);
  const p1 = await page.evaluate(() => window.__plays);
  ok("switching the chime on plays it once", p1 === p0 + 1, `${p0} -> ${p1}`);
  await page.click('#mMinutes [data-min="1"]'); await tick(100);
  await page.click("#mBegin"); await tick(400);
  await shot(page, "m8-silence-dark");
  const p2 = await page.evaluate(() => window.__plays);
  ok("Begin arms it without making a sound", p2 === p1, `${p1} -> ${p2}`);
  await tick(61000);
  const p3 = await page.evaluate(() => window.__plays);
  ok("the chime plays when time is up", p3 === p2 + 1 && (await text(page, "#mTime")) === "0:00", `${p2} -> ${p3}`);
  await page.click("#mBack"); await tick(200); await page.click("#mChime"); await tick(100); await page.click("#mBack"); await tick(500);

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
