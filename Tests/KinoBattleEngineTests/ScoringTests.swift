import XCTest
@testable import KinoBattleEngine

final class ScoringTests: XCTestCase {
    func testFullTimeGivesMaxPoints() {
        XCTAssertEqual(Scoring.points(isCorrect: true, timeLeft: 10, multiplier: 1), 1000)
    }

    func testTimeIsTruncatedToTenths() {
        // 9.95 → 9.9 → 500 + 495
        XCTAssertEqual(Scoring.points(isCorrect: true, timeLeft: 9.95, multiplier: 1), 995)
    }

    func testLastMomentGivesBasePoints() {
        XCTAssertEqual(Scoring.points(isCorrect: true, timeLeft: 0.01, multiplier: 1), 500)
    }

    func testTimeAboveLimitIsClamped() {
        XCTAssertEqual(Scoring.points(isCorrect: true, timeLeft: 12, multiplier: 1), 1000)
    }

    func testWrongOrTimeoutGivesZero() {
        XCTAssertEqual(Scoring.points(isCorrect: false, timeLeft: 5, multiplier: 1), 0)
        XCTAssertEqual(Scoring.points(isCorrect: true, timeLeft: nil, multiplier: 1), 0)
        XCTAssertEqual(Scoring.points(isCorrect: true, timeLeft: 0, multiplier: 2), 0)
    }

    func testFinalQuestionIsDoubled() {
        XCTAssertEqual(Scoring.multiplier(questionIndex: 0), 1)
        XCTAssertEqual(Scoring.multiplier(questionIndex: MatchRules.questionsPerMatch - 2), 1)
        XCTAssertEqual(Scoring.multiplier(questionIndex: MatchRules.questionsPerMatch - 1), 2)
        XCTAssertEqual(Scoring.points(isCorrect: true, timeLeft: 5, multiplier: 2), 1500)
    }

    func testLongMatchDoublesOnlyLastQuestion() {
        XCTAssertEqual(Scoring.multiplier(questionIndex: 6, totalQuestions: 14), 1)
        XCTAssertEqual(Scoring.multiplier(questionIndex: 13, totalQuestions: 14), 2)
    }

    func testOutcome() {
        XCTAssertEqual(MatchOutcome.decide(playerScore: 3000, opponentScore: 2000, playerCorrect: 3, opponentCorrect: 4), .win)
        XCTAssertEqual(MatchOutcome.decide(playerScore: 2000, opponentScore: 3000, playerCorrect: 5, opponentCorrect: 4), .loss)
        XCTAssertEqual(MatchOutcome.decide(playerScore: 2000, opponentScore: 2000, playerCorrect: 4, opponentCorrect: 3), .win)
        XCTAssertEqual(MatchOutcome.decide(playerScore: 2000, opponentScore: 2000, playerCorrect: 3, opponentCorrect: 4), .loss)
        XCTAssertEqual(MatchOutcome.decide(playerScore: 2000, opponentScore: 2000, playerCorrect: 3, opponentCorrect: 3), .draw)
    }
}
