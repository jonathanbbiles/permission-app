#!/usr/bin/env node
/* ============================================================================
   patch-ondevice-speech.mjs   —   runs automatically from `npm install`
                                   (package.json "postinstall")

   WHY THIS EXISTS
   ---------------
   Permission's whole promise, printed on its own home screen, is
   "your words never leave this phone". The privacy policy says the same.

   @capacitor-community/speech-recognition gives us SFSpeechRecognizer, but two
   things about it are wrong for this app, and both are patched here.

   PATCH A — force ON-DEVICE recognition
   -------------------------------------
   The plugin builds its recognition request WITHOUT setting
   `requiresOnDeviceRecognition`. That property defaults to `false`, which lets
   iOS send captured audio to Apple's speech servers whenever it feels like it.
   Shipping that while the app claims nothing leaves the device is a Guideline
   5.1.1(i) MISREPRESENTATION — the same rejection that hit Bull or Bust and
   Slow Burn. With it forced on, iOS transcribes locally or fails the task; it
   will NOT silently fall back to the network.

   PATCH B — add FILE-BASED transcription (`transcribeFile`)
   ---------------------------------------------------------
   THE 1.3.1 DEVICE BUG. The plugin only does LIVE microphone recognition: it
   spins up an AVAudioEngine and calls

       audioSession.setActive(true, options: .notifyOthersOnDeactivation)

   ...which THROWS when capacitor-voice-recorder's AVAudioRecorder is already
   holding the mic, and the plugin then rejects with "Microphone is already in
   use by another application." Recording a voice note therefore produced a
   perfect recording and no transcript at all, every time, on device — the two
   plugins were fighting over one microphone and one AVAudioSession.

   The fix is to stop competing for the mic entirely: record first, then run
   SFSpeechRecognizer over the SAVED AUDIO with an SFSpeechURLRecognitionRequest
   once the recorder has let go. Upstream has no such method, so we add one.

   `transcribeFile` never throws for expected conditions — it RESOLVES with
   {ok:false, reason:"..."} so the JS can show an honest reason instead of a
   silent nothing. It refuses to run at all if on-device recognition is not
   available, rather than quietly using the network.

   Exit codes: 0 = patched, or already patched, or plugin not installed.
               1 = plugin IS installed but could not be patched  → build fails,
                   which is what we want. A silent no-op here would ship either
                   the network path or the broken live-mic path.
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = path.join(ROOT, "node_modules/@capacitor-community/speech-recognition/ios/Plugin");
const SWIFT = path.join(BASE, "Plugin.swift");
const OBJC = path.join(BASE, "Plugin.m");

const MARKER_ONDEVICE = "PERMISSION_ON_DEVICE_ONLY";
const MARKER_FILE = "PERMISSION_FILE_TRANSCRIBE";

const log = (m) => console.log(`[on-device-speech] ${m}`);
function bail(msg) {
  console.error(`[on-device-speech] FAILED: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(SWIFT)) {
  log("speech-recognition plugin not installed — nothing to patch.");
  process.exit(0);
}

/* ---------------------------------------------------------------- PATCH A -- */
const ANCHOR_A = "self.recognitionRequest?.shouldReportPartialResults = partialResults";
const INJECT_A = `
            // ${MARKER_ONDEVICE} — patched by scripts/patch-ondevice-speech.mjs.
            // Keep transcription on the device: no audio to Apple's servers,
            // so the app's "never leaves this phone" promise stays literally true.
            if #available(iOS 13.0, *) {
                self.recognitionRequest?.requiresOnDeviceRecognition = true
            }`;

/* ---------------------------------------------------------------- PATCH B -- */
const ANCHOR_B_PROP = "private var recognitionTask: SFSpeechRecognitionTask?";
const INJECT_B_PROP = `
    // ${MARKER_FILE} — retained so the file recognition task is not deallocated
    private var fileRecognitionTask: SFSpeechRecognitionTask?`;

