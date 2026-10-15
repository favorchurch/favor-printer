#if DEBUG
import Foundation

/// In-process stand-in for the cloud relay, compiled only in DEBUG. It never touches the network, so a
/// `-FavorHostFakeRelay` launch cannot send anything anywhere. Tests script its failures and read what it recorded.
actor FakeRelay: HostRelay {
    enum Call: Sendable, Equatable { case claim, heartbeat, config, sending, report }

    /// How a scripted call fails. `.stale` is only meaningful for `sending` and `report`.
    enum Failure: Sendable, Equatable {
        case network
        case auth
        case stale
    }

    struct Report: Sendable, Equatable {
        let jobId: String
        let outcome: RelayReportOutcome
        let error: String?
    }

    /// How the fake answers claims once an admin has "handed the printer over".
    enum Handover: Sendable, Equatable {
        /// 403 `printer_handed_over` naming the printer.
        case forbidden
        /// 200 with no jobs and the printer in `handedOverPrinterIds`.
        case listed
    }

    static let printerId = "fake-printer-1"

    private(set) var calls: [Call] = []
    /// Reports the fake accepted, in order.
    private(set) var reports: [Report] = []
    /// Jobs the fake answered `sending` for.
    private(set) var sendingIds: [String] = []
    /// Jobs the fake refused as stale (scripted), which settles them without a report.
    private(set) var staleIds: [String] = []
    private(set) var heartbeats: [RelayHeartbeatRequest] = []
    private(set) var printerEnabled = true
    private var handover: Handover?

    private var queue: [RelayJob]
    private var leased: [String: RelayJob] = [:]
    private var settled: Set<String> = []
    private var script: [Call: [Failure]] = [:]
    private var issued = 0

    /// A fake relay with one small test label waiting.
    static func demo() -> FakeRelay {
        FakeRelay(queue: [RelayJob(
            id: "fake-job-0", printerId: printerId, label: "Fake relay test", copy: 1,
            zpl: "^XA^FO40,40^A0N,48,48^FDFavor fake relay test^FS^XZ", claimToken: "", leaseExpiresAt: "",
            attempt: 0, host: "usb", port: 0
        )])
    }

    init(queue: [RelayJob] = []) {
        self.queue = queue
    }

    @discardableResult
    func enqueue(zpl: String, label: String = "Fake label", id: String? = nil) -> String {
        issued += 1
        let jobId = id ?? "fake-job-\(issued)"
        queue.append(RelayJob(
            id: jobId, printerId: Self.printerId, label: label, copy: 1, zpl: zpl, claimToken: "", leaseExpiresAt: "",
            attempt: 0, host: "usb", port: 0
        ))
        return jobId
    }

    func failNext(_ call: Call, _ failures: Failure...) {
        script[call, default: []].append(contentsOf: failures)
    }

    func clearScript() { script = [:] }

    /// Makes later claims answer as if the printer moved to another host. Nil puts it back.
    func setHandover(_ handover: Handover?) { self.handover = handover }

    func setPrinterEnabled(_ enabled: Bool) { printerEnabled = enabled }

    /// Lease expiry: jobs claimed but never answered `sending` and not in `held` go back in the queue with a new claim token.
    func expireLeases(keeping held: Set<String>) {
        for (id, job) in leased where !held.contains(id) && !sendingIds.contains(id) && !settled.contains(id) {
            leased[id] = nil
            queue.insert(job, at: 0)
        }
    }

    var pendingCount: Int { queue.count }

    /// Ids leased and not yet settled: what the cloud still expects a report for.
    var unsettledIds: Set<String> { Set(leased.keys).subtracting(settled) }

    func claim(printerIds: [String], limit: Int) async throws -> RelayClaimResponse {
        calls.append(.claim)
        try fail(.claim)
        switch handover {
        case .forbidden: throw RelayFailure.printerHandedOver([Self.printerId])
        case .listed: return RelayClaimResponse(jobs: [], rejectedPrinterIds: printerIds, handedOverPrinterIds: [Self.printerId])
        case nil: break
        }
        guard printerIds.contains(Self.printerId) else {
            return RelayClaimResponse(jobs: [], rejectedPrinterIds: printerIds)
        }
        return RelayClaimResponse(jobs: lease(limit), rejectedPrinterIds: [])
    }

    /// Queues one job and leases it right away, without a recorded claim call: setup for a job a previous run held.
    func claimJobs(zpl: String, id: String) -> RelayJob? {
        enqueue(zpl: zpl, id: id)
        return lease(1).first
    }

    private func lease(_ limit: Int) -> [RelayJob] {
        var jobs: [RelayJob] = []
        while jobs.count < limit, !queue.isEmpty {
            let job = queue.removeFirst()
            issued += 1
            let leasedJob = RelayJob(
                id: job.id, printerId: job.printerId, label: job.label, copy: job.copy, zpl: job.zpl,
                claimToken: "token-\(job.id)-\(issued)", leaseExpiresAt: "2099-01-01T00:00:00Z", attempt: job.attempt + 1,
                host: job.host, port: job.port
            )
            leased[job.id] = leasedJob
            jobs.append(leasedJob)
        }
        return jobs
    }

    func heartbeat(_ body: RelayHeartbeatRequest) async throws -> RelayHeartbeatResponse {
        calls.append(.heartbeat)
        try fail(.heartbeat)
        heartbeats.append(body)
        return RelayHeartbeatResponse(
            ok: true, serverTime: "2099-01-01T00:00:00Z",
            printers: [.init(id: Self.printerId, name: "Fake printer", enabled: printerEnabled, host: "usb", port: 0)]
        )
    }

    func config() async throws -> RelayConfigResponse {
        calls.append(.config)
        try fail(.config)
        return RelayConfigResponse(
            apiVersion: 1, relayId: "fake-relay", label: "Fake relay", printerIds: [Self.printerId],
            printers: [RelayPrinter(id: Self.printerId, name: "Fake printer", usbSerial: "FAKE0001", campusId: 1)]
        )
    }

    func sending(jobId: String, claimToken: String) async throws -> RelayJobCallResult {
        calls.append(.sending)
        if try staleOrThrow(.sending) { return drop(jobId) }
        guard let job = leased[jobId], job.claimToken == claimToken, !settled.contains(jobId) else { return .stale }
        if !sendingIds.contains(jobId) { sendingIds.append(jobId) }
        return .ok(status: "sending")
    }

    func report(jobId: String, claimToken: String, outcome: RelayReportOutcome, error: String?) async throws -> RelayJobCallResult {
        calls.append(.report)
        if try staleOrThrow(.report) { return drop(jobId) }
        guard let job = leased[jobId], job.claimToken == claimToken, !settled.contains(jobId) else { return .stale }
        settled.insert(jobId)
        reports.append(Report(jobId: jobId, outcome: outcome, error: error))
        return .ok(status: outcome.rawValue)
    }

    /// A scripted stale answer: the cloud has given the job away or expired it, so it is settled without a report.
    private func drop(_ jobId: String) -> RelayJobCallResult {
        settled.insert(jobId)
        if !staleIds.contains(jobId) { staleIds.append(jobId) }
        return .stale
    }

    private func nextFailure(_ call: Call) -> Failure? {
        guard var pending = script[call], !pending.isEmpty else { return nil }
        let failure = pending.removeFirst()
        script[call] = pending
        return failure
    }

    private func fail(_ call: Call) throws {
        switch nextFailure(call) {
        case .network, .stale: throw RelayFailure.network
        case .auth: throw RelayFailure.auth
        case nil: return
        }
    }

    /// True when the scripted failure is `.stale`.
    private func staleOrThrow(_ call: Call) throws -> Bool {
        switch nextFailure(call) {
        case .stale: return true
        case .network: throw RelayFailure.network
        case .auth: throw RelayFailure.auth
        case nil: return false
        }
    }
}
#endif
