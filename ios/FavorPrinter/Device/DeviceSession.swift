import Foundation
import Observation

enum DeviceState: Equatable, Sendable {
    case launching
    case unregistered
    case pending(DeviceGrant)
    case approved(DeviceGrant)
    /// Terminal for the old credential: the secret is wiped and the iPad must register again.
    case revoked(label: String?)
}

/// Owns the device grant lifecycle (docs/native-api/v1.md). The bearer secret goes straight to the
/// secret store; nothing here keeps it in a property.
@MainActor
@Observable
final class DeviceSession {
    private(set) var state: DeviceState = .launching
    private(set) var isBusy = false
    private(set) var notice: String?

    private let api: any DeviceAPI
    private let secrets: any SecretStore
    private let records: any DeviceRecordStore

    init(api: any DeviceAPI, secrets: any SecretStore, records: any DeviceRecordStore) {
        self.api = api
        self.secrets = secrets
        self.records = records
    }

    /// Restores state after launch, then checks the server when a credential exists.
    func start() async {
        let record = records.load()
        if record?.revoked == true {
            // A previous wipe may have failed; make sure no credential survives a revoked record.
            wipeSecret()
            state = .revoked(label: record?.grant?.label)
            return
        }
        guard (try? secrets.read()) != nil else {
            records.clear()
            state = .unregistered
            return
        }
        if let grant = record?.grant { state = Self.state(for: grant) }
        await refresh()
    }

    func register(campusId: Int, label: String) async {
        guard !isBusy else { return }
        isBusy = true
        notice = nil
        defer { isBusy = false }
        do {
            let registration = try await api.register(campusId: campusId, label: label)
            do {
                try secrets.write(registration.token)
            } catch {
                notice = "Could not save the device key on this iPad. Try again."
                return
            }
            apply(registration.grant)
        } catch let error as APIError {
            notice = error.message
        } catch {
            notice = APIError.transport.message
        }
    }

    /// Asks the server for the current status. Pending, approved and revoked all arrive as 200.
    func refresh() async {
        guard !isBusy else { return }
        guard let token = (try? secrets.read()) ?? nil else {
            if case .pending = state { markRevoked(label: nil) }
            else if case .approved = state { markRevoked(label: nil) }
            return
        }
        isBusy = true
        defer { isBusy = false }
        do {
            apply(try await api.status(token: token))
            notice = nil
        } catch {
            report(error)
        }
    }

    /// Single entry point for any API failure on an authenticated call. A 401 or revoked response
    /// wipes the secret and returns to the revoked state; other failures keep the credential.
    func report(_ error: Error) {
        guard let error = error as? APIError else {
            notice = APIError.transport.message
            return
        }
        if error.invalidatesCredential {
            markRevoked(label: currentLabel)
        } else if case .server(_, .devicePending) = error, let grant = currentGrant {
            state = .pending(grant)
        } else {
            notice = error.message
        }
    }

    /// Leaves the revoked screen. The old credential is already gone.
    func registerAgain() {
        wipeSecret()
        records.clear()
        notice = nil
        state = .unregistered
    }

    // MARK: - Internals

    private var currentGrant: DeviceGrant? {
        switch state {
        case .pending(let grant), .approved(let grant): grant
        default: nil
        }
    }

    private var currentLabel: String? {
        if case .revoked(let label) = state { return label }
        return currentGrant?.label
    }

    private static func state(for grant: DeviceGrant) -> DeviceState {
        switch grant.status {
        case .pending: .pending(grant)
        case .approved: .approved(grant)
        case .revoked: .revoked(label: grant.label)
        }
    }

    private func apply(_ grant: DeviceGrant) {
        if grant.status == .revoked {
            markRevoked(label: grant.label)
            return
        }
        records.save(DeviceRecord(grant: grant, revoked: false))
        state = Self.state(for: grant)
    }

    private func markRevoked(label: String?) {
        // Record first so a failed wipe is retried on the next launch.
        records.save(DeviceRecord(grant: currentGrant, revoked: true))
        wipeSecret()
        notice = nil
        state = .revoked(label: label)
    }

    private func wipeSecret() {
        try? secrets.delete()
    }
}