const ANCHOR_B_FUNC = "    @objc func start(_ call: CAPPluginCall) {";
const INJECT_B_FUNC = `    // ${MARKER_FILE} — added by scripts/patch-ondevice-speech.mjs.
    //
    // Transcribe an ALREADY-RECORDED clip. The live \`start()\` path above cannot
    // be used while capacitor-voice-recorder owns the microphone: its
    // setActive(true, .notifyOthersOnDeactivation) throws and the whole thing
    // rejects with "Microphone is already in use by another application."
    // Running over the finished file sidesteps the contention completely.
    //
    // Resolves {ok:false, reason} for every expected failure so the UI can say
    // WHY instead of showing nothing. Refuses to run unless on-device
    // recognition is available — it must never quietly use the network.
    @objc func transcribeFile(_ call: CAPPluginCall) {
        let language: String = call.getString("language") ?? "en-US"

        guard let b64 = call.getString("data"), !b64.isEmpty else {
            call.resolve(["ok": false, "reason": "no-audio"]); return
        }
        guard let audioData = Data(base64Encoded: b64), audioData.count > 0 else {
            call.resolve(["ok": false, "reason": "bad-audio"]); return
        }
        if SFSpeechRecognizer.authorizationStatus() != .authorized {
            call.resolve(["ok": false, "reason": "permission-denied"]); return
        }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)) else {
            call.resolve(["ok": false, "reason": "no-recognizer"]); return
        }
        if !recognizer.isAvailable {
            call.resolve(["ok": false, "reason": "recognizer-unavailable"]); return
        }
        var onDeviceOK = false
        if #available(iOS 13.0, *) { onDeviceOK = recognizer.supportsOnDeviceRecognition }
        if !onDeviceOK {
            // The offline model for this locale is not on the device. We do NOT
            // fall back to Apple's servers — that would break the privacy claim.
            call.resolve(["ok": false, "reason": "no-on-device"]); return
        }

        let ext: String = call.getString("ext") ?? "m4a"
        let tmpURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("permission-stt-\\(UUID().uuidString).\\(ext)")
        do {
            try audioData.write(to: tmpURL)
        } catch {
            call.resolve(["ok": false, "reason": "write-failed"]); return
        }

        let request = SFSpeechURLRecognitionRequest(url: tmpURL)
        request.shouldReportPartialResults = false
        if #available(iOS 13.0, *) { request.requiresOnDeviceRecognition = true }

        var settled = false
        func finish(_ payload: [String: Any]) {
            if settled { return }
            settled = true
            try? FileManager.default.removeItem(at: tmpURL)
            self.fileRecognitionTask = nil
            call.resolve(payload)
        }

        self.fileRecognitionTask = recognizer.recognitionTask(with: request) { (result, error) in
            if let error = error {
                finish(["ok": false, "reason": "recognition-failed", "detail": error.localizedDescription])
                return
            }
            guard let result = result else { return }
            if result.isFinal {
                let text = result.bestTranscription.formattedString
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty {
                    finish(["ok": false, "reason": "no-speech"])
                } else {
                    finish(["ok": true, "transcript": text, "onDevice": true])
                }
            }
        }
    }

${ANCHOR_B_FUNC}`;

const ANCHOR_M = "        CAP_PLUGIN_METHOD(available, CAPPluginReturnPromise);";
const INJECT_M = `${ANCHOR_M}
        CAP_PLUGIN_METHOD(transcribeFile, CAPPluginReturnPromise);   // ${MARKER_FILE}`;

/* ------------------------------------------------------------------ apply -- */
let swift = fs.readFileSync(SWIFT, "utf8");
let changed = false;

if (swift.includes(MARKER_ONDEVICE)) {
  log("A: already patched — on-device recognition forced.");
} else {
  if (!swift.includes(ANCHOR_A)) {
    bail(`anchor A not found in ${SWIFT}\n  Expected: ${ANCHOR_A}\n` +
      `  Without this patch, speech audio may be sent to Apple's servers while the\n` +
      `  app and its privacy policy claim nothing leaves the device (5.1.1(i)).`);
  }
  swift = swift.replace(ANCHOR_A, ANCHOR_A + "\n" + INJECT_A);
  changed = true;
  log("A: patched — requiresOnDeviceRecognition = true.");
}

if (swift.includes(MARKER_FILE)) {
  log("B: already patched — transcribeFile present.");
} else {
  if (!swift.includes(ANCHOR_B_PROP)) bail(`anchor B(prop) not found in ${SWIFT}`);
  if (!swift.includes(ANCHOR_B_FUNC)) bail(`anchor B(func) not found in ${SWIFT}`);
  swift = swift.replace(ANCHOR_B_PROP, ANCHOR_B_PROP + INJECT_B_PROP);
  swift = swift.replace(ANCHOR_B_FUNC, INJECT_B_FUNC);
  changed = true;
  log("B: patched — transcribeFile (file-based, on-device) added.");
}

if (changed) fs.writeFileSync(SWIFT, swift);

/* register the new method with Capacitor, or JS can never call it */
if (!fs.existsSync(OBJC)) bail(`${OBJC} missing — cannot register transcribeFile`);
let objc = fs.readFileSync(OBJC, "utf8");
if (objc.includes("transcribeFile")) {
  log("M: already registered.");
} else {
  if (!objc.includes(ANCHOR_M)) bail(`anchor M not found in ${OBJC}`);
  objc = objc.replace(ANCHOR_M, INJECT_M);
  fs.writeFileSync(OBJC, objc);
  log("M: registered transcribeFile with the Capacitor bridge.");
}

/* verify by re-reading, rather than trusting the writes */
const swiftNow = fs.readFileSync(SWIFT, "utf8");
const objcNow = fs.readFileSync(OBJC, "utf8");
if (!swiftNow.includes("requiresOnDeviceRecognition = true")) bail("on-device flag did not land.");
if (!swiftNow.includes("@objc func transcribeFile")) bail("transcribeFile did not land.");
if (!objcNow.includes("CAP_PLUGIN_METHOD(transcribeFile")) bail("transcribeFile is not registered.");
log("verified — on-device flag + file transcription both present and registered.");
