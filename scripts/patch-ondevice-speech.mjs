#!/usr/bin/env node
/* ============================================================================
   patch-ondevice-speech.mjs   —   runs automatically from `npm install`
                                   (package.json "postinstall")

   WHY THIS EXISTS
   ---------------
   Permission's whole promise, printed on its own home screen, is
   "your words never leave this phone". The privacy policy says the same.

   @capacitor-community/speech-recognition builds its
   SFSpeechAudioBufferRecognitionRequest WITHOUT setting
   `requiresOnDeviceRecognition`. That property defaults to `false`, which
   lets iOS send captured audio to Apple's speech servers whenever it feels
   like it (older device, unsupported locale, or just its own heuristics).

   Shipping that while the app claims nothing leaves the device is a
   Guideline 5.1.1(i) MISREPRESENTATION — the same rejection that hit Bull or
   Bust and Slow Burn, both of which had an honest "offline" policy and then
   quietly added a network path. The policy is never in the diff, so nobody
   notices until review does.

   So we force it on. With `requiresOnDeviceRecognition = true`, iOS either
   transcribes locally or fails the task outright — it will NOT silently fall
   back to the network. A failed task surfaces in the app as "no transcript",
   which is the correct, honest outcome.

   This is deliberately a build-time source patch rather than a fork: it is
   three lines, it is verifiable (the codemagic build greps for the marker and
   FAILS if it is absent), and it disappears the moment upstream exposes the
   option itself.

   Exit codes: 0 = patched, or already patched, or plugin not installed.
               1 = plugin IS installed but could not be patched  → build fails,
                   which is what we want. A silent no-op here would ship the
                   very network path this file exists to prevent.
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(
  ROOT,
  "node_modules/@capacitor-community/speech-recognition/ios/Plugin/Plugin.swift"
);

const MARKER = "PERMISSION_ON_DEVICE_ONLY";
const ANCHOR = "self.recognitionRequest?.shouldReportPartialResults = partialResults";
const INJECT = `
            // ${MARKER} — patched by scripts/patch-ondevice-speech.mjs.
            // Keep transcription on the device: no audio to Apple's servers,
            // so the app's "never leaves this phone" promise stays literally true.
            if #available(iOS 13.0, *) {
                self.recognitionRequest?.requiresOnDeviceRecognition = true
            }`;

function log(msg) {
  console.log(`[on-device-speech] ${msg}`);
}

if (!fs.existsSync(PLUGIN)) {
  // Plugin not installed (e.g. a docs-only checkout). Nothing to protect.
  log("speech-recognition plugin not installed — nothing to patch.");
  process.exit(0);
}

let src = fs.readFileSync(PLUGIN, "utf8");

if (src.includes(MARKER)) {
  log("already patched — on-device recognition is forced.");
  process.exit(0);
}

if (!src.includes(ANCHOR)) {
  console.error(
    `[on-device-speech] FAILED: anchor line not found in\n  ${PLUGIN}\n` +
      `  Expected: ${ANCHOR}\n` +
      `  The plugin's iOS source changed. Do NOT ship until this is re-pointed —\n` +
      `  without the patch, speech audio may be sent to Apple's servers while the\n` +
      `  app and its privacy policy claim nothing leaves the device (Guideline 5.1.1(i)).`
  );
  process.exit(1);
}

src = src.replace(ANCHOR, ANCHOR + "\n" + INJECT);
fs.writeFileSync(PLUGIN, src);

// Re-read and confirm, rather than trusting the write.
if (!fs.readFileSync(PLUGIN, "utf8").includes(MARKER)) {
  console.error("[on-device-speech] FAILED: patch did not land.");
  process.exit(1);
}

log("patched — requiresOnDeviceRecognition = true.");
