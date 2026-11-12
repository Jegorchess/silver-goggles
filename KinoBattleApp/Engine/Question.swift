import Foundation

/// Питання так, як воно лежить у `questions.json`.
struct Question: Codable, Hashable, Identifiable {
    enum Kind: String, Codable {
        /// Звичайне текстове питання.
        case text
        /// Фільм, загаданий емодзі; на екрані над ним підказка «Вгадай фільм».
        case emoji
    }

    let id: String
    let type: Kind
    let prompt: String
    let options: [String]
    let correctIndex: Int
    /// Цікавий факт або пояснення, яке показується після відповіді. Необовʼязкове.
    let fact: String?
}

/// Питання в конкретному матчі: варіанти перемішані, індекс правильного перераховано.
struct RoundQuestion: Hashable, Identifiable {
    let question: Question
    let options: [String]
    let correctIndex: Int

    var id: String { question.id }
    var prompt: String { question.prompt }
    var type: Question.Kind { question.type }
    var fact: String? { question.fact }

    init<G: RandomNumberGenerator>(_ question: Question, using rng: inout G) {
        let order = Array(question.options.indices).shuffled(using: &rng)
        self.question = question
        self.options = order.map { question.options[$0] }
        self.correctIndex = order.firstIndex(of: question.correctIndex) ?? 0
    }

    /// Без перемішування — для тестів і превʼю.
    init(unshuffled question: Question) {
        self.question = question
        self.options = question.options
        self.correctIndex = question.correctIndex
    }
}
