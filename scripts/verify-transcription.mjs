#!/usr/bin/env node
/* ============================================================================
   verify-transcription.mjs — drive the REAL Record screen in a real browser and
   prove the 1.5.0 transcription path works end to end, on both recorder paths.

   Usage:  cd www && python3 -m http.server 8765
           node scripts/verify-transcription.mjs [baseUrl]

   WHY THIS EXISTS
   ---------------
   Static assertions (test/permission.test.mjs) prove the SOURCE says the right
   things. They cannot prove the wiring runs: 1.3.0-1.3.2 shipped a transcriber
   whose plugin was not in the IPA, and every static check of that code passed.

   So this stubs `Capacitor.Plugins.PermissionSpeech` with a fake that answers
   exactly like the native one, then makes the app take each of its real code
   paths and checks what the user would actually see:

     1  the native-recorder path  (VoiceRecorder present -> finishNativeRec)
     2  the MediaRecorder path    (no native plugin -> mediaRec.onstop)
     3  a REFUSED transcription   (no on-device model) still saves the audio
     4  an edited transcript is not clobbered, and is what gets saved
     5  the recogniser is never called while the recorder holds the mic
     6  there is no Dictate control, and no live method is ever called

   Any uncaught page error fails the run — a thrown exception in this flow is
   the failure mode that matters most.
   ========================================================================== */

import { chromium } from "playwright";

const URL = process.argv[2] || "http://localhost:8765/index.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  — " + extra : "")); }
}
function section(t) { console.log("\n" + t); }

/* The fake native side. Mirrors PermissionSpeechPlugin's contract exactly:
   resolves {ok,...} + a diag snapshot, never rejects. `mode` picks the answer
   so each branch of the JS can be exercised. It also RECORDS every call, which
   is how we prove ordering (recogniser after the mic is released) and prove no
   live method is ever reached. */
function installFakeNative({ withVoiceRecorder, sttMode }) {
  return `(() => {
    window.__calls = [];
    const diag = {
      engine: "native-sfspeechrecognizer", plugin: "PermissionSpeech", mode: "file-only",
      speechAuth: "authorized", micAuth: "granted", available: true,
      onDevice: ${sttMode === "no-on-device" ? "false" : "true"},
      locale: "en-US", hasRecognizer: true,
    };
    const PermissionSpeech = new Proxy({
      diagnostics: () => { window.__calls.push("diagnostics"); return Promise.resolve(diag); },
      checkPermissions: () => { window.__calls.push("checkPermissions"); return Promise.resolve(diag); },
      requestPermissions: () => { window.__calls.push("requestPermissions"); return Promise.resolve(diag); },
      transcribeFile: (o) => {
        window.__calls.push("transcribeFile:" + (o && o.ext) + ":" + ((o && o.data || "").length > 0));
        ${sttMode === "no-on-device"
          ? 'return Promise.resolve({ ok:false, reason:"no-on-device", diag });'
          : 'return Promise.resolve({ ok:true, transcript:"I keep waiting to feel ready. Maybe ready is just the thing that shows up after you start.", onDevice:true, diag });'}
      },
    }, {
      // Anything the app tries to call that the real plugin does NOT expose —
      // startLive, stopLive, addListener — is recorded and then thrown, so a
      // revived live path fails loudly here instead of silently on a device.
      get(t, k) {
        if (k in t) return t[k];
        if (typeof k === "string" && !k.startsWith("__") && k !== "then") {
          window.__calls.push("FORBIDDEN:" + k);
        }
        return undefined;
      },
    });

    const VoiceRecorder = {
      requestAudioRecordingPermission: () => { window.__calls.push("mic:request"); return Promise.resolve({ value:true }); },
      startRecording: () => { window.__calls.push("mic:acquire"); return Promise.resolve({ value:true }); },
      stopRecording: () => {
        window.__calls.push("mic:release");
        // "AAAAIGZ0eXA" is a tiny valid-looking mp4 header in base64.
        return Promise.resolve({ value: { recordDataBase64:"AAAAIGZ0eXA=", mimeType:"audio/aac", msDuration: 7400 } });
      },
    };

    window.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "ios",
      Plugins: { PermissionSpeech${withVoiceRecorder ? ", VoiceRecorder" : ""} },
    };
  })()`;
}

