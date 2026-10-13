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
    private let now: @Sendable () -> Date
    private var automaticRefreshPausedUntil: Date?

    init(
        api: any DeviceAPI,
        secrets: any SecretStore,
        records: any DeviceRecordStore,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.api = api
        self.secrets = secrets
        self.records = records
        self.now = now
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
        // Registering over a live grant would overwrite its secret and strand that grant.
        guard !isBusy, state == .unregistered else { return }
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
    /// Automatic callers (polling) are held back after a throttled or unavailable response.
    func refresh(automatic: Bool = false) async {
        guard !isBusy else { return }
        if automatic, let until = automaticRefreshPausedUntil, now() < until { return }
        guard let token = (try? secrets.read()) ?? nil else {
            // The credential vanished locally: same teardown as a 401, keeping the label for the screen.
            if let grant = currentGrant { markRevoked(label: grant.label) }
            return
        }
        isBusy = true
        defer { isBusy = false }
        do {
            let grant = try await api.status(token: token)
            // The credential may have been wiped or replaced while the request was in flight.
            guard (try? secrets.read()) == token else { return }
            apply(grant)
            notice = nil
            automaticRefreshPausedUntil = nil
        } catch {
            guard (try? secrets.read()) == token else { return }
            pauseAutomaticRefresh(after: error)
            report(error)
        }
    }

    private func pauseAutomaticRefresh(after error: Error) {
        guard case .server(_, let code)? = error as? APIError else { return }
        switch code {
        case .throttled: automaticRefreshPausedUntil = now().addingTimeInterval(10 * 60)
        case .unavailable: automaticRefreshPausedUntil = now().addingTimeInterval(60)
        default: break
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

    /// Runs an authenticated call with the stored secret. Only an approved grant may call: pending,
    /// revoked and unregistered states make no request. Failures go through `report(_:)`.
    func withCredential<T: Sendable>(_ call: (String, DeviceGrant) async throws -> T) async throws -> T {
        guard case .approved(let grant) = state, let token = (try? secrets.read()) ?? nil else {
            throw CheckinFailure.notApproved
        }
        do {
            let value = try await call(token, grant)
            // The credential may have been wiped or replaced while the request was in flight.
            guard (try? secrets.read()) == token, case .approved = state else { throw CheckinFailure.notApproved }
            return value
        } catch let error as APIError {
            if (try? secrets.read()) == token { report(error) }
            throw CheckinFailure.api(error)
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
