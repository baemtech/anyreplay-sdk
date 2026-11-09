// swift-tools-version: 5.9
import PackageDescription

// Swift Package Manager is how Capacitor 8 links iOS plugins by default;
// AnyreplayCapacitor.podspec is for apps still on CocoaPods (Capacitor 7).
let package = Package(
    name: "AnyreplayCapacitor",
    platforms: [.iOS(.v14)],
    products: [
        .library(
            name: "AnyreplayCapacitor",
            targets: ["AnyReplayPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", "7.0.0"..<"9.0.0")
    ],
    targets: [
        .target(
            name: "AnyReplayPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/AnyReplayPlugin")
    ]
)
