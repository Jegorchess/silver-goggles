import Foundation

/// База питань, що поставляється разом із застосунком.
struct QuestionBank {
    static let optionCount = 4
    static let maxPromptLength = 120
    static let maxOptionLength = 40
    static let maxFactLength = 160
    static let difficultyRange = 1...3
    static let castRange = 2...4
    static let maxCastNameLength = 40

    enum ValidationError: Error, Equatable {
        case empty
        case duplicateID(String)
        case wrongOptionCount(String)
        case badCorrectIndex(String)
        case duplicateOptions(String)
        case emptyText(String)
        case promptTooLong(String)
        case optionTooLong(String)
        case factTooLong(String)
        case badDifficulty(String)
        case missingImage(String)
        case badCast(String)
    }

    let questions: [Question]

    init(questions: [Question]) throws {
        try Self.validate(questions)
        self.questions = questions
    }

    init(jsonData: Data) throws {
        try self.init(questions: JSONDecoder().decode([Question].self, from: jsonData))
    }

    /// Завантажує `questions.json` з бандла. Битий файл — помилка розробника, тому падаємо одразу.
    static func bundled(in bundle: Bundle = .main) -> QuestionBank {
        guard let url = bundle.url(forResource: "questions", withExtension: "json") else {
            fatalError("questions.json не знайдено в бандлі")
        }
        do {
            return try QuestionBank(jsonData: Data(contentsOf: url))
        } catch {
            fatalError("questions.json невалідний: \(error)")
        }
    }

    static func validate(_ questions: [Question]) throws {
        guard !questions.isEmpty else { throw ValidationError.empty }
        var seen = Set<String>()
        for q in questions {
            guard seen.insert(q.id).inserted else { throw ValidationError.duplicateID(q.id) }
            guard q.options.count == optionCount else { throw ValidationError.wrongOptionCount(q.id) }
            guard q.options.indices.contains(q.correctIndex) else { throw ValidationError.badCorrectIndex(q.id) }
            guard Set(q.options).count == q.options.count else { throw ValidationError.duplicateOptions(q.id) }
            let texts = [q.prompt] + q.options + (q.fact.map { [$0] } ?? [])
            guard texts.allSatisfy({ !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else {
                throw ValidationError.emptyText(q.id)
            }
            guard q.prompt.count <= maxPromptLength else { throw ValidationError.promptTooLong(q.id) }
            guard q.options.allSatisfy({ $0.count <= maxOptionLength }) else { throw ValidationError.optionTooLong(q.id) }
            guard (q.fact?.count ?? 0) <= maxFactLength else { throw ValidationError.factTooLong(q.id) }
            if let d = q.difficulty, !difficultyRange.contains(d) { throw ValidationError.badDifficulty(q.id) }
            switch q.type {
            case .frame:
                guard let image = q.image, !image.file.isEmpty, !image.credit.isEmpty else { throw ValidationError.missingImage(q.id) }
            case .cast:
                guard let cast = q.cast, castRange.contains(cast.count),
                      cast.allSatisfy({ !$0.name.trimmingCharacters(in: .whitespaces).isEmpty
                                        && $0.name.count <= maxCastNameLength
                                        && !$0.image.file.isEmpty && !$0.image.credit.isEmpty })
                else { throw ValidationError.badCast(q.id) }
            case .text, .emoji:
                break
            }
        }
    }

    /// Обирає `count` питань. Спершу ті, яких немає в `recent`, у випадковому порядку;
    /// якщо їх не вистачає — добирає з `recent`, починаючи з найдавніших.
    /// Обрані питання йдуть від легших до важчих (за `difficulty`), щоб матч розгонився до фіналу.
    /// - Parameter recent: id нещодавно показаних питань, від найстаріших до найновіших.
    func pick<G: RandomNumberGenerator>(count: Int, avoiding recent: [String], using rng: inout G) -> [Question] {
        let recentSet = Set(recent)
        var result = questions.filter { !recentSet.contains($0.id) }.shuffled(using: &rng)
        if result.count >= count {
            result = Array(result.prefix(count))
        } else {
            let byID = Dictionary(uniqueKeysWithValues: questions.map { ($0.id, $0) })
            var added = Set(result.map(\.id))
            for id in recent where result.count < count {
                if let q = byID[id], added.insert(id).inserted {
                    result.append(q)
                }
            }
        }
        return Self.byDifficulty(result)
    }

    /// Стабільне сортування за складністю: при рівній складності порядок не змінюється.
    static func byDifficulty(_ questions: [Question]) -> [Question] {
        questions.enumerated()
            .sorted { ($0.element.level, $0.offset) < ($1.element.level, $1.offset) }
            .map(\.element)
    }
}
