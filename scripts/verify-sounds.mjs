#!/usr/bin/env node
/* ============================================================================
   verify-sounds.mjs — DRIVE the 1.11.0 Sounds screen in a real browser and fail
                       on what a person would notice.

   Usage:  npm run verify:sounds             (serves www/ itself)
           node scripts/verify-sounds.mjs [shotDir]

   Needs a headless Chromium (Playwright), like verify-morning.mjs, so it is not
   part of `npm test`. CHROMIUM_PATH overrides the browser.

   Two kinds of run:

   FAKED PLAYERS + A FAKED CLOCK, so ten hours take a few seconds. The page's
   Audio is replaced by a stand-in that keeps time by the page's own clock,
   knows how long each piece is from the size of the WAV it was handed, fires
   the events a media element fires, and writes down every stretch during which
   it would have been heard. From that record the script checks:
     - Play starts one player at once and readies the second inside the tap;
     - a new piece starts about six seconds before the last one ends, every
       time, with no gap and no silence, for ten minutes and for ten hours;
     - the last piece is cut so the sound ends when the timer does, and after
       that nothing plays and the screen is back to "Play";
     - Stop stops it; choosing another sound swaps it and keeps the end time;
       a new length runs from now; a longer time chosen during the last fade
       starts it up again; with only seconds left, the fade under way is the end;
     - a pause from outside (a call) shows "Paused" and is NOT answered with a
       pause of the app's own, so the system's resume brings it back; if nobody
       resumes it, it clears itself when the time is up; "Carry on" restarts it;
     - a turn that could not start leaves "Paused", not silence with "Stop";
     - leaving the screen and locking the app do not stop it; starting a
       recording and Erase everything do;
     - the Home card says what is playing, and sits where it should.

   REAL PLAYERS, REAL TIME: the same page with the browser's own media
   elements. Each sound really decodes and really plays, the second player
   really takes over when the first reaches its turn (sped up 16x), a pause
   and a play from outside are really noticed, and each WAV is decoded and
   measured.

   Plus the layout at five sizes, and: no page error, no network request.
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
const URL_ = `${ORIGIN}/index.html`;

let passed = 0, failed = 0;
const ok = (name, cond, why = "") => { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.error("  ✗ " + name + (why ? "  — " + why : "")); } };

const exe = process.env.CHROMIUM_PATH || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const LOOP_BYTES = 44 + 90 * 22050 * 2;

/* ---- the stand-in players ------------------------------------------------ */
function fakePlayers() {
  const sizes = new Map();
  const S = (window.__snd = { players: [], log: [], segs: [], urls: [], revoked: [], errors: [], blockPlay: false });
  const mk = URL.createObjectURL.bind(URL), rv = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (b) => { const u = mk(b); if (b && b.type === "audio/wav") { sizes.set(u, b.size); S.urls.push({ url: u, size: b.size, t: Date.now() }); } return u; };
  URL.revokeObjectURL = (u) => { S.revoked.push(u); return rv(u); };
  class FakePlayer {
    constructor() { this.id = S.players.length; this._src = ""; this._pos0 = 0; this._t0 = 0; this._paused = true; this._muted = false; this._ls = {}; this._iv = null; this._seg = null; this._restore = false; this.preload = ""; this.error = null; S.players.push(this); }
    setAttribute() {} removeAttribute() {} load() {}
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
    _fire(t) { const fns = (this._ls[t] || []).slice(); setTimeout(() => fns.forEach((f) => { try { f.call(this, { type: t, target: this }); } catch (e) { S.errors.push(String(e && e.stack || e)); } }), 0); }
    get duration() { const z = sizes.get(this._src); return z ? (z - 44) / 2 / 22050 : NaN; }
    _at() { return this._paused ? this._pos0 : this._pos0 + (Date.now() - this._t0) / 1000; }
    _sync() { if (!this._paused && this._at() >= this.duration) this._finish(); }
    _finish() {
      const endT = this._t0 + (this.duration - this._pos0) * 1000;
      this._pos0 = this.duration; this._paused = true; this._stopIv(); this._close(endT);
      S.log.push({ t: endT, id: this.id, ev: "ended" });
      this._fire("timeupdate"); this._fire("pause"); this._fire("ended");
    }
    _open() { if (!this._seg && !this._paused && !this._muted) { this._seg = { id: this.id, url: this._src, dur: this.duration, start: Date.now(), from: this._pos0, end: null }; S.segs.push(this._seg); } }
    _close(t) { if (this._seg) { this._seg.end = t === undefined ? Date.now() : t; this._seg = null; } }
    _mark() { if (!this._paused && !this._muted) this._open(); else this._close(); }
    _startIv() { this._stopIv(); this._iv = setInterval(() => { this._sync(); if (!this._paused) this._fire("timeupdate"); }, 250); }
    _stopIv() { if (this._iv) { clearInterval(this._iv); this._iv = null; } }
    _halt(fire) { if (this._paused) return; this._pos0 = Math.min(this.duration, this._at()); this._paused = true; this._stopIv(); this._mark(); if (fire) this._fire("pause"); }
    get paused() { this._sync(); return this._paused; }
    get muted() { return this._muted; }
    set muted(v) { v = !!v; if (v !== this._muted) { this._muted = v; this._mark(); } }
    get currentTime() { this._sync(); return this._at(); }
    set currentTime(v) { this._sync(); const playing = !this._paused; this._close(); this._pos0 = Math.max(0, +v || 0); this._t0 = Date.now(); if (playing) this._mark(); }
    get ended() { this._sync(); const d = this.duration; return !isNaN(d) && this._paused && this._pos0 >= d - 1e-9; }
    get src() { return this._src; }
    set src(u) { this._halt(false); this._src = String(u); this._pos0 = 0; S.log.push({ t: Date.now(), id: this.id, ev: "src", url: this._src, dur: this.duration, revoked: S.revoked.includes(this._src) }); }
    play() {
      if (S.blockPlay) { S.log.push({ t: Date.now(), id: this.id, ev: "blocked" }); return Promise.reject(new DOMException("not allowed", "NotAllowedError")); }
      if (isNaN(this.duration)) { S.log.push({ t: Date.now(), id: this.id, ev: "nosrc" }); return Promise.reject(new DOMException("no source", "NotSupportedError")); }
      this._sync();
      if (this._paused && this._pos0 >= this.duration - 1e-9) this._pos0 = 0;      // an ended element starts again from the top
      S.log.push({ t: Date.now(), id: this.id, ev: "play", muted: this._muted, from: this._pos0, url: this._src, dur: this.duration, was: this._paused ? "paused" : "playing", revoked: S.revoked.includes(this._src) });
      if (this._paused) { this._paused = false; this._t0 = Date.now(); this._restore = false; this._startIv(); this._mark(); this._fire("play"); }
      return Promise.resolve();
    }
    pause() {
      this._sync();
      S.log.push({ t: Date.now(), id: this.id, ev: "pause", was: this._paused ? "paused" : "playing", muted: this._muted, cancelledResume: this._restore });
      this._restore = false;                           // as on iOS: a pause during an interruption cancels the system's resume
      this._halt(true);
    }
  }
  window.Audio = FakePlayer;
  /* What the system does to every media element when a call comes in, and when it ends. */
  S.interrupt = () => { S.log.push({ t: Date.now(), ev: "INTERRUPT" }); S.players.forEach((p) => { p._sync(); if (!p._paused) { p._halt(true); p._restore = true; } }); };
  S.resume = () => { S.log.push({ t: Date.now(), ev: "RESUME" }); S.players.forEach((p) => { if (p._restore) { p._restore = false; p.play(); } }); };
  S.heard = () => S.players.filter((p) => { p._sync(); return !p._paused && !p._muted; }).map((p) => p.id);
  S.snapshot = () => ({ now: Date.now(), heard: S.heard(), segs: S.segs.map((g) => Object.assign({}, g)), log: S.log.slice(), urls: S.urls.slice(), revoked: S.revoked.slice(), errors: S.errors.slice(),
    players: S.players.map((p) => ({ id: p.id, paused: p.paused, muted: p.muted, t: p.currentTime, dur: p.duration, src: p.src })) });
}

