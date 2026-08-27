import Foundation
import Capacitor
import Speech
import AVFoundation

/**
 PermissionSpeech — Permission's own on-device speech-to-text bridge.

 WHAT THIS DOES, AND THE ONE THING IT DELIBERATELY CANNOT DO
 -----------------------------------------------------------
 It transcribes a FINISHED recording, and nothing else. You hand it the audio
 the recorder already captured; it runs SFSpeechRecognizer over that file
 on-device and hands back text.

 It has NO live path. There is no `startLive`, no AVAudioEngine, no
 `installTap`, no AVAudioSession mutation — not disabled, ABSENT. That path
 was the "Dictate" button, and it crashed the app in 1.3.5:

     input.installTap(onBus: 0, bufferSize: 1024, format: format)

 raises an **Objective-C exception** — not a Swift error, so `do/catch` cannot
 save you and the process dies — whenever `format` is invalid
 (`sampleRate == 0` / `channelCount == 0`). That happens easily here, because
 recording runs on WKWebView's MediaRecorder, so WebKit may already own the
 audio input when the engine asks for it.

 1.4.0 removed the whole capability to be rid of that crash. 1.5.0 brings back
 only the half that never crashed. Keeping the two apart is not a matter of
 discipline: the crashing API is simply not linked into this file any more, so
 no amount of JS can reach it. codemagic.yaml enforces that — the build FAILS
 if `startLive`, `installTap`, `AVAudioEngine` or
 `SFSpeechAudioBufferRecognitionRequest` ever reappear here.

 WHY THIS IS FIRST-PARTY
 -----------------------
 The app used @capacitor-community/speech-recognition. That package ships only
 a CocoaPods podspec and an ObjC `CAP_PLUGIN` registration macro — it has no
 `Package.swift`. This app's iOS project is SPM-based, and `npx cap sync ios`
 SILENTLY DROPS SPM-incompatible plugins: it prints

     [warn] @capacitor-community/speech-recognition does not have a Package.swift
     [warn] Some installed Capacitor plugins are not compatible with SPM

 ...and then builds anyway, leaving the plugin out of the IPA entirely. So
 `window.Capacitor.Plugins.SpeechRecognition` was `undefined` on device, every
 call fell into the "unavailable" branch, the transcript was always empty, and
 the speech permission was never even requested — which is why the user was
 only ever prompted for the microphone. Being first-party and SPM-native, this
 plugin cannot be dropped that way: it builds into the IPA, or the build fails.

 PRIVACY
 -------
 `requiresOnDeviceRecognition = true` on the request. iOS transcribes locally
 or the task fails; there is deliberately NO server fallback, because the app
 and its privacy policy both promise nothing leaves the phone. "No transcript"
 is the worst case — never a silent upload.
 */
