import Foundation
import Capacitor
import Speech
import AVFoundation

/**
 PermissionSpeech — Permission's own on-device speech-to-text bridge.

 WHY THIS EXISTS (the bug it fixes)
 ----------------------------------
 The app used @capacitor-community/speech-recognition. That package ships only
 a CocoaPods podspec and an ObjC `CAP_PLUGIN` registration macro — it has no
 `Package.swift`. This app's iOS project is SPM-based, and `npx cap sync ios`
 SILENTLY DROPS SPM-incompatible plugins: it prints

     [warn] @capacitor-community/speech-recognition does not have a Package.swift
     [warn] Some installed Capacitor plugins are not compatible with SPM

 ...and then builds anyway, leaving the plugin out of the IPA entirely. So
 `window.Capacitor.Plugins.SpeechRecognition` was `undefined` on device, every
 call fell into the "unavailable" branch, the transcript was always empty, and
 the speech-recognition permission was never even requested — which is why the
 user was only ever prompted for the microphone.

 Being first-party and SPM-native, this plugin cannot be dropped that way. If
 it fails to build, the build FAILS instead of quietly shipping without it.

 PRIVACY
 -------
 `requiresOnDeviceRecognition = true` on every request. iOS transcribes locally
 or the task fails; there is deliberately NO server fallback, because the app
 and its privacy policy both promise nothing leaves the phone.
 */
@objc(PermissionSpeechPlugin)
public class PermissionSpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PermissionSpeechPlugin"
    public let jsName = "PermissionSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "diagnostics", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transcribeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startLive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopLive", returnType: CAPPluginReturnPromise),
        // Inherited from CAPPlugin, but JS can only call what is listed here.
        // Dictate's live partial results arrive through these.
        CAPPluginMethod(name: "addListener", returnType: CAPPluginReturnCallback),
        CAPPluginMethod(name: "removeAllListeners", returnType: CAPPluginReturnPromise)
    ]

    private var audioEngine: AVAudioEngine?
    private var liveRequest: SFSpeechAudioBufferRecognitionRequest?
    private var liveTask: SFSpeechRecognitionTask?
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

    /// Microphone permission state.
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

    /// Same split for *requesting* the microphone.
    private func requestMic(_ done: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: done)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(done)
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

    // MARK: - permissions  (speech AND microphone are SEPARATE permissions)

    /// NOTE: `CAPPlugin` itself declares `checkPermissions:` and
    /// `requestPermissions:` (the Capacitor 3+ permission pattern), so these
    /// MUST be `override public` — redeclaring them plainly is a compile error
    /// ("overriding declaration requires an 'override' keyword"), which is what
    /// failed the 1.3.3 build.
    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        call.resolve(snapshot(call.getString("language") ?? "en-US"))
    }

    /// Requests BOTH authorizations. Speech recognition is its own permission —
    /// granting the microphone does not grant it, and without it
    /// SFSpeechRecognizer just returns nothing.
    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        let language = call.getString("language") ?? "en-US"
        SFSpeechRecognizer.requestAuthorization { _ in
            self.requestMic { _ in
                DispatchQueue.main.async {
                    call.resolve(self.snapshot(language))
                }
            }
        }
    }

    // MARK: - file transcription  (the path used after a recording)

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

    // MARK: - live dictation  (the "Dictate" button only — never while recording)

    @objc func startLive(_ call: CAPPluginCall) {
        let language = call.getString("language") ?? "en-US"

        if audioEngine?.isRunning == true {
            call.resolve(["ok": false, "reason": "already-listening", "diag": snapshot(language)]); return
        }
        let auth = SFSpeechRecognizer.authorizationStatus()
        if auth != .authorized {
            call.resolve(["ok": false, "reason": "permission-" + authString(auth), "diag": snapshot(language)]); return
        }
        guard let rec = recognizer(language), rec.isAvailable else {
            call.resolve(["ok": false, "reason": "recognizer-unavailable", "diag": snapshot(language)]); return
        }
        if !supportsOnDevice(rec) {
            call.resolve(["ok": false, "reason": "no-on-device", "diag": snapshot(language)]); return
        }

        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            // Something else holds the mic. Say so instead of failing silently.
            call.resolve(["ok": false, "reason": "mic-busy", "detail": error.localizedDescription,
                          "diag": snapshot(language)]); return
        }

        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if #available(iOS 13.0, *) { request.requiresOnDeviceRecognition = true }

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }

        liveTask = rec.recognitionTask(with: request) { [weak self] (result, error) in
            guard let self = self else { return }
            if let result = result {
                self.notifyListeners("partialResults", data: [
                    "matches": [result.bestTranscription.formattedString]
                ])
            }
            if error != nil || (result?.isFinal ?? false) {
                self.teardownLive()
                self.notifyListeners("listeningState", data: ["status": "stopped"])
            }
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            call.resolve(["ok": false, "reason": "engine-failed", "detail": error.localizedDescription,
                          "diag": snapshot(language)]); return
        }

        audioEngine = engine
        liveRequest = request
        notifyListeners("listeningState", data: ["status": "started"])
        call.resolve(["ok": true, "diag": snapshot(language)])
    }

    @objc func stopLive(_ call: CAPPluginCall) {
        teardownLive()
        call.resolve(["ok": true])
    }

    private func teardownLive() {
        if let engine = audioEngine {
            if engine.isRunning { engine.stop() }
            engine.inputNode.removeTap(onBus: 0)
        }
        audioEngine = nil
        liveRequest?.endAudio()
        liveRequest = nil
        liveTask = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
