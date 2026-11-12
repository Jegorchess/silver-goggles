import XCTest
@testable import KinoBattleEngine

func makeQuestion(
    _ id: String,
    prompt: String = "Питання?",
    options: [String] = ["A", "B", "C", "D"],
    correctIndex: Int = 0,
    type: Question.Kind = .text,
    fact: String? = nil
) -> Question {
    Question(id: id, type: type, prompt: prompt, options: options, correctIndex: correctIndex, fact: fact)
}

final class QuestionBankTests: XCTestCase {
    func testDecodesJSON() throws {
        let json = """
        [{"id":"q1","type":"emoji","prompt":"🦁👑","options":["Король Лев","Мадагаскар","Тарзан","Зоотрополіс"],"correctIndex":0}]
        """
        let bank = try QuestionBank(jsonData: Data(json.utf8))
        XCTAssertEqual(bank.questions.count, 1)
        XCTAssertEqual(bank.questions[0].type, .emoji)
        XCTAssertNil(bank.questions[0].fact)
    }

    func testDecodesFact() throws {
        let json = """
        [{"id":"q1","type":"text","prompt":"?","options":["A","B","C","D"],"correctIndex":0,"fact":"Цікаво!"}]
        """
        XCTAssertEqual(try QuestionBank(jsonData: Data(json.utf8)).questions[0].fact, "Цікаво!")
    }

    func testValidationErrors() {
        func error(_ questions: [Question]) -> QuestionBank.ValidationError? {
            do {
                try QuestionBank.validate(questions)
                return nil
            } catch {
                return error as? QuestionBank.ValidationError
            }
        }
        XCTAssertEqual(error([]), .empty)
        XCTAssertEqual(error([makeQuestion("a"), makeQuestion("a")]), .duplicateID("a"))
        XCTAssertEqual(error([makeQuestion("a", options: ["A", "B", "C"])]), .wrongOptionCount("a"))
        XCTAssertEqual(error([makeQuestion("a", correctIndex: 4)]), .badCorrectIndex("a"))
        XCTAssertEqual(error([makeQuestion("a", options: ["A", "A", "C", "D"])]), .duplicateOptions("a"))
        XCTAssertEqual(error([makeQuestion("a", prompt: "   ")]), .emptyText("a"))
        XCTAssertEqual(error([makeQuestion("a", prompt: String(repeating: "x", count: 121))]), .promptTooLong("a"))
        XCTAssertEqual(error([makeQuestion("a", options: ["A", "B", "C", String(repeating: "x", count: 41)])]), .optionTooLong("a"))
        XCTAssertEqual(error([makeQuestion("a", fact: "  ")]), .emptyText("a"))
        XCTAssertEqual(error([makeQuestion("a", fact: String(repeating: "x", count: 161))]), .factTooLong("a"))
        XCTAssertNil(error([makeQuestion("a"), makeQuestion("b", fact: "Факт")]))
    }

    func testPickAvoidsRecent() throws {
        let bank = try QuestionBank(questions: (1...10).map { makeQuestion("q\($0)") })
        var rng = SeededGenerator(seed: 1)
        let picked = bank.pick(count: 7, avoiding: ["q1", "q2", "q3"], using: &rng).map(\.id)
        XCTAssertEqual(picked.count, 7)
        XCTAssertEqual(Set(picked).count, 7)
        XCTAssertTrue(Set(picked).isDisjoint(with: ["q1", "q2", "q3"]))
    }

    func testPickRefillsFromOldestRecent() throws {
        let bank = try QuestionBank(questions: (1...8).map { makeQuestion("q\($0)") })
        var rng = SeededGenerator(seed: 1)
        // Свіжих лише 5, бракує 2 — беремо найдавніші з recent: q1, q2.
        let picked = bank.pick(count: 7, avoiding: ["q1", "q2", "q3"], using: &rng).map(\.id)
        XCTAssertEqual(picked.count, 7)
        XCTAssertEqual(Array(picked.suffix(2)), ["q1", "q2"])
        XCTAssertFalse(picked.contains("q3"))
    }

    func testPickWhenBankTooSmall() throws {
        let bank = try QuestionBank(questions: (1...3).map { makeQuestion("q\($0)") })
        var rng = SeededGenerator(seed: 1)
        XCTAssertEqual(bank.pick(count: 7, avoiding: [], using: &rng).count, 3)
    }

    func testShuffleKeepsCorrectAnswer() {
        let q = makeQuestion("a", options: ["A", "B", "C", "D"], correctIndex: 2)
        for seed in 0..<50 as Range<UInt64> {
            var rng = SeededGenerator(seed: seed)
            let round = RoundQuestion(q, using: &rng)
            XCTAssertEqual(Set(round.options), Set(q.options))
            XCTAssertEqual(round.options[round.correctIndex], "C")
        }
    }
}
