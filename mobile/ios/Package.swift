// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "ClaudexCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "ClaudexCore", targets: ["ClaudexCore"])],
    targets: [
        .target(name: "ClaudexCore", path: "Claudex/Core"),
        .testTarget(name: "ClaudexCoreTests", dependencies: ["ClaudexCore"], path: "ClaudexTests", resources: [.copy("Fixtures")])
    ]
)
