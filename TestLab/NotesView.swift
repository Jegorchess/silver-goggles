import SwiftUI

struct Note: Identifiable, Codable, Equatable {
    var id = UUID()
    var text: String
    var date = Date()
}

/// Простий сховок нотаток у UserDefaults у вигляді JSON.
@Observable
final class NotesStore {
    private static let key = "notes.v1"
    private(set) var notes: [Note] = []

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.key),
           let decoded = try? JSONDecoder().decode([Note].self, from: data) {
            notes = decoded
        }
    }

    func add(_ text: String) {
        notes.insert(Note(text: text), at: 0)
        save()
    }

    func delete(at offsets: IndexSet) {
        notes.remove(atOffsets: offsets)
        save()
    }

    func move(from source: IndexSet, to destination: Int) {
        notes.move(fromOffsets: source, toOffset: destination)
        save()
    }

    private func save() {
        if let data = try? JSONEncoder().encode(notes) {
            UserDefaults.standard.set(data, forKey: Self.key)
        }
    }
}

struct NotesView: View {
    @State private var store = NotesStore()
    @State private var draft = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        TextField("Нова нотатка…", text: $draft, axis: .vertical)
                            .focused($isFocused)
                            .onSubmit(add)
                        Button(action: add) {
                            Image(systemName: "plus.circle.fill").font(.title2)
                        }
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }

                Section {
                    if store.notes.isEmpty {
                        Text("Поки порожньо").foregroundStyle(.secondary)
                    }
                    ForEach(store.notes) { note in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(note.text)
                            Text(note.date, format: .dateTime.day().month().hour().minute())
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .onDelete { store.delete(at: $0) }
                    .onMove { store.move(from: $0, to: $1) }
                }
            }
            .navigationTitle("Нотатки")
            .toolbar { EditButton() }
        }
    }

    private func add() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        withAnimation { store.add(text) }
        draft = ""
        isFocused = false
    }
}

#Preview {
    NotesView()
}