async function boot(browser, { withVoiceRecorder, sttMode }) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e && e.message || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  // Must run BEFORE the app's IIFE, so capNative() sees the native platform.
  await page.addInitScript(installFakeNative({ withVoiceRecorder, sttMode }));
  await page.goto(URL, { waitUntil: "networkidle" });

  await page.waitForSelector("#pad button.key", { timeout: 15000 });
  const tap4 = async () => { for (let i = 0; i < 4; i++) { await page.click('#pad button.key:has-text("1")'); await sleep(70); } };
  await tap4(); await sleep(500);
  if (await page.locator("#lock").isVisible()) { await tap4(); await sleep(700); }
  if (await page.locator("#onboard").isVisible()) { await page.click("#obSkip"); await sleep(700); }
  return { ctx, page, errors };
}

/* Opens Record, records, stops. On the MediaRecorder path getUserMedia and
   MediaRecorder are stubbed in the page so the real onstop handler runs. */
/* The whole web-recorder stub in one place: getUserMedia, a MediaRecorder that
   models pause/resume, and a no-op AudioContext for the level meter. Every
   section that drives the MediaRecorder path installs ALL of it — a partial
   stub just makes startTake() fall into "Microphone permission needed". */
async function stubWebRecorder(page) {
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => {
      window.__calls.push("mic:acquire");
      return Promise.resolve({ getTracks: () => [{ stop() { window.__calls.push("mic:release"); } }] });
    };
    /* Models the real thing where it matters: ONE ondataavailable at stop,
       carrying everything captured across every record/pause segment. The
       payload size tracks how long it was actually capturing, which is how the
       tests prove a resumed take APPENDS instead of starting over. */
    class FakeRec {
      constructor() { this.state = "inactive"; this.mimeType = "audio/mp4"; this._ms = 0; this._t0 = 0; }
      start() { this.state = "recording"; this._t0 = Date.now(); window.__calls.push("rec:start"); }
      pause() {
        if (this.state !== "recording") return;
        this._ms += Date.now() - this._t0; this.state = "paused"; window.__calls.push("rec:pause");
      }
      resume() {
        if (this.state !== "paused") return;
        this._t0 = Date.now(); this.state = "recording"; window.__calls.push("rec:resume");
      }
      stop() {
        if (this.state === "recording") this._ms += Date.now() - this._t0;
        this.state = "inactive";
        window.__calls.push("rec:stop");
        window.__capturedMs = this._ms;
        const n = Math.max(8, Math.round(this._ms / 10));
        if (this.ondataavailable) this.ondataavailable({ data: new Blob([new Uint8Array(n)], { type: "audio/mp4" }) });
        if (this.onstop) this.onstop();
      }
    }
    FakeRec.isTypeSupported = () => true;
    window.MediaRecorder = FakeRec;
    // The level meter needs a real AudioContext; a no-op keeps it quiet.
    window.AudioContext = function () {
      return { createMediaStreamSource: () => ({ connect() {} }),
               createAnalyser: () => ({ fftSize: 64, frequencyBinCount: 32, getByteFrequencyData() {} }),
               close() {} };
    };
  });
}

async function recordAndStop(page, native) {
  await page.click('.mode[data-mode="voice"]');
  await sleep(500);
  if (!native) await stubWebRecorder(page);
  await page.click("#recBtn");     // start
  await sleep(600);
  await page.click("#recDone");    // Done ends the take (the mic only pauses)
  await sleep(1400);
}

const browser = await chromium.launch({ headless: true });

