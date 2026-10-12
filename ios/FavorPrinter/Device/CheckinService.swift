import Foundation
import Network
import Observation

/// Why a check-in call did not produce a result. `message` is safe to show a volunteer.
enum CheckinFailure: Error, Sendable, Equatable {
    /// No network. Check-in is online-only, so nothing is sent and nothing is queued.
    case offline
    /// The grant is not approved (any more), so no request was made or its answer was dropped.
    case notApproved
    case api(APIError)

    static let offlineMessage = "No network connection. Check-in needs a connection, and nothing is saved to send later."

    var message: String {
        switch self {
        case .offline: Self.offlineMessage
        case .notApproved: "This iPad is not approved to check anyone in."
        case .api(let error): error.message
        }
    }

    /// The request may have reached the server before the connection failed.
    var outcomeUnknown: Bool { self == .api(.transport) }
}

@MainActor
protocol Connectivity: AnyObject {
    var isOnline: Bool { get }
}

@MainActor
@Observable
final class NetworkMonitor: Connectivity {
    private(set) var isOnline = true
    @ObservationIgnored private let monitor = NWPathMonitor()

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.isOnline = online }
        }
        monitor.start(queue: DispatchQueue(label: "church.favor.printer.network"))
    }

    deinit { monitor.cancel() }
}

/// Every check-in screen reaches the API through here: it blocks while offline, takes the secret from
/// the device session and routes failures through the session's credential rules.
@MainActor
final class CheckinService {
    let session: DeviceSession
    let api: any CheckinAPI
    let connectivity: any Connectivity

    init(session: DeviceSession, api: any CheckinAPI, connectivity: any Connectivity) {
        self.session = session
        self.api = api
        self.connectivity = connectivity
    }

    var isOnline: Bool { connectivity.isOnline }

    func call<T: Sendable>(_ operation: (any CheckinAPI, String, Int) async throws -> T) async throws -> T {
        guard connectivity.isOnline else { throw CheckinFailure.offline }
        do {
            return try await session.withCredential { [api] token, grant in
                try await operation(api, token, grant.campusId)
            }
        } catch let failure as CheckinFailure {
            throw failure
        } catch {
            throw CheckinFailure.api(.transport)
        }
    }
}
