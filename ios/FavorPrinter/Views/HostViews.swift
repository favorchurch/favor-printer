import SwiftUI

// The Printer Host screen: whether this iPad can print for the cloud relay, and enrollment.
// It shows states and counts only, never ZPL, label text, names or the relay credential.

struct HostStatusView: View {
    let host: HostController
    @State private var code = ""
    @State private var confirmingUnenroll = false

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
            enrollmentSection
            #if DEBUG
            if host.fakeRelay != nil {
                Section("Test build") {
                    Button("Print synthetic test label") { Task { await host.printSyntheticTestLabel() } }
                        .accessibilityLabel("Print synthetic test label")
                        .accessibilityIdentifier("host-synthetic-label")
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
            HostRow(title: "Spool", value: "\(host.status.spoolDepth)", id: "host-spool")
            HostRow(title: "Last job", value: lastJobText, id: "host-last-job")
            HostRow(title: "Last error", value: host.status.lastError ?? "None", id: "host-last-error")
        }
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
            Section("Enrollment") { ProgressView().accessibilityLabel("Checking enrollment") }
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
