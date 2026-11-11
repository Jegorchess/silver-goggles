import Foundation

enum MatchRules {
    static let questionsPerMatch = 7
    /// Час на відповідь, с.
    static let questionTime: Double = 10
    /// Пауза між появою питання і варіантів, с.
    static let promptLeadIn: Double = 1
    /// Тривалість розкриття правильної відповіді, с.
    static let revealDuration: Double = 2
    /// Банер «Фінальне питання ×2», с.
    static let finalBannerDuration: Double = 1.5
}

enum Scoring {
    static let basePoints = 500
    static let speedPoints = 500

    /// Множник очок: фінальне питання коштує вдвічі.
    static func multiplier(questionIndex: Int, totalQuestions: Int = MatchRules.questionsPerMatch) -> Int {
        questionIndex == totalQuestions - 1 ? 2 : 1
    }

    /// Очки за відповідь: `round(500 + 500 · t / 10) × k`, де t — залишок таймера з точністю 0,1 с.
    ///
    /// Відповідь приймається лише поки таймер > 0, тож будь-яка прийнята правильна відповідь
    /// дає щонайменше 500 × k. Помилка або тайм-аут (timeLeft == nil чи ≤ 0) — 0.
    static func points(isCorrect: Bool, timeLeft: Double?, multiplier: Int) -> Int {
        guard isCorrect, let timeLeft, timeLeft > 0 else { return 0 }
        let clamped = min(timeLeft, MatchRules.questionTime)
        let tenths = (clamped * 10).rounded(.down) / 10
        let raw = Double(basePoints) + Double(speedPoints) * tenths / MatchRules.questionTime
        return Int(raw.rounded()) * multiplier
    }
}

enum MatchOutcome: String, Codable {
    case win, loss, draw
}

extension MatchOutcome {
    /// Більше очок перемагає; при рівному рахунку — більше правильних; інакше нічия.
    static func decide(playerScore: Int, opponentScore: Int, playerCorrect: Int, opponentCorrect: Int) -> MatchOutcome {
        if playerScore != opponentScore { return playerScore > opponentScore ? .win : .loss }
        if playerCorrect != opponentCorrect { return playerCorrect > opponentCorrect ? .win : .loss }
        return .draw
    }
}
