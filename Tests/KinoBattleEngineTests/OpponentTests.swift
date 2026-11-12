import XCTest
@testable import KinoBattleEngine

final class OpponentTests: XCTestCase {
    private let round = RoundQuestion(unshuffled: makeQuestion("a", correctIndex: 1))

    func testSeededGeneratorIsDeterministic() {
        var a = SeededGenerator(seed: 42)
        var b = SeededGenerator(seed: 42)
        XCTAssertEqual((0..<5).map { _ in a.next() }, (0..<5).map { _ in b.next() })
    }

    func testSameSeedSamePlans() {
        let a = BotOpponent(seed: 7)
        let b = BotOpponent(seed: 7)
        for _ in 0..<20 {
            XCTAssertEqual(a.plan(for: round), b.plan(for: round))
        }
    }

    func testPlanRespectsConfig() {
        let config = BotConfig(accuracy: 0.7, answerTime: 3...7)
        let bot = BotOpponent(config: config, seed: 1)
        var correct = 0
        let n = 2000
        for _ in 0..<n {
            let plan = bot.plan(for: round)
            XCTAssertTrue(config.answerTime.contains(plan.delay))
            XCTAssertTrue(round.options.indices.contains(plan.optionIndex))
            if plan.optionIndex == round.correctIndex { correct += 1 }
        }
        XCTAssertEqual(Double(correct) / Double(n), 0.7, accuracy: 0.05)
    }

    func testPerfectAndHopelessBots() {
        let perfect = BotOpponent(config: BotConfig(accuracy: 1), seed: 3)
        let hopeless = BotOpponent(config: BotConfig(accuracy: 0), seed: 3)
        for _ in 0..<50 {
            XCTAssertEqual(perfect.plan(for: round).optionIndex, round.correctIndex)
            XCTAssertNotEqual(hopeless.plan(for: round).optionIndex, round.correctIndex)
        }
    }

    func testAnswerArrivesAfterDelay() async {
        let bot = BotOpponent(config: BotConfig(accuracy: 1, answerTime: 0.05...0.05), seed: 1)
        let answer = await bot.answer(to: round, timeLimit: 10)
        XCTAssertEqual(answer?.optionIndex, round.correctIndex)
        XCTAssertEqual(answer?.timeLeft ?? 0, 9.95, accuracy: 0.0001)
    }

    func testNoAnswerWhenSlowerThanTimer() async {
        let bot = BotOpponent(config: BotConfig(answerTime: 5...5), seed: 1)
        let answer = await bot.answer(to: round, timeLimit: 2)
        XCTAssertNil(answer)
    }

    func testCancellationReturnsNil() async {
        let bot = BotOpponent(config: BotConfig(answerTime: 5...5), seed: 1)
        let task = Task { await bot.answer(to: round, timeLimit: 10) }
        task.cancel()
        let answer = await task.value
        XCTAssertNil(answer)
    }
}