/* The page's clock, faked and fast. Playwright's own page.clock waits 4 ms of real time between
   timers, so ten simulated hours (about 400,000 timers) would take half an hour; this one runs
   them in a tight loop in a few seconds. Time stands still until tick() moves it, which also
   makes every check below exact. Playwright keeps the real timers for its own waiting: it looks
   for them in window.__pwClock.builtins, so they are left there. */
function fakeClock(start) {
  const RealDate = Date; let vnow = start, seq = 1; const timers = new Map(); const errs = (window.__clockErrors = []);
  window.__pwClock = { builtins: { setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    requestIdleCallback: window.requestIdleCallback && window.requestIdleCallback.bind(window), cancelIdleCallback: window.cancelIdleCallback && window.cancelIdleCallback.bind(window),
    performance: window.performance, Intl: window.Intl, Date: RealDate, AbortSignal: window.AbortSignal } };
  function VDate(...a) { if (!new.target) return new RealDate(vnow).toString(); return a.length ? new RealDate(...a) : new RealDate(vnow); }
  VDate.prototype = RealDate.prototype; VDate.now = () => vnow; VDate.parse = RealDate.parse; VDate.UTC = RealDate.UTC;
  window.Date = VDate;
  const add = (fn, ms, every, args) => { const id = seq++; timers.set(id, { at: vnow + ms, fn, args, every, ord: id }); return id; };
  window.setTimeout = (fn, ms, ...args) => add(fn, Math.max(0, +ms || 0), 0, args);
  window.setInterval = (fn, ms, ...args) => add(fn, Math.max(1, +ms || 0), Math.max(1, +ms || 0), args);
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
  window.__advance = async (ms) => {
    const end = vnow + ms; let ran = 0;
    for (;;) {
      let bid = 0, bt = null;
      for (const [id, t] of timers) { if (t.at <= end && (!bt || t.at < bt.at || (t.at === bt.at && t.ord < bt.ord))) { bid = id; bt = t; } }
      if (!bt) break;
      if (bt.at > vnow) vnow = bt.at;
      if (bt.every) { bt.at += bt.every; bt.ord = seq++; } else timers.delete(bid);
      try { if (typeof bt.fn === "function") bt.fn(...bt.args); } catch (e) { errs.push(String((e && e.stack) || e)); }
      ran++; await null;                                  // let promise callbacks run between timers, as a browser does
    }
    vnow = end; return ran;
  };
}

/* The real players, only watched: every Audio the page makes, and every WAV it builds. */
function watchPlayers() {
  const Real = window.Audio, W = (window.__real = { els: [], urls: [] });
  window.Audio = function () { const a = new Real(); W.els.push(a); return a; };
  const mk = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { const u = mk(b); if (b && b.type === "audio/wav") W.urls.push({ url: u, size: b.size }); return u; };
}

async function open(hour, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.size || { width: 390, height: 844 }, deviceScaleFactor: opts.dpr || 1, hasTouch: true, colorScheme: opts.dark ? "dark" : "light" });
  const page = await ctx.newPage();
  const errors = [], foreign = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("request", (r) => { const u = r.url(); if (!u.startsWith(ORIGIN) && !/^(data|blob):/.test(u)) foreign.push(u); });
  page.on("dialog", (d) => d.accept());
  const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let tick;
  if (opts.real) { await page.addInitScript(watchPlayers); tick = realSleep; }
  else { await page.addInitScript(fakeClock, new Date(2026, 10, 24, hour, 5, 0).getTime()); await page.addInitScript(fakePlayers); tick = (ms) => page.evaluate((m) => window.__advance(m), ms); }
  await page.goto(URL_, { waitUntil: "load" });
  await page.waitForSelector("#pad button.key");
  const tap4 = async () => { for (let i = 0; i < 4; i++) { await page.click('#pad button.key:has-text("1")'); await tick(80); } };
  await tap4(); await tick(600);
  if (await page.locator("#lock").isVisible()) { await tap4(); await tick(800); }
  if (await page.locator("#onboard").isVisible()) { await page.click("#obSkip"); await tick(800); }
  await tick(2500);
  const snap = () => page.evaluate(() => Object.assign(window.__snd.snapshot(), { clockErrors: window.__clockErrors.slice() }));
  const openSounds = async () => { await page.locator("#cardSounds").scrollIntoViewIfNeeded(); await page.click("#cardSounds"); await tick(700); };
  return { ctx, page, tick, errors, foreign, snap, tap4, openSounds, real: realSleep };
}
const text = (page, sel) => page.locator(sel).innerText();
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png") }); };
const clean = (b, name) => { ok(`${name}: no page error`, b.errors.length === 0, b.errors.join(" | ")); ok(`${name}: no network request`, b.foreign.length === 0, b.foreign.join(" | ")); };

