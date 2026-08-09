// swift-tools-version: 5.9
import PackageDescription

// Permission's own speech bridge.
//
// This manifest is the entire point of this package. Capacitor's iOS project
// for this app is SPM-based, and `npx cap sync ios` SILENTLY DROPS any plugin
// that has no Package.swift — it prints a warning and carries on. That is how
// @capacitor-community/speech-recognition ended up discovered-but-never-built
// for three releases: the JS called a plugin that was not in the IPA.
let package = Package(
    name: "PermissionSpeech",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "PermissionSpeech",
            targets: ["PermissionSpeechPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "PermissionSpeechPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/PermissionSpeechPlugin")
    ]
)
