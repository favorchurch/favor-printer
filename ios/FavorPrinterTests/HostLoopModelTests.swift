import Foundation
import Testing
@testable import FavorPrinter

// Model-based tests for the host loop. A seeded random command sequence drives the real loop over a real spool
// directory against a fake relay and fake printer, with crash-and-restart injected at any call boundary. After every
// step the observable world (spool files, relay records, printer writes) is checked against a reference model.
//
// Replay a failure: the failing case is named by its seed. Rerun just it with HOST_MODEL_SEED=<seed> (and
// HOST_MODEL_STEPS=<n> for a longer run). Deep runs: HOST_MODEL_SEEDS=<count>.
// On a simulator, pass them as SIMCTL_CHILD_HOST_MODEL_SEED=<seed> xcodebuild test ...

struct SplitMix64: RandomNumberGenerator {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

/// How the fake printer answers one send.
enum SendKind: Sendable, Equatable, CustomStringConvertible {
    case full
    /// Fails before any write was attempted (the transport proves nothing reached the printer).
    case zero(UsbTransportError)
    case partial(written: Int)
    case writeFailed(bytesWritten: Int)
    case timeout

    var description: String {
        switch self {
        case .full: "full"
        case .zero(let error): "zero(\(error))"
        case .partial(let written): "partial(\(written))"
        case .writeFailed(let bytes): "writeFailed(\(bytes))"
        case .timeout: "timeout"
        }
    }

    func result(count: Int) -> Result<Int, UsbTransportError> {
        switch self {
        case .full: .success(count)
        case .zero(let error): .failure(error)
        case .partial(let written): .failure(.shortWrite(written: min(written, max(count - 1, 0)), expected: count))
        case .writeFailed(let bytes): .failure(.writeFailed(code: -1, bytesWritten: bytes))
        case .timeout: .failure(.timeout)
        }
    }

    /// The reference rule: a clean full write is sent, a failure proven to precede any write is failed, anything else
    /// about a write that began is ambiguous, and so is any outcome the process died before recording.
    func expectedOutcome(crashedBeforeRecording: Bool) -> RelayReportOutcome {
        if crashedBeforeRecording { return .ambiguous }
        switch self {
        case .full: return .sent
        case .zero: return .failed
        case .partial, .writeFailed, .timeout: return .ambiguous
        }
    }
}

/// Everything the fakes observed, shared by the relay and printer fakes and the checker.
final class World: @unchecked Sendable {
    private let lock = NSLock()
    private var _status = FakeUsbTransport.readyStatus
    private var _sends: [String: [SendKind]] = [:]
    private var _crashedAfterSend: Set<String> = []
    private var _pendingSendCrash: String?
    private var _doubt: Set<String> = []
    private var _pendingDoubt: String?
    private var _markedSending: Set<String> = []
    private var _violations: [String] = []
    private var _script: [SendKind] = []

    func locked<T>(_ body: () -> T) -> T { lock.withLock(body) }

    var status: UsbPrinterStatus { get { locked { _status } } set { locked { _status = newValue } } }
    var isReady: Bool { let s = status; return s.driver == .running && s.printerAttached == true }
    var sends: [String: [SendKind]] { locked { _sends } }
    var crashedAfterSend: Set<String> { locked { _crashedAfterSend } }
    var doubt: Set<String> { get { locked { _doubt } } set { locked { _doubt = newValue } } }
    var markedSending: Set<String> { locked { _markedSending } }
    var violations: [String] { locked { _violations } }

    func violate(_ message: String) { locked { _violations.append(message) } }
    func markSending(_ id: String) { locked { _ = _markedSending.insert(id) } }
    func enqueueScript(_ kind: SendKind) { locked { _script.append(kind) } }
    func clearScript() { locked { _script = [] } }

    func nextKind() -> SendKind { locked { _script.isEmpty ? .full : _script.removeFirst() } }
    func recordSend(_ id: String, _ kind: SendKind) { locked { _sends[id, default: []].append(kind) } }
    func setPendingSendCrash(_ id: String?) { locked { _pendingSendCrash = id } }
    func setPendingDoubt(_ id: String?) { locked { _pendingDoubt = id } }

    /// Called once a crash has happened: what was in flight at the crash point becomes a fact.
    func promotePending() {
        locked {
            if let id = _pendingSendCrash { _crashedAfterSend.insert(id) }
            if let id = _pendingDoubt { _doubt.insert(id) }
            _pendingSendCrash = nil
            _pendingDoubt = nil
        }
    }
}

func hangForever() async {
    await withUnsafeContinuation { (_: UnsafeContinuation<Void, Never>) in }
}

/// Counts external call boundaries and "kills the process" at the armed one: the caller never resumes, like a
/// process that died there. Nothing after that boundary happens in that process.
final class CrashSwitch: @unchecked Sendable {
    private let lock = NSLock()
    private var countdown: Int?
    private var onCrash: (@Sendable () -> Void)?

