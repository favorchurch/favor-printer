import SwiftUI

struct OnboardingView: View {
    let host: HostController
    let onFinish: () -> Void

    @State private var page: Page = .welcome
    @State private var code = ""

    private enum Page: String, CaseIterable, Identifiable {
        case welcome, driver, cable, enrollment, environment, background, done
        var id: String { rawValue }
        var title: String {
            switch self {
            case .welcome: "Welcome"
            case .driver: "Printer driver"
            case .cable: "Connect the printer"
            case .enrollment: "Enroll this printer"
            case .environment: "Guided Access and Auto-Lock"
            case .background: "Background printing"
            case .done: "You're ready"
            }
        }
    }

    private var pages: [Page] {
        Page.allCases.filter { $0 != .background || step(.background)?.state != .notApplicable }
    }

    private var currentIndex: Int { pages.firstIndex(of: page) ?? 0 }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FavorSpace.medium) {
                Text("SETUP GUIDE  ·  \(currentIndex + 1) OF \(pages.count)")
                    .font(FavorType.utility(12, weight: .semibold))
                    .foregroundStyle(FavorColor.mutedInk)
                    .accessibilityIdentifier("onboarding-progress")
                Text(page.title)
                    .font(FavorType.display(32))
                    .foregroundStyle(FavorColor.ink)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("onboarding-title")

                pageContent

                HStack(spacing: FavorSpace.small) {
                    if currentIndex > 0 {
                        Button("Back") { move(-1) }
                            .accessibilityIdentifier("onboarding-back")
                    }
                    Spacer()
                    if page != .done {
                        Button("Continue") { move(1) }
                            .buttonStyle(FavorPrimaryButtonStyle())
                            .accessibilityLabel("Continue setup")
                            .accessibilityIdentifier("onboarding-continue")
                    } else {
                        Button("Finish setup", action: onFinish)
                            .buttonStyle(FavorPrimaryButtonStyle())
                            .accessibilityLabel("Finish setup and open printer status")
                            .accessibilityIdentifier("onboarding-finish")
                    }
                }
                .padding(.top, FavorSpace.small)
            }
            .padding(FavorSpace.medium)
            .frame(maxWidth: 680, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(FavorColor.paper.ignoresSafeArea())
        .navigationTitle("Setup guide")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private var pageContent: some View {
        switch page {
        case .welcome:
            FavorCard {
                Text("This iPad becomes the campus label printer. Check-in happens in Favor RSVP on other devices.")
                    .font(FavorType.utility())
                    .foregroundStyle(FavorColor.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("onboarding-welcome-copy")
            }
        case .driver:
            stepCard(.driver)
        case .cable:
            stepCard(.cable)
        case .enrollment:
            VStack(alignment: .leading, spacing: FavorSpace.small) {
                stepCard(.enrollment)
                FavorCard {
                    VStack(alignment: .leading, spacing: FavorSpace.small) {
                        Text("One-time code").font(FavorType.utility(18, weight: .semibold)).foregroundStyle(FavorColor.ink)
                        TextField("One-time code", text: $code)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .accessibilityLabel("One-time enrollment code")
                            .accessibilityIdentifier("onboarding-enroll-code")
                        Button("Enroll") { Task { await host.enroll(code: code) } }
                            .buttonStyle(FavorPrimaryButtonStyle())
                            .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || host.isEnrolling)
                            .accessibilityLabel("Enroll this printer")
                            .accessibilityIdentifier("onboarding-enroll-button")
                        if let error = host.error {
                            Text(error.message)
                                .font(FavorType.utility(14))
                                .foregroundStyle(FavorColor.warning)
                                .accessibilityIdentifier("onboarding-enroll-error")
                        }
                    }
                }
            }
        case .environment:
            VStack(alignment: .leading, spacing: FavorSpace.small) {
                stepCard(.guidedAccess)
                stepCard(.autoLock)
            }
        case .background:
            stepCard(.background)
        case .done:
            VStack(alignment: .leading, spacing: FavorSpace.small) {
                ForEach([SetupStepID.cable, .driver, .enrollment, .guidedAccess, .autoLock, .background], id: \.self) { id in
                    if let step = step(id), step.state != .notApplicable { stepCard(step) }
                }
            }
        }
    }

    @ViewBuilder private func stepCard(_ id: SetupStepID) -> some View {
        if let step = step(id) { stepCard(step) }
    }

    private func stepCard(_ step: SetupStep) -> some View {
        FavorCard {
            VStack(alignment: .leading, spacing: FavorSpace.small) {
                HStack(alignment: .firstTextBaseline) {
                    Text(step.title)
                        .font(FavorType.utility(18, weight: .semibold))
                        .foregroundStyle(FavorColor.ink)
                    Spacer()
                    Text(stateLabel(step.state))
                        .font(FavorType.utility(13, weight: .semibold))
                        .foregroundStyle(step.state == .done ? FavorColor.positive : FavorColor.mutedInk)
                        .accessibilityIdentifier("onboarding-step-\(step.id.rawValue)-state")
                }
                Text(step.summary)
                    .font(FavorType.utility(14))
                    .foregroundStyle(FavorColor.mutedInk)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(Array(step.instructions.enumerated()), id: \.offset) { item in
                    Text("•  \(item.element)")
                        .font(FavorType.utility(14))
                        .foregroundStyle(FavorColor.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func step(_ id: SetupStepID) -> SetupStep? {
        host.setupSteps.first { $0.id == id }
    }

    private func move(_ offset: Int) {
        let nextIndex = min(max(currentIndex + offset, 0), pages.count - 1)
        page = pages[nextIndex]
    }

    private func stateLabel(_ state: SetupStepState) -> String {
        switch state {
        case .done: "Done"
        case .actionNeeded: "Action needed"
        case .pending: "Waiting"
        case .manualCheck: "Check by hand"
        case .info: "Optional"
        case .notApplicable: "Not available"
        }
    }
}
