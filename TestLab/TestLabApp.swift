import SwiftUI

@main
struct TestLabApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    var body: some View {
        TabView {
            HomeView()
                .tabItem { Label("Головна", systemImage: "house") }
            SensorsView()
                .tabItem { Label("Сенсори", systemImage: "gyroscope") }
            NotesView()
                .tabItem { Label("Нотатки", systemImage: "note.text") }
        }
    }
}

#Preview {
    ContentView()
}