/* Read the record of what was heard. Returns the stretches in order, with the facts the checks need. */
function heard(snapshot, since = 0) {
  const segs = snapshot.segs.filter((g) => g.start >= since).map((g) => ({ ...g, end: g.end === null ? snapshot.now : g.end })).sort((a, b) => a.start - b.start);
  let gap = 0, reach = segs.length ? segs[0].end : 0;
  const overlaps = [];
  for (let i = 1; i < segs.length; i++) { if (segs[i].start > reach) gap = Math.max(gap, segs[i].start - reach); overlaps.push((segs[i - 1].end - segs[i].start) / 1000); reach = Math.max(reach, segs[i].end); }
  return { segs, gap, overlaps, first: segs.length ? segs[0].start : 0, last: reach };
}
const noStalePlays = (s) => s.log.filter((e) => (e.ev === "play" || e.ev === "src") && e.revoked).length === 0;
const now = (page) => page.evaluate(() => Date.now());
/* Move the page's clock to exactly `target`. */
async function runTo(page, tick, target) { const d = target - (await now(page)); if (d > 0) await tick(d); }
const firstHeardSince = (snapshot, since) => { const g = snapshot.segs.filter((x) => x.start >= since).sort((a, b) => a.start - b.start)[0]; return g ? g.start : 0; };

/* ============================================================== the screen */
console.log("\nHome and the Sounds screen, at 10:05 at night");
{
  const b = await open(22, { dpr: 2 }); const { page, tick } = b;
  const order = await page.evaluate(() => [...document.getElementById("v-home").children].map((e) => e.id || e.className.split(" ")[0]));
  ok("one Sounds card on Home, a real button", (await page.locator("button#cardSounds").count()) === 1);
  ok("it is the last thing above the journal, under the four tiles", order.indexOf("cardSounds") === order.indexOf("sechead") - 1 && order.indexOf("cardSounds") === order.indexOf("modes") + 1, order.join(","));
  ok("the card says what it is for", (await text(page, "#soundsSub")) === "Rain, waves, soft noise to rest in");
  ok("nothing has been made or played before it is opened", (await b.snap()).urls.length === 0 && (await b.snap()).players.length === 0);
  await page.locator("#cardSounds").scrollIntoViewIfNeeded(); await shot(page, "s1-home");
  await b.openSounds();
  ok("the card opens the Sounds screen", await page.locator("#v-sounds").isVisible() && !(await page.locator("#v-home").isVisible()));
  ok("the brand header is hidden there, like every other sub-screen", !(await page.locator("header").isVisible()));
  const rows = await page.locator("#sList .s-opt").evaluateAll((els) => els.map((e) => ({ nm: e.querySelector(".nm").textContent, dsc: e.querySelector(".dsc").textContent, on: e.getAttribute("aria-pressed"), tag: e.tagName, h: e.getBoundingClientRect().height })));
  ok("four sounds: Rain, Ocean, Brown noise, White noise", rows.map((r) => r.nm).join("|") === "Rain|Ocean|Brown noise|White noise", JSON.stringify(rows));
  ok("each is a real button at least 44pt tall", rows.every((r) => r.tag === "BUTTON" && r.h >= 44));
  ok("Rain is chosen to begin with, and only Rain", rows.map((r) => r.on).join(",") === "true,false,false,false");
  ok("it starts at 30 minutes", (await text(page, "#sDurTx")) === "30 minutes" && (await page.locator("#sRange").inputValue()) === "4");
  ok("the button says Play, and nothing is playing", (await text(page, "#sPlay")) === "Play" && (await text(page, "#sNow")) === "" && !(await page.locator("#sOff").isVisible()));
  await tick(900);
  let s = await b.snap();
  ok("the chosen sound is made a moment after the screen opens, so Play answers at once", s.urls.length === 1 && s.urls[0].size === LOOP_BYTES, JSON.stringify(s.urls));
  ok("making it plays nothing", s.log.filter((e) => e.ev === "play").length === 0);
  await shot(page, "s2-sounds");

  /* the length */
  await page.click('#sQuick button[data-min="600"]'); await tick(100);
  ok("10 hr sets ten hours, the top of the range", (await text(page, "#sDurTx")) === "10 hours" && (await page.locator("#sRange").inputValue()) === "32" && await page.locator("#sMore").isDisabled());
  await page.click('#sQuick button[data-min="10"]'); await tick(100);
  ok("10 min sets ten minutes, the bottom of the range", (await text(page, "#sDurTx")) === "10 minutes" && (await page.locator("#sRange").inputValue()) === "0" && await page.locator("#sLess").isDisabled());
  await page.click("#sMore"); await tick(60);
  ok("+ adds five minutes", (await text(page, "#sDurTx")) === "15 minutes");
  for (let i = 0; i < 12; i++) { await page.click("#sMore"); } await tick(60);
  ok("+ goes on past the hour in fives", (await text(page, "#sDurTx")) === "1 hr 15 min");
  await page.click("#sLess"); await page.click("#sLess"); await tick(60);
  ok("− takes five minutes off, and reaches lengths the slider skips (1 hr 5)", (await text(page, "#sDurTx")) === "1 hr 5 min" && (await page.locator("#sRange").inputValue()) === "10");
  await page.locator("#sRange").fill("12"); await tick(60);
  ok("the slider moves through its stops (the 13th is 1 hr 30)", (await text(page, "#sDurTx")) === "1 hr 30 min");
  await page.locator("#sRange").fill("27"); await tick(60);
  ok("far along the slider the steps are half hours", (await text(page, "#sDurTx")) === "7 hr 30 min");
  ok("no quick pick is lit when none matches", (await page.locator("#sQuick button.on").count()) === 0);
  await page.click('#sQuick button[data-min="120"]'); await tick(60);
  ok("2 hr lights up when it is the length", (await page.locator("#sQuick button.on").innerText()) === "2 hr" && (await text(page, "#sDurTx")) === "2 hours");

  /* the sound */
  await page.click('#sList .s-opt[data-snd="ocean"]'); await tick(900);
  ok("choosing Ocean ticks Ocean and nothing else", (await page.locator('#sList .s-opt[aria-pressed="true"]').evaluateAll((e) => e.map((x) => x.dataset.snd).join(","))) === "ocean");
  s = await b.snap();
  ok("choosing a sound does not start it", s.log.filter((e) => e.ev === "play").length === 0 && (await text(page, "#sPlay")) === "Play");
  ok("the new sound is made ready and the old one let go", s.urls.length === 2 && s.revoked.includes(s.urls[0].url));

  await page.reload({ waitUntil: "load" }); await page.waitForSelector("#pad button.key"); await b.tap4(); await tick(3000);
  await b.openSounds();
  ok("the sound and the length are remembered", (await page.locator('#sList .s-opt[aria-pressed="true"]').getAttribute("data-snd")) === "ocean" && (await text(page, "#sDurTx")) === "2 hours");
  clean(b, "screen"); await b.ctx.close();
}

