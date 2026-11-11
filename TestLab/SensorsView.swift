import SwiftUI
import CoreMotion
import Observation

@Observable
final class MotionModel {
    var isAvailable = false
    var isRunning = false
    var gravity = (x: 0.0, y: 0.0, z: 0.0)
    var acceleration = (x: 0.0, y: 0.0, z: 0.0)
    var rotationRate = (x: 0.0, y: 0.0, z: 0.0)
    var pitch = 0.0
    var roll = 0.0
    var yaw = 0.0

    private let manager = CMMotionManager()

    init() {
        isAvailable = manager.isDeviceMotionAvailable
    }

    func start() {
        guard manager.isDeviceMotionAvailable, !manager.isDeviceMotionActive else { return }
        manager.deviceMotionUpdateInterval = 1.0 / 30.0
        manager.startDeviceMotionUpdates(to: .main) { [weak self] motion, _ in
            guard let self, let motion else { return }
            self.gravity = (motion.gravity.x, motion.gravity.y, motion.gravity.z)
            self.acceleration = (motion.userAcceleration.x, motion.userAcceleration.y, motion.userAcceleration.z)
            self.rotationRate = (motion.rotationRate.x, motion.rotationRate.y, motion.rotationRate.z)
            self.pitch = motion.attitude.pitch
            self.roll = motion.attitude.roll
            self.yaw = motion.attitude.yaw
        }
        isRunning = true
    }

    func stop() {
        manager.stopDeviceMotionUpdates()
        isRunning = false
    }
}

struct SensorsView: View {
    @State private var motion = MotionModel()

    var body: some View {
        NavigationStack {
            List {
                if !motion.isAvailable {
                    Section {
                        Label("Сенсори руху недоступні (симулятор їх не має — запусти на справжньому айфоні).",
                              systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    }
                }

                Section("Рівень (поклади телефон на стіл)") {
                    LevelBubble(x: motion.gravity.x, y: motion.gravity.y)
                        .frame(height: 220)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }

                Section("Орієнтація, °") {
                    valueRow("Pitch (нахил)", degrees(motion.pitch))
                    valueRow("Roll (крен)", degrees(motion.roll))
                    valueRow("Yaw (поворот)", degrees(motion.yaw))
                }

                Section("Прискорення користувача, g") {
                    vectorRow(motion.acceleration)
                }

                Section("Гіроскоп, рад/с") {
                    vectorRow(motion.rotationRate)
                }
            }
            .monospacedDigit()
            .navigationTitle("Сенсори")
            .toolbar {
                Button(motion.isRunning ? "Пауза" : "Старт") {
                    motion.isRunning ? motion.stop() : motion.start()
                }
                .disabled(!motion.isAvailable)
            }
            .onAppear { motion.start() }
            .onDisappear { motion.stop() }
        }
    }

    private func degrees(_ radians: Double) -> Double { radians * 180 / .pi }

    private func valueRow(_ title: String, _ value: Double) -> some View {
        LabeledContent(title, value: value.formatted(.number.precision(.fractionLength(1))))
    }

    private func vectorRow(_ v: (x: Double, y: Double, z: Double)) -> some View {
        Group {
            valueRow("X", v.x)
            valueRow("Y", v.y)
            valueRow("Z", v.z)
        }
    }
}

/// Пухирець, як у будівельному рівні: зміщується в бік, куди нахилений телефон.
struct LevelBubble: View {
    let x: Double
    let y: Double

    var body: some View {
        GeometryReader { geo in
            let size = min(geo.size.width, geo.size.height)
            let radius = size / 2
            let bubble: CGFloat = 44
            let maxOffset = radius - bubble / 2
            let dx = CGFloat(-x).clamped(to: -1...1) * maxOffset
            let dy = CGFloat(y).clamped(to: -1...1) * maxOffset
            let isLevel = abs(x) < 0.02 && abs(y) < 0.02

            ZStack {
                Circle().stroke(.secondary, lineWidth: 2)
                Circle().stroke(.secondary.opacity(0.4), lineWidth: 1).frame(width: bubble + 8)
                Circle()
                    .fill(isLevel ? Color.green : Color.accentColor)
                    .frame(width: bubble, height: bubble)
                    .offset(x: dx, y: dy)
                    .animation(.interactiveSpring, value: dx)
                    .animation(.interactiveSpring, value: dy)
            }
            .frame(width: size, height: size)
            .position(x: geo.size.width / 2, y: geo.size.height / 2)
        }
    }
}

private extension Comparable {
    func clamped(to range: ClosedRange<Self>) -> Self {
        min(max(self, range.lowerBound), range.upperBound)
    }
}

#Preview {
    SensorsView()
}
