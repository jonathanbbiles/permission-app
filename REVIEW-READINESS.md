# Permission — Apple Review Readiness record

**Version:** 1.3.1 (Record rename; in-app-only recordings; Draw actions above the fold)
**Date:** 2026-08-08 (device-feedback pass)
**Gate run:** `scripts/apple-review-audit.sh` (canonical copy, App Builder Template)

## §A VERDICT: **MECHANICAL CHECKS PASS** — zero blockers.

## Overall: **not yet submittable**, and not being submitted.

§A is clean. What stands between this and a submission is **§C, the on-device
TestFlight smoke test**, which is Jonathan's to run and cannot be done off real
hardware. This build goes to **TestFlight only**; `submit_to_app_store` stays
commented out in `codemagic.yaml`.

The three blockers from the 2026-08-07 run are now cleared:

| Was blocked | Now |
|---|---|
| Universal build with no large-screen media query | **PASS** — real two-column iPad layout at ≥700px |
| No 2048×2732 iPad screenshots | **PASS** — rendered from the current build |
| No `appicon-1024.png` at repo root | **PASS** — 1024×1024, no alpha, re-embedded and verified every build |

---

## 1.3.1 — recordings are app-private, and that is enforced, not just intended

Jonathan's device test raised this as core to the app's promise. Three
independent layers, strongest first:

1. **The OS will not allow it.** `NSPhotoLibraryAddUsageDescription` is **absent
   from Info.plist**, so iOS refuses any attempt to add media to the photo
   library — the app *cannot* write to Photos even if code tried. The build
   **fails** if that key ever appears, so it cannot be reintroduced quietly.
   (`NSPhotoLibraryUsageDescription` — read-only — stays, and only exists so the
   user can pick an existing video to bring *into* the app.)
2. **Nothing in the app even reaches for it.** No `@capacitor/camera`, no media
   or photo-library plugin is installed at all, and there is no `savePhoto` /
   `saveToGallery` / `CameraRoll` / `UISaveVideo` call anywhere in `www/`.
3. **Where recordings actually live.** Audio and video are stored as Blobs in
   **IndexedDB (`awaken_db`)**, inside the app's own container — the same place
   as written and drawn entries. Verified end-to-end in a headless run: the
   audio Blob, its transcript and the video Blob all persist on the entry record
   and render back in the viewer.

**No automatic export of any kind.** Every share path (`Export a copy`,
`Page PNG`, `Export PDF`) sits behind an explicit tap. The one filesystem write
in the app stages a file in the app's **own CACHE** directory purely to hand to
the share sheet, and it is now **deleted immediately afterwards** so no loose
copy is left behind.

> The one thing that cannot be proven off-hardware: whether iOS's own picker
> writes a camera-captured video to the camera roll before handing it to the
> page. It should not — a web file input receives a temp file, and saving to
> Photos is something an app must ask for. **Confirm on device** (item 6 of §C).

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

### A5 — iPad, and why it's a real layout rather than a wider phone

The build is Universal, so Apple reviews it on a 13" iPad. Previously the 540px
phone column just floated in the middle of a 1024×1366pt screen — Guideline 4
"not designed for iPad". Now, at **≥700px** (every iPad in full screen; iPad mini
portrait is 744pt):

- Body widens to 940px (1080px past 1100px), with a larger type scale.
- **Home becomes two columns** — the invitation, the three ways to answer it and
  the Notebook on the left; the journal alongside on the right, instead of pushed
  a screen and a half down. Grid rows are assigned explicitly so auto-flow can't
  reshuffle them.
- The home journal preview shows **6** entries instead of 3, because the column
  has the room. "See all" still shows everything on every device.