    func arm(after points: Int?, onCrash: (@Sendable () -> Void)?) {
        lock.withLock {
            countdown = points
            self.onCrash = onCrash
        }
    }

    func point() async {
        let crash: (@Sendable () -> Void)? = lock.withLock {
            guard let remaining = countdown else { return nil }
            if remaining > 0 {
                countdown = remaining - 1
                return nil
            }
            countdown = nil
            return onCrash ?? {}
        }
        if let crash {
            crash()
            await hangForever()
        }
    }
}

final class Latch: @unchecked Sendable {
    enum Outcome: Sendable { case finished, crashed }
    private let lock = NSLock()
    private var outcome: Outcome?
    private var waiter: CheckedContinuation<Outcome, Never>?

    func signal(_ value: Outcome) {
        let resume: CheckedContinuation<Outcome, Never>? = lock.withLock {
            guard outcome == nil else { return nil }
            outcome = value
            defer { waiter = nil }
            return waiter
        }
        resume?.resume(returning: value)
    }

    func wait() async -> Outcome {
        await withCheckedContinuation { continuation in
            let ready: Outcome? = lock.withLock {
                if let outcome { return outcome }
                waiter = continuation
                return nil
            }
            if let ready { continuation.resume(returning: ready) }
        }
    }
}

private func jobId(fromZpl zpl: Data) -> String? {
    let text = String(decoding: zpl, as: UTF8.self)
    guard let start = text.range(of: "SECRET-ZPL-"), let end = text.range(of: "^FS") else { return nil }
    return String(text[start.upperBound..<end.lowerBound])
}

/// The relay as the loop sees it: the fake relay plus crash points and protocol checks.
final class ChaosRelay: HostRelay, @unchecked Sendable {
    private let inner: FakeRelay
    private let crash: CrashSwitch
    private let world: World
    private let directory: URL

    init(inner: FakeRelay, crash: CrashSwitch, world: World, directory: URL) {
        self.inner = inner
        self.crash = crash
        self.world = world
        self.directory = directory
    }

    func claim(printerIds: [String], limit: Int) async throws -> RelayClaimResponse {
        if !world.isReady { world.violate("claimed while the printer was not ready") }
        await crash.point()
        let answer = try await inner.claim(printerIds: printerIds, limit: limit)
        await crash.point()
        return answer
    }

    func heartbeat(_ body: RelayHeartbeatRequest) async throws -> RelayHeartbeatResponse {
        let depth = rawEntries(in: directory).count
        if body.spoolDepth != depth { world.violate("heartbeat spoolDepth \(body.spoolDepth) but \(depth) entries are on disk") }
        if body.printerAttached != world.status.printerAttached { world.violate("heartbeat printerAttached disagrees with the printer") }
        await crash.point()
        let answer = try await inner.heartbeat(body)
        await crash.point()
        return answer
    }

    func config() async throws -> RelayConfigResponse {
        await crash.point()
        let answer = try await inner.config()
        await crash.point()
        return answer
    }

    func sending(jobId: String, claimToken: String) async throws -> RelayJobCallResult {
        let stage = rawEntries(in: directory).first { $0.id == jobId }?.stage
        if stage != "sending" { world.violate("told the cloud \(jobId) is sending while its spool stage is \(stage ?? "absent")") }
        await crash.point()
        let answer = try await inner.sending(jobId: jobId, claimToken: claimToken)
        await crash.point()
        return answer
    }

    func report(jobId: String, claimToken: String, outcome: RelayReportOutcome, error: String?) async throws -> RelayJobCallResult {
        let stage = rawEntries(in: directory).first { $0.id == jobId }?.stage
        if stage != "report" { world.violate("reported \(jobId) while its spool stage is \(stage ?? "absent")") }
        await crash.point()
        let answer = try await inner.report(jobId: jobId, claimToken: claimToken, outcome: outcome, error: error)
        if case .ok = answer { world.setPendingDoubt(jobId) }
        await crash.point()
        world.setPendingDoubt(nil)
        return answer
    }
}

/// The printer as the loop sees it, with crash points around each write and checks on what is durable first.
final class ChaosTransport: UsbPrinterTransport, @unchecked Sendable {
    private let crash: CrashSwitch
    private let world: World
    private let directory: URL

