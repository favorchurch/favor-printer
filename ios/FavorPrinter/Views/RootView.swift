import SwiftUI

struct RootView: View {
    let host: HostController
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("firstRunOnboardingCompleted") private var onboardingCompleted = false
    @State private var showingOnboarding = false
    @State private var decidedInitialRoute = false
    @State private var resetUITestCompletion = false

    var body: some View {
        NavigationStack {
            Group {
                if showingOnboarding {
                    OnboardingView(host: host) {
                        onboardingCompleted = true
                        showingOnboarding = false
                    }
                } else {
                    HostStatusView(host: host)
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