- Editors keep a 760px reading measure rather than stretching text and buttons
  the full width. **The Notebook is deliberately not capped** — there, more width
  is more paper (canvas renders 870×1079 on iPad vs 396×628 on a 6.9" phone).
- The settings sheet is centred at panel width instead of a full-bleed bar.

Below 700px nothing changes, so Slide Over and narrow Split View correctly keep
the phone layout. **No feature is added, removed or hidden by screen size** — the
iPad build is the same app, which is what Guideline 4 is actually asking for.

Verified by rendering, not by eye: `scripts/render-screenshots.mjs` reports body
fill, grid mode, horizontal overflow, page errors, and the notebook fold check at
every size. Latest run — 6.9": 100% width, no overflow · 6.5": 100%, no overflow ·
iPad 13": 92% width, `home=grid [421px 421px]`, no overflow, no page errors.

### A7 — icon and screenshots

- **`appicon-1024.png`** at repo root: 1024×1024, RGB, **no alpha** (Apple rejects
  an app icon with transparency). It is now the single source of truth — the build
  copies it to `assets/icon.png`, regenerates the appiconset from it, then
  **verifies a real 1024 icon landed and fails the build otherwise**. That closes
  a live trap: `ios/` is regenerated every build, so a silently-failed asset
  generation would have shipped Capacitor's placeholder icon = automatic rejection.
- **Screenshots** — 12 rendered from the *current* build by
  `scripts/render-screenshots.mjs`, at exactly the sizes ASC expects:

  | slot | pixels | shots |
  |---|---|---|
  | `iphone69` | 1290×2796 | 4 |
  | `iphone65` | 1242×2688 | 4 |
  | `ipad13` | **2048×2732** | 4 |

  Home · Record-with-transcript · Notebook · Draw · an entry showing audio + transcript.
  Content is the app's own invented sample text — no third-party media, brands or
  encyclopedic text anywhere (the 4.1(a) "Copycats" rule that rejected Moodie).
  The test suite re-checks every file's exact pixel size on every run.

### Remaining WARN / CHECK (none blocking)

- ⚠️ **Screenshots are on disk but NOT published** to
  `jonathanbbiles.github.io/appstore-assets/permission-app/`. The ASC upload lane
  reads the published manifest, so before submitting:
  `scripts/publish-screenshots.sh permission-app screenshots/` then
  `scripts/cm-build.sh -w asc-screenshots`. Left unpublished deliberately — these
  are brand-new shots and worth eyeballing first, and publishing is a step on the
  submit path, not the TestFlight path.
- **No privacy-policy URL inside `www/`** — the policy lives in `docs/`. Publish to
  `jonathanbbiles.github.io/app-privacy` and link it before submit.
- **`TARGETED_DEVICE_FAMILY` not overridden** — intentional. The app now has a real
  iPad layout, so staying Universal is the right call.

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
- **Screenshots.** Live ASC screenshots still show 1.2. Fresh ones are rendered
  from this build in `screenshots/`, but are **not yet published or swapped into
  ASC**. Do that while the version is still *Prepare for Submission* — a stale
  screenshot is what took the 2.3.3 on Permission 1.2. Verify the swap landed by
  opening ASC; don't assume.
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
2. **Record → Voice.** Record. Confirm the transcript fills in *while recording*.
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
5. **Record → Video.** Confirm the action sheet offers **Record Video** *and*
   **Photo Library**. Record one, play it back, save, reopen from the journal.
6. **Deny every permission on a second clean install** — microphone, speech,
   camera, photos. Confirm: no crash, the app stays usable, and each denial says
   something useful. (A missing usage string here is a `SIGABRT`, not a prompt.)
6b. **Confirm the video did NOT land in Photos.** After saving a video entry,
   open the Photos app and check the camera roll — the recording should not be
   there. It should only exist inside Permission.
7. **Notebook.** Confirm **Page PNG** and **Export PDF** are both visible without
   scrolling, on the smallest device you have. Confirm the canvas is bigger than
   in 1.2. Draw, add pages, rotate the device, confirm nothing is lost.
7b. **Draw.** On first open, **Discard** and **Save entry** must both be visible
   without scrolling, above the canvas. Then try to scroll with a finger on the
   canvas — it must leave **no line**. A deliberate stroke must still draw
   normally, including straight down.
7c. **Header.** Confirm there is no Notebook icon at the top of the screen, and
   that the Notebook still opens from its card on the home screen.
8. **Existing 1.2 notebook pages still render undistorted** (page images are now
   drawn aspect-preserved rather than stretched).
9. **Airplane mode** — repeat the tour.
10. **Force-quit mid-recording**; relaunch; confirm state.
11. Both website links open in the in-app browser and come back.
12. **On an iPad, if one is available.** Home should be two columns filling the
    screen — not a phone column floating in the middle. Check the Notebook canvas
    is large with both exports on screen, and that Split View / Slide Over falls
    back to the phone layout cleanly.

§A is clear. Once §C above is done — and the screenshots are published and swapped
into ASC, and the privacy page is published — 1.3 is submittable.
