import Foundation

struct OpponentAnswer: Equatable, Sendable {
    let optionIndex: Int
    /// Скільки секунд лишалося на таймері в момент відповіді.
    let timeLeft: Double
}

/// Суперник у матчі. Зараз це бот; пізніше — онлайн-гравець (наприклад, через Game Center),
/// і `MatchEngine` при цьому не зміниться.
protocol Opponent: AnyObject {
    var name: String { get }
    var avatar: String { get }

    /// Чекає відповідь суперника на питання. Повертає `nil`, якщо суперник не відповів у межах
    /// `timeLimit` секунд. Має завершуватися швидко, коли поточну задачу скасовано.
    func answer(to question: RoundQuestion, timeLimit: Double) async -> OpponentAnswer?
}

struct BotConfig: Equatable {
    var name = "Кіноман"
    var avatar = "🍿"
    /// Імовірність правильної відповіді.
    var accuracy = 0.7
    /// Діапазон часу на відповідь, с.
    var answerTime: ClosedRange<Double> = 3...7
}

final class BotOpponent: Opponent {
    struct Plan: Equatable {
        let optionIndex: Int
        let delay: Double
    }

    let config: BotConfig
    private var rng: SeededGenerator

    var name: String { config.name }
    var avatar: String { config.avatar }

    init(config: BotConfig = BotConfig(), seed: UInt64? = nil) {
        self.config = config
        self.rng = seed.map(SeededGenerator.init(seed:)) ?? SeededGenerator()
    }

    /// Вирішує, що і коли відповість бот. Хибна відповідь — випадкова з неправильних.
    func plan(for question: RoundQuestion) -> Plan {
        let delay = Double.random(in: config.answerTime, using: &rng)
        let isCorrect = Double.random(in: 0..<1, using: &rng) < config.accuracy
        let wrong = question.options.indices.filter { $0 != question.correctIndex }
        let index = isCorrect ? question.correctIndex : (wrong.randomElement(using: &rng) ?? question.correctIndex)
        return Plan(optionIndex: index, delay: delay)
    }

    func answer(to question: RoundQuestion, timeLimit: Double) async -> OpponentAnswer? {
        let plan = plan(for: question)
        guard plan.delay < timeLimit else { return nil }
        do {
            try await Task.sleep(for: .seconds(plan.delay))
        } catch {
            return nil
        }
        return OpponentAnswer(optionIndex: plan.optionIndex, timeLeft: timeLimit - plan.delay)
    }
}

/// Простий детермінований генератор (SplitMix64), щоб поведінку бота можна було відтворити в тестах.
struct SeededGenerator: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed
    }

    init() {
        state = UInt64.random(in: .min ... .max)
    }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
