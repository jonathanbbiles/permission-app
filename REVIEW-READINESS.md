# Permission — Apple Review Readiness record

**Version:** 1.3.0 (Speak transcripts + video; Notebook canvas resize)
**Date:** 2026-08-07
**Gate run:** `scripts/apple-review-audit.sh` (canonical copy, App Builder Template)

## VERDICT: **NOT SUBMITTABLE — and not being submitted.**

This build goes to **TestFlight only**, for on-device testing. `submit_to_app_store`
stays commented out in `codemagic.yaml`.

Three §A blockers remain. **All three pre-date this release** (verified against
`HEAD`: zero `@media` queries and no `appicon-1024.png` before these changes) and
all three are *submission*-stage, not *TestFlight*-stage.

---

## §A — MECHANICAL

### PASS

| Area | Result |
|---|---|
| A1 · usage strings vs. the APIs that need them | **PASS** — camera, photo library, microphone, speech, Face ID all set in `codemagic.yaml`, each printed back individually so the build log proves it landed; the build **fails** if any is missing |
| A1 · `capture=` attribute | **PASS** — no `capture` on any file input |
| A2 · dead controls | **PASS** — 32 interactive ids, all driven |
| A2 · "coming soon" / demo copy | **PASS** — none |
| A2 · remote `<script src>` | **PASS** — none |
| A3 · IAP | **PASS** — no IAP surface; review notes must say "no in-app purchases" |
| A4b · third-party media / brands | **PASS** |
| A5 · safe-area, viewport-fit, no fake device chrome | **PASS** |
| A6 · both external links reachable (200) | **PASS** — jessicaleighbiles.com, jonathanscribbles.com |
| A6 · privacy claim vs. actual behaviour | **PASS** — see below |
| A7 · export compliance pre-answered | **PASS** |

### A6 — the privacy claim is now literally true, and greppable

This release adds speech recognition, which is exactly the shape of change that
created the 5.1.1(i) misrepresentations in Bull or Bust and Slow Burn: an honest
"nothing leaves your device" policy, plus a new feature that quietly transmits.

Two things were done so the claim holds:

1. **On-device recognition is forced.**
   `@capacitor-community/speech-recognition` does **not** set
   `requiresOnDeviceRecognition`, and the default (`false`) lets iOS ship captured
   audio to Apple's servers. `scripts/patch-ondevice-speech.mjs` (wired to
   `postinstall`) sets it to `true`, so iOS transcribes locally **or fails the
   task** — it will not silently fall back to the network. The build **verifies
   the patch and refuses to build without it**.
2. **The app now contains zero request APIs.** The one remaining `fetch()` (used
   to turn a drawing's `data:` URL into a Blob) was replaced with a direct decode.
   `grep -c "fetch(\|XMLHttpRequest\|WebSocket\|sendBeacon" www/index.html` → **0**.
   That also removes a real WKWebView hazard: `fetch()` does not work against
   `capacitor://`.

The privacy policy (`docs/privacy.html`) was updated in the same commit with new
**Speech to text** and **Camera and video** sections and a new effective date.

> ⚠️ The script scans `www/` and repo metadata only. It **cannot** see the
> **published** privacy page, the **ASC privacy declaration**, or reviewer notes.
> Before any submission, all four must be re-checked by hand — the published page
> still needs the two new sections copied to it.

### BLOCKED (pre-existing — must be cleared before submit, not before TestFlight)

1. **Universal build with no large-screen media query.** `npx cap add ios` defaults
   to Universal (1,2), so Apple reviews this on iPad, where it renders as a
   floating phone-width card → Guideline 4 "not designed for iPad".
   *Fix options: add an iPad layout, or set `TARGETED_DEVICE_FAMILY = 1`.*
2. **No 2048×2732 iPad screenshots.** Hard upload block while the build is Universal.
3. **No `appicon-1024.png` at repo root.** (`assets/icon.png` is 1024×1024 but not
   where the lane looks.)

### CHECK (verified by hand this run)

- `segVoice` / `segVideo` are reported as "never referenced in JS" — they are
  driven by a delegated `querySelectorAll("#speakSeg button")` handler. **Tapped
  both in the browser; both switch panes correctly.**
- No privacy-policy URL inside `www/` — the policy lives in `docs/`. Publish to
  `jonathanbbiles.github.io/app-privacy` and link it before submit.

---

## §B — JUDGEMENT PASS

- **2.3 — nothing advertised that isn't in the build.** The new features are
  additive; the listing does not yet mention transcripts or video. If the ASC
  description/What's New is updated to mention them, both must be demonstrably
  present (they are).
- **Screenshots.** Live screenshots still show 1.2. The Notebook layout changed
  visibly in this release. **Re-render and re-publish before submit** — a stale
  screenshot is what took the 2.3.3 on Permission 1.2.
- **Age rating** unchanged (intimacy/desire content → 17+ stands).
- **No mocks, no dead ends.** Transcript and video both persist real data to
  IndexedDB and render back in the viewer; verified end-to-end in-browser.

---

## §C — TESTFLIGHT ON-DEVICE SMOKE TEST — **MANDATORY, NOT YET DONE**

**This is the gate. None of the below exists in a browser or a simulator.** What
was verified in-browser (layout measurements, storage round-trip, no console
errors) proves the *repo* is clean, never that the *build* is.

Run on a real iPhone from a clean install:

1. **Cold launch from a clean install** (delete the app first).
2. **Speak → Voice.** Record. Confirm the transcript fills in *while recording*.
   ⚠️ **This is the #1 thing to check.** The recorder (`AVAudioRecorder`) and
   speech recognition (`AVAudioEngine` input tap) both want the microphone and
   both call `setCategory`/`setActive` on the shared audio session. If they
   conflict on device, **the recording still works and the transcript comes back
   empty** — that is the designed failure, not a crash. If that happens, the
   **Dictate** button is the fallback path and must be used instead.
3. **Long recording (> 1 min).** iOS caps a single recognition task around a
   minute; confirm the transcript keeps going (auto-restart) rather than stopping.
4. **Edit the transcript**, then save. Confirm the edit survives and is not
   overwritten by late recognition results.
5. **Speak → Video.** Confirm the action sheet offers **Record Video** *and*
   **Photo Library**. Record one, play it back, save, reopen from the journal.
6. **Deny every permission on a second clean install** — microphone, speech,
   camera, photos. Confirm: no crash, the app stays usable, and each denial says
   something useful. (A missing usage string here is a `SIGABRT`, not a prompt.)
7. **Notebook.** Confirm **Page PNG** and **Export PDF** are both visible without
   scrolling, on the smallest device you have. Confirm the canvas is bigger than
   in 1.2. Draw, add pages, rotate the device, confirm nothing is lost.
8. **Existing 1.2 notebook pages still render undistorted** (page images are now
   drawn aspect-preserved rather than stretched).
9. **Airplane mode** — repeat the tour.
10. **Force-quit mid-recording**; relaunch; confirm state.
11. Both website links open in the in-app browser and come back.

Only after all of the above, plus clearing the three §A blockers, does 1.3 become
submittable.
