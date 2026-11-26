import SwiftUI

struct RootView: View {
    let host: HostController
    let updates: UpdateChecker
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("firstRunOnboardingCompleted") private var onboardingCompleted = false
    @State private var showingOnboarding = false
    @State private var decidedInitialRoute = false
    @State private var resetUITestCompletion = false

    var body: some View {
        NavigationStack {
            Group {
                if showingOnboarding {
                    OnboardingView(
                        host: host,
                        onFinish: {
                            onboardingCompleted = true
                            showingOnboarding = false
                        },
                        onExit: { showingOnboarding = false }
                    )
                } else {
                    HostStatusView(host: host, updates: updates)
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("Setup guide") { showingOnboarding = true }
                                    .accessibilityLabel("Open setup guide")
                                    .accessibilityIdentifier("setup-guide-button")
                            }
                        }
                }
            }
        }
            .onChange(of: scenePhase, initial: true) { _, phase in host.scenePhaseChanged(phase) }
            .task { decideInitialRoute() }
            // The update check runs on its own schedule while the app is in the foreground. The host loop does not wait for it.
            .task(id: scenePhase == .active) {
                if scenePhase == .active { await updates.runWhileForeground() }
            }
            .onChange(of: host.enrollment) { _, _ in decideInitialRoute() }
    }

    private func decideInitialRoute() {
        #if DEBUG
        if !resetUITestCompletion, ProcessInfo.processInfo.arguments.contains(UITestHarness.resetOnboardingFlag) {
            onboardingCompleted = false
            resetUITestCompletion = true
        } else if !ProcessInfo.processInfo.arguments.contains(UITestHarness.resetOnboardingFlag),
                  !ProcessInfo.processInfo.arguments.contains(UITestHarness.respectOnboardingFlag),
                  UITestHarness.isActive {
            onboardingCompleted = true
        }
        #endif
        guard !decidedInitialRoute, host.enrollment != .launching else { return }
        decidedInitialRoute = true
        if host.enrollment == .enrolled || host.enrollment == .fakeRelay {
            onboardingCompleted = true
        } else if !onboardingCompleted {
            showingOnboarding = true
        }
    }
}

struct ConfigErrorView: View {
    let message: String

    var body: some View {
        ContentUnavailableView("Cannot start", systemImage: "exclamationmark.triangle", description: Text(message))
    }
}
