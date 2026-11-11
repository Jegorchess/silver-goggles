import SwiftUI
import UIKit

struct HomeView: View {
    @AppStorage("tapCount") private var tapCount = 0

    private var device: UIDevice { UIDevice.current }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(spacing: 16) {
                        Text("\(tapCount)")
                            .font(.system(size: 72, weight: .bold, design: .rounded))
                            .contentTransition(.numericText())
                        HStack(spacing: 12) {
                            Button("Скинути", role: .destructive) {
                                withAnimation { tapCount = 0 }
                            }
                            .buttonStyle(.bordered)
                            Button {
                                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                                withAnimation { tapCount += 1 }
                            } label: {
                                Label("Натисни", systemImage: "hand.tap")
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical)
                } header: {
                    Text("Лічильник (зберігається між запусками)")
                }

                Section("Пристрій") {
                    row("Модель", device.model)
                    row("Система", "\(device.systemName) \(device.systemVersion)")
                    row("Імʼя", device.name)
                    row("Мова", Locale.current.identifier)
                }
            }
            .navigationTitle("TestLab")
        }
    }

    private func row(_ title: String, _ value: String) -> some View {
        LabeledContent(title, value: value)
    }
}

#Preview {
    HomeView()
}