/* ---------------------------------------------------------------- 1 */
section("1) native recorder path — transcript arrives after the mic is released");
{
  const { ctx, page, errors } = await boot(browser, { withVoiceRecorder: true, sttMode: "ok" });
  ok("no Dictate control exists on the Record screen",
     await page.locator("#vDictate").count() === 0);
  ok("the transcript panel is on the Record screen",
     await page.locator("#vTranscript").count() === 1);

  await recordAndStop(page, true);
  const text = await page.inputValue("#vTranscript");
  const status = (await page.textContent("#trStatus")) || "";
  const calls = await page.evaluate(() => window.__calls);

  ok("the transcript text appears in the box", /Maybe ready is just the thing/.test(text), text.slice(0, 60));
  ok("the status says it stayed on device", /never left your device/.test(status), status);
  ok("the diagnostic line stays hidden while healthy",
     await page.locator("#trDiag.hidden").count() === 1);
  ok("the recogniser was called with the real audio and a sane extension",
     calls.some((c) => c === "transcribeFile:m4a:true"), calls.join(" > "));
  ok("the recogniser ran AFTER the recorder released the microphone",
     calls.indexOf("mic:release") > -1 &&
     calls.indexOf("mic:release") < calls.findIndex((c) => c.startsWith("transcribeFile")),
     calls.join(" > "));
  ok("no live-dictation method was ever reached",
     !calls.some((c) => c.startsWith("FORBIDDEN:")), calls.filter((c) => c.startsWith("FORBIDDEN:")).join(","));
  ok("speech permission was requested, separately from the mic",
     calls.includes("requestPermissions"));

  // save it, and read the entry straight back out of IndexedDB
  await page.click("#vSave");
  await sleep(900);
  const saved = await page.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open("awaken_db"); r.onsuccess = () => res(r.result); });
    return await new Promise((res) => {
      const rows = [];
      const tx = db.transaction("entries", "readonly");
      tx.objectStore("entries").openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (!c) return res(rows);
        rows.push({ type: c.value.type, transcript: c.value.transcript, hasAudio: !!c.value.audio, duration: c.value.duration });
        c.continue();
      };
    });
  });
  const voice = saved.find((r) => r.type === "voice");
  ok("the voice entry was saved", !!voice, JSON.stringify(saved));
  ok("the transcript was saved WITH the audio",
     !!voice && /Maybe ready is just the thing/.test(voice.transcript || "") && voice.hasAudio,
     JSON.stringify(voice));
  ok("the recording's duration survived", !!voice && voice.duration > 0);
  ok("no page errors in the whole flow", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* ---------------------------------------------------------------- 2 */
section("2) MediaRecorder path — same result, no native recorder");
{
  const { ctx, page, errors } = await boot(browser, { withVoiceRecorder: false, sttMode: "ok" });
  await recordAndStop(page, false);
  const text = await page.inputValue("#vTranscript");
  const calls = await page.evaluate(() => window.__calls);
  ok("the transcript arrives on the fallback recorder too", /Maybe ready is just the thing/.test(text), text.slice(0, 60));
  ok("the blob was re-encoded and handed over", calls.some((c) => c.startsWith("transcribeFile:") && c.endsWith(":true")), calls.join(" > "));
  ok("the recogniser ran only after the tracks were stopped",
     calls.indexOf("mic:release") < calls.findIndex((c) => c.startsWith("transcribeFile")), calls.join(" > "));
  ok("no live-dictation method was ever reached", !calls.some((c) => c.startsWith("FORBIDDEN:")));
  ok("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* ---------------------------------------------------------------- 3 */
section("3) a REFUSED transcription is explained, and never blocks the recording");
{
  const { ctx, page, errors } = await boot(browser, { withVoiceRecorder: true, sttMode: "no-on-device" });
  await recordAndStop(page, true);
  const status = (await page.textContent("#trStatus")) || "";
  const diagVisible = await page.locator("#trDiag:not(.hidden)").count() === 1;
  const diagText = (await page.textContent("#trDiag")) || "";
  ok("the failure is stated plainly, not silently", /Transcription unavailable/.test(status), status);
  ok("it says the audio is safe anyway", /recording is safe either way/.test(status));
  ok("it refuses rather than offering to upload", /won.t send your audio anywhere/.test(status), status);
  ok("the diagnostic line appears when something IS wrong", diagVisible);
  ok("the diagnostic names the on-device state", /on-device: no/.test(diagText), diagText);
  ok("Save is still enabled — the recording is not held hostage",
     await page.locator("#vSave:not([disabled])").count() === 1);
  await page.click("#vSave");
  await sleep(900);
  const kinds = await page.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open("awaken_db"); r.onsuccess = () => res(r.result); });
    return await new Promise((res) => {
      const rows = []; const tx = db.transaction("entries", "readonly");
      tx.objectStore("entries").openCursor().onsuccess = (e) => {
        const c = e.target.result; if (!c) return res(rows);
        rows.push({ type: c.value.type, hasAudio: !!c.value.audio, transcript: c.value.transcript }); c.continue();
      };
    });
  });
  const v = kinds.find((r) => r.type === "voice");
  ok("the audio still saved with no transcript", !!v && v.hasAudio && !v.transcript, JSON.stringify(v));
  ok("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* ---------------------------------------------------------------- 4 */
section("4) the words end up the user's — edits are never clobbered");
{
  const { ctx, page, errors } = await boot(browser, { withVoiceRecorder: true, sttMode: "ok" });
  await page.click('.mode[data-mode="voice"]');
  await sleep(400);
  await stubWebRecorder(page);
  await page.fill("#vTranscript", "My own words, typed before anything was recorded.");
  await page.click("#recBtn"); await sleep(500); await page.click("#recDone"); await sleep(1500);
  const after = await page.inputValue("#vTranscript");
  const status = (await page.textContent("#trStatus")) || "";
  ok("a hand-typed transcript survives a transcription that follows it",
     after === "My own words, typed before anything was recorded.", after);
  ok("the status admits the machine transcript stepped aside",
     /your own words were kept/i.test(status), status);
  await page.click("#vSave"); await sleep(900);
  const v = await page.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open("awaken_db"); r.onsuccess = () => res(r.result); });
    return await new Promise((res) => {
      const rows = []; const tx = db.transaction("entries", "readonly");
      tx.objectStore("entries").openCursor().onsuccess = (e) => {
        const c = e.target.result; if (!c) return res(rows.find((r) => r.type === "voice"));
        rows.push(c.value); c.continue();
      };
    });
  });
  ok("what was saved is what the user could see", /My own words/.test((v && v.transcript) || ""), (v && v.transcript) || "");
  ok("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* ---------------------------------------------------------------- 5 */
section("5) PAUSE/RESUME — the mic never ends a take, and never wipes one");
{
  const { ctx, page, errors } = await boot(browser, { withVoiceRecorder: false, sttMode: "ok" });
  await page.click('.mode[data-mode="voice"]');
  await sleep(400);
  await stubWebRecorder(page);

  ok("no Done/Start-over controls before anything is recorded",
     await page.locator("#recActions.hidden").count() === 1);

  await page.click("#recBtn");                    // start
  await sleep(700);
  const tRec = await page.textContent("#recTime");
  await page.click("#recBtn");                    // PAUSE (used to be "stop")
  await sleep(500);

  const stateAfterPause = await page.evaluate(() => ({
    recorder: window.__recState || null,
    calls: window.__calls.slice(),
    btnPaused: document.getElementById("recBtn").classList.contains("paused"),
    btnHidden: document.getElementById("recBtn").classList.contains("hidden"),
    hint: document.getElementById("recHint").textContent,
    doneVisible: !document.getElementById("recDone").classList.contains("hidden"),
    saveDisabled: document.getElementById("vSave").disabled,
  }));
  ok("tapping the mic PAUSES — the recorder is never stopped",
     stateAfterPause.calls.includes("rec:pause") && !stateAfterPause.calls.includes("rec:stop"),
     stateAfterPause.calls.join(" > "));
  ok("the button shows a distinct paused state, not the idle mic", stateAfterPause.btnPaused);
  ok("the hint says nothing is lost", /nothing is lost/i.test(stateAfterPause.hint), stateAfterPause.hint);
  ok("Done is offered while paused", stateAfterPause.doneVisible);
  ok("Save stays disabled until the take is finished", stateAfterPause.saveDisabled);

  // the timer must FREEZE while paused
  const tPause1 = await page.textContent("#recTime");
  await sleep(1600);
  const tPause2 = await page.textContent("#recTime");
  ok("the timer freezes while paused", tPause1 === tPause2, `${tPause1} -> ${tPause2}`);

  await page.click("#recBtn");                    // CONTINUE
  await sleep(700);
  const calls2 = await page.evaluate(() => window.__calls.slice());
  ok("tapping again RESUMES the same recorder session",
     calls2.includes("rec:resume") && calls2.filter((c) => c === "rec:start").length === 1,
     calls2.join(" > "));
  const tResume = await page.textContent("#recTime");
  ok("the timer carries on from where it paused, not from zero",
     tResume !== "0:00" && tResume >= tRec, `${tRec} -> ${tResume}`);

  await page.click("#recDone");
  await sleep(1500);
  const fin = await page.evaluate(() => ({
    calls: window.__calls.slice(),
    capturedMs: window.__capturedMs,
    micHidden: document.getElementById("recBtn").classList.contains("hidden"),
    restartVisible: !document.getElementById("recRestart").classList.contains("hidden"),
    doneHidden: document.getElementById("recDone").classList.contains("hidden"),
    playbackVisible: !document.getElementById("playbackWrap").classList.contains("hidden"),
    saveDisabled: document.getElementById("vSave").disabled,
    transcript: document.getElementById("vTranscript").value,
  }));
  ok("Done stops the recorder exactly once",
     fin.calls.filter((c) => c === "rec:stop").length === 1, fin.calls.join(" > "));
  ok("the finished take spans BOTH segments, not just the last one",
     fin.capturedMs > 1000, `captured ${fin.capturedMs}ms across two ~700ms segments`);
  ok("the mic is hidden once a take is finished, so it cannot silently wipe it", fin.micHidden);
  ok("Start over replaces it, named for what it does", fin.restartVisible && fin.doneHidden);
  ok("playback of the whole take appears", fin.playbackVisible);
  ok("Save is now enabled", !fin.saveDisabled);
  ok("the whole accumulated take was transcribed, once",
     /Maybe ready is just the thing/.test(fin.transcript) &&
     fin.calls.filter((c) => c.startsWith("transcribeFile")).length === 1,
     fin.calls.filter((c) => c.startsWith("transcribeFile")).join(","));

  // and the saved entry carries the FULL take
  await page.click("#vSave");
  await sleep(900);
  const v = await page.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open("awaken_db"); r.onsuccess = () => res(r.result); });
    return await new Promise((res) => {
      const rows = []; const tx = db.transaction("entries", "readonly");
      tx.objectStore("entries").openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (!c) return res(rows.find((r) => r.type === "voice"));
        rows.push({ type: c.value.type, size: c.value.audio ? c.value.audio.size : 0, duration: c.value.duration, transcript: c.value.transcript });
        c.continue();
      };
    });
  });
  ok("the saved audio is the accumulated take", !!v && v.size > 100, JSON.stringify(v));
  ok("the saved duration covers both segments", !!v && v.duration >= 1, JSON.stringify(v));
  ok("the saved transcript is the full one", !!v && /Maybe ready/.test(v.transcript || ""));
  ok("no page errors across the whole pause/resume flow", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* ---------------------------------------------------------------- 6 */
section("6) a SINGLE take (no pause) still behaves, and Start over is the only wipe");
{
  const { ctx, page, errors } = await boot(browser, { withVoiceRecorder: false, sttMode: "ok" });
  await page.click('.mode[data-mode="voice"]');
  await sleep(400);
  await stubWebRecorder(page);
  await page.click("#recBtn"); await sleep(700); await page.click("#recDone"); await sleep(1400);
  const oneSeg = await page.evaluate(() => window.__capturedMs);
  ok("an unpaused take finishes normally", oneSeg > 400 && oneSeg < 1200, `${oneSeg}ms`);
  ok("its transcript arrived", /Maybe ready/.test(await page.inputValue("#vTranscript")));

  await page.click("#recRestart");
  await sleep(400);
  const after = await page.evaluate(() => ({
    time: document.getElementById("recTime").textContent,
    transcript: document.getElementById("vTranscript").value,
    playbackHidden: document.getElementById("playbackWrap").classList.contains("hidden"),
    micVisible: !document.getElementById("recBtn").classList.contains("hidden"),
    saveDisabled: document.getElementById("vSave").disabled,
    actionsHidden: document.getElementById("recActions").classList.contains("hidden"),
  }));
  ok("Start over clears the timer", after.time === "0:00", after.time);
  ok("Start over clears the transcript", after.transcript === "", after.transcript);
  ok("Start over hides the old playback", after.playbackHidden);
  ok("the mic comes back, ready for a new take", after.micVisible && after.actionsHidden);
  ok("Save is disabled again", after.saveDisabled);
  ok("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

await browser.close();
console.log("\n" + "=".repeat(40));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
