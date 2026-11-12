import Foundation

/// Картинка з бандла (з Wikimedia Commons) і підпис автора/ліцензії, обовʼязковий за ліцензією.
struct Media: Codable, Hashable {
    /// Шлях у бандлі, напр. `media/frame-gold-rush.jpg`.
    let file: String
    /// «Автор · ліцензія», напр. `Public domain` або `Gage Skidmore · CC BY-SA 3.0`.
    let credit: String
}

/// Актор у питанні «за складом».
struct CastMember: Codable, Hashable {
    let name: String
    let image: Media
}

/// Питання так, як воно лежить у `questions.json`.
struct Question: Codable, Hashable, Identifiable {
    enum Kind: String, Codable {
        /// Звичайне текстове питання.
        case text
        /// Фільм, загаданий емодзі; на екрані над ним підказка «Вгадай фільм».
        case emoji
        /// Кадр із фільму (`image`) — треба вгадати фільм.
        case frame
        /// Фото кількох акторів (`cast`) — треба вгадати фільм, де вони грали разом.
        case cast
    }

    let id: String
    let type: Kind
    let prompt: String
    let options: [String]
    let correctIndex: Int
    /// Цікавий факт або пояснення, яке показується після відповіді. Необовʼязкове.
    let fact: String?
    /// 1 — легке, 2 — середнє, 3 — складне. Немає — вважаємо середнім.
    let difficulty: Int?
    /// Для `frame`.
    let image: Media?
    /// Для `cast`.
    let cast: [CastMember]?

    init(
        id: String,
        type: Kind,
        prompt: String,
        options: [String],
        correctIndex: Int,
        fact: String? = nil,
        difficulty: Int? = nil,
        image: Media? = nil,
        cast: [CastMember]? = nil
    ) {
        self.id = id
        self.type = type
        self.prompt = prompt
        self.options = options
        self.correctIndex = correctIndex
        self.fact = fact
        self.difficulty = difficulty
        self.image = image
        self.cast = cast
    }

    /// Складність для сортування в матчі.
    var level: Int { difficulty ?? 2 }
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
    var image: Media? { question.image }
    var cast: [CastMember]? { question.cast }

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
