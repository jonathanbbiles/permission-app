#!/usr/bin/env node
/* ============================================================================
   render-screenshots.mjs — App Store screenshots, rendered from the CURRENT
                            build, at exact App Store Connect pixel sizes.

   Usage:  node scripts/render-screenshots.mjs [outDir] [baseUrl]
           (defaults: ./screenshots  http://localhost:8765/index.html)

   Serve www/ first:  cd www && python3 -m http.server 8765

   WHY EXACT SIZES MATTER
   ----------------------
   ASC rejects the upload outright if the pixel dimensions are not exactly what
   the slot expects. And a screenshot rendered from an OLD build is a 2.3.3 —
   that is the rejection Permission 1.2 took, for showing a tab that had been
   removed. So these are always re-rendered, never edited by hand.

   Slots:
     iphone69  1290x2796   430x932 @3x    (6.9" — iPhone 16 Pro Max class)
     iphone65  1242x2688   414x896 @3x    (6.5" — iPhone 11 Pro Max class)
     ipad13    2048x2732  1024x1366 @2x   (13" iPad — REQUIRED while the build
                                           is Universal; missing it is a hard
                                           upload block)

   The app is seeded with its own invented sample content. Never put
   third-party media, real brands or encyclopedic text in a screenshot —
   that is the 4.1(a) "Copycats" rejection that hit Moodie.
   ========================================================================== */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(process.argv[2] || "screenshots");
const URL = process.argv[3] || "http://localhost:8765/index.html";

const DEVICES = [
  { slot: "iphone69", w: 430, h: 932, dpr: 3, px: "1290x2796" },
  { slot: "iphone65", w: 414, h: 896, dpr: 3, px: "1242x2688" },
  { slot: "ipad13", w: 1024, h: 1366, dpr: 2, px: "2048x2732" },
];

/* The app's own words — nothing borrowed. */
const SAMPLE = [
  {
    id: "s1", type: "text", offsetMin: 40,
    prompt: "What is one thing you long for in your intimate life?",
    text: "I want to stop apologising for wanting to be wanted. Writing that down felt like putting down something I had been carrying with both arms.",
  },
  {
    id: "s2", type: "voice", offsetMin: 26 * 60, duration: 84,
    prompt: "Where in your body do you feel most at home right now?",
    transcript: "My shoulders, oddly. They dropped about an inch when I said out loud that nobody is grading me on this.",
  },
  {
    id: "s3", type: "text", offsetMin: 52 * 60,
    prompt: "Name something you gave yourself permission for this week.",
    text: "I said no to something I would have said yes to a year ago, and the sky did not fall.",
  },
  {
    id: "s4", type: "voice", offsetMin: 74 * 60, duration: 132,
    prompt: "What would you say to the version of you from ten years ago?",
    transcript: "That you were not too much. You were just the only one in the room who was being honest about it.",
  },
  {
    id: "s5", type: "text", offsetMin: 99 * 60,
    prompt: "What does rest actually look like for you?",
    text: "Not earning it first. That is the whole answer and it took me thirty-four years to write it down.",
  },
  {
    id: "s6", type: "text", offsetMin: 121 * 60,
    prompt: "Where are you being gentler with yourself than you used to be?",
    text: "I let a morning be slow today without narrating it as laziness. Small, but it counted.",
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function unlock(page) {
  // First launch asks for a passcode, then to confirm it, then onboarding.
  await page.waitForSelector("#pad button.key", { timeout: 15000 });
  const tap4 = async () => {
    for (let i = 0; i < 4; i++) {
      await page.click('#pad button.key:has-text("1")');
      await sleep(70);
    }
  };
  await tap4();
  await sleep(500);
  if (await page.locator("#lock").isVisible()) {
    await tap4();
    await sleep(700);
  }
  if (await page.locator("#onboard").isVisible()) {
    await page.click("#obSkip");
    await sleep(700);
  }
}

async function seed(page) {
  await page.evaluate(async (rows) => {
    const audio = new Blob([new Uint8Array([0, 0, 0, 32, 102, 116, 121, 112])], { type: "audio/mp4" });
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("awaken_db");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction("entries", "readwrite");
      const st = tx.objectStore("entries");
      for (const e of rows) {
        const rec = { id: e.id, ts: Date.now() - e.offsetMin * 60000, type: e.type, prompt: e.prompt };
        if (e.type === "text") rec.text = e.text;
        else { rec.audio = audio; rec.mime = "audio/mp4"; rec.duration = e.duration; rec.transcript = e.transcript; }
        st.put(rec);
      }
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  }, SAMPLE);
  await page.evaluate(() => window.Permission.showApp());
  await sleep(700);
}

/* Scribble a few strokes so the Notebook shot isn't a blank white rectangle. */
async function scribble(page, sel = "#nbCanvas") {
  const box = await page.locator(sel).boundingBox();
  if (!box) return;
  const strokes = [
    [[0.10, 0.16], [0.30, 0.11], [0.52, 0.19], [0.74, 0.12]],
    [[0.10, 0.32], [0.34, 0.27], [0.58, 0.35], [0.80, 0.28]],
    [[0.10, 0.48], [0.26, 0.44], [0.44, 0.51]],
    [[0.12, 0.66], [0.32, 0.61], [0.55, 0.69], [0.78, 0.62]],
  ];
  for (const s of strokes) {
    const [sx, sy] = s[0];
    await page.mouse.move(box.x + box.width * sx, box.y + box.height * sy);
    await page.mouse.down();
    for (const [x, y] of s.slice(1)) {
      await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 14 });
    }
    await page.mouse.up();
    await sleep(90);
  }
}