    init(crash: CrashSwitch, world: World, directory: URL) {
        self.crash = crash
        self.world = world
        self.directory = directory
    }

    func status() async -> UsbPrinterStatus { world.status }

    func send(_ zpl: Data) async -> Result<Int, UsbTransportError> {
        guard let id = jobId(fromZpl: zpl) else {
            world.violate("sent bytes that are not a known job")
            return .success(zpl.count)
        }
        if !world.isReady { world.violate("sent \(id) while the printer was not ready") }
        if !(world.sends[id] ?? []).isEmpty { world.violate("job \(id) was sent twice") }
        let entry = rawEntries(in: directory).first { $0.id == id }
        if entry?.stage != "sending" { world.violate("bytes for \(id) left before its spool entry was sending (it was \(entry?.stage ?? "absent"))") }
        world.markSending(id)
        await crash.point()
        let kind = world.nextKind()
        world.recordSend(id, kind)
        let result = kind.result(count: zpl.count)
        world.setPendingSendCrash(id)
        await crash.point()
        world.setPendingSendCrash(nil)
        return result
    }

    func readStatus() async -> Result<Data, UsbTransportError> { .failure(.timeout) }
}

enum ModelCommand: CustomStringConvertible {
    case enqueue(Int)
    case scriptSend(SendKind)
    case scriptRelay(FakeRelay.Call, FakeRelay.Failure)
    case tick
    case crashTick(afterPoints: Int)
    case detach
    case attach
    case restart

    var description: String {
        switch self {
        case .enqueue(let n): "enqueue(\(n))"
        case .scriptSend(let kind): "scriptSend(\(kind))"
        case .scriptRelay(let call, let failure): "scriptRelay(\(call), \(failure))"
        case .tick: "tick"
        case .crashTick(let n): "crashTick(after \(n) points)"
        case .detach: "detach"
        case .attach: "attach"
        case .restart: "restart"
        }
    }

    static func random(using rng: inout SplitMix64) -> ModelCommand {
        switch Int.random(in: 0..<100, using: &rng) {
        case 0..<14: return .enqueue(Int.random(in: 1...3, using: &rng))
        case 14..<26:
            let kinds: [SendKind] = [
                .full, .full, .zero(.driverNotFound), .zero(.notAttached), .zero(.openFailed(code: -3)),
                .partial(written: Int.random(in: 0...12, using: &rng)), .writeFailed(bytesWritten: 0),
                .writeFailed(bytesWritten: Int.random(in: 1...12, using: &rng)), .timeout,
            ]
            return .scriptSend(kinds.randomElement(using: &rng)!)
        case 26..<40:
            let cases: [(FakeRelay.Call, FakeRelay.Failure)] = [
                (.claim, .network), (.claim, .auth), (.heartbeat, .network), (.heartbeat, .auth), (.config, .network),
                (.sending, .network), (.sending, .auth), (.sending, .stale), (.report, .network), (.report, .network),
                (.report, .auth), (.report, .stale),
            ]
            let pick = cases.randomElement(using: &rng)!
            return .scriptRelay(pick.0, pick.1)
        case 40..<72: return .tick
        case 72..<86: return .crashTick(afterPoints: Int.random(in: 0..<26, using: &rng))
        case 86..<91: return .detach
        case 91..<96: return .attach
        default: return .restart
        }
    }
}

/// One run of the system under test plus its reference model.
final class ModelRun: @unchecked Sendable {
    let seed: UInt64
    let directory = TempDirectory()
    let relay = FakeRelay()
    let world = World()
    let crash = CrashSwitch()
    private(set) var chaosRelay: ChaosRelay!
    private(set) var transport: ChaosTransport!
    private(set) var loop: HostLoop!
    private var jobCounter = 0
    private(set) var enqueued: [String] = []
    private(set) var failures: [String] = []
    private(set) var crashes = 0
    private(set) var log: [String] = []
    private(set) var checkedReports = 0

    init(seed: UInt64) throws {
        self.seed = seed
        chaosRelay = ChaosRelay(inner: relay, crash: crash, world: world, directory: directory.url)
        transport = ChaosTransport(crash: crash, world: world, directory: directory.url)
        try restartProcess()
    }

    /// A new process over the same spool directory.
    private func restartProcess() throws {
        loop = HostLoop(
            relay: chaosRelay, transport: transport, spool: try HostSpool(directory: directory.url),
            identity: testIdentity, timing: fastTiming
        )
    }

