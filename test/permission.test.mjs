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
const pkgRaw = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
const cm = fs.readFileSync(path.join(ROOT, "codemagic.yaml"), "utf8");
const PLUGIN_SWIFT = "native/permission-speech/ios/Sources/PermissionSpeechPlugin/PermissionSpeechPlugin.swift";
const pluginSrc = fs.readFileSync(path.join(ROOT, PLUGIN_SWIFT), "utf8");
/* comment-free view: the doc comments quote the exact APIs they warn against,
   so absence checks must not see them. Strips block comments AND // lines. */
const pluginCode = pluginSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const pluginPkg = fs.readFileSync(path.join(ROOT, "native/permission-speech/Package.swift"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  — " + extra : "")); }
}
function section(t){ console.log("\n" + t); }
/* Removal checks must look at CODE, not at the comments that explain the
   removal — those deliberately name what was taken out. */
function stripComments(src){
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
}

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
   /Browser\.open\(\{ url:url \}\)/.test(html) && /window\.open\(url,"_blank"/.test(html));
ok("in-app rating after success moment, not first launch", /requestReview/.test(html) && /n===3/.test(html));
/* exact version is re-asserted in section 20; here just check it moved past 1.2 */
ok("version bumped past the live 1.2", /APP_VERSION = "1\.[3-9](\.\d+)?"/.test(html) && />v1\.[3-9]/.test(html));
ok("IndexedDB name preserved for existing users", /indexedDB\.open\("awaken_db"/.test(html));
ok("passcode keys preserved", /"awaken_pin"/.test(html) && /"awaken_face"/.test(html));
ok("creator link jonathanscribbles.com present + clickable",
   /jonathanscribbles\.com/.test(html) && /makerLink/.test(html) && /MAKER_URL/.test(html));
ok("Jessica's link kept as the headline link", /SITE_URL="https:\/\/jessicaleighbiles\.com"/.test(html));

/* ============================================================ */
section("8) v1.5.0 — TRANSCRIPTION is back; LIVE DICTATION stays gone");
/* The two halves of the old feature had different fates and this is the fence
   that keeps them apart.
     IN  — file transcription: the finished recording is transcribed on-device.
           It touches no audio hardware and never crashed.
     OUT — live dictation ("Dictate"): AVAudioEngine + installTap raises an
           ObjC exception Swift cannot catch. It crashed the app in 1.3.5. */

/* ---- the half that is IN ---- */
ok("first-party speech plugin declared", /"permission-speech": "file:native\/permission-speech"/.test(pkgRaw));
ok("the SPM-incompatible community plugin is still not used",
   !/@capacitor-community\/speech-recognition/.test(pkgRaw));
ok("plugin accessed through the guarded Capacitor.Plugins lookup",
   /Capacitor\.Plugins\.PermissionSpeech/.test(html));
ok("transcript textarea exists and is editable", /id="vTranscript"/.test(html) && /class="transcript"/.test(html));
ok("transcription runs on the finished file, on BOTH recorder paths",
   (html.match(/runTranscription\(/g) || []).length >= 3 && /transcribeFile/.test(html));
ok("the transcript is persisted on the voice entry",
   /type:"voice"[^}]*transcript:transcript/.test(html));
ok("the transcript is rendered in the entry viewer alongside the audio",
   /e\.transcript/.test(html) && /Transcript</.test(html));
ok("user edits to the transcript are not clobbered", /trUserEdited/.test(html));
ok("a stuck transcription times out rather than hanging", /TRANSCRIBE_TIMEOUT_MS/.test(html));
ok("first-use warm-up retry retained", /WARMUP_REASONS/.test(html) && /LSK_STT_OK/.test(html));
ok("transcripts saved by 1.3.x still travel with a shared voice note",
   /var body=tr \? \("Permission — "/.test(html));

/* ---- the half that is OUT: no Dictate control, no live listener ---- */
ok("the Dictate button is gone", !/id="vDictate"/.test(html));
ok("no Dictate control of any name is in the transcript header",
   /<div class="tr-head">\s*<div class="tr-lbl" id="trLabel">Transcript<\/div>\s*<\/div>/.test(html));
for (const sym of ["srStart", "srStop", "srAttach", "srDetach", "syncDictateBtn",
                   "startLive", "stopLive", "srListening", "srPartial", "srHandles",
                   "partialResults", "listeningState"]) {
  ok(`no live-dictation symbol "${sym}" in the app`, !new RegExp(`\\b${sym}\\b`).test(stripComments(html)), sym);
}
/* Scoped, not blanket: MediaQueryList.addListener is a legitimate legacy
   fallback elsewhere in the app. What must not exist is a listener on the
   SPEECH PLUGIN — those only ever carried live dictation partials, and the
   plugin no longer declares the method to the bridge at all. */
ok("nothing subscribes to the speech plugin",
   !/sr\.addListener|PermissionSpeech[\s\S]{0,80}?addListener/.test(stripComments(html)));
ok("no Web Speech API crept in as a replacement",
   !/webkitSpeechRecognition|window\.SpeechRecognition|new SpeechRecognition/.test(stripComments(html)));
ok("no live-dictation-only failure copy remains",
   !/"mic-busy":|"no-audio-input":|"engine-failed":|"already-listening":|"input-unavailable":/.test(html));

/* ---- the crash APIs are absent from the native plugin, not merely unused ---- */
ok("the plugin has NO audio engine", !/AVAudioEngine/.test(pluginCode));
ok("the plugin never installs a tap (the uncatchable ObjC raise)", !/installTap/.test(pluginCode));
ok("the plugin has no live buffer request", !/SFSpeechAudioBufferRecognitionRequest/.test(pluginCode));
ok("the plugin exposes no live methods", !/func startLive|func stopLive|func teardownLive/.test(pluginCode));
ok("the bridge does not even declare a live method to JS",
   !/CAPPluginMethod\(name: "startLive"|CAPPluginMethod\(name: "stopLive"|CAPPluginMethod\(name: "addListener"/.test(pluginSrc));
ok("the plugin never mutates the shared audio session",
   !/setCategory|setActive/.test(pluginCode));
ok("the plugin never requests the microphone (the recorder owns it)",
   !/requestRecordPermission|AVAudioApplication\.requestRecordPermission/.test(pluginCode));

/* ---- the plugin is still built the way that makes it un-droppable ---- */
ok("our plugin HAS a Package.swift (the thing that was missing in 1.3.0-1.3.2)",
   fs.existsSync(path.join(ROOT, "native/permission-speech/Package.swift")));
ok("it declares an SPM library target", /\.library\(\s*name: "PermissionSpeech"/.test(pluginPkg));
ok("source sits where SPM expects it", /path: "ios\/Sources\/PermissionSpeechPlugin"/.test(pluginPkg));
ok("registered via CAPBridgedPlugin (pure Swift, no ObjC macro)",
   /CAPBridgedPlugin/.test(pluginSrc) && /jsName = "PermissionSpeech"/.test(pluginSrc));
ok("every JS-called method is declared to the bridge",
   ["diagnostics","checkPermissions","requestPermissions","transcribeFile"]
     .every((m) => new RegExp(`CAPPluginMethod\\(name: "${m}"`).test(pluginSrc)));
ok("checkPermissions is an override", /@objc override public func checkPermissions/.test(pluginSrc));
ok("requestPermissions is an override", /@objc override public func requestPermissions/.test(pluginSrc));
ok("file transcription uses SFSpeechURLRecognitionRequest", /SFSpeechURLRecognitionRequest/.test(pluginSrc));
ok("speech authorization is actually requested", /SFSpeechRecognizer\.requestAuthorization/.test(pluginSrc));
ok("a real type-check harness is committed",
   fs.existsSync(path.join(ROOT, "native/permission-speech/typecheck/run.sh")) &&
   fs.existsSync(path.join(ROOT, "native/permission-speech/typecheck/CapacitorStubs.swift")));
ok("the build runs that type-check before xcodebuild",
   /typecheck\/run\.sh/.test(cm) && /does not type-check/.test(cm));

/* ---- the build enforces both halves ---- */
ok("build BLOCKS unless the plugin is in the GENERATED SPM manifest",
   /CapApp-SPM\/Package\.swift/.test(cm) && /PermissionSpeech is NOT in/.test(cm));
ok("build checks the artefact, not node_modules", !/node_modules\/@capacitor-community/.test(cm));
ok("build BLOCKS if live dictation returns to the native plugin",
   /"AVAudioEngine", "installTap", "SFSpeechAudioBufferRecognitionRequest"/.test(cm) &&
   /"startLive", "stopLive", "setCategory", "setActive"/.test(cm) &&
   /BLOCKED: live dictation is back/.test(cm));
ok("build BLOCKS if a Dictate control returns to the web app",
   /'id="vDictate"', "startLive", "stopLive", "partialResults"/.test(cm));
/* A naive grep flags the doc comments that explain WHY these APIs are banned,
   so it would fail every build until someone deleted the explanation. */
ok("the guard reads code, not the comments that name the banned APIs",
   /Grep the CODE, not the prose/.test(cm) &&
   /l\.lstrip\(\)\.startswith\("\/\/"\)/.test(cm));
ok("build BLOCKS if the transcript panel or transcriber goes missing",
   /never calls the transcriber/.test(cm) && /transcript panel is missing/.test(cm));

/* ---- on-device only, as before ---- */
ok("on-device flag forced on the file request",
   /SFSpeechURLRecognitionRequest[\s\S]{0,400}?requiresOnDeviceRecognition = true/.test(pluginSrc));
ok("if on-device is unavailable it REFUSES rather than using the network",
   /supportsOnDeviceRecognition/.test(pluginSrc) && /"reason": "no-on-device"/.test(pluginSrc));
ok("no server-recognition fallback exists",
   !/requiresOnDeviceRecognition = false/.test(pluginCode) && !/server/i.test(pluginCode));
ok("the build refuses a server fallback too",
   /requiresOnDeviceRecognition = true is missing/.test(cm) &&
   /a server-recognition fallback was introduced/.test(cm));
ok("the UI explains that refusal honestly", /won.t send your audio anywhere/.test(html));
ok("no network APIs introduced", !/fetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(html));

/* ---- failure is never silent ---- */
ok("a visible 'Transcribing…' state exists", /Transcribing on this phone/.test(html));
ok("success states that the audio stayed on device", /The audio never left your device/.test(html));
ok("failures render as 'Transcription unavailable — <reason>'", /Transcription unavailable — /.test(html));
for (const reason of ["permission-denied", "no-on-device", "recognizer-unavailable",
                      "no-speech", "recognition-failed", "timeout", "unsupported"]) {
  ok(`reason "${reason}" has human copy`, new RegExp(`"${reason}":`).test(html));
}
ok("a missing native engine is named, not silent",
   /engine: none/.test(html) && /function renderDiag/.test(html));
ok("the diagnostic line stays hidden while everything is healthy",
   /if\(!bad\)\{ diagHide\(\); return; \}/.test(html));

section("8b) v1.5.0 — RECORDING itself is untouched");
ok("the record button and its handler are intact",
   /id="recBtn"/.test(html) && /\$\("recBtn"\)\.addEventListener\("click", toggleRecord\)/.test(html));
ok("both recorder paths survive (native plugin + MediaRecorder fallback)",
   /capacitor-voice-recorder/.test(pkgRaw) && /vp\.startRecording\(\)/.test(html) &&
   /new MediaRecorder\(/.test(html));
ok("the microphone is still requested by the recorder itself",
   /vp\.requestAudioRecordingPermission\(\)/.test(html) &&
   /getUserMedia\(\{audio:true\}\)/.test(html));
ok("audio is still saved as a Blob on the entry", /audio:recBlob/.test(html) && /duration:recSeconds/.test(html));
ok("playback after recording still appears", /id="playbackWrap"/.test(html) && /\$\("playback"\)\.src/.test(html));
ok("a failed recording explains itself in the recorder's own words",
   /That recording couldn.t be read/.test(html));
/* Ordering is enforced by CONTROL FLOW now, not by where the lines sit: the
   only caller of takeFinished() on this path is mediaRec.onstop, and it stops
   every track before calling it. Assert that shape inside the handler. */
ok("transcription never runs while the recorder holds the microphone",
   /mediaRec\.onstop=function\(\)\{[\s\S]{0,600}?recStream\.getTracks\(\)\.forEach\(function\(t\)\{t\.stop\(\);\}\);[\s\S]{0,200}?takeFinished\(/.test(html));
ok("the Voice|Video switch still works", /id="speakSeg"/.test(html) && /function setSpeakMode/.test(html));
ok("mic denial still leaves the rest of the app usable",
   /You can still write or draw an entry/.test(html));
ok("saving is not blocked by anything that was removed", !/if\(!transcript\)/.test(html));

section("8c) v1.6.0 — the mic PAUSES a take; it never ends or wipes one");
/* The bug: stop-then-start began a brand new recording, silently discarding
   the audio and the transcript. The fix is a real MediaRecorder pause/resume,
   so one take is one continuous session and one valid file. */
ok("there is an explicit take state machine",
   /var recState="idle"/.test(html) && /function recSetState/.test(html));
ok("the mic button dispatches on state and never stops a take",
   /function toggleRecord\(\)\{[\s\S]{0,400}?if\(recState==="recording"\)\{ pauseTake\(\); return; \}/.test(html) &&
   /if\(recState==="paused"\)\{ resumeTake\(\); return; \}/.test(html));
ok("pause is a REAL MediaRecorder pause, not a stop in disguise",
   /mediaRec\.pause\(\)/.test(html) && /mediaRec\.resume\(\)/.test(html));
ok("pause verifies the recorder actually paused before saying so",
   /if\(mediaRec\.state!=="paused"\)\{ toast/.test(html));
ok("a platform that cannot pause keeps RECORDING rather than discarding",
   /Pause isn.t available here/.test(html) && /recording is still going/.test(html));
ok("every chunk of the take lands in the SAME array across pauses",
   /Every chunk of the take lands in the SAME array/.test(html) &&
   !/mediaRec\.onstop[\s\S]{0,300}?chunks=\[\]/.test(html));
ok("only Done stops the recorder", /function finishTake\(\)\{[\s\S]{0,400}?mediaRec\.stop\(\)/.test(html));
ok("Done and Start over exist as their own controls",
   /id="recDone"/.test(html) && /id="recRestart"/.test(html) &&
   /\$\("recDone"\)\.addEventListener\("click", finishTake\)/.test(html) &&
   /\$\("recRestart"\)\.addEventListener\("click", restartTake\)/.test(html));
ok("Start over is the ONLY thing that clears a take",
   /function restartTake\(\)\{[\s\S]{0,300}?chunks=\[\]/.test(html));
ok("the mic is hidden once a take is finished, so it cannot be mistaken for one",
   /btn\.classList\.toggle\("hidden", next==="finished"\)/.test(html));
ok("paused has its own look, distinct from idle",
   /\.rec-btn\.paused\{/.test(html) && /btn\.classList\.toggle\("paused", next==="paused"\)/.test(html));
ok("the paused hint promises nothing is lost", /Paused — nothing is lost/.test(html));
ok("Save is enabled only for a finished take",
   /disableSave\(\$\("vSave"\), next!=="finished" \|\| !recBlob\)/.test(html));
/* Elapsed time is MEASURED. Counting 1s ticks made any segment shorter than a
   tick count as zero, so a take of several short bursts saved duration 0. */
ok("recorded time is measured, not counted in interval ticks",
   /function recElapsedMs\(\)\{ return recMs \+/.test(html) && !/recSeconds\+\+/.test(html));
ok("a paused segment is banked, and the clock stops with it",
   /if\(segStart\)\{ recMs \+= Date\.now\(\)-segStart; segStart=0; \}/.test(html));
ok("a real but sub-second take never saves duration 0",
   /if\(!recSeconds\) recSeconds=Math\.max\(1, Math\.round\(recElapsedMs\(\)\/1000\)\)/.test(html));
ok("the ten-minute cap now measures elapsed recorded time",
   /recElapsedMs\(\)>=REC_MAX_SECONDS\*1000/.test(html));
ok("the native recorder pauses through the plugin when it can",
   /function nativeCanPause/.test(html) && /vp\.pauseRecording\(\)/.test(html) && /vp\.resumeRecording\(\)/.test(html));
ok("leaving the screen mid-take ENDS it rather than abandoning a live recorder",
   /function stopRecord\(\)\{ if\(recState==="recording"\|\|recState==="paused"\) finishTake\(\); \}/.test(html));
/* The whole point: pausing the RECORDER has nothing to do with the removed
   live-dictation crash path, and must not smuggle it back. */
ok("pause/resume introduced no audio-engine or live-recognition API",
   !/AVAudioEngine|installTap|startLive|webkitSpeechRecognition/.test(stripComments(html)));
ok("transcription still runs exactly once, on the finished take",
   (html.match(/runTranscription\(/g) || []).length === 3 &&
   /function takeFinished[\s\S]{0,900}?runTranscription\(/.test(html));

section("8d) v1.7.0 — zero network: the typefaces are embedded");
/* The app used to fetch three families from a font CDN. That was the ONE thing
   it ever requested, and it forced the privacy policy to hedge. The policy now
   says outright that the app makes no network connections, so these assertions
   are what stops that from becoming a 5.1.1(i) misstatement. */
const htmlCode = stripComments(html);
ok("no font CDN host appears anywhere in the app", !/googleapis|gstatic/.test(html));
ok("nothing is loaded over http(s) — no link, script, media, url() or @import",
   !/<link\b[^>]*href=["']https?:/i.test(htmlCode) &&
   !/<script\b[^>]*src=["']https?:/i.test(htmlCode) &&
   !/<(?:img|video|audio|source|iframe)\b[^>]*src=["']https?:/i.test(htmlCode) &&
   !/url\(\s*["']?https?:/i.test(htmlCode) &&
   !/@import\s+(?:url\()?["']https?:/i.test(htmlCode));
ok("the typefaces are embedded as data URIs",
   /@font-face/.test(html) && /data:font\/woff2;base64,/.test(html));
ok("all three families are present",
   ["Caveat","Oswald","Poppins"].every((f) => new RegExp(`font-family:'${f}'`).test(html)));
/* Caveat and Oswald are variable fonts: Google answers four discrete weights
   with four rules pointing at ONE file. Embedding it four times would quadruple
   it for no visual difference, so each is declared with a weight RANGE. */
ok("the variable faces are embedded once, with a weight range",
   /font-family:'Oswald';font-style:normal;font-weight:400 700/.test(html) &&
   /font-family:'Caveat';font-style:normal;font-weight:600 700/.test(html));
ok("only one copy of each variable file is embedded",
   (html.match(/font-family:'Oswald'/g) || []).length === 2 &&
   (html.match(/font-family:'Caveat'/g) || []).length === 1);
/* Poppins carries every word the user writes, so it must keep latin-ext or
   accented characters silently fall back to a system font. */
ok("Poppins keeps latin-ext, for accented characters in entries",
   (html.match(/font-family:'Poppins'/g) || []).length === 8);
ok("the regenerator is committed, so the embed is reproducible",
   fs.existsSync(path.join(ROOT, "scripts/build-embedded-fonts.py")));
ok("the licence of the embedded fonts is stated",
   /SIL Open Font License/.test(html) && /openfontlicense\.org/.test(html));
ok("a baseline of how the fonts RENDER is committed",
   fs.existsSync(path.join(ROOT, "test/font-baseline.json")));
ok("the no-network check is runnable and wired up",
   fs.existsSync(path.join(ROOT, "scripts/verify-no-network.mjs")) &&
   /verify:no-network/.test(pkgRaw));
ok("the build BLOCKS anything network-loaded creeping back",
   /BLOCKED: the app would fetch something over the network/.test(cm) &&
   /BLOCKED: the embedded typefaces are gone/.test(cm));
/* The old claim was hedged because it had to be. It no longer is. */
ok("the app still has zero network APIs", !/fetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(html));

section("9) v1.3 — Speak: video option");
ok("video pane + capture input present", /id="speakVideoPane"/.test(html) && /id="vidInput"/.test(html));
ok('video input uses a plain accept="video/*"', /accept="video\/\*"/.test(html));
/* capture="" forces the camera as the ONLY source, so on a device with no
   camera (or one blocked by Screen Time / MDM) iOS has no fallback and the
   picker dies. Check the <input> tags themselves — the word also appears in
   the comment that explains why we don't use it. */
ok('NO capture attribute on any file input (forces camera-only, dies with no camera)',
   !(html.match(/<input\b[^>]*>/g) || []).some((tag) => /\bcapture\s*=/.test(tag)));
ok("a real <video> element lives in the DOM for iOS capture/playback",
   /<video id="vidPlayback"/.test(html) && /playsinline/.test(html));
ok("video entries are saved, viewed, and exported",
   /type:"video"/.test(html) && /e\.type==="video"/.test(html));
ok("oversized videos are refused with a message, not a crash", /MAX_VIDEO_BYTES/.test(html));
ok("cancelling the picker is a no-op", /if\(!f\)\{ return; \}/.test(html));

section("11) v1.3 — Info.plist usage strings for every new capability");
for (const key of [
  "NSMicrophoneUsageDescription",
  "NSCameraUsageDescription",
  "NSPhotoLibraryUsageDescription",
  "NSFaceIDUsageDescription",
]) {
  ok(`${key} set in codemagic.yaml`, new RegExp(key).test(cm));
}
ok("usage strings are printed back so the build log proves they landed",
   /Print :\$K/.test(cm));
ok("build FAILS if a usage string is missing", /BLOCKED: a required usage string is missing/.test(cm));
ok("usage strings name the app and the reason (not 'we need access')",
   /Permission uses the camera only so you can record/.test(cm));
/* 1.5.0: transcription is back, so the permission it needs must be declared.
   iOS hard-CRASHES (SIGABRT) the instant an app touches SFSpeechRecognizer
   with no matching usage string — a missing key here is a shipped crash. */
ok("the speech usage string is set again", /setkey NSSpeechRecognitionUsageDescription/.test(cm));
ok("it is in the required-keys readback loop, so a miss FAILS the build",
   /for K in NSMicrophoneUsageDescription NSSpeechRecognitionUsageDescription/.test(cm));
ok("the string says transcription is on-device and nothing is uploaded",
   /on-device speech recognition/.test(cm) && /never uploaded/.test(cm));
ok("the build blocks a returning DICTATE control",
   /'id="vDictate"', "startLive", "stopLive", "partialResults"/.test(cm) &&
   /BLOCKED: live dictation is back/.test(cm));
ok("the build still proves the recorder survived", /the record button is gone/.test(cm));

section("12) v1.5.0 — the privacy promise is still literal");
ok("the only recogniser is on-device, and refuses rather than uploading",
   /requiresOnDeviceRecognition = true/.test(pluginSrc) &&
   /"reason": "no-on-device"/.test(pluginSrc) &&
   !/requiresOnDeviceRecognition = false/.test(pluginCode));
ok("recordings still cannot be written to Photos",
   !/NSPhotoLibraryAddUsageDescription *[:=]/.test(cm));
ok("no network calls anywhere in the app",
   !/fetch\(["'`]https?:/.test(html) && !/XMLHttpRequest\(\)[\s\S]{0,80}https?:/.test(html));

section("13) v1.3 — Notebook canvas sized to the screen, exports above the fold");
ok("canvas height is measured, not a fixed ratio", /function nbHeightFor/.test(html) && /function nbSpace/.test(html));
ok("measurement subtracts the export row", /nbExportRow/.test(html));
ok("export row has the id the measurement needs", /id="nbExportRow"/.test(html));
ok("BOTH export controls kept", /id="nbExportPage"/.test(html) && /id="nbExportPdf"/.test(html));
ok("page scroll is locked only while the notebook fits", /nb-open/.test(html) && /nbApplyScrollLock/.test(html));
ok("scroll lock is released when leaving the notebook",
   /id!=="notebook"\) document\.body\.classList\.remove\("nb-open"\)/.test(html));
ok("canvas refits on resize AND orientation change", /orientationchange/.test(html) && /nbFit/.test(html));
ok("stored pages keep their aspect ratio when the canvas shape changes",
   /Math\.min\(cw\/iw, ch\/ih\)/.test(html));
ok("a minimum canvas height is enforced", /NB_MIN_H/.test(html));

/* ============================================================ */
section("14) v1.3 — iPad / large screen (Guideline 4 'designed for iPad')");
/* The audit greps for a min-width between 620 and 899 — below that it is a
   phone breakpoint, above it would miss iPad mini portrait (744pt). */
const bigMq = html.match(/@media *\( *min-width: *(\d+)px *\)/g) || [];
ok("a large-screen @media block exists", bigMq.length > 0);
ok("its breakpoint is in the iPad range the gate requires (620–899)",
   bigMq.some((m) => { const n = +m.match(/(\d+)px/)[1]; return n >= 620 && n <= 899; }),
   bigMq.join(" "));
ok("body widens past the 540px phone column on iPad",
   /@media[^{]*min-width: *7\d\dpx[^{]*\{[\s\S]{0,600}?body\{max-width:9\d\dpx/.test(html));
ok("home becomes a two-column grid on iPad", /#v-home\.active\{display:grid/.test(html));
ok("grid rows are assigned explicitly (auto-flow can't reshuffle)",
   /#v-home \.greet\s*\{grid-column:1 \/ -1; grid-row:1;\}/.test(html) &&
   /#v-home #homeList\{grid-column:2/.test(html));
ok("editors keep a reading measure instead of stretching full width",
   /#v-text, #v-voice, #v-draw, #v-entry, #v-journal\{max-width:7\d\dpx/.test(html));
ok("notebook is NOT width-capped on iPad (more width = more paper)",
   !/#v-notebook\{max-width/.test(html));
ok("settings sheet is centred at panel width, transform untouched",
   /\.sheet\{max-width:6\d\dpx; margin-left:auto/.test(html));
ok("onboarding logo is excluded from the column constraint",
   /#onboard > \*:not\(\.ob-logo\)/.test(html));
ok("home preview count adapts to screen size", /function homePreviewCount/.test(html) && /matches \? 6 : 3/.test(html));
ok("crossing the breakpoint re-renders the preview (Split View / Slide Over)",
   /addEventListener\("change", onBreakpoint\)/.test(html));
ok("no feature is hidden by screen size — layout only",
   !/@media[^{]*min-width[^{]*\{[\s\S]{0,3000}?(display:none *!important|visibility:hidden)/.test(
      html.slice(html.indexOf("iPAD / LARGE SCREEN"))));

section("15) v1.3 — App Store assets");
const iconPath = path.join(ROOT, "appicon-1024.png");
ok("appicon-1024.png exists at repo root", fs.existsSync(iconPath));
if (fs.existsSync(iconPath)) {
  const buf = fs.readFileSync(iconPath);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), colorType = buf[25];
  ok("app icon is exactly 1024x1024", w === 1024 && h === 1024, `${w}x${h}`);
  /* PNG colour types 4 and 6 carry an alpha channel; Apple rejects an app
     icon with transparency. */
  ok("app icon has NO alpha channel (Apple rejects it)", colorType !== 4 && colorType !== 6,
     `colorType=${colorType}`);
}
ok("build regenerates the icon from appicon-1024.png", /cp appicon-1024\.png assets\/icon\.png/.test(cm));
ok("build references AppIcon.appiconset", /AppIcon\.appiconset/.test(cm));
ok("build FAILS rather than shipping the Capacitor placeholder",
   /the Capacitor placeholder would ship/.test(cm) && /that is a placeholder, not the real artwork/.test(cm));

/* Screenshots must exist at the EXACT pixel sizes ASC expects — a wrong size
   is a hard upload rejection, and a stale one is the 2.3.3 that hit 1.2. */
const SLOTS = { iphone69: [1290, 2796], iphone65: [1242, 2688], ipad13: [2048, 2732] };
for (const [slot, [ew, eh]] of Object.entries(SLOTS)) {
  const dir = path.join(ROOT, "screenshots", slot);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".png")) : [];
  ok(`${slot}: screenshots rendered`, files.length > 0, `${files.length} file(s)`);
  const bad = files.filter((f) => {
    const b = fs.readFileSync(path.join(dir, f));
    return b.readUInt32BE(16) !== ew || b.readUInt32BE(20) !== eh;
  });
  ok(`${slot}: every shot is exactly ${ew}x${eh}`, files.length > 0 && bad.length === 0, bad.join(", "));
}
ok("iPad 13\" screenshots present (hard upload block without them)",
   fs.existsSync(path.join(ROOT, "screenshots/ipad13")) &&
   fs.readdirSync(path.join(ROOT, "screenshots/ipad13")).some((f) => f.endsWith(".png")));
ok("screenshot renderer is committed so shots can be re-rendered per build",
   fs.existsSync(path.join(ROOT, "scripts/render-screenshots.mjs")));

/* ============================================================ */
section("16) v1.3.1 — header Notebook shortcut removed");
ok("no #btnNotebook element", !/id="btnNotebook"/.test(html));
ok("no listener bound to it either", !/\$\("btnNotebook"\)/.test(html));
ok("header keeps only Settings + Lock",
   /id="btnSettings"/.test(html) && /id="btnLock"/.test(html));
ok("Notebook still reachable from the home card",
   /id="cardNotebook"/.test(html) && /\$\("cardNotebook"\)\.addEventListener\("click", openNotebook\)/.test(html));

section("17) v1.3.1 — 'Speak' renamed to 'Record'");
ok('home mode card reads "Record"', /<div class="nm">Record<\/div>/.test(html));
ok("its subtitle covers both media", /<div class="dsc">voice or video<\/div>/.test(html));
ok('editor title reads "Record"', /<div class="ttl serif">Record<\/div>/.test(html));
ok("empty state says Write, Record, or Draw", /then Write, Record, or Draw\./.test(html));
ok("no user-visible 'Speak' label left",
   !/<div class="nm">Speak<\/div>/.test(html) &&
   !/<div class="ttl serif">Speak<\/div>/.test(html) &&
   !/Write, Speak, or Draw/.test(html));
/* "Speak it gently to this page" is a journal prompt, not a label — it stays. */
ok("the journal prompt that uses the word 'Speak' is untouched",
   /Speak it gently to this page/.test(html));

section("18) v1.3.1 — recordings stay INSIDE the app");
ok("no camera / photo-library plugin is even installed",
   !/@capacitor\/camera|capacitor-plugin-camera|photo-library|@capacitor-community\/media/.test(pkgRaw));
ok("no Photos-write API anywhere in the app",
   !/savePhoto|saveToGallery|CameraRoll|writePhoto|UISaveVideo|PhotoLibraryAdd/.test(html));
/* Without NSPhotoLibraryAddUsageDescription iOS will not let the app add
   anything to Photos at all — the guarantee is enforced by the OS. */
ok("NSPhotoLibraryAddUsageDescription is NOT set", !/NSPhotoLibraryAddUsageDescription *[:=]/.test(cm));
ok("the build FAILS if that key ever appears",
   /Print :NSPhotoLibraryAddUsageDescription/.test(cm) &&
   /must never be able to write to the photo library/.test(cm));
ok("audio + video entries are stored as Blobs in IndexedDB",
   /audio:recBlob/.test(html) && /video:vidBlob/.test(html) && /indexedDB\.open\("awaken_db"/.test(html));
ok("the only filesystem write is the app's own CACHE, for an explicit share",
   (html.match(/writeFile\(/g) || []).length === 1 && /directory:"CACHE"/.test(html));
ok("that staging copy is deleted after sharing", /function cleanupCache/.test(html) && /deleteFile\(/.test(html));
ok("nothing shares automatically — every export sits behind a click",
   !/setTimeout[^)]*shareFile|setInterval[^)]*shareFile/.test(html));
ok("camera usage string states videos never reach Photos",
   /never added to your Photos library/.test(cm));

section("19) v1.3.1 — Draw: actions above the fold, scrolling leaves no ink");
ok("Discard + Save live in a bar ABOVE the canvas",
   html.indexOf('id="drawActions"') < html.indexOf('id="drawWrap"'));
ok("both actions are in that bar", /id="drawActions"[\s\S]{0,400}?data-discard="1"[\s\S]{0,400}?id="dSave"/.test(html));
ok("the bar also holds the draw controls", /id="drawBar"[\s\S]{0,200}?id="drawTools"/.test(html));
ok("draw canvas is measured to fit the screen", /function drawHeightFor/.test(html) && /canvasSpace\("drawWrap", \[\]\)/.test(html));
ok("fit + scroll-lock helpers exist", /function drawFit/.test(html) && /function drawApplyScrollLock/.test(html));
ok("scroll is locked while Draw fits", /body\.nb-open, body\.draw-open\{overflow:hidden/.test(html));
ok("draw-open is cleared when leaving Draw", /if\(id!=="draw"\) document\.body\.classList\.remove\("draw-open"\)/.test(html));
ok("measurement helper is shared with the Notebook",
   /function canvasSpace/.test(html) && /function nbSpace\(\)\{ return canvasSpace\("nbWrap"/.test(html));
/* the two guards that keep a scroll from painting */
ok("a stroke is discarded if the page scrolls under it", /function abortStroke/.test(html) && /Math\.abs\(scrollPos\(\)-startScroll\)>2/.test(html));
ok("pointercancel ABORTS rather than finishing the stroke",
   /addEventListener\("pointercancel",abortStroke\)/.test(html));
ok("touchcancel does the same on the non-pointer path",
   /addEventListener\("touchcancel",abortStroke\)/.test(html));
ok("a scroll starting outside the canvas also kills an in-flight stroke",
   /addEventListener\("scroll", function\(\)\{\s*if\(drawing/.test(html));

section("20) v1.3.1 — kept intact (explicitly requested)");
ok("passcode lock on open still gates the app", /if\(hasPin\(\)\)\{ showLock\("enter"/.test(html) && /showLock\("set"/.test(html));
ok("passcode + Face ID storage keys unchanged", /"awaken_pin"/.test(html) && /"awaken_face"/.test(html));
ok("Settings still has passcode, website, theme + accent, erase",
   /id="setPin"/.test(html) && /id="setSite"/.test(html) &&
   /id="themeSeg"/.test(html) && /id="accentRow"/.test(html) && /id="setErase"/.test(html));
ok("writing section intact", /id="v-text"/.test(html) && /id="tSave"/.test(html) && /id="tChips"/.test(html));
ok("Jessica's headline link + jonathanscribbles footer both present",
   /SITE_URL="https:\/\/jessicaleighbiles\.com"/.test(html) && /MAKER_URL="https:\/\/jonathanscribbles\.com"/.test(html));
ok("notebook PNG + PDF exports still there", /id="nbExportPage"/.test(html) && /id="nbExportPdf"/.test(html));
ok("zero network APIs still hold",
   !/fetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(html));
/* exact version re-asserted in section 25 */
ok("version moved past 1.6.x", /APP_VERSION = "1\.7\.\d+"/.test(html));

/* ============================================================ */
section("25) v1.7.0 — nothing else changed");
ok("version bumped to 1.7.0", /APP_VERSION = "1\.7\.0"/.test(html) && />v1\.7\.0</.test(html) &&
   /CFBundleShortVersionString 1\.7\.0/.test(cm));
ok("package.json agrees", /"version": "1\.7\.0"/.test(pkgRaw));
/* The build-number scheme must stay monotonic and 12-digit: computing it from
   "latest visible in TestFlight + 1" deadlocks silently, every build green and
   nothing ever landing. */
ok("build number is a 12-digit UTC stamp, read back and asserted",
   /date -u \+%Y%m%d%H%M/.test(cm) && /is not a 12-digit stamp/.test(cm));
ok("build number is never derived from the latest visible build",
   !/get-latest-testflight-build-number/.test(cm));
ok("this lane still publishes to TestFlight ONLY",
   /submit_to_testflight: true/.test(cm) && !/^\s*submit_to_app_store: true/m.test(cm));
ok("header still has no Notebook icon", !/id="btnNotebook"/.test(html));
ok('Record label intact', /<div class="nm">Record<\/div>/.test(html) && /<div class="ttl serif">Record<\/div>/.test(html));
ok("voice entries saved with audio, duration AND transcript",
   /type:"voice"[\s\S]{0,200}?audio:recBlob/.test(html) && /transcript:transcript/.test(html));
ok("video entries intact", /type:"video"/.test(html) && /id="vidInput"/.test(html));
ok("Draw actions still above the canvas", html.indexOf('id="drawActions"') < html.indexOf('id="drawWrap"'));
ok("scroll-does-not-draw guards intact", /function abortStroke/.test(html) && /addEventListener\("pointercancel",abortStroke\)/.test(html));
ok("passcode lock + Settings + writing intact",
   /showLock\("enter"/.test(html) && /id="setPin"/.test(html) && /id="v-text"/.test(html));
ok("both links intact",
   /SITE_URL="https:\/\/jessicaleighbiles\.com"/.test(html) && /MAKER_URL="https:\/\/jonathanscribbles\.com"/.test(html));
ok("recordings still cannot reach Photos", !/NSPhotoLibraryAddUsageDescription *[:=]/.test(cm));

section("31) v1.4.0 — home options are one balanced 2x2 grid");
/* Notebook used to be a full-width .bigcard BELOW a 3-across row, which read
   as a different class of thing and left the row unbalanced. */
ok("the mode grid is two columns, not three", /\.modes\{display:grid; grid-template-columns:1fr 1fr;/.test(html));
ok("all four options are .mode tiles in ONE .modes container",
   /<div class="modes">[\s\S]*?class="mode write"[\s\S]*?class="mode speak"[\s\S]*?class="mode draw"[\s\S]*?class="mode notebook"[\s\S]*?<\/div>\s*<\/div>/.test(html));
ok("each tile has the same icon/name/description shape",
   (html.match(/<div class="mode [a-z]+"[^>]*>\s*<div class="ic">[\s\S]*?<div class="nm">[\s\S]*?<div class="dsc">/g) || []).length === 4);
ok("the stray full-width Notebook card is gone",
   !/class="bigcard"/.test(html) && !/\.bigcard\{/.test(html));
ok("Notebook keeps its own accent, matching the old card's icon",
   /\.mode\.notebook \.ic\{background:linear-gradient\(155deg,var\(--secondary\)/.test(html));
ok("Notebook still opens from its tile, and only from there",
   /id="cardNotebook"/.test(html) &&
   /\$\("cardNotebook"\)\.addEventListener\("click", openNotebook\)/.test(html) &&
   !/id="btnNotebook"/.test(html));
/* The .mode delegation used to end in a bare `else startDrawView()`. With a
   fourth .mode tile that would have opened Draw UNDERNEATH the Notebook. */
ok("the mode delegation is explicit, never a fall-through to Draw",
   /if\(mode==="text"\) startText\(\); else if\(mode==="voice"\) startVoice\(\); else if\(mode==="draw"\) startDrawView\(\);/.test(html));
ok("the Notebook tile carries NO data-mode, so the delegation ignores it",
   !/class="mode notebook"[^>]*data-mode/.test(html));
ok("iPad two-column layout no longer positions a .bigcard row",
   !/#v-home \.bigcard/.test(html));
ok("the tiles still occupy the iPad's left column", /#v-home \.modes\s*\{grid-column:1/.test(html));

section("29) v1.3.6 — dark-mode safe-area background");
const capCfg = fs.readFileSync(path.join(ROOT, "capacitor.config.json"), "utf8");
/* ios.contentInset "always" insets the WKWebView viewport away from the safe
   area, so even `position:fixed; inset:0` could not paint the home-indicator
   strip — what showed there was the native background, hardcoded to the LIGHT
   theme colour, i.e. a white bar in dark mode. */
ok('contentInset is "never" so the web layer paints edge to edge', /"contentInset"\s*:\s*"never"/.test(capCfg));
ok('contentInset "always" is gone', !/"contentInset"\s*:\s*"always"/.test(capCfg));
ok("viewport-fit=cover is set", /viewport-fit=cover/.test(html));
ok("html itself carries the themed background (not just body)",
   /\n  html\{[\s\S]{0,400}?linear-gradient\(180deg,var\(--bg\) 0%, var\(--bg2\) 100%\)/.test(html));
ok("html has a solid fallback colour for overscroll", /background-color:var\(--bg2\);/.test(html));
ok("html background is viewport-anchored so it lines up with body's",
   /\n  html\{[\s\S]{0,400}?background-attachment:fixed;/.test(html));
ok("no hardcoded white on the root", !/\n  html\{[\s\S]{0,400}?(#fff|#ffffff|white)/i.test(html));
ok("color-scheme follows the chosen theme",
   /:root\[data-theme="light"\]\{color-scheme:light;\}/.test(html) &&
   /:root\[data-theme="dark"\]\{color-scheme:dark;\}/.test(html));
ok("theme-color meta still tracks the theme", /tc\.setAttribute\("content", dark\?"#160512":"#FCE9F0"\)/.test(html));
ok("full-screen overlays stay themed", /#lock\{position:fixed; inset:0/.test(html) && /#onboard\{position:fixed; inset:0/.test(html));

/* ============================================================ */
console.log("\n" + "=".repeat(40));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