/* ======================================================= a whole ten minutes */
console.log("\nRain for ten minutes, start to finish");
{
  const b = await open(22); const { page, tick } = b;
  await b.openSounds(); await tick(900);
  await page.click('#sQuick button[data-min="10"]'); await tick(60);
  await page.click("#sPlay"); await tick(40);
  let s = await b.snap();
  const T = s.segs[0].start, p0 = s.log.filter((e) => e.ev === "play");
  ok("Play starts the first player at once, from the top, unmuted", p0.length >= 1 && p0[0].id === 0 && p0[0].muted === false && p0[0].from === 0, JSON.stringify(p0[0]));
  ok("the piece it plays is the 90-second loop", p0[0].dur === 90);
  ok("the second player is started in the same tap, muted, and stopped at once", p0.length === 2 && p0[1].id === 1 && p0[1].muted === true && p0[1].t === p0[0].t && s.players[1].paused && s.players[1].muted === false && s.players[1].t === 0, JSON.stringify(p0[1]) + JSON.stringify(s.players[1]));
  ok("only the first can be heard", s.heard.join(",") === "0");
  ok("the button turns to Stop and the time shows", (await text(page, "#sPlay")) === "Stop" && (await text(page, "#sNow")) === "Rain · 10 minutes left" && !(await page.locator("#sOff").isVisible()));
  await shot(page, "s3-playing");
  await runTo(page, tick, T + 61000);
  ok("a minute later it says nine minutes", (await text(page, "#sNow")) === "Rain · 9 minutes left", await text(page, "#sNow"));
  await runTo(page, tick, T + 81000);
  s = await b.snap();
  ok("at 81 seconds the first piece is still the only one", s.heard.join(",") === "0" && s.segs.length === 1);
  await runTo(page, tick, T + 86000);
  s = await b.snap();
  ok("by 86 seconds the second has come in underneath it: both are playing", s.heard.join(",") === "0,1", JSON.stringify(s.players));
  await runTo(page, tick, T + 92000);
  s = await b.snap();
  ok("by 92 seconds the first has ended by itself and the second carries on", s.heard.join(",") === "1" && s.log.some((e) => e.ev === "ended" && e.id === 0));
  ok("the app never paused a piece that could be heard", s.log.filter((e) => e.ev === "pause" && e.was === "playing" && !e.muted).length === 0, JSON.stringify(s.log.filter((e) => e.ev === "pause")));
  await page.click("#sBack"); await tick(600);
  ok("Home says what is playing and how long is left", /^Rain · 9 minutes left$/.test(await text(page, "#soundsSub")), await text(page, "#soundsSub"));
  ok("leaving the screen does not stop it", (await b.snap()).heard.length === 1);
  await page.locator("#cardSounds").scrollIntoViewIfNeeded(); await shot(page, "s4-home-playing");
  await b.openSounds();
  ok("coming back shows it still running", (await text(page, "#sPlay")) === "Stop" && /^Rain · \d minutes left$/.test(await text(page, "#sNow")));
  await runTo(page, tick, T + 596000);
  s = await b.snap();
  ok("four seconds before the end something is still playing", s.heard.length >= 1 && (await text(page, "#sNow")) === "Rain · under a minute left", JSON.stringify(s.heard) + (await text(page, "#sNow")));
  await runTo(page, tick, T + 603000);
  s = await b.snap();
  const h = heard(s, T - 1);
  ok("then it stops by itself", s.heard.length === 0 && (await text(page, "#sPlay")) === "Play" && !(await page.locator("#sOff").isVisible()));
  ok("the screen says it finished", (await text(page, "#sNow")) === "Finished. Rest well.");
  ok("it was heard from the tap to the end with no gap at all", h.gap === 0 && h.first === T, `gap ${h.gap}`);
  ok("it ended when the timer did (within half a second)", Math.abs(h.last - (T + 600000)) <= 500, `off by ${(h.last - (T + 600000)) / 1000}s`);
  ok("eight pieces: seven loops and an ending cut to fit", h.segs.length === 8 && h.segs.slice(0, 7).every((g) => g.dur === 90 && g.from === 0) && h.segs[7].dur > 8 && h.segs[7].dur < 90 && h.segs[7].from === 0, h.segs.map((g) => g.dur.toFixed(1)).join(","));
  ok("the two players take turns", h.segs.map((g) => g.id).join("") === "01010101");
  ok("each new piece comes in about six seconds before the last one ends", h.overlaps.every((o) => o > 5.2 && o <= 6.01), h.overlaps.map((o) => o.toFixed(2)).join(","));
  ok("no piece is ever played after it was let go", noStalePlays(s));
  await tick(30000);
  ok("and nothing starts again afterwards", (await b.snap()).heard.length === 0 && (await b.snap()).log.filter((e) => e.ev === "play" && e.t > h.last + 100).length === 0);
  await page.click("#sBack"); await tick(500);
  ok("Home goes back to its plain line", (await text(page, "#soundsSub")) === "Rain, waves, soft noise to rest in");
  clean(b, "ten minutes"); ok("ten minutes: no error inside a player or timer callback", s.errors.length + s.clockErrors.length === 0, s.errors.concat(s.clockErrors).join(" | "));
  await b.ctx.close();
}

/* ============================================================== ten hours */
console.log("\nBrown noise for ten hours");
{
  const b = await open(22); const { page, tick } = b;
  await b.openSounds();
  await page.click('#sList .s-opt[data-snd="brown"]'); await page.click('#sQuick button[data-min="600"]'); await tick(900);
  await page.click("#sPlay"); await tick(40);
  const T = (await b.snap()).segs[0].start, END = T + 36000000;
  ok("the time shows as ten hours", (await text(page, "#sNow")) === "Brown noise · 10 hours left");
  await runTo(page, tick, T + (3 * 3600 + 20 * 60) * 1000 + 500);
  ok("three hours twenty in, it says 6 hr 40 min left", (await text(page, "#sNow")) === "Brown noise · 6 hr 40 min left", await text(page, "#sNow"));
  ok("and it is playing", (await b.snap()).heard.length >= 1);
  await runTo(page, tick, END - 5000);
  ok("five seconds before ten hours it is still playing", (await b.snap()).heard.length >= 1);
  await runTo(page, tick, END + 3000);
  const s = await b.snap(), h = heard(s, T - 1);
  ok("at ten hours it has stopped by itself", s.heard.length === 0 && (await text(page, "#sPlay")) === "Play");
  ok("ten hours with no gap", h.gap === 0, `gap ${h.gap}`);
  ok("it ended on time: at most two seconds early, never more than half a second late", h.last - END <= 500 && h.last - END >= -2200, `off by ${(h.last - END) / 1000}s`);
  ok("about 428 pieces, every one a full loop but the last", h.segs.length >= 425 && h.segs.length <= 430 && h.segs.slice(0, -1).every((g) => g.dur === 90), String(h.segs.length));
  ok("every join overlapped by about six seconds", h.overlaps.every((o) => o > 5.2 && o <= 6.01), `min ${Math.min(...h.overlaps).toFixed(2)} max ${Math.max(...h.overlaps).toFixed(2)}`);
  ok("only one loop and one ending were ever made: nothing piles up", s.urls.length <= 4, String(s.urls.length));
  clean(b, "ten hours"); ok("ten hours: no error inside a player or timer callback", s.errors.length + s.clockErrors.length === 0, s.errors.concat(s.clockErrors).join(" | "));
  await b.ctx.close();
}

