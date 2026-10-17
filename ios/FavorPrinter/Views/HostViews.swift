import SwiftUI

// The Printer Host screen: whether this iPad can print for the cloud relay, and enrollment.
// It shows states and counts only, never ZPL, label text, names or the relay credential.

struct HostStatusView: View {
    let host: HostController
    @State private var code = ""
    @State private var confirmingUnenroll = false
    #if DEBUG
    @State private var printerReading: PrinterStatusReading?
    #endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FavorSpace.medium) {
                headlineCard
                if let error = host.error { errorCard(error) }
                printerCard
                hostCard
                keepAliveCard
                enrollmentCard
                #if DEBUG
                debugSections
                #endif
            }
            .padding(.horizontal, FavorSpace.medium)
            .padding(.vertical, FavorSpace.medium)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .background(FavorColor.paper.ignoresSafeArea())
        .navigationTitle("Printer host")
        .task {
            // The loop reports the printer only while it runs; poll gently otherwise, as the pending screen does.
            while !Task.isCancelled {
                await host.refreshPrinter()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private var headlineCard: some View {
        FavorCard {
            VStack(alignment: .leading, spacing: FavorSpace.small) {
                Text(headline.title)
                    .font(FavorType.display(30))
                    .foregroundStyle(FavorColor.ink)
                    .accessibilityIdentifier("host-headline")
                Text(headline.detail)
                    .font(FavorType.utility())
                    .foregroundStyle(FavorColor.mutedInk)
                FavorStatusBadge(status: headline.badge)
            }
        }
    }

    private var headline: Headline {
        if host.error != nil { return Headline(title: "Needs attention", detail: "Check the message below and try again.", badge: .attention) }
        if host.status.driver != .running || host.status.printerAttached != true {
            return Headline(title: "Needs attention", detail: "Check the printer connection and driver.", badge: .attention)
        }
        if host.enrollment == .notEnrolled { return Headline(title: "Not enrolled", detail: "Add this printer in Favor RSVP to start printing.", badge: .unavailable) }
        if host.isLoopRunning { return Headline(title: "Ready", detail: "This iPad is connected and ready to print.", badge: .ready) }
        return Headline(title: "Paused", detail: "Printing resumes when this app is active.", badge: .unavailable)
    }

    private func errorCard(_ error: HostError) -> some View {
        FavorCard {
            VStack(alignment: .leading, spacing: FavorSpace.small) {
                Text(error.message)
                    .font(FavorType.utility())
                    .foregroundStyle(FavorColor.warning)
                    .accessibilityIdentifier("host-error")
                if error == .authRejected {
                    Button("Try again") { host.retryAfterAuthError() }
                        .buttonStyle(FavorPrimaryButtonStyle())
                        .accessibilityLabel("Try the relay again")
                        .accessibilityIdentifier("host-retry")
                }
            }
        }
    }

    private var printerCard: some View {
        card("Printer") {
            HostRow(title: "Printer", value: printerText, id: "host-printer")
            HostRow(title: "Driver", value: driverText, id: "host-driver")
            if let driverHint {
                Text(driverHint)
                    .font(FavorType.utility(14))
                    .foregroundStyle(FavorColor.mutedInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("host-driver-hint")
            }
        }
    }

    private var printerText: String {
        host.status.printerAttached == true ? "Attached" : "Not seen"
    }

    private var driverText: String {
        switch host.status.driver {
        case .running: "Running"
        case .printerPresentDriverNotRunning: "Printer seen, driver not running"
        case .unknown, nil: "Unknown"
        }
    }

    private var driverHint: String? {
        guard host.status.driver != .running else { return nil }
        let printerWasSeen = host.status.printerAttached == true || host.status.driver == .printerPresentDriverNotRunning
        let stepID: SetupStepID = printerWasSeen ? .driver : .cable
        return host.setupSteps.first { $0.id == stepID }?.instructions.joined(separator: " ") ?? "Connect the printer to check the driver."
    }

    private var hostCard: some View {
        card("Host") {
            HostRow(title: "Host", value: host.isLoopRunning ? "Running" : "Paused", id: "host-running")
            if host.status.printerMoved {
                HostRow(title: "Printer", value: "Printer moved to another host", id: "host-printer-moved")
            }
            HostRow(title: "Spool", value: "\(host.status.spoolDepth)", id: "host-spool")
            HostRow(title: "Last job", value: lastJobText, id: "host-last-job")
            HostRow(title: "Last error", value: host.status.lastError ?? "None", id: "host-last-error")
        }
    }

    @ViewBuilder
    private var keepAliveCard: some View {
        if let preference = host.keepAlivePreference {
            @Bindable var preference = preference
            card("Background printing") {
                Toggle("Keep running in background", isOn: $preference.isEnabled)
                    .accessibilityIdentifier("keep-alive-toggle")
                HostRow(title: "Keep-alive", value: keepAliveText(enabled: preference.isEnabled), id: "keep-alive-status")
                if let note = host.setupSteps.first(where: { $0.id == .background })?.instructions.first,
                   host.isKeepAliveInterrupted {
                    Text(note)
                        .font(FavorType.utility(14))
                        .foregroundStyle(FavorColor.warning)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("keep-alive-interruption-note")
                }
            }
        }
    }

    private func keepAliveText(enabled: Bool) -> String {
        if host.isKeepAliveAudioActive { return "Active (silent audio playing)" }
        return enabled ? "On, starts when the app is in the background" : "Off, printing pauses in the background"
    }

    private var lastJobText: String {
        guard let outcome = host.status.lastJobOutcome, let at = host.status.lastJobAt else { return "None yet" }
        let name: String
        switch outcome {
        case .sent: name = "Sent"
        case .failed: name = "Failed"
        case .ambiguous: name = "Unknown, may have printed"
        }
        return "\(name), \(at.formatted(date: .abbreviated, time: .shortened))"
    }

    private var enrollmentHelp: String {
        host.setupSteps.first { $0.id == .enrollment }?.instructions.joined(separator: " ")
            ?? "An RSVP admin creates a one-time code in the printing panel. Enter that code here to connect this iPad."
    }

    @ViewBuilder
    private var enrollmentCard: some View {
        switch host.enrollment {
        case .launching:
            card("Enrollment") { ProgressView().accessibilityLabel("Reading enrollment") }
        case .notEnrolled:
            card("Enrollment") {
                HostRow(title: "Status", value: "Not enrolled", id: "host-enrollment")
                Text(enrollmentHelp)
                    .font(FavorType.utility(14))
                    .foregroundStyle(FavorColor.mutedInk)
                    .fixedSize(horizontal: false, vertical: true)
                TextField("One-time code", text: $code)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .accessibilityLabel("One-time enrollment code")
                    .accessibilityIdentifier("enroll-code-field")
                Button("Enroll") { enroll() }
                    .buttonStyle(FavorPrimaryButtonStyle())
                    .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || host.isEnrolling)
                    .accessibilityLabel("Enroll this printer")
                    .accessibilityIdentifier("enroll-button")
            }
        case .enrolled:
            card("Enrollment") {
                HostRow(title: "Status", value: host.printerName.map { "Enrolled, \($0)" } ?? "Enrolled", id: "host-enrollment")
                if let from = host.handedOverFrom {
                    HostRow(title: "Handover", value: from.summary, id: "host-handed-over-from")
                }
                Button("Unenroll", role: .destructive) { confirmingUnenroll = true }
                    .accessibilityLabel("Unenroll this printer")
                    .accessibilityIdentifier("unenroll-button")
                    .confirmationDialog("Unenroll this printer?", isPresented: $confirmingUnenroll, titleVisibility: .visible) {
                        Button("Unenroll", role: .destructive) { Task { await host.unenroll() } }
                            .accessibilityIdentifier("unenroll-confirm")
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("This iPad stops printing for the relay until it is enrolled again.")
                    }
            }
        case .fakeRelay:
            card("Enrollment") { HostRow(title: "Status", value: "Fake relay (test build)", id: "host-enrollment") }
        }
    }

    #if DEBUG
    @ViewBuilder
    private var debugSections: some View {
        if host.backgroundExperimentEnabledForDisplay {
            card("Background experiment") {
                experimentRow("Backgrounded at", host.backgroundExperiment.backgroundedAt)
                ForEach(host.backgroundExperiment.jobs.indices, id: \.self) { index in
                    let job = host.backgroundExperiment.jobs[index]
                    HostRow(title: "Job sent, \(job.outcome)", value: job.at.formatted(date: .abbreviated, time: .shortened), id: "host-experiment-job-\(job.at.timeIntervalSince1970)")
                }
                experimentRow("Background task expired", host.backgroundExperiment.expiredAt)
                experimentRow("Last background heartbeat", host.backgroundExperiment.lastHeartbeatAt)
                experimentRow("Returned to foreground", host.backgroundExperiment.returnedToForegroundAt)
                ForEach(host.backgroundExperiment.audioEvents.indices, id: \.self) { index in
                    let event = host.backgroundExperiment.audioEvents[index]
                    HostRow(title: event.name.prefix(1).uppercased() + event.name.dropFirst(), value: event.at.formatted(date: .abbreviated, time: .standard), id: "host-experiment-audio-\(index)")
                }
            }
        }
        card("Printer diagnostics") {
            if let diagnostic = host.status.driverDiagnostic {
                Text(diagnostic).font(.caption.monospaced()).textSelection(.enabled).accessibilityIdentifier("host-driver-diagnostic")
            }
            Button("Read printer status (~HS)") { Task { printerReading = await host.readPrinterStatus() } }
                .disabled(host.isReadingPrinterStatus)
                .accessibilityLabel("Read printer status")
                .accessibilityIdentifier("host-read-status")
            if let printerReading {
                Text(printerReading.summary).font(.caption.monospaced()).textSelection(.enabled).accessibilityIdentifier("host-status-reading")
            }
        }
        if host.fakeRelay != nil {
            card("Test build") {
                Button("Print synthetic test label") { Task { await host.printSyntheticTestLabel() } }
                    .accessibilityLabel("Print synthetic test label")
                    .accessibilityIdentifier("host-synthetic-label")
                Button("Print large synthetic label") { Task { await host.printLargeSyntheticTestLabel() } }
                    .accessibilityLabel("Print large synthetic label")
                    .accessibilityIdentifier("host-synthetic-label-large")
            }
        }
    }

    private func experimentRow(_ title: String, _ date: Date?) -> some View {
        HostRow(title: title, value: date?.formatted(date: .abbreviated, time: .shortened) ?? "None", id: "host-experiment-\(title)")
    }
    #endif

    private func card<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        FavorCard {
            VStack(alignment: .leading, spacing: FavorSpace.medium) {
                Text(title).font(FavorType.utility(20, weight: .semibold)).foregroundStyle(FavorColor.ink)
                content()
            }
        }
    }

    private func enroll() {
        let entered = code
        Task {
            if await host.enroll(code: entered) == nil { code = "" }
        }
    }
}

private struct Headline {
    let title: String
    let detail: String
    let badge: FavorStatusBadge.Status
}

private struct HostRow: View {
    let title: String
    let value: String
    let id: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: FavorSpace.medium) {
            Text(title).foregroundStyle(FavorColor.ink)
            Spacer(minLength: FavorSpace.small)
            Text(value)
                .foregroundStyle(FavorColor.mutedInk)
                .multilineTextAlignment(.trailing)
                .accessibilityIdentifier(id)
        }
        .font(FavorType.utility())
    }
}
