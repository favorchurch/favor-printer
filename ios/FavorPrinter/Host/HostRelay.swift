import Foundation

/// What the host loop needs from the cloud relay. `RelayAPIClient` is the real one; `FakeRelay` (DEBUG) is the local one.
protocol HostRelay: Sendable {
    func claim(printerIds: [String], limit: Int) async throws -> RelayClaimResponse
    func heartbeat(_ body: RelayHeartbeatRequest) async throws -> RelayHeartbeatResponse
    func config() async throws -> RelayConfigResponse
    func sending(jobId: String, claimToken: String) async throws -> RelayJobCallResult
    func report(jobId: String, claimToken: String, outcome: RelayReportOutcome, error: String?) async throws -> RelayJobCallResult
}

extension RelayAPIClient: HostRelay {}

/// App and OS versions sent with every heartbeat and at enrollment.
struct HostIdentity: Sendable, Equatable {
    var appVersion: String
    var osVersion: String

    static var current: HostIdentity {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        let os = ProcessInfo.processInfo.operatingSystemVersion
        return HostIdentity(
            appVersion: "\(version) (\(build))",
            osVersion: "iPadOS \(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
        )
    }
}
