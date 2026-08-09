// Minimal stand-ins for the two things the macOS SDK cannot provide:
//   1. Capacitor (iOS-only framework)
//   2. AVAudioSession (iOS/tvOS/watchOS only)
// Everything else — Speech, AVAudioEngine, AVAudioApplication — is the REAL
// framework from the macOS SDK, so those APIs are genuinely type-checked.
import Foundation
import AVFoundation

// ---- Capacitor stubs (shapes copied from Capacitor 8) ----
// exactly the three #defines in Capacitor's CAPBridgedPlugin.h
public let CAPPluginReturnNone = "none"
public let CAPPluginReturnCallback = "callback"
public let CAPPluginReturnPromise = "promise"

public struct CAPPluginMethod {
    public let name: String
    public let returnType: String
    public init(name: String, returnType: String) { self.name = name; self.returnType = returnType }
}

public protocol CAPBridgedPlugin {
    var identifier: String { get }
    var jsName: String { get }
    var pluginMethods: [CAPPluginMethod] { get }
}

@objc open class CAPPluginCall: NSObject {
    @objc public func getString(_ key: String) -> String? { return nil }
    public func getString(_ key: String, _ def: String) -> String { return def }
    @objc public func resolve(_ data: [String: Any]) {}
    @objc public func resolve() {}
    public func reject(_ message: String, _ code: String? = nil) {}
}

open class CAPPlugin: NSObject {
    @objc public func notifyListeners(_ eventName: String, data: [String: Any]) {}
    // CAPPlugin.h ALREADY declares these two — a subclass must `override`.
    @objc open func checkPermissions(_ call: CAPPluginCall) {}
    @objc open func requestPermissions(_ call: CAPPluginCall) {}
    @objc open func load() {}
}

// ---- AVAudioSession stub, shaped like the iOS API we call ----
#if !os(iOS)
public class AVAudioSession {
    public enum RecordPermission { case granted, denied, undetermined }
    public struct CategoryOptions: OptionSet {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }
        public static let defaultToSpeaker = CategoryOptions(rawValue: 1)
        public static let allowBluetooth   = CategoryOptions(rawValue: 2)
    }
    public struct SetActiveOptions: OptionSet {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }
        public static let notifyOthersOnDeactivation = SetActiveOptions(rawValue: 1)
    }
    public enum Category { case playAndRecord }
    public enum Mode { case `default` }
    public static func sharedInstance() -> AVAudioSession { return AVAudioSession() }
    public var recordPermission: RecordPermission { return .undetermined }
    public func requestRecordPermission(_ response: @escaping (Bool) -> Void) { response(true) }
    public func setCategory(_ c: Category, mode: Mode, options: CategoryOptions = []) throws {}
    public func setActive(_ active: Bool, options: SetActiveOptions = []) throws {}
}
#endif
