// swift-tools-version: 6.0
// CUA-derived UI: FSL-1.1-MIT, see LICENSE and UPSTREAM.md.
import PackageDescription
let package = Package(name: "StrataBots", platforms: [.macOS(.v14)], products: [.executable(name: "StrataBots", targets: ["StrataBots"])], targets: [.target(name: "CuaBotsCore"), .target(name: "CuaBotsUI", dependencies: ["CuaBotsCore"]), .executableTarget(name: "StrataBots", dependencies: ["CuaBotsCore", "CuaBotsUI"]), .testTarget(name: "StrataBotsTests", dependencies: ["CuaBotsCore"])], swiftLanguageModes: [.v5])