/* ================================================ stopping and changing it */
console.log("\nStop, another sound, another length");
{
  const b = await open(22); const { page, tick } = b;
  await b.openSounds(); await tick(900);
  await page.click("#sPlay"); await tick(40);
  const T = (await b.snap()).segs[0].start;
  await runTo(page, tick, T + 100000);
  await page.click("#sPlay"); const tStop = await now(page); await tick(300);
  let s = await b.snap();
  ok("Stop stops it", s.heard.length === 0 && (await text(page, "#sPlay")) === "Play" && (await text(page, "#sNow")) === "");
  await tick(200000);
  s = await b.snap();
  ok("and it stays stopped: the next piece never starts", s.heard.length === 0 && s.log.filter((e) => e.ev === "play" && e.t > tStop).length === 0);

  let mark = await now(page);
  await page.click("#sPlay"); await tick(40);
  const T1 = firstHeardSince(await b.snap(), mark);
  await runTo(page, tick, T1 + 50000);
  await page.click('#sList .s-opt[data-snd="ocean"]'); await tick(300);
  s = await b.snap();
  const lastPlay = s.log.filter((e) => e.ev === "play" && !e.muted).pop();
  ok("choosing Ocean while Rain plays swaps the sound straight away", s.heard.join(",") === "0" && lastPlay.url !== s.urls[0].url && lastPlay.from === 0 && lastPlay.revoked === false && lastPlay.t > T1 + 49000, JSON.stringify(lastPlay));
  ok("and keeps the time that was left", (await text(page, "#sNow")) === "Ocean · 30 minutes left" && (await text(page, "#sPlay")) === "Stop");
  const plays = s.log.filter((e) => e.ev === "play").length;
  await page.click('#sList .s-opt[data-snd="ocean"]'); await tick(300);
  ok("choosing the sound that is already playing changes nothing", (await b.snap()).log.filter((e) => e.ev === "play").length === plays);
  await runTo(page, tick, T1 + 1800000 - 3000);
  ok("three seconds before the first end time it is still playing", (await b.snap()).heard.length >= 1);
  await runTo(page, tick, T1 + 1800000 + 3000);
  s = await b.snap();
  let h = heard(s, T1 - 1);
  ok("it ends at the time first asked for, not thirty minutes after the swap", s.heard.length === 0 && h.last - (T1 + 1800000) <= 500 && h.last - (T1 + 1800000) >= -2200, `off by ${(h.last - (T1 + 1800000)) / 1000}s`);

  mark = await now(page);
  await page.click("#sPlay"); await tick(40);
  const T2 = firstHeardSince(await b.snap(), mark);
  await runTo(page, tick, T2 + 60000);
  const pausesBefore = (await b.snap()).log.filter((e) => e.ev === "pause" && e.was === "playing").length;
  await page.click('#sQuick button[data-min="10"]'); const tC = await now(page); await tick(300);
  ok("a new length while it plays runs from now", (await text(page, "#sNow")) === "Ocean · 10 minutes left");
  ok("and does not interrupt the sound", (await b.snap()).log.filter((e) => e.ev === "pause" && e.was === "playing").length === pausesBefore && (await b.snap()).heard.length === 1);
  await runTo(page, tick, tC + 600000 - 4000);
  ok("still playing four seconds before the new end", (await b.snap()).heard.length >= 1);
  await runTo(page, tick, tC + 600000 - 1500);
  /* the last fade is under way: ask for more time */
  await page.click('#sQuick button[data-min="30"]'); const tD = await now(page); await tick(400);
  s = await b.snap();
  ok("more time, asked for during the last fade, starts it up again", s.heard.length === 1 && (await text(page, "#sNow")) === "Ocean · 30 minutes left" && (await text(page, "#sPlay")) === "Stop");
  await runTo(page, tick, tD + 1800000 + 3000);
  s = await b.snap(); h = heard(s, tD - 200);
  ok("and it runs the whole new length, without a gap, then stops", s.heard.length === 0 && h.gap === 0 && h.last - (tD + 1800000) <= 500 && h.last - (tD + 1800000) >= -2400, `gap ${h.gap} off by ${(h.last - (tD + 1800000)) / 1000}s`);
  ok("nothing was played after being let go", noStalePlays(s));

  /* An end time that falls seven seconds after a piece's turn: too short for an ending of its
     own, so the fade already under way is the ending. (Pieces start every 84 seconds: asking
     for ten minutes at second 79 puts the end at 679, seven seconds after the turn at 672.) */
  mark = await now(page);
  await page.click("#sPlay"); await tick(40);
  const T5 = firstHeardSince(await b.snap(), mark);
  await runTo(page, tick, T5 + 79000);
  await page.click('#sQuick button[data-min="10"]'); const tE = await now(page); await tick(100);
  await runTo(page, tick, tE + 600000 + 3000);
  s = await b.snap(); h = heard(s, T5 - 1);
  const lastSeg = h.segs[h.segs.length - 1];
  ok("with only seconds left no extra piece is started: the last full piece fades out as the ending",
     s.heard.length === 0 && lastSeg.dur === 90 && s.log.filter((e) => e.ev === "play" && e.t > lastSeg.start).length === 0 && (await text(page, "#sNow")) === "Finished. Rest well.",
     JSON.stringify(lastSeg));
  ok("and that ends within two seconds of the time asked for, never after it", h.gap === 0 && h.last <= tE + 600000 + 300 && h.last >= tE + 600000 - 2200, `off by ${(h.last - (tE + 600000)) / 1000}s`);
  clean(b, "changes"); ok("changes: no error inside a player or timer callback", s.errors.length + s.clockErrors.length === 0, s.errors.concat(s.clockErrors).join(" | "));
  await b.ctx.close();
}

