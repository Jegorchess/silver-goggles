// swift-tools-version:5.10
// Рушій гри як окремий Swift-пакет: збирається й тестується без Xcode (зокрема в Docker на Linux),
// а пізніше підключається до iOS-проєкту як локальна залежність.
import PackageDescription

let package = Package(
    name: "KinoBattleEngine",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "KinoBattleEngine", targets: ["KinoBattleEngine"]),
    ],
    targets: [
        .target(
            name: "KinoBattleEngine",
            path: "KinoBattleApp/Engine"
        ),
        .testTarget(
            name: "KinoBattleEngineTests",
            dependencies: ["KinoBattleEngine"],
            path: "Tests/KinoBattleEngineTests"
        ),
    ]
)