    private func fail(_ message: String, step: Int) {
        failures.append("seed \(seed) step \(step) [\(log.suffix(6).joined(separator: " > "))]: \(message)")
    }

    func apply(_ command: ModelCommand, step: Int) async throws {
        log.append(command.description)
        switch command {
        case .enqueue(let count):
            for _ in 0..<count {
                jobCounter += 1
                let id = String(format: "J%04d", jobCounter)
                enqueued.append(id)
                await relay.enqueue(zpl: "^XA^FDSECRET-ZPL-\(id)^FS^XZ", label: "LBL-\(id)", id: id)
            }
        case .scriptSend(let kind): world.enqueueScript(kind)
        case .scriptRelay(let call, let failure): await relay.failNext(call, failure)
        case .tick: try await runTick(crashAfter: nil, step: step)
        case .crashTick(let points): try await runTick(crashAfter: points, step: step)
        case .detach: world.status = UsbPrinterStatus(driver: .unknown)
        case .attach: world.status = FakeUsbTransport.readyStatus
        case .restart: try restartProcess()
        }
        await check(step: step)
    }

    private func runTick(crashAfter: Int?, step: Int) async throws {
        let latch = Latch()
        crash.arm(after: crashAfter, onCrash: { latch.signal(.crashed) })
        let target = loop!
        Task {
            _ = await target.tick()
            latch.signal(.finished)
        }
        let outcome = await latch.wait()
        crash.arm(after: nil, onCrash: nil)
        guard outcome == .crashed else { return }

        // The process died at a call boundary. Whatever was in flight there is now a fact; the old process never
        // runs again. What the next process finds on disk is all it has.
        crashes += 1
        world.promotePending()
        observeSpool(step: step)
        try restartProcess()
        let held = Set(rawEntries(in: directory.url).compactMap(\.id))
        // A job the cloud handed out that never reached the disk expires and is handed out again.
        await relay.expireLeases(keeping: held)
    }

    /// Checks that hold at every point, including right after a crash.
    private func observeSpool(step: Int) {
        for entry in rawEntries(in: directory.url) {
            guard let id = entry.id else { fail("a spool file without an id", step: step); continue }
            let hasPayload = (entry.json["zpl"] != nil && !(entry.json["zpl"] is NSNull)) || (entry.json["label"] != nil && !(entry.json["label"] is NSNull))
            switch entry.stage {
            case "claimed":
                if !hasPayload { fail("claimed entry \(id) lost its payload", step: step) }
            case "sending", "report":
                if hasPayload || entry.text.contains("SECRET-ZPL") || entry.text.contains("LBL-") {
                    fail("\(entry.stage) entry \(id) still holds ZPL or label text", step: step)
                }
                if entry.stage == "sending" { world.markSending(id) }
            default:
                fail("entry \(id) has unknown stage '\(entry.stage)'", step: step)
            }
            if entry.stage == "claimed", !(world.sends[id] ?? []).isEmpty {
                fail("entry \(id) is claimed again after bytes were written", step: step)
            }
        }
    }

    private func check(step: Int) async {
        observeSpool(step: step)
        let held = Set(rawEntries(in: directory.url).compactMap(\.id))
        let unsettled = await relay.unsettledIds

        // Spool depth equals unreported entries: every job the cloud still expects a report for is on disk, and the
        // only extra entries are ones whose report the cloud accepted just before a crash.
        let missing = unsettled.subtracting(held)
        if !missing.isEmpty { fail("jobs owed a report are not in the spool: \(missing.sorted())", step: step) }
        let extra = held.subtracting(unsettled).subtracting(world.doubt)
        if !extra.isEmpty { fail("the spool holds jobs the cloud has settled: \(extra.sorted())", step: step) }
        world.doubt = world.doubt.intersection(held)

        for (id, sends) in world.sends where sends.count > 1 { fail("job \(id) was sent \(sends.count) times", step: step) }
        for message in world.violations where !message.isEmpty && !failures.contains(where: { $0.hasSuffix(message) }) {
            fail(message, step: step)
        }

        let reports = await relay.reports
        let seen = Dictionary(grouping: reports, by: \.jobId)
        for (id, list) in seen where list.count > 1 { fail("job \(id) was reported \(list.count) times", step: step) }
        let sendingIds = Set(await relay.sendingIds)
        for report in reports.dropFirst(checkedReports) {
            if let kind = world.sends[report.jobId]?.first {
                let expected = kind.expectedOutcome(crashedBeforeRecording: world.crashedAfterSend.contains(report.jobId))
                if report.outcome != expected {
                    fail("job \(report.jobId) wrote as \(kind) but was reported \(report.outcome), expected \(expected)", step: step)
                }
            } else {
                if report.outcome != .ambiguous { fail("job \(report.jobId) had no write but was reported \(report.outcome)", step: step) }
                if !world.markedSending.contains(report.jobId), !sendingIds.contains(report.jobId) {
                    fail("job \(report.jobId) was reported without ever reaching sending", step: step)
                }
            }
        }
        checkedReports = reports.count
    }