/* ======================================================== a pause from outside */
console.log("\nA call comes in");
{
  const b = await open(22); const { page, tick } = b;
  await b.openSounds(); await page.click('#sQuick button[data-min="10"]'); await tick(900);
  await page.click("#sPlay"); await tick(40);
  const T = (await b.snap()).segs[0].start;
  await runTo(page, tick, T + 120000);
  const before = (await b.snap()).log.length;
  await page.evaluate(() => window.__snd.interrupt()); await tick(700);
  let s = await b.snap();
  ok("the sound stops and the screen says Paused, with the time still running", s.heard.length === 0 && (await text(page, "#sNow")) === "Paused · 8 minutes left" && (await text(page, "#sPlay")) === "Carry on", await text(page, "#sNow"));
  ok("a plain Stop appears under Carry on", await page.locator("#sOff").isVisible());
  ok("the app did not pause anything itself (on iOS that would cancel the resume)", s.log.slice(before).filter((e) => e.ev === "pause").length === 0, JSON.stringify(s.log.slice(before)));
  await shot(page, "s5-paused");
  await page.click("#sBack"); await tick(500);
  ok("Home says it is paused", (await text(page, "#soundsSub")) === "Rain · paused");
  await b.openSounds();
  await runTo(page, tick, T + 166000);
  await page.evaluate(() => window.__snd.resume()); await tick(700);
  s = await b.snap();
  ok("when the call ends and iOS resumes the player, the app carries on by itself", s.heard.length === 1 && (await text(page, "#sPlay")) === "Stop" && /^Rain · \d minutes left$/.test(await text(page, "#sNow")) && !(await page.locator("#sOff").isVisible()), JSON.stringify(s.heard) + (await text(page, "#sNow")));
  ok("from where it was, not from the top", s.log.filter((e) => e.ev === "play" && !e.muted).pop().from > 30);
  await runTo(page, tick, T + 600000 + 4000);
  s = await b.snap();
  let h = heard(s, T - 1);
  ok("it still ends at the time first asked for (the call did not add to it)", s.heard.length === 0 && (await text(page, "#sPlay")) === "Play" && h.last - (T + 600000) <= 2600 && h.last - (T + 600000) >= -2400, `off by ${(h.last - (T + 600000)) / 1000}s`);
  ok("the only silence was the call itself", Math.abs(h.gap - 46000) < 1500, `gap ${h.gap}`);

  /* nobody resumes it */
  let mark = await now(page);
  await page.click("#sPlay"); await tick(40);
  const T1 = firstHeardSince(await b.snap(), mark);
  await runTo(page, tick, T1 + 100000);
  await page.evaluate(() => window.__snd.interrupt()); const tInt = await now(page); await tick(700);
  ok("paused again", (await text(page, "#sPlay")) === "Carry on");
  await runTo(page, tick, T1 + 600000 + 2000);
  s = await b.snap();
  ok("if nothing resumes it, it clears itself when the time is up", s.heard.length === 0 && (await text(page, "#sPlay")) === "Play" && !(await page.locator("#sOff").isVisible()) && s.log.filter((e) => e.ev === "play" && e.t > tInt).length === 0);

  /* carried on by hand, and stopped by hand */
  mark = await now(page);
  await page.click("#sPlay"); await tick(40);
  const T2 = firstHeardSince(await b.snap(), mark);
  await runTo(page, tick, T2 + 30000);
  await page.evaluate(() => window.__snd.interrupt()); await tick(700);
  await page.click("#sPlay"); await tick(300);
  s = await b.snap();
  const again = s.log.filter((e) => e.ev === "play" && !e.muted).pop();
  ok("Carry on starts it again from the top of a fresh piece, fading in", s.heard.length === 1 && again.from === 0 && (await text(page, "#sPlay")) === "Stop", JSON.stringify(again));
  ok("with the end time unchanged", (await text(page, "#sNow")) === "Rain · 10 minutes left");
  await page.evaluate(() => window.__snd.interrupt()); await tick(700);
  await page.click("#sOff"); await tick(300);
  s = await b.snap();
  ok("Stop while paused clears it", s.heard.length === 0 && (await text(page, "#sPlay")) === "Play" && !(await page.locator("#sOff").isVisible()) && (await text(page, "#sNow")) === "");
  await page.evaluate(() => window.__snd.resume()); await tick(700);
  ok("a late resume from the system does not bring it back", (await b.snap()).heard.length === 0);
  await page.evaluate(() => window.__snd.players[0].play()); await tick(300);
  s = await b.snap();
  ok("and a player that restarts anyway is stopped again at once", s.heard.length === 0 && s.players.every((p) => p.paused), JSON.stringify(s.players));

  /* the lock screen's own buttons */
  await page.evaluate(() => { window.__acts = {}; const real = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = (k, f) => { window.__acts[k] = f; try { real(k, f); } catch (e) {} }; });
  mark = await now(page);
  await page.click("#sPlay"); await tick(40);
  const T3 = firstHeardSince(await b.snap(), mark);
  await runTo(page, tick, T3 + 20000);
  let acts = await page.evaluate(() => ({ play: typeof window.__acts.play, pause: typeof window.__acts.pause, stop: typeof window.__acts.stop, title: navigator.mediaSession.metadata && navigator.mediaSession.metadata.title, artist: navigator.mediaSession.metadata && navigator.mediaSession.metadata.artist }));
  ok("the lock screen is given the sound's name and pause, play and stop", acts.play === "function" && acts.pause === "function" && acts.stop === "function" && acts.title === "Rain" && acts.artist === "Permission", JSON.stringify(acts));
  await page.evaluate(() => window.__acts.pause()); await tick(600);
  ok("its pause pauses", (await b.snap()).heard.length === 0 && (await text(page, "#sPlay")) === "Carry on");
  await page.evaluate(() => window.__acts.play()); await tick(600);
  ok("its play carries on from where it was", (await b.snap()).heard.length === 1 && (await text(page, "#sPlay")) === "Stop" && (await b.snap()).log.filter((e) => e.ev === "play" && !e.muted).pop().from > 15);
  await page.evaluate(() => window.__acts.stop()); await tick(600);
  acts = await page.evaluate(() => ({ play: window.__acts.play, meta: navigator.mediaSession.metadata }));
  ok("its stop stops, and the lock screen is given back", (await b.snap()).heard.length === 0 && (await text(page, "#sPlay")) === "Play" && acts.play === null && acts.meta === null);

  /* a turn that cannot start */
  mark = await now(page);
  await page.click("#sPlay"); await tick(40);
  const T4 = firstHeardSince(await b.snap(), mark);
  await runTo(page, tick, T4 + 80000);
  await page.evaluate(() => { window.__snd.blockPlay = true; });
  await runTo(page, tick, T4 + 92000);
  s = await b.snap();
  ok("if the next piece is refused, the screen says Paused instead of pretending", s.heard.length === 0 && s.log.some((e) => e.ev === "blocked" && e.t > T4 + 80000) && (await text(page, "#sPlay")) === "Carry on", (await text(page, "#sPlay")) + JSON.stringify(s.players));
  await page.evaluate(() => { window.__snd.blockPlay = false; });
  await page.click("#sPlay"); await tick(300);
  ok("and Carry on brings it back", (await b.snap()).heard.length === 1 && (await text(page, "#sPlay")) === "Stop");
  await page.click("#sPlay"); await tick(200);
  s = await b.snap();
  clean(b, "interruptions"); ok("interruptions: no error inside a player or timer callback", s.errors.length + s.clockErrors.length === 0, s.errors.concat(s.clockErrors).join(" | "));
  await b.ctx.close();
}

