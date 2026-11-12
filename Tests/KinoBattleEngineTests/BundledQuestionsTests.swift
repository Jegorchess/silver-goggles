import XCTest
@testable import KinoBattleEngine

/// Перевіряє справжній `KinoBattleApp/questions.json`, який поставляється із застосунком.
final class BundledQuestionsTests: XCTestCase {
    func testBundledQuestionsAreValid() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // KinoBattleEngineTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // корінь репозиторію
            .appendingPathComponent("KinoBattleApp/questions.json")
        let bank = try QuestionBank(jsonData: Data(contentsOf: url))
        // Щоб два найдовші матчі поспіль не повторювали питань.
        XCTAssertGreaterThanOrEqual(bank.questions.count, MatchRules.matchLengths.max()! * 2)
        // Після кожного питання показуємо факт.
        XCTAssertEqual(bank.questions.filter { $0.fact == nil }.map(\.id), [])
    }
}