@objc(PermissionSpeechPlugin)
public class PermissionSpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PermissionSpeechPlugin"
    public let jsName = "PermissionSpeech"
    /// JS can call ONLY what is listed here. There is deliberately no
    /// `startLive`/`stopLive`, and no `addListener` — listeners existed purely
    /// to stream live dictation partials, and live dictation is gone.
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "diagnostics", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transcribeFile", returnType: CAPPluginReturnPromise)
    ]

    /// The only task this plugin ever owns. File recognition holds no audio
    /// hardware, so there is nothing else to tear down.
    private var fileTask: SFSpeechRecognitionTask?

    // MARK: - helpers

    private func authString(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch s {
        case .authorized:    return "authorized"
        case .denied:        return "denied"
        case .restricted:    return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default:    return "unknown"
        }
    }

    /// Microphone permission state — REPORTED ONLY, never requested here.
    ///
    /// The recorder owns the microphone and asks for it itself; this plugin
    /// only ever reads a file. The value is surfaced so the on-screen readout
    /// can explain an empty recording honestly.
    ///
    /// `AVAudioSession.recordPermission` was deprecated in iOS 17 in favour of
    /// `AVAudioApplication`. Codemagic builds with `xcode: latest`, so prefer
    /// the modern API wherever it exists and keep the old one only as the
    /// iOS 15/16 fallback the deployment target still requires.
    private func micString() -> String {
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted:      return "granted"
            case .denied:       return "denied"
            case .undetermined: return "notDetermined"
            @unknown default:   return "unknown"
            }
        } else {
            switch AVAudioSession.sharedInstance().recordPermission {
            case .granted:      return "granted"
            case .denied:       return "denied"
            case .undetermined: return "notDetermined"
            @unknown default:   return "unknown"
            }
        }
    }

    private func recognizer(_ language: String) -> SFSpeechRecognizer? {
        return SFSpeechRecognizer(locale: Locale(identifier: language))
    }

    private func supportsOnDevice(_ r: SFSpeechRecognizer) -> Bool {
        if #available(iOS 13.0, *) { return r.supportsOnDeviceRecognition }
        return false
    }

    /// Everything the UI needs to show an honest status line, in one call.
    private func snapshot(_ language: String) -> [String: Any] {
        let r = recognizer(language)
        return [
            "engine": "native-sfspeechrecognizer",
            "plugin": "PermissionSpeech",
            "mode": "file-only",
            "speechAuth": authString(SFSpeechRecognizer.authorizationStatus()),
            "micAuth": micString(),
            "available": r?.isAvailable ?? false,
            "onDevice": r == nil ? false : supportsOnDevice(r!),
            "locale": language,
            "hasRecognizer": r != nil
        ]
    }

    // MARK: - diagnostics

    @objc func diagnostics(_ call: CAPPluginCall) {
        call.resolve(snapshot(call.getString("language") ?? "en-US"))
    }

    // MARK: - permissions

    /// NOTE: `CAPPlugin` itself declares `checkPermissions:` and
    /// `requestPermissions:` (the Capacitor 3+ permission pattern), so these
    /// MUST be `override public` — redeclaring them plainly is a compile error
    /// ("overriding declaration requires an 'override' keyword"), which is what
    /// failed the 1.3.3 build.
    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        call.resolve(snapshot(call.getString("language") ?? "en-US"))
    }

    /// Requests SPEECH RECOGNITION ONLY.
    ///
    /// Speech recognition is its own permission — granting the microphone does
    /// not grant it, and without it SFSpeechRecognizer just returns nothing.
    /// The microphone is deliberately NOT requested here: the recorder already
    /// asks for it when recording starts, and this plugin never touches audio
    /// hardware.
    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        let language = call.getString("language") ?? "en-US"
        SFSpeechRecognizer.requestAuthorization { _ in
            DispatchQueue.main.async {
                call.resolve(self.snapshot(language))
            }
        }
    }

    // MARK: - file transcription  (the ONLY recognition path in this app)

    /// Transcribes an already-recorded clip. Never rejects: it resolves either
    /// `{ok: true, transcript}` or `{ok: false, reason}` plus a diag snapshot,
    /// so the JS side always has something honest to show.
    @objc func transcribeFile(_ call: CAPPluginCall) {
        let language = call.getString("language") ?? "en-US"

        guard let b64 = call.getString("data"), !b64.isEmpty,
              let audioData = Data(base64Encoded: b64), !audioData.isEmpty else {
            call.resolve(["ok": false, "reason": "no-audio", "diag": snapshot(language)]); return
        }
        let auth = SFSpeechRecognizer.authorizationStatus()
        if auth != .authorized {
            call.resolve(["ok": false, "reason": "permission-" + authString(auth), "diag": snapshot(language)]); return
        }
        guard let rec = recognizer(language) else {
            call.resolve(["ok": false, "reason": "no-recognizer", "diag": snapshot(language)]); return
        }
        if !rec.isAvailable {
            call.resolve(["ok": false, "reason": "recognizer-unavailable", "diag": snapshot(language)]); return
        }
        if !supportsOnDevice(rec) {
            // No offline model for this locale. We do NOT fall back to Apple's
            // servers — that would break the app's privacy promise.
            call.resolve(["ok": false, "reason": "no-on-device", "diag": snapshot(language)]); return
        }

        let ext = call.getString("ext") ?? "m4a"
        let tmpURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("permission-stt-\(UUID().uuidString).\(ext)")
        do {
            try audioData.write(to: tmpURL)
        } catch {
            call.resolve(["ok": false, "reason": "write-failed", "diag": snapshot(language)]); return
        }

        let request = SFSpeechURLRecognitionRequest(url: tmpURL)
        request.shouldReportPartialResults = false
        if #available(iOS 13.0, *) { request.requiresOnDeviceRecognition = true }

        var settled = false
        let done: ([String: Any]) -> Void = { [weak self] payload in
            if settled { return }
            settled = true
            try? FileManager.default.removeItem(at: tmpURL)
            self?.fileTask = nil
            var out = payload
            out["diag"] = self?.snapshot(language) ?? [:]
            DispatchQueue.main.async { call.resolve(out) }
        }

        fileTask = rec.recognitionTask(with: request) { (result, error) in
            if let error = error {
                done(["ok": false, "reason": "recognition-failed", "detail": error.localizedDescription])
                return
            }
            guard let result = result, result.isFinal else { return }
            let text = result.bestTranscription.formattedString
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty {
                done(["ok": false, "reason": "no-speech"])
            } else {
                done(["ok": true, "transcript": text, "onDevice": true])
            }
        }
    }
}
