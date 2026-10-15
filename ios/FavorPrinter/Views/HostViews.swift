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
        List {
            if let error = host.error {
                Section {
                    Text(error.message).foregroundStyle(.red).accessibilityIdentifier("host-error")
                    if error == .authRejected {
                        Button("Try again") { host.retryAfterAuthError() }
                            .accessibilityLabel("Try the relay again")
                            .accessibilityIdentifier("host-retry")
                    }
                }
            }
            printerSection
            hostSection
            keepAliveSection
            enrollmentSection
            #if DEBUG
            if host.backgroundExperimentEnabledForDisplay {
                Section("Background experiment") {
                    experimentRow("Backgrounded at", host.backgroundExperiment.backgroundedAt)
                    ForEach(host.backgroundExperiment.jobs.indices, id: \.self) { index in
                        let job = host.backgroundExperiment.jobs[index]
                        HostRow(
                            title: "Job sent, \(job.outcome)",
                            value: job.at.formatted(date: .abbreviated, time: .shortened),
                            id: "host-experiment-job-\(job.at.timeIntervalSince1970)"
                        )
                    }
                    experimentRow("Background task expired", host.backgroundExperiment.expiredAt)
                    experimentRow("Last background heartbeat", host.backgroundExperiment.lastHeartbeatAt)
                    experimentRow("Returned to foreground", host.backgroundExperiment.returnedToForegroundAt)
                    ForEach(host.backgroundExperiment.audioEvents.indices, id: \.self) { index in
                        let event = host.backgroundExperiment.audioEvents[index]
                        HostRow(
                            title: event.name.prefix(1).uppercased() + event.name.dropFirst(),
                            value: event.at.formatted(date: .abbreviated, time: .standard),
                            id: "host-experiment-audio-\(index)"
                        )
                    }
                }
            }
            Section("Printer diagnostics") {
                if let diagnostic = host.status.driverDiagnostic {
                    Text(diagnostic)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .accessibilityIdentifier("host-driver-diagnostic")
                }
                Button("Read printer status (~HS)") {
                    Task { printerReading = await host.readPrinterStatus() }
                }
                .disabled(host.isReadingPrinterStatus)
                .accessibilityLabel("Read printer status")
                .accessibilityIdentifier("host-read-status")
                if let printerReading {
                    Text(printerReading.summary)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .accessibilityIdentifier("host-status-reading")
                }
            }
            if host.fakeRelay != nil {
                Section("Test build") {
                    Button("Print synthetic test label") { Task { await host.printSyntheticTestLabel() } }
                        .accessibilityLabel("Print synthetic test label")
                        .accessibilityIdentifier("host-synthetic-label")
                    Button("Print large synthetic label") { Task { await host.printLargeSyntheticTestLabel() } }
                        .accessibilityLabel("Print large synthetic label")
                        .accessibilityIdentifier("host-synthetic-label-large")
                }
            }
            #endif
        }
        .navigationTitle("Printer host")
        .task {
            // The loop reports the printer only while it runs; poll gently otherwise, as the pending screen does.
            while !Task.isCancelled {
                await host.refreshPrinter()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

#if DEBUG
    @ViewBuilder
    private func experimentRow(_ title: String, _ date: Date?) -> some View {
        HostRow(title: title, value: date?.formatted(date: .abbreviated, time: .shortened) ?? "None", id: "host-experiment-\(title)")
    }
#endif

    // MARK: Printer

    private var printerSection: some View {
        Section("Printer") {
            HostRow(title: "Printer", value: printerText, id: "host-printer")
            HostRow(title: "Driver", value: driverText, id: "host-driver")
            if let hint = driverHint {
                Text(hint).font(.caption).accessibilityIdentifier("host-driver-hint")
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
        switch host.status.driver {
        case .running: nil
        case .printerPresentDriverNotRunning:
            "Turn on Settings > Favor Printer > Drivers, then unplug and replug the printer. Replug after enabling."
        case .unknown, nil: "Attach the printer to check."
        }
    }

    // MARK: Host

    private var hostSection: some View {
        Section("Host") {
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
    private var keepAliveSection: some View {
        if let preference = host.keepAlivePreference {
            @Bindable var preference = preference
            Section {
                Toggle("Keep running in background", isOn: $preference.isEnabled)
                    .accessibilityIdentifier("keep-alive-toggle")
                HostRow(title: "Keep-alive", value: keepAliveText(enabled: preference.isEnabled), id: "keep-alive-status")
            } footer: {
                Text("Plays silent audio while the app is in the background so printing continues. Internal builds only.")
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

    // MARK: Enrollment

    @ViewBuilder
    private var enrollmentSection: some View {
        switch host.enrollment {
        case .launching:
            Section("Enrollment") { ProgressView().accessibilityLabel("Reading enrollment") }
        case .notEnrolled:
            Section {
                HostRow(title: "Status", value: "Not enrolled", id: "host-enrollment")
                TextField("One-time code", text: $code)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .accessibilityLabel("One-time enrollment code")
                    .accessibilityIdentifier("enroll-code-field")
                Button("Enroll") { enroll() }
                    .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || host.isEnrolling)
                    .accessibilityLabel("Enroll this printer")
                    .accessibilityIdentifier("enroll-button")
            } header: {
                Text("Enrollment")
            } footer: {
                Text("An admin makes a one-time code for this printer in Favor RSVP.")
            }
        case .enrolled:
            Section("Enrollment") {
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
            Section("Enrollment") { HostRow(title: "Status", value: "Fake relay (test build)", id: "host-enrollment") }
        }
    }

    private func enroll() {
        let entered = code
        Task {
            if await host.enroll(code: entered) == nil { code = "" }
        }
    }
}

private struct HostRow: View {
    let title: String
    let value: String
    let id: String

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            Text(value).foregroundStyle(.secondary).multilineTextAlignment(.trailing).accessibilityIdentifier(id)
        }
    }
}