/* ================================================ what stops it, and what does not */
console.log("\nThe rest of the app while a sound plays");
{
  const b = await open(14); const { page, tick } = b;
  const order = await page.evaluate(() => [...document.getElementById("v-home").children].map((e) => e.id || e.className.split(" ")[0]));
  ok("in the afternoon the Morning card sits under the tiles and Sounds under that", order.indexOf("cardMorning") === order.indexOf("modes") + 1 && order.indexOf("cardSounds") === order.indexOf("cardMorning") + 1 && order.indexOf("sechead") === order.indexOf("cardSounds") + 1, order.join(","));
  await b.openSounds(); await page.click('#sList .s-opt[data-snd="white"]'); await page.click('#sQuick button[data-min="120"]'); await tick(900);
  await page.click("#sPlay"); await tick(20000);
  await page.click("#sBack"); await tick(500);
  ok("Home shows the hours left", (await text(page, "#soundsSub")) === "White noise · 2 hours left", await text(page, "#soundsSub"));

  await page.click("#btnLock"); await tick(500);
  ok("locking the app does not stop it", await page.locator("#lock").isVisible() && (await b.snap()).heard.length === 1);
  await b.tap4(); await tick(900);
  ok("and it is still playing after the passcode", !(await page.locator("#lock").isVisible()) && (await b.snap()).heard.length === 1 && /^White noise · /.test(await text(page, "#soundsSub")));

  await page.click('.mode[data-mode="text"]'); await tick(500);
  ok("writing an entry does not stop it", await page.locator("#v-text").isVisible() && (await b.snap()).heard.length === 1);
  await page.click("#v-text .iconbtn.back"); await tick(500);

  await page.locator("#cardMorning").scrollIntoViewIfNeeded(); await page.click("#cardMorning"); await tick(500);
  ok("opening Morning does not stop it", await page.locator("#v-morning").isVisible() && (await b.snap()).heard.length === 1);
  await page.click("#mBack"); await tick(500);

  await page.click('.mode[data-mode="voice"]'); await tick(500);
  ok("opening Record does not stop it yet", await page.locator("#v-voice").isVisible() && (await b.snap()).heard.length === 1);
  await page.click("#recBtn"); await tick(600);
  let s = await b.snap();
  ok("starting a recording does: the microphone never hears it", s.heard.length === 0 && s.players.every((p) => p.paused));
  await tick(100000);
  ok("and it does not come back by itself", (await b.snap()).heard.length === 0);
  await page.click("#v-voice .iconbtn.back"); await tick(600);
  ok("Home is back to its plain line", (await text(page, "#soundsSub")) === "Rain, waves, soft noise to rest in");

  await b.openSounds();
  ok("the screen shows it stopped, with the choice kept", (await text(page, "#sPlay")) === "Play" && (await page.locator('#sList .s-opt[aria-pressed="true"]').getAttribute("data-snd")) === "white");
  await page.click("#sPlay"); await tick(5000);
  ok("(playing again)", (await b.snap()).heard.length === 1);
  await page.click("#sBack"); await tick(500);
  await page.click('.mode[data-mode="voice"]'); await tick(500);
  await page.click("#segVideo"); await tick(300);
  const chooser = page.waitForEvent("filechooser", { timeout: 3000 }).catch(() => null);
  await page.click("#vidPick"); await chooser; await tick(300);
  ok("so does starting a video", (await b.snap()).heard.length === 0);
  await page.click("#v-voice .iconbtn.back"); await tick(600);

  await b.openSounds(); await page.click("#sPlay"); await tick(5000);
  ok("(playing again)", (await b.snap()).heard.length === 1);
  await page.click("#sBack"); await tick(500);
  await page.click("#btnSettings"); await tick(500);
  await page.locator("#setErase").scrollIntoViewIfNeeded(); await page.click("#setErase"); await b.real(500); await tick(1500);
  s = await b.snap();
  ok("Erase everything stops it", s.heard.length === 0);
  ok("and forgets the sound and the length", await page.evaluate(() => localStorage.getItem("perm_sound_id") === null && localStorage.getItem("perm_sound_min") === null));
  await b.openSounds();
  ok("so the screen is back to Rain for 30 minutes", (await page.locator('#sList .s-opt[aria-pressed="true"]').getAttribute("data-snd")) === "rain" && (await text(page, "#sDurTx")) === "30 minutes" && (await text(page, "#sPlay")) === "Play");
  clean(b, "the rest of the app"); ok("the rest of the app: no error inside a player or timer callback", s.errors.length + s.clockErrors.length === 0, s.errors.concat(s.clockErrors).join(" | "));
  await b.ctx.close();
}

