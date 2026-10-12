import SwiftUI

struct RootView: View {
    let session: DeviceSession

    var body: some View {
        NavigationStack {
            Group {
                switch session.state {
                case .launching:
                    ProgressView()
                case .unregistered:
                    RegisterView(session: session)
                case .pending(let grant):
                    PendingView(session: session, grant: grant)
                case .approved(let grant):
                    ApprovedView(session: session, grant: grant)
                case .revoked(let label):
                    RevokedView(session: session, label: label)
                }
            }
            .navigationTitle("Favor Printer")
        }
    }
}

struct ConfigErrorView: View {
    let message: String

    var body: some View {
        ContentUnavailableView("Cannot start", systemImage: "exclamationmark.triangle", description: Text(message))
    }
}

struct NoticeText: View {
    let notice: String?

    var body: some View {
        if let notice {
            Text(notice).foregroundStyle(.red).accessibilityIdentifier("notice")
        }
    }
}

struct RegisterView: View {
    let session: DeviceSession
    @State private var campus = ""
    @State private var label = ""

    private var campusId: Int? { Int(campus.trimmingCharacters(in: .whitespaces)) }

    var body: some View {
        Form {
            Section("Register this iPad") {
                TextField("Campus number", text: $campus)
                    .keyboardType(.numberPad)
                TextField("Name, for example Manila Kids iPad 2", text: $label)
                    .textInputAutocapitalization(.words)
            }
            Section {
                Button("Request approval") {
                    guard let campusId else { return }
                    Task { await session.register(campusId: campusId, label: label) }
                }
                .disabled(campusId == nil || label.isEmpty || session.isBusy)
                NoticeText(notice: session.notice)
            } footer: {
                Text("An admin approves this iPad in Favor RSVP before it can check anyone in.")
            }
        }
    }
}

struct PendingView: View {
    let session: DeviceSession
    let grant: DeviceGrant

    var body: some View {
        ContentUnavailableView {
            Label("Waiting for approval", systemImage: "hourglass")
        } description: {
            Text("\(grant.label) is registered. Ask an admin to approve it in Favor RSVP under Devices.")
        } actions: {
            Button("Check again") { Task { await session.refresh() } }
                .disabled(session.isBusy)
            NoticeText(notice: session.notice)
        }
        .task {
            // Poll gently while the screen is visible.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                await session.refresh()
            }
        }
    }
}

struct ApprovedView: View {
    let session: DeviceSession
    let grant: DeviceGrant

    var body: some View {
        ContentUnavailableView {
            Label("Ready", systemImage: "checkmark.seal")
        } description: {
            Text("\(grant.label) is approved for campus \(grant.campusId).")
        } actions: {
            Button("Refresh status") { Task { await session.refresh() } }
                .disabled(session.isBusy)
            NoticeText(notice: session.notice)
        }
    }
}

struct RevokedView: View {
    let session: DeviceSession
    let label: String?

    var body: some View {
        ContentUnavailableView {
            Label("This iPad was removed", systemImage: "xmark.octagon")
        } description: {
            Text("\(label ?? "This iPad") can no longer check anyone in. Register it again to request new approval.")
        } actions: {
            Button("Register again") { session.registerAgain() }
        }
    }
}
