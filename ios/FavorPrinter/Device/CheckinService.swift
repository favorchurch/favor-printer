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

    /// The request may have reached the server and been acted on even though no usable answer came back:
    /// the connection dropped, the body was unreadable, or a gateway failed after forwarding it.
    var outcomeUnknown: Bool {
        guard case .api(let error) = self else { return false }
        switch error {
        case .transport, .invalidResponse: return true
        case .unexpected(let status, _): return status >= 500
        default: return false
        }
    }
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
            // Delivered on the main queue, so updates apply in the order the system reported them.
            MainActor.assumeIsolated { self?.isOnline = online }
        }
        monitor.start(queue: .main)
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
    private var activeKeys: Set<String> = []

    init(session: DeviceSession, api: any CheckinAPI, connectivity: any Connectivity) {
        self.session = session
        self.api = api
        self.connectivity = connectivity
    }

    var isOnline: Bool { connectivity.isOnline }

    /// Marks a write as in flight. False when the same write is already being sent, even from a screen
    /// the volunteer has since left and reopened, so a second tap never becomes a second request.
    func claim(_ key: String) -> Bool { activeKeys.insert(key).inserted }

    func release(_ key: String) { activeKeys.remove(key) }

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