async function shoot(page, dir, name) {
  const file = path.join(dir, name + ".png");
  await page.screenshot({ path: file });
  return file;
}

const browser = await chromium.launch();
const written = [];
let failed = 0;

for (const d of DEVICES) {
  const dir = path.join(OUT, d.slot);
  fs.mkdirSync(dir, { recursive: true });

  const ctx = await browser.newContext({
    viewport: { width: d.w, height: d.h },
    deviceScaleFactor: d.dpr,
    isMobile: d.slot !== "ipad13",
    hasTouch: true,
    colorScheme: "light",
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(URL, { waitUntil: "networkidle" });
  await unlock(page);
  await seed(page);

  // 1 — home
  written.push(await shoot(page, dir, "01-home"));

  // 2 — Record, with the transcript the finished recording produced.
  //     Staged, because a headless browser has no native recogniser: the
  //     DEVICE state is what a screenshot must show, not the renderer's.
  await page.click('.mode[data-mode="voice"]');
  await sleep(700);
  await page.evaluate(() => {
    /* Depict a FINISHED take: the state a real recording lands in. A headless
       browser has no microphone and no native recogniser, so the screen is
       dressed to show what the device actually does — never a capability the
       app does not have. */
    document.getElementById("recTime").textContent = "1:24";
    document.getElementById("recBtn").classList.add("hidden");
    document.getElementById("recActions").classList.remove("hidden");
    document.getElementById("recDone").classList.add("hidden");
    document.getElementById("recRestart").classList.remove("hidden");
    document.getElementById("recHint").textContent =
      "Listen back, then save. Start over only if you want to discard this take.";
    document.getElementById("playbackWrap").classList.remove("hidden");
    document.getElementById("vTranscript").value =
      "I keep waiting to feel ready. Maybe ready is just the thing that shows up after you start.";
    document.getElementById("trStatus").textContent =
      "Transcribed on this phone. The audio never left your device.";
    // The diagnostic line is hidden whenever the recogniser is healthy, which
    // is the state being depicted — leave it hidden.
    document.getElementById("trDiag").classList.add("hidden");
  });
  written.push(await shoot(page, dir, "02-record"));

  // 2b — PAUSED mid-take: the 1.6.0 behaviour, and the reassurance that goes
  //      with it. This is a real state of the screen, not a mock-up.
  await page.evaluate(() => {
    document.getElementById("recTime").textContent = "0:47";
    document.getElementById("recBtn").classList.remove("hidden");
    document.getElementById("recBtn").classList.add("paused");
    document.getElementById("recBtn").innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 4v16M15 4v16"/></svg>';
    document.getElementById("recDone").classList.remove("hidden");
    document.getElementById("recRestart").classList.add("hidden");
    document.getElementById("recHint").textContent =
      "Paused — nothing is lost. Tap to carry on, or Done when you have finished.";
    document.getElementById("playbackWrap").classList.add("hidden");
    document.getElementById("vTranscript").value = "";
    document.getElementById("trStatus").textContent =
      "When you tap Done, your words are turned into text on your phone. Nothing is uploaded.";
  });
  written.push(await shoot(page, dir, "02b-record-paused"));

  // 3 — Notebook, with ink, showing both export controls
  await page.click('#v-voice [data-discard]');
  await sleep(600);
  await page.click("#cardNotebook");   // header shortcut removed in 1.3.1
  await sleep(1200);
  await scribble(page);
  await sleep(300);
  written.push(await shoot(page, dir, "03-notebook"));

  /* Both export controls must be reachable WITHOUT scrolling, on every device
     size — that is the whole point of the 1.3 notebook change. Assert it here
     so a future layout tweak can't quietly push them back under the fold. */
  const nb = await page.evaluate(() => {
    const vh = window.innerHeight;
    const row = document.getElementById("nbExportRow").getBoundingClientRect();
    const c = document.getElementById("nbCanvas").getBoundingClientRect();
    return {
      vh,
      canvasH: Math.round(c.height),
      canvasW: Math.round(c.width),
      exportBottom: Math.round(row.bottom),
      exportsVisible: row.bottom <= vh,
      scrolls: document.documentElement.scrollHeight > vh + 1,
    };
  });
  if (!nb.exportsVisible) {
    console.error(`  ✗ ${d.slot}: export row bottom ${nb.exportBottom} > viewport ${nb.vh} — below the fold`);
    failed++;
  }
  if (nb.scrolls) { console.error(`  ✗ ${d.slot}: notebook page scrolls`); failed++; }
  console.log(
    `${"".padEnd(9)} notebook canvas ${nb.canvasW}x${nb.canvasH}` +
    `  exports@${nb.exportBottom}/${nb.vh}` +
    (nb.exportsVisible && !nb.scrolls ? "  ✓ above the fold, no scroll" : "")
  );

  // 4 — Draw: both actions must be reachable the moment it opens
  await page.click('#v-notebook [data-back]');
  await sleep(800);
  await page.click('.mode[data-mode="draw"]');
  await sleep(1200);
  await scribble(page, "#drawCanvas");
  await sleep(250);
  written.push(await shoot(page, dir, "04-draw"));

  const dw = await page.evaluate(() => {
    const vh = window.innerHeight;
    const save = document.getElementById("dSave").getBoundingClientRect();
    const disc = document.querySelector('#drawActions [data-discard]').getBoundingClientRect();
    const c = document.getElementById("drawCanvas").getBoundingClientRect();
    return {
      vh,
      canvasH: Math.round(c.height), canvasW: Math.round(c.width),
      saveBottom: Math.round(save.bottom), discardBottom: Math.round(disc.bottom),
      // both must be fully on screen, and ABOVE the canvas
      actionsVisible: save.bottom <= vh && disc.bottom <= vh,
      actionsAboveCanvas: save.bottom <= c.top + 1 && disc.bottom <= c.top + 1,
      scrolls: document.documentElement.scrollHeight > vh + 1,
    };
  });
  if (!dw.actionsVisible) {
    console.error(`  ✗ ${d.slot}: Draw actions below the fold (save@${dw.saveBottom} discard@${dw.discardBottom} vh=${dw.vh})`);
    failed++;
  }
  if (!dw.actionsAboveCanvas) { console.error(`  ✗ ${d.slot}: Draw actions are not above the canvas`); failed++; }
  if (dw.scrolls) { console.error(`  ✗ ${d.slot}: Draw view scrolls`); failed++; }
  console.log(
    `${"".padEnd(9)} draw canvas ${dw.canvasW}x${dw.canvasH}` +
    `  actions@${Math.max(dw.saveBottom, dw.discardBottom)}/${dw.vh}` +
    (dw.actionsVisible && dw.actionsAboveCanvas && !dw.scrolls ? "  ✓ above canvas + fold, no scroll" : "")
  );

  // 5 — a saved voice entry, played back in the viewer
  await page.click('#v-draw [data-discard]');
  await sleep(800);
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#homeList .entry")];
    const voice = rows.find((r) => /shoulders/i.test(r.textContent)) || rows[1] || rows[0];
    voice.click();
  });
  await sleep(900);
  written.push(await shoot(page, dir, "05-entry-voice"));

  // ---- verify, don't assume ----
  const metrics = await page.evaluate(() => {
    window.Permission.showApp();
    const b = document.body.getBoundingClientRect();
    const home = document.getElementById("v-home");
    return {
      innerW: window.innerWidth,
      bodyW: Math.round(b.width),
      homeDisplay: getComputedStyle(home).display,
      homeCols: getComputedStyle(home).gridTemplateColumns,
      docScrollW: document.documentElement.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });

  // Every file must land at EXACTLY the slot's pixel size.
  for (const f of written.filter((f) => f.includes(`/${d.slot}/`))) {
    const buf = fs.readFileSync(f);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    const got = `${w}x${h}`;
    if (got !== d.px) { console.error(`  ✗ ${path.basename(f)} is ${got}, expected ${d.px}`); failed++; }
  }

  const fill = Math.round((metrics.bodyW / metrics.innerW) * 100);
  console.log(
    `${d.slot.padEnd(9)} ${d.px.padEnd(10)} body ${metrics.bodyW}/${metrics.innerW}px (${fill}% of width)` +
    `  home=${metrics.homeDisplay}` +
    (metrics.homeDisplay === "grid" ? ` [${metrics.homeCols}]` : "") +
    (metrics.horizontalOverflow ? "  ✗ H-OVERFLOW" : "")
  );
  if (metrics.horizontalOverflow) failed++;
  if (errors.length) { console.error(`  ✗ ${d.slot} console/page errors:`, errors.slice(0, 4)); failed++; }

  await ctx.close();
}

await browser.close();
console.log(`\n${written.length} screenshot(s) written to ${OUT}`);
if (failed) { console.error(`${failed} problem(s) — see above.`); process.exit(1); }
console.log("All slots rendered at their exact ASC pixel sizes, no horizontal overflow, no page errors.");
