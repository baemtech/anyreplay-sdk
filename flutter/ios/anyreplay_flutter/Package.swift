// swift-tools-version: 5.9

import PackageDescription

// Two targets because a Swift Package target cannot mix Swift and
// Objective-C: the signal and exception handlers are plain C / Objective-C.
let package = Package(
    name: "anyreplay_flutter",
    platforms: [
        .iOS("13.0")
    ],
    products: [
        .library(name: "anyreplay-flutter", targets: ["anyreplay_flutter"])
    ],
    dependencies: [
        .package(name: "FlutterFramework", path: "../FlutterFramework")
    ],
    targets: [
        .target(
            name: "anyreplay_flutter_c",
            path: "Sources/anyreplay_flutter_c",
            publicHeadersPath: "include"
        ),
        .target(
            name: "anyreplay_flutter",
            dependencies: [
                "anyreplay_flutter_c",
                .product(name: "FlutterFramework", package: "FlutterFramework")
            ]
        )
    ]
)
