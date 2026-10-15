import Foundation
import os

/// What the host screens show. Counts and flags only: never a label, ZPL or credential.
struct HostStatus: Sendable, Equatable {
    var printerAttached: Bool?
    /// The printer is attached and the driver extension answers, so jobs can be claimed and sent.
    var printerReady = false
    var spoolDepth = 0
    var lastHeartbeatAt: Date?
    /// The cloud refused the credential. The loop has stopped; nothing was wiped.
    var authRejected = false
    /// The cloud says an admin handed this printer to another host. The loop no longer claims or sends for it and
    /// keeps the credential. It resumes only after a new enrollment or an app relaunch.
    var printerMoved = false
    /// What the driver extension reported on the last cycle. Nil before the first cycle.
    var driver: DriverAvailability?
#if DEBUG
    /// Driver candidate and handshake trace for the host screen's diagnostics section.
    var driverDiagnostic: String? = nil
#endif
    /// The outcome of the last job this host decided, whether or not the cloud has been told yet.
    var lastJobOutcome: RelayReportOutcome?
    var lastJobAt: Date?
    /// The error recorded with the last failed or ambiguous job. A fixed phrase from this app, never label or ZPL text.
    var lastError: String?
}

enum HostTickResult: Sendable, Equatable {
    case completed
    case authRejected
}