/* ==================================================================== layout */
console.log("\nLayout");
for (const [w, hgt, name] of [[320, 568, "small phone"], [390, 844, "phone"], [844, 390, "phone sideways"], [820, 1180, "iPad upright"], [1180, 820, "iPad sideways"]]) {
  const b = await open(22, { size: { width: w, height: hgt } }); const { page, tick } = b;
  const home = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); const q = e.getBoundingClientRect(); return { l: q.left, r: q.right, t: q.top + scrollY, b: q.bottom + scrollY, h: q.height }; };
    return { card: r("#cardSounds"), modes: r("#v-home .modes"), greet: r("#v-home .greet"), morning: r("#cardMorning"), list: r("#v-home .sechead"), over: document.documentElement.scrollWidth > innerWidth + 1, iw: innerWidth, ih: innerHeight };
  });
  ok(`${name} (${w}x${hgt}): Home does not scroll sideways`, !home.over);
  if (w >= 760 && w > hgt) {
    ok(`${name}: the card is in the right-hand column, beside the greeting and above the Evening card`, home.card.l >= home.greet.r - 1 && home.card.b <= home.morning.t + 1 && home.card.r <= home.iw, JSON.stringify(home));
    ok(`${name}: it is on screen without scrolling`, home.card.b <= home.ih || hgt < 500, JSON.stringify(home.card));
  } else {
    ok(`${name}: the card sits under the tiles and above the journal, full width`, home.card.t >= home.modes.b && home.card.b <= home.list.t + 1 && home.card.h >= 44 && Math.abs(home.card.l - home.modes.l) < 1 && Math.abs(home.card.r - home.modes.r) < 1, JSON.stringify(home));
  }
  await b.openSounds();
  const scr = await page.evaluate(() => {
    const out = { over: document.documentElement.scrollWidth > innerWidth + 1, small: [], off: [] };
    document.querySelectorAll("#v-sounds button, #v-sounds input").forEach((e) => { if (e.offsetParent === null) return; const q = e.getBoundingClientRect();
      const need = e.id === "sBack" ? 39.5 : 43.5;        // the back button is the app-wide one (40pt on a phone)
      if (q.height < need || q.width < need) out.small.push((e.id || e.textContent.trim()) + " " + Math.round(q.width) + "x" + Math.round(q.height));
      if (q.left < -0.5 || q.right > innerWidth + 0.5) out.off.push(e.id || e.textContent.trim()); });
    const p = document.getElementById("sPlay"); p.scrollIntoView({ block: "end" }); const q = p.getBoundingClientRect();
    out.playOn = q.top >= -0.5 && q.bottom <= innerHeight + 0.5; scrollTo(0, 0);
    return out;
  });
  ok(`${name}: the Sounds screen does not scroll sideways`, !scr.over && scr.off.length === 0, scr.off.join(","));
  ok(`${name}: every control is at least 44pt each way`, scr.small.length === 0, scr.small.join(", "));
  ok(`${name}: Play can be reached`, scr.playOn);
  if (SHOTS && name !== "phone") await page.screenshot({ path: path.join(SHOTS, `s6-${w}x${hgt}.png`) });
  clean(b, name); await b.ctx.close();
}

/* ================================================================ dark */
if (SHOTS) {
  const b = await open(22, { dark: true, dpr: 2 }); await b.openSounds(); await b.page.click('#sList .s-opt[data-snd="ocean"]'); await b.page.click("#sPlay"); await b.tick(400);
  await shot(b.page, "s7-dark-playing"); await b.ctx.close();
}

/* ======================================================= the real players */
console.log("\nReal media elements, in real time");
{
  const b = await open(22, { real: true }); const { page } = b; const wait = b.real;
  await b.openSounds(); await wait(900);
  await page.click("#sPlay"); await wait(1300);
  let st = await page.evaluate(() => window.__real.els.map((a) => ({ paused: a.paused, t: a.currentTime, d: a.duration, muted: a.muted, err: a.error ? a.error.code : 0, ended: a.ended })));
  ok("the browser really plays the first piece: it is 90 seconds long and moving", st.length === 2 && !st[0].paused && st[0].t > 0.4 && Math.abs(st[0].d - 90) < 0.01 && st[0].err === 0, JSON.stringify(st));
  ok("the second player was readied without a sound: stopped, at the start, unmuted", st[1].paused && st[1].t === 0 && st[1].muted === false && st[1].err === 0, JSON.stringify(st[1]));
  for (const id of ["ocean", "brown", "white", "rain"]) {
    await page.click(`#sList .s-opt[data-snd="${id}"]`); await wait(900);
    st = await page.evaluate(() => window.__real.els.map((a) => ({ paused: a.paused, t: a.currentTime, d: a.duration, err: a.error ? a.error.code : 0 })));
    ok(`${id}: really decodes and plays`, !st[0].paused && st[0].t > 0.3 && Math.abs(st[0].d - 90) < 0.01 && st[0].err === 0 && st[1].err === 0, JSON.stringify(st));
  }
  /* a pause and a play from outside the app */
  await page.evaluate(() => window.__real.els[0].pause()); await wait(900);
  ok("a pause from outside is noticed", (await text(page, "#sPlay")) === "Carry on" && /^Paused · /.test(await text(page, "#sNow")));
  await page.evaluate(() => window.__real.els[0].play()); await wait(900);
  ok("and so is the play that follows", (await text(page, "#sPlay")) === "Stop" && /^Rain · /.test(await text(page, "#sNow")));
  /* the first player's turn ends: sped up so 84 seconds take about five */
  await page.evaluate(() => { window.__real.els.forEach((a) => { a.playbackRate = 16; }); });
  await wait(6500);
  st = await page.evaluate(() => window.__real.els.map((a) => ({ paused: a.paused, t: a.currentTime, ended: a.ended, muted: a.muted })));
  ok("the second player really takes over when the first reaches its turn", !st[1].paused && st[1].t > 0.5 && st[1].muted === false, JSON.stringify(st));
  ok("and the first really runs out by itself", st[0].ended && st[0].paused, JSON.stringify(st[0]));
  ok("the screen never noticed a thing", (await text(page, "#sPlay")) === "Stop" && /^Rain · 30 minutes left$/.test(await text(page, "#sNow")), await text(page, "#sNow"));
  await wait(6500);
  st = await page.evaluate(() => window.__real.els.map((a) => ({ paused: a.paused, t: a.currentTime, ended: a.ended })));
  ok("then the first takes its turn again", !st[0].paused && st[0].t > 0.5 && st[1].ended, JSON.stringify(st));
  await page.click("#sPlay"); await wait(400);
  st = await page.evaluate(() => window.__real.els.map((a) => a.paused));
  ok("Stop really stops both", st.every(Boolean) && (await text(page, "#sPlay")) === "Play");

  /* measure each WAV the page built */
  for (const id of ["rain", "ocean", "brown", "white"]) {
    await page.click(`#sList .s-opt[data-snd="${id}"]`); await wait(900);
    const m = await page.evaluate(async () => {
      const u = window.__real.urls[window.__real.urls.length - 1];
      const ab = await (await window.fetch(u.url)).arrayBuffer();
      const buf = await new OfflineAudioContext(1, 1, 22050).decodeAudioData(ab);
      const x = buf.getChannelData(0); let q = 0, peak = 0;
      for (let i = 22050 * 30; i < 22050 * 60; i++) { q += x[i] * x[i]; }
      for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
      return { size: u.size, ch: buf.numberOfChannels, sr: buf.sampleRate, n: buf.length, first: x[0], last: x[x.length - 1], rms: Math.sqrt(q / (22050 * 30)), peak };
    });
    ok(`${id}: a mono 22.05 kHz file, exactly 90 seconds`, m.ch === 1 && m.sr === 22050 && m.n === 90 * 22050 && m.size === LOOP_BYTES, JSON.stringify(m));
    ok(`${id}: starts and ends in silence, is loud enough to hear and never clips`, m.first === 0 && Math.abs(m.last) < 0.002 && m.rms > 0.05 && m.rms < 0.3 && m.peak < 1, JSON.stringify(m));
  }
  clean(b, "real players"); await b.ctx.close();
}

await browser.close(); server.close();
console.log("\n" + "=".repeat(40));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
