import XCTest
@testable import KinoBattleEngine

/// Перевіряє справжній `KinoBattleApp/questions.json`, який поставляється із застосунком.
final class BundledQuestionsTests: XCTestCase {
    private let appDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // KinoBattleEngineTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // корінь репозиторію
        .appendingPathComponent("KinoBattleApp")

    private func bank() throws -> QuestionBank {
        try QuestionBank(jsonData: Data(contentsOf: appDir.appendingPathComponent("questions.json")))
    }

    func testBundledQuestionsAreValid() throws {
        let bank = try bank()
        // Щоб два найдовші матчі поспіль не повторювали питань.
        XCTAssertGreaterThanOrEqual(bank.questions.count, MatchRules.matchLengths.max()! * 2)
        // Після кожного питання показуємо факт.
        XCTAssertEqual(bank.questions.filter { $0.fact == nil }.map(\.id), [])
        // У базі є питання всіх складностей.
        XCTAssertEqual(Set(bank.questions.map(\.level)), [1, 2, 3])
    }

    func testBundledMediaFilesExist() throws {
        let media = try bank().questions.flatMap { q in [q.image].compactMap { $0 } + (q.cast ?? []).map(\.image) }
        for m in media {
            XCTAssertTrue(FileManager.default.fileExists(atPath: appDir.appendingPathComponent(m.file).path), "немає \(m.file)")
        }
    }
}