/// Claims print jobs from the relay, sends each one to the USB printer exactly once and reports what happened.
///
/// The safety rules, in order of importance:
///  - A job is marked `sending` in the spool before any byte goes to the transport. A job found in `sending` after a
///    restart might have printed, so it is reported `ambiguous` and never sent again.
///  - `failed` is reported only when the transport proves nothing was written (it never got as far as a write).
///    A partial or unknown write is `ambiguous`.
///  - An outcome is written to the spool before it is delivered, and the entry is removed only once the cloud
///    has accepted or refused the report.
///  - The label and ZPL exist only in a `claimed` entry (see `SpoolEntry`).
///  - Stopping never cuts a send short: it ends new claims and new sends and waits for the one in flight.
///
/// The loop is foreground-only. `HostController` stops it when the app leaves the foreground.
actor HostLoop {
    struct Timing: Sendable {
        var poll: Duration = .seconds(2)
        var heartbeat: TimeInterval = 15
        var claimLimit = 5
        /// Most jobs held locally at once.
        var maxSpool = 20
        /// Longest a "paused" beat waits for an "active" beat already on the wire, so the two land in order.
        var pausedBeatWait: Duration = .seconds(3)
    }

    private struct AuthRejected: Error {}

    private let relay: any HostRelay
    private let transport: any UsbPrinterTransport
    private let spool: HostSpool
    private let identity: HostIdentity
    private let timing: Timing
    private let now: @Sendable () -> Date
    private let onStatus: (@Sendable (HostStatus) -> Void)?
    private let log = Logger(subsystem: "church.favor.printer.ios", category: "host-loop")

    private var loopTask: Task<Void, Never>?
    private var inFlight: Task<HostTickResult, Never>?
    private var sleeper: CheckedContinuation<Void, Never>?
    private var halted = false
    private(set) var isRunning = false

    private var printerIds: [String] = []
    private var lastConfigAttempt: Date?
    private var enabledPrinterIds: Set<String> = []
    private var heartbeatAnswered = false
    private var lastHeartbeatAt: Date?
    private var cloudUnreachable = false
    /// Printers the cloud has told this host were handed to another host. Kept for the life of this loop: `start()`
    /// does not clear it, a new enrollment builds a new loop.
    private var handedOver: Set<String> = []
    private var lastPrinter: PrinterState?
    /// Set once the last "paused" beat is on its way, so no regular "active" beat follows it until `start()`.
    private var paused = false
    private var pausedBeat: Task<Void, Never>?
    /// The "active" beat currently on the wire, if any.
    private var activeBeat: Task<Void, Never>?
    private var status = HostStatus()

    init(
        relay: any HostRelay,
        transport: any UsbPrinterTransport,
        spool: HostSpool,
        identity: HostIdentity = .current,
        timing: Timing = Timing(),
        now: @escaping @Sendable () -> Date = { Date() },
        onStatus: (@Sendable (HostStatus) -> Void)? = nil
    ) {
        self.relay = relay
        self.transport = transport
        self.spool = spool
        self.identity = identity
        self.timing = timing
        self.now = now
        self.onStatus = onStatus
    }

    var currentStatus: HostStatus { status }

    // MARK: Lifecycle

    func start() {
        guard !isRunning else { return }
        isRunning = true
        halted = false
        paused = false
        status.authRejected = false
        forgetCloudState()
        loopTask = Task { await self.run() }
    }

    /// Ends new claims and new sends, waits for a send already writing, then returns.
    func stop() async {
        halted = true
        wake()
        await loopTask?.value
        _ = await inFlight?.value
    }

    private func run() async {
        while !halted {
            if await tick() == .authRejected { break }
            if halted { break }
            await sleep(timing.poll)
        }
        isRunning = false
        loopTask = nil
    }

    private func sleep(_ duration: Duration) async {
        await withCheckedContinuation { continuation in
            sleeper = continuation
            Task {
                try? await Task.sleep(for: duration)
                self.wake()
            }
        }
    }

    private func wake() {
        sleeper?.resume()
        sleeper = nil
    }

    /// Drop everything learned from the cloud, so the next cycle asks again before any send.
    private func forgetCloudState() {
        printerIds = []
        lastConfigAttempt = nil
        enabledPrinterIds = []
        heartbeatAnswered = false
        lastHeartbeatAt = nil
    }

    // MARK: One cycle

    /// One full cycle. Calls are serialized: a call made while a cycle runs joins it.
    func tick() async -> HostTickResult {
        if let inFlight { return await inFlight.value }
        let task = Task { await self.runTick() }
        inFlight = task
        let result = await task.value
        inFlight = nil
        return result
    }

    private func runTick() async -> HostTickResult {
        cloudUnreachable = false
        status.authRejected = false
        let printer = await readPrinter()
        lastPrinter = printer
        do {
            try await loadConfigIfNeeded()
            if !heartbeatAnswered { try await heartbeat(printer) }
            try await drain(printer, only: nil)
            let claimed = try await claimNew(printer)
            if !claimed.isEmpty { try await drain(printer, only: claimed) }
            try await heartbeatIfDue(printer)
        } catch {
            // Only a refused credential escapes the stages above.
            status.authRejected = true
            log.error("relay rejected the credential; host loop stopped")
        }
        status.spoolDepth = await spool.count
        status.printerAttached = printer.attached
        status.printerReady = printer.ready
        status.driver = printer.driver
        status.printerMoved = !printerIds.isEmpty && printerIds.allSatisfy(handedOver.contains)
#if DEBUG
        status.driverDiagnostic = printer.debugDiagnostic
#endif
        onStatus?(status)
        return status.authRejected ? .authRejected : .completed
    }

    private struct PrinterState {
        var driver: DriverAvailability
        var attached: Bool?
        var ready: Bool
        var error: String?
#if DEBUG
        var debugDiagnostic: String?
#endif
    }

    private func readPrinter() async -> PrinterState {
        let reading = await transport.status()
        let ready = reading.driver == .running && reading.printerAttached == true
        let error: String? = ready ? nil : (reading.driver == .printerPresentDriverNotRunning ? "driver_not_running" : "printer_not_attached")
        var printer = PrinterState(driver: reading.driver, attached: reading.printerAttached, ready: ready, error: error)
#if DEBUG
        printer.debugDiagnostic = reading.debugDiagnostic
#endif
        return printer
    }

    /// Runs one relay call. A refused credential throws; any other failure marks the cloud unreachable for the rest
    /// of this cycle and returns nil, so the work is retried next cycle.
    private func call<T: Sendable>(handoverFallback: [String]? = nil, _ body: () async throws -> T) async throws -> T? {
        if cloudUnreachable { return nil }
        do {
            return try await body()
        } catch RelayFailure.auth {
            throw AuthRejected()
        } catch RelayFailure.printerHandedOver(let ids) {
            // Terminal for these printers, not a network error: the cloud itself is fine.
            // Only printers this host knows count. An empty list means the printers of this call.
            handedOver.formUnion(ids.isEmpty ? (handoverFallback ?? printerIds) : ids.filter(printerIds.contains))
            return nil
        } catch {
            cloudUnreachable = true
            return nil
        }
    }

    // MARK: Cloud state

    private func loadConfigIfNeeded() async throws {
        guard printerIds.isEmpty else { return }
        let nowDate = now()
        if let last = lastConfigAttempt, nowDate.timeIntervalSince(last) < timing.heartbeat { return }
        lastConfigAttempt = nowDate
        guard let config = try await call({ try await relay.config() }) else { return }
        printerIds = config.printerIds
    }

    private func heartbeatIfDue(_ printer: PrinterState) async throws {
        if let last = lastHeartbeatAt, now().timeIntervalSince(last) < timing.heartbeat { return }
        try await heartbeat(printer)
    }

    /// The printers this host still serves: everything the cloud listed except what was handed to another host.
    private var servedPrinterIds: [String] { printerIds.filter { !handedOver.contains($0) } }

    private func heartbeatBody(_ printer: PrinterState, at date: Date, lifecycle: RelayLifecycle) async -> RelayHeartbeatRequest {
        let ids = servedPrinterIds
        let checkedAt = date.formatted(.iso8601)
        return RelayHeartbeatRequest(
            printerIds: ids,
            relayVersion: identity.appVersion,
            spoolDepth: await spool.count,
            probes: ids.map {
                RelayProbe(printerId: $0, reachable: printer.ready, checkedAt: checkedAt, error: printer.error, status: "status_unknown")
            },
            appVersion: identity.appVersion,
            osVersion: identity.osVersion,
            printerAttached: printer.attached,
            hostKind: .ipad,
            lifecycle: lifecycle
        )
    }

    /// One best-effort "paused" beat for a host that is about to stop. It never waits for a send, never stops the loop
    /// and ignores every failure. After it, no "active" beat goes out until `start()`. It does not depend on the loop
    /// still running: a `stop()` that won the race does not drop it. The body is built and the beat is under way when
    /// this returns; the returned task finishes when the beat has landed or failed. Nil when nothing was ever heard.
    func startPausedHeartbeat() async -> Task<Void, Never>? {
        guard !paused, !status.authRejected, lastHeartbeatAt != nil, let printer = lastPrinter, !servedPrinterIds.isEmpty else { return nil }
        paused = true
        let body = await heartbeatBody(printer, at: now(), lifecycle: .paused)
        let relay = relay
        let earlier = activeBeat
        let wait = timing.pausedBeatWait
        let beat = Task {
            await Self.settle(earlier, within: wait)
            _ = try? await relay.heartbeat(body)
        }
        pausedBeat = beat
        return beat
    }

    /// The app came back before the loop was stopped: the loop keeps running, so the next beat is "active" again and
    /// goes out on the next cycle. A "paused" beat still on its way lands first (see `heartbeat`).
    func resumeAfterPausedHeartbeat() {
        guard paused, isRunning, !halted else { return }
        paused = false
        lastHeartbeatAt = nil
    }

    /// Same as `startPausedHeartbeat`, then waits for the beat.
    func sendPausedHeartbeat() async {
        await startPausedHeartbeat()?.value
    }

    /// Waits for `task`, but no longer than `limit`.
    private static func settle(_ task: Task<Void, Never>?, within limit: Duration) async {
        guard let task else { return }
        let (stream, signal) = AsyncStream<Void>.makeStream()
        Task { await task.value; signal.yield() }
        Task { try? await Task.sleep(for: limit); signal.yield() }
        for await _ in stream { break }
    }

    private func heartbeat(_ printer: PrinterState) async throws {
        guard !paused, !servedPrinterIds.isEmpty, !cloudUnreachable else { return }
        // A "paused" beat still on its way must land first, or it could overwrite this "active" one.
        await pausedBeat?.value
        pausedBeat = nil
        let nowDate = now()
        lastHeartbeatAt = nowDate
        let body = await heartbeatBody(printer, at: nowDate, lifecycle: .active)
        guard let answer = try await call({ try await sendActiveBeat(body) }) else {
            // Nothing is known about the printers yet, so try again next cycle instead of waiting out the interval.
            if !heartbeatAnswered { lastHeartbeatAt = nil }
            return
        }
        enabledPrinterIds = Set(answer.printers.filter(\.enabled).map(\.id))
        heartbeatAnswered = true
        status.lastHeartbeatAt = nowDate
    }

    /// Sends an "active" beat in a task of its own and remembers it, so a "paused" beat can wait for it.
    private func sendActiveBeat(_ body: RelayHeartbeatRequest) async throws -> RelayHeartbeatResponse {
        let relay = relay
        let request = Task { try await relay.heartbeat(body) }
        activeBeat = Task { _ = await request.result }
        defer { activeBeat = nil }
        return try await request.value
    }

    // MARK: Spool

    private func claimNew(_ printer: PrinterState) async throws -> Set<String> {
        let claimable = servedPrinterIds.filter(enabledPrinterIds.contains)
        guard !halted, printer.ready, !claimable.isEmpty else { return [] }
        let room = timing.maxSpool - (await spool.count)
        guard room > 0 else { return [] }
        guard let answer = try await call(handoverFallback: claimable, { try await relay.claim(printerIds: claimable, limit: min(timing.claimLimit, room)) }) else {
            return []
        }
        handedOver.formUnion(answer.handedOverPrinterIds.filter(printerIds.contains))
        var stored: Set<String> = []
        for job in answer.jobs {
            // A claim that cannot be stored is left to expire at the cloud.
            if (try? await spool.addClaimed(job, at: now())) == true { stored.insert(job.id) }
        }
        return stored
    }

    private func drain(_ printer: PrinterState, only ids: Set<String>?) async throws {
        for entry in await spool.list() where ids?.contains(entry.id) ?? true {
            if halted { return }
            try await process(entry, printer)
        }
    }

    private func process(_ entry: SpoolEntry, _ printer: PrinterState) async throws {
        switch entry.stage {
        case .report:
            try await deliver(entry)
        case .sending:
            // The previous run stopped between marking the job and recording the result. Bytes may have reached the
            // printer, so it is never sent again.
            try await record(entry, .ambiguous, "app stopped while sending; outcome unknown")
        case .claimed:
            // Past its lease the cloud refuses `sending`, so this job can never be printed here. Drop it rather than
            // keep a child's label text on disk and a spool slot taken.
            if Self.leaseHasExpired(entry.leaseExpiresAt, now: now()) {
                await spool.remove(entry.id)
                return
            }
            // The printer went to another host and the cloud requeues this job. Nothing was written for it, so it is
            // dropped here: never sent, and no longer taking a spool slot.
            if handedOver.contains(entry.printerId) {
                await spool.remove(entry.id)
                return
            }
            try await print(entry, printer)
        }
    }

    /// False when the lease cannot be read: an unparseable date never drops a job.
    static func leaseHasExpired(_ lease: String, now: Date) -> Bool {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = formatter.date(from: lease)
        if date == nil {
            formatter.formatOptions = [.withInternetDateTime]
            date = formatter.date(from: lease)
        }
        return date.map { $0 <= now } ?? false
    }

    private func print(_ entry: SpoolEntry, _ printer: PrinterState) async throws {
        guard !halted, !cloudUnreachable, printer.ready, enabledPrinterIds.contains(entry.printerId), printerIds.contains(entry.printerId),
              !handedOver.contains(entry.printerId) else {
            return
        }
        guard let zpl = entry.zpl, !zpl.isEmpty else {
            // No payload to send: nothing can have been written.
            return try await record(entry, .failed, "job has no label data")
        }
        // Durable before the cloud is told and before any byte is written. If this cannot be stored, nothing is sent.
        let marked = entry.markedSending()
        do { try await spool.write(marked) } catch { return }

        let answer: RelayJobCallResult?
        do {
            answer = try await call({ try await relay.sending(jobId: entry.id, claimToken: entry.claimToken) })
        } catch {
            await putBack(entry)
            throw error
        }
        switch answer {
        case nil:
            // Nothing was written, so the job is safe to retry later.
            return await putBack(entry)
        case .stale:
            // The cloud gave the job to someone else or it expired.
            return await spool.remove(entry.id)
        case .ok:
            break
        }
        if halted { return await putBack(entry) }

        let data = Data(zpl.utf8)
        let result = await transport.send(data)
        let (outcome, error) = Self.outcome(of: result, expected: data.count)
        try await record(marked, outcome, error)
    }

    /// Returns a job to `claimed` after a send that never started. Should this write fail, the entry stays
    /// `sending` and is reported ambiguous: the safe direction.
    private func putBack(_ entry: SpoolEntry) async {
        try? await spool.write(entry)
    }

    private func record(_ entry: SpoolEntry, _ outcome: RelayReportOutcome, _ error: String?) async throws {
        let recorded = entry.reported(outcome, error: error)
        // If this write fails the outcome is still delivered from memory; a crash first leaves `sending`, which restarts as ambiguous.
        try? await spool.write(recorded)
        log.notice("job \(entry.id, privacy: .public) \(outcome.rawValue, privacy: .public)")
        status.lastJobOutcome = outcome
        status.lastJobAt = now()
        if let error { status.lastError = error }
        try await deliver(recorded)
    }

    private func deliver(_ entry: SpoolEntry) async throws {
        let outcome = entry.outcome ?? .ambiguous
        let answer = try await call({
            try await relay.report(jobId: entry.id, claimToken: entry.claimToken, outcome: outcome, error: entry.error)
        })
        // Accepted or refused as stale: either way the cloud has settled this job.
        if answer != nil { await spool.remove(entry.id) }
    }

    /// Only an error raised before any write was attempted proves nothing reached the printer. A failed or short
    /// write, a timeout or anything else about a write that began is unknown.
    static func outcome(of result: Result<Int, UsbTransportError>, expected: Int) -> (RelayReportOutcome, String?) {
        switch result {
        case .success(let written):
            return written == expected ? (.sent, nil) : (.ambiguous, "wrote \(written) of \(expected) bytes")
        case .failure(.driverNotFound):
            return (.failed, "driver not running")
        case .failure(.notAttached):
            return (.failed, "printer not attached")
        case .failure(.openFailed(let code)):
            return (.failed, "could not open the printer driver (\(code))")
        case .failure(.abiMismatch):
            // Refused before any write, so nothing reached the printer.
            return (.failed, "printer driver version mismatch")
        case .failure(.writeFailed(let code, let bytes)):
            return (.ambiguous, "write failed (\(code)) after \(bytes) of \(expected) bytes")
        case .failure(.shortWrite(let written, let total)):
            return (.ambiguous, "wrote \(written) of \(total) bytes")
        case .failure(.timeout):
            return (.ambiguous, "write timed out; outcome unknown")
        case .failure(.readFailed(let code)):
            return (.ambiguous, "unexpected read failure (\(code)); outcome unknown")
        }
    }
}