    /// Heal everything, let the loop finish its work and check the end state.
    func quiesce(step: Int) async throws {
        world.clearScript()
        world.status = FakeUsbTransport.readyStatus
        await relay.clearScript()
        log.append("quiesce")
        for _ in 0..<20 {
            try await runTick(crashAfter: nil, step: step)
            let left = rawEntries(in: directory.url).count
            if left == 0, await relay.pendingCount == 0, await relay.unsettledIds.isEmpty { break }
        }
        await check(step: step)

        if !rawEntries(in: directory.url).isEmpty { fail("the spool did not drain: \(rawEntries(in: directory.url).compactMap(\.id))", step: step) }
        let reports = Dictionary(grouping: await relay.reports, by: \.jobId)
        let stale = Set(await relay.staleIds)
        let sendingIds = Set(await relay.sendingIds)
        for id in enqueued {
            let sends = world.sends[id] ?? []
            let accepted = reports[id] ?? []
            if sends.count > 1 { fail("job \(id) was sent \(sends.count) times", step: step) }
            if accepted.count > 1 { fail("job \(id) was reported \(accepted.count) times", step: step) }
            let reachedSending = !sends.isEmpty || world.markedSending.contains(id) || sendingIds.contains(id)
            if reachedSending, accepted.count != 1, !stale.contains(id) {
                fail("job \(id) reached sending but ended with \(accepted.count) accepted reports and no stale answer", step: step)
            }
            if !reachedSending, accepted.isEmpty, !stale.contains(id) {
                fail("job \(id) never reached sending and was never settled", step: step)
            }
            if let report = accepted.first, report.outcome == .sent, sends.count != 1 {
                fail("job \(id) reported sent with \(sends.count) writes", step: step)
            }
        }
    }
}

struct HostLoopModelTests {
    private static func environmentInt(_ name: String) -> Int? {
        ProcessInfo.processInfo.environment[name].flatMap(Int.init)
    }

    static let seeds: [UInt64] = {
        if let one = environmentInt("HOST_MODEL_SEED") { return [UInt64(one)] }
        return (1...UInt64(environmentInt("HOST_MODEL_SEEDS") ?? 20)).map { $0 }
    }()

    @Test(arguments: HostLoopModelTests.seeds)
    func randomSequencesKeepEveryInvariant(seed: UInt64) async throws {
        let steps = Self.environmentInt("HOST_MODEL_STEPS") ?? 60
        var rng = SplitMix64(seed: seed)
        let run = try ModelRun(seed: seed)
        for step in 0..<steps {
            try await run.apply(ModelCommand.random(using: &rng), step: step)
            if !run.failures.isEmpty { break }
        }
        if run.failures.isEmpty { try await run.quiesce(step: steps) }
        if !run.failures.isEmpty { print("HOST MODEL FAILURE, replay with HOST_MODEL_SEED=\(seed): \(run.failures[0])") }
        #expect(run.failures.isEmpty, "replay with HOST_MODEL_SEED=\(seed): \(run.failures.prefix(3))")
    }

    /// The generator must actually reach the interesting cases, or the invariants above prove little.
    @Test func theSeedsExerciseCrashesPartialWritesAndEveryOutcome() async throws {
        var crashes = 0, jobs = 0
        var outcomes: Set<RelayReportOutcome> = []
        var sawAmbiguousAfterCrash = false
        for seed in 1...UInt64(30) {
            var rng = SplitMix64(seed: seed)
            let run = try ModelRun(seed: seed)
            for step in 0..<60 { try await run.apply(ModelCommand.random(using: &rng), step: step) }
            try await run.quiesce(step: 60)
            crashes += run.crashes
            jobs += run.enqueued.count
            let reports = await run.relay.reports
            outcomes.formUnion(reports.map(\.outcome))
            if reports.contains(where: { $0.outcome == .ambiguous && run.world.crashedAfterSend.contains($0.jobId) }) { sawAmbiguousAfterCrash = true }
        }
        #expect(crashes > 30)
        #expect(jobs > 200)
        #expect(outcomes == [.sent, .failed, .ambiguous])
        #expect(sawAmbiguousAfterCrash)
    }
}
