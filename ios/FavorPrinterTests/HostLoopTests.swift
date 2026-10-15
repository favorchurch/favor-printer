import Foundation
import SwiftUI
import Testing
@testable import FavorPrinter

/// A throwaway directory under one per-process root, removed when the test process exits. It does not depend on
/// its owner staying alive, so a test can hand `url` to a long-lived object.
struct TempDirectory: Sendable {
    private static let root: URL = {
        let root = FileManager.default.temporaryDirectory.appending(path: "host-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        atexit { _ = try? FileManager.default.removeItem(at: TempDirectory.root) }
        return root
    }()

    let url = TempDirectory.root.appending(path: UUID().uuidString, directoryHint: .isDirectory)
}

/// What a spool file holds on disk, read without going through `HostSpool`.
struct RawEntry {
    let name: String
    let text: String
    let json: [String: Any]
    var stage: String { json["stage"] as? String ?? "" }
    var id: String? { json["id"] as? String }
}

func rawEntries(in directory: URL) -> [RawEntry] {
    let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
    return urls.filter { $0.pathExtension == "json" }.compactMap { url in
        guard let data = try? Data(contentsOf: url),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return RawEntry(name: url.lastPathComponent, text: String(decoding: data, as: UTF8.self), json: json)
    }
}

func eventually(timeout: Duration = .seconds(5), _ condition: @Sendable () async -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return await condition()
}

let testIdentity = HostIdentity(appVersion: "9.9 (99)", osVersion: "iPadOS 18.0.0")
let fastTiming = HostLoop.Timing(poll: .milliseconds(10), heartbeat: 0)

@MainActor
func eventuallyOnMain(timeout: Duration = .seconds(5), _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return condition()
}

func zplMarker(_ id: String) -> String { "SECRET-ZPL-\(id)" }
func zpl(for id: String) -> String { "^XA^FD\(zplMarker(id))^FS^XZ" }

/// A loop over a fresh spool, fake relay and fake printer.
final class HostRig: @unchecked Sendable {
    let directory = TempDirectory()
    let spool: HostSpool
    let relay: FakeRelay
    let transport: FakeUsbTransport
    let loop: HostLoop

    init(timing: HostLoop.Timing = fastTiming, relay: FakeRelay = FakeRelay(), transport: FakeUsbTransport = FakeUsbTransport()) throws {
        spool = try HostSpool(directory: directory.url)
        self.relay = relay
        self.transport = transport
        loop = HostLoop(relay: relay, transport: transport, spool: spool, identity: testIdentity, timing: timing)
    }

    /// A second loop over the same spool and relay: a restarted app.
    func restarted(transport: (any UsbPrinterTransport)? = nil) throws -> HostLoop {
        HostLoop(
            relay: relay, transport: transport ?? self.transport, spool: try HostSpool(directory: directory.url),
            identity: testIdentity, timing: fastTiming
        )
    }

    var raw: [RawEntry] { rawEntries(in: directory.url) }

    func writes() async -> [String] { await transport.writes.map { String(decoding: $0, as: UTF8.self) } }
}

/// Reads the spool while a send is in progress, to check what was durable at that moment.
final class SpyTransport: UsbPrinterTransport, @unchecked Sendable {
    private let inner: FakeUsbTransport
    private let directory: URL
    private let lock = NSLock()
    private var seen: [[RawEntry]] = []

    init(inner: FakeUsbTransport, directory: URL) {
        self.inner = inner
        self.directory = directory
    }

    /// Spool contents at each send call, taken before the bytes were handed to the printer.
    var spoolAtSend: [[RawEntry]] { lock.withLock { seen } }

    func status() async -> UsbPrinterStatus { await inner.status() }
    func send(_ zpl: Data) async -> Result<Int, UsbTransportError> {
        lock.withLock { seen.append(rawEntries(in: directory)) }
        return await inner.send(zpl)
    }
    func readStatus() async -> Result<Data, UsbTransportError> { await inner.readStatus() }
}

/// Holds a send open until released, so a test can act while bytes are mid-write.
actor GatedTransport: UsbPrinterTransport {
    private var entered: CheckedContinuation<Void, Never>?
    private var release: CheckedContinuation<Void, Never>?
    private(set) var hasEntered = false
    private(set) var writes: [Data] = []

    func status() async -> UsbPrinterStatus { FakeUsbTransport.readyStatus }

    func send(_ zpl: Data) async -> Result<Int, UsbTransportError> {
        writes.append(zpl)
        hasEntered = true
        entered?.resume()
        entered = nil
        await withCheckedContinuation { release = $0 }
        return .success(zpl.count)
    }

    func readStatus() async -> Result<Data, UsbTransportError> { .failure(.timeout) }

    func waitUntilSending() async {
        if hasEntered { return }
        await withCheckedContinuation { entered = $0 }
    }

    func releaseSend() {
        release?.resume()
        release = nil
    }
}

struct HostSpoolTests {
    private func job(_ id: String, zpl: String = "^XA^FDhello^FS^XZ", label: String = "Ada Lovelace") -> RelayJob {
        RelayJob(
            id: id, printerId: "p1", label: label, copy: 1, zpl: zpl, claimToken: "claim-\(id)",
            leaseExpiresAt: "2099-01-01T00:00:00Z", attempt: 1, host: "usb", port: 0
        )
    }

    @Test func laterStagesCarryNeitherLabelNorZpl() throws {
        let claimed = SpoolEntry.claimed(job("j1"), at: Date())
        #expect(claimed.zpl != nil && claimed.label != nil)
        for later in [claimed.markedSending(), claimed.reported(.ambiguous, error: "x"), claimed.markedSending().reported(.sent, error: nil)] {
            #expect(later.zpl == nil && later.label == nil)
            let text = String(decoding: try JSONEncoder().encode(later), as: UTF8.self)
            #expect(!text.contains("Ada") && !text.contains("hello"))
        }
    }

    @Test func aFileClaimingLaterStageWithPayloadIsStrippedOnLoad() async throws {
        let dir = TempDirectory()
        let spool = try HostSpool(directory: dir.url)
        let forged = #"{"id":"j1","printerId":"p1","copy":1,"attempt":1,"claimToken":"c","leaseExpiresAt":"x","claimedAt":1,"stage":"sending","label":"Ada","zpl":"^XA"}"#
        try Data(forged.utf8).write(to: dir.url.appending(path: HostSpool.fileName(for: "j1")))
        let entry = try #require(await spool.list().first)
        #expect(entry.stage == .sending && entry.zpl == nil && entry.label == nil)
    }

    @Test func existingEntryIsNeverOverwrittenByAFreshClaim() async throws {
        let dir = TempDirectory()
        let spool = try HostSpool(directory: dir.url)
        #expect(try await spool.addClaimed(job("j1"), at: Date()))
        try await spool.write(SpoolEntry.claimed(job("j1"), at: Date()).markedSending())
        #expect(try await spool.addClaimed(job("j1"), at: Date()) == false)
        #expect(await spool.list().first?.stage == .sending)
    }

    @Test func jobIdsCannotEscapeTheSpoolDirectory() async throws {
        let dir = TempDirectory()
        let spool = try HostSpool(directory: dir.url)
        let hostile = "../../escape"
        #expect(try await spool.addClaimed(job(hostile), at: Date()))
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.url.path)
        #expect(names == [HostSpool.fileName(for: hostile)])
        #expect(!names[0].contains("/") && !names[0].hasPrefix("."))
        #expect(!FileManager.default.fileExists(atPath: dir.url.deletingLastPathComponent().appending(path: "escape.json").path))
        #expect(await spool.list().first?.id == hostile)
        #expect(try await spool.addClaimed(job(String(repeating: "a", count: 81)), at: Date()) == false)
        #expect(try await spool.addClaimed(job(""), at: Date()) == false)
    }

    @Test func interruptedWritesLeaveNoEntryAndAreCleanedOnLaunch() async throws {
        let dir = TempDirectory()
        _ = try HostSpool(directory: dir.url)
        let leftover = dir.url.appending(path: "\(UUID().uuidString).tmp")
        try Data("{".utf8).write(to: leftover)
        let torn = dir.url.appending(path: "torn.json")
        try Data("{\"id\":".utf8).write(to: torn)
        let spool = try HostSpool(directory: dir.url)
        #expect(!FileManager.default.fileExists(atPath: leftover.path))
        #expect(await spool.list().isEmpty)
        // An undecodable entry is skipped, not deleted.
        #expect(FileManager.default.fileExists(atPath: torn.path))
    }

    @Test func rewritingReplacesTheEntryInPlace() async throws {
        let dir = TempDirectory()
        let spool = try HostSpool(directory: dir.url)
        let entry = SpoolEntry.claimed(job("j1"), at: Date())
        try await spool.write(entry)
        try await spool.write(entry.markedSending())
        try await spool.write(entry.markedSending().reported(.failed, error: "boom"))
        let all = try FileManager.default.contentsOfDirectory(atPath: dir.url.path)
        #expect(all.count == 1)
        let stored = try #require(await spool.list().first)
        #expect(stored.stage == .report && stored.outcome == .failed && stored.error == "boom")
    }
}

struct HostLoopTests {
    @Test func claimsSendsOnceAndReportsSent() async throws {
        let rig = try HostRig()
        let id = await rig.relay.enqueue(zpl: zpl(for: "a"), id: "a")
        #expect(await rig.loop.tick() == .completed)
        #expect(await rig.writes() == [zpl(for: "a")])
        #expect(await rig.relay.reports == [.init(jobId: id, outcome: .sent, error: nil)])
        #expect(await rig.relay.sendingIds == [id])
        #expect(rig.raw.isEmpty)
        #expect(await rig.loop.tick() == .completed)
        #expect(await rig.writes().count == 1)
    }

    @Test func sendingIsDurableBeforeAnyByteAndPayloadIsGone() async throws {
        let inner = FakeUsbTransport()
        let directory = TempDirectory()
        let spool = try HostSpool(directory: directory.url)
        let spy = SpyTransport(inner: inner, directory: directory.url)
        let relay = FakeRelay()
        await relay.enqueue(zpl: zpl(for: "a"), label: "Ada Lovelace", id: "a")
        let loop = HostLoop(relay: relay, transport: spy, spool: spool, identity: testIdentity, timing: fastTiming)
        _ = await loop.tick()
        let atSend = try #require(spy.spoolAtSend.first)
        #expect(atSend.count == 1)
        #expect(atSend[0].stage == "sending")
        #expect(!atSend[0].text.contains(zplMarker("a")) && !atSend[0].text.contains("Ada"))
        #expect(await inner.writes.count == 1)
    }

    @Test func onlyAClaimedEntryHoldsTheZplAndLabel() async throws {
        let rig = try HostRig()
        await rig.relay.enqueue(zpl: zpl(for: "a"), label: "Ada Lovelace", id: "a")
        // The cloud does not answer `sending`, so the job goes back to claimed with nothing written.
        await rig.relay.failNext(.sending, .network)
        _ = await rig.loop.tick()
        var entry = try #require(rig.raw.first)
        #expect(entry.stage == "claimed" && entry.text.contains(zplMarker("a")) && entry.text.contains("Ada"))
        #expect(await rig.writes().isEmpty)

        // Written, but the report cannot be delivered: the entry stays as a report with no payload.
        await rig.relay.failNext(.report, .network)
        _ = await rig.loop.tick()
        entry = try #require(rig.raw.first)
        #expect(entry.stage == "report" && entry.json["outcomeRaw"] as? String == "sent")
        #expect(!entry.text.contains(zplMarker("a")) && !entry.text.contains("Ada"))
        #expect(await rig.writes().count == 1)
    }

    @Test func aSendingEntryAfterRestartIsReportedAmbiguousAndNeverResent() async throws {
        let rig = try HostRig()
        // A previous run claimed the job, marked it sending and was killed.
        let leased = try #require(await rig.relay.claimJobs(zpl: zpl(for: "a"), id: "a"))
        try await rig.spool.write(SpoolEntry.claimed(leased, at: Date()).markedSending())
        _ = try await rig.relay.sending(jobId: "a", claimToken: leased.claimToken)

        #expect(await rig.loop.tick() == .completed)
        #expect(await rig.writes().isEmpty)
        let reports = await rig.relay.reports
        #expect(reports.map(\.outcome) == [.ambiguous])
        #expect(reports.first?.error?.isEmpty == false)
        #expect(rig.raw.isEmpty)
    }

    @Test func aSendingEntryStaysAmbiguousWhileThePrinterIsAway() async throws {
        let rig = try HostRig(transport: FakeUsbTransport(status: UsbPrinterStatus(driver: .unknown)))
        let leased = try #require(await rig.relay.claimJobs(zpl: zpl(for: "a"), id: "a"))
        try await rig.spool.write(SpoolEntry.claimed(leased, at: Date()).markedSending())
        _ = await rig.loop.tick()
        #expect(await rig.relay.reports.map(\.outcome) == [.ambiguous])
        #expect(await rig.writes().isEmpty)
    }

    @Test(arguments: [
        (Result<Int, UsbTransportError>.failure(.driverNotFound), RelayReportOutcome.failed),
        (.failure(.notAttached), .failed),
        (.failure(.openFailed(code: -5)), .failed),
        (.failure(.writeFailed(code: -1, bytesWritten: 0)), .ambiguous),
        (.failure(.writeFailed(code: -1, bytesWritten: 7)), .ambiguous),
        (.failure(.shortWrite(written: 3, expected: 20)), .ambiguous),
        (.failure(.timeout), .ambiguous),
        (.failure(.readFailed(code: -1)), .ambiguous),
        (.success(3), .ambiguous),
        (.success(20), .sent),
    ])
    func transportResultsMapToOutcomes(result: Result<Int, UsbTransportError>, expected: RelayReportOutcome) {
        #expect(HostLoop.outcome(of: result, expected: 20).0 == expected)
    }

    @Test func aTransportFailureIsReportedOnceAndNeverRetried() async throws {
        let rig = try HostRig()
        await rig.relay.enqueue(zpl: zpl(for: "a"), id: "a")
        await rig.transport.enqueueSend(.failure(.timeout))
        _ = await rig.loop.tick()
        _ = await rig.loop.tick()
        #expect(await rig.writes().count == 1)
        #expect(await rig.relay.reports.map(\.outcome) == [.ambiguous])

        await rig.relay.enqueue(zpl: zpl(for: "b"), id: "b")
        await rig.transport.enqueueSend(.failure(.driverNotFound))
        _ = await rig.loop.tick()
        #expect(await rig.relay.reports.map(\.outcome) == [.ambiguous, .failed])
    }

    @Test func reportsAreRetriedUntilDelivered() async throws {
        let rig = try HostRig()
        await rig.relay.enqueue(zpl: zpl(for: "a"), id: "a")
        await rig.relay.failNext(.report, .network, .network)
        _ = await rig.loop.tick()
        #expect(rig.raw.map(\.stage) == ["report"])
        _ = await rig.loop.tick()
        #expect(rig.raw.map(\.stage) == ["report"])
        #expect(await rig.relay.reports.isEmpty)
        _ = await rig.loop.tick()
        #expect(rig.raw.isEmpty)
        #expect(await rig.relay.reports.map(\.outcome) == [.sent])
        #expect(await rig.writes().count == 1)
    }

    @Test func aStaleReportDropsTheEntry() async throws {
        let rig = try HostRig()
        await rig.relay.enqueue(zpl: zpl(for: "a"), id: "a")
        await rig.relay.failNext(.report, .stale)
        _ = await rig.loop.tick()
        #expect(rig.raw.isEmpty)
        #expect(await rig.relay.reports.isEmpty)
        #expect(await rig.writes().count == 1)
        _ = await rig.loop.tick()
        #expect(await rig.relay.calls.filter { $0 == .report }.count == 1)
    }

    @Test func aStaleSendingAnswerDropsTheJobWithoutPrinting() async throws {
        let rig = try HostRig()
        await rig.relay.enqueue(zpl: zpl(for: "a"), id: "a")
        await rig.relay.failNext(.sending, .stale)
        _ = await rig.loop.tick()
        #expect(rig.raw.isEmpty)
        #expect(await rig.writes().isEmpty)
        #expect(await rig.relay.reports.isEmpty)
    }

    @Test func aCloudErrorBeforeSendingLeavesTheJobClaimedAndItPrintsOnceLater() async throws {
        let rig = try HostRig()
        await rig.relay.enqueue(zpl: zpl(for: "a"), id: "a")
        await rig.relay.failNext(.sending, .network)
        _ = await rig.loop.tick()
        #expect(rig.raw.map(\.stage) == ["claimed"])
        #expect(await rig.writes().isEmpty)
        _ = await rig.loop.tick()
        #expect(await rig.writes().count == 1)
        #expect(await rig.relay.reports.map(\.outcome) == [.sent])
    }

    @Test func aClaimedJobPastItsLeaseIsDroppedUnsentEvenWhileThePrinterIsAway() async throws {
        let rig = try HostRig(transport: FakeUsbTransport(status: UsbPrinterStatus(driver: .unknown)))
        let expired = RelayJob(
            id: "a", printerId: FakeRelay.printerId, label: "Ada Lovelace", copy: 1, zpl: zpl(for: "a"), claimToken: "c",
            leaseExpiresAt: "2020-01-01T00:00:00.000Z", attempt: 1, host: "usb", port: 0
        )
        try await rig.spool.write(SpoolEntry.claimed(expired, at: Date()))
        _ = await rig.loop.tick()
        #expect(rig.raw.isEmpty, "the expired job's label text is still on disk")
        #expect(await rig.relay.calls.contains(.sending) == false)
        #expect(await rig.writes().isEmpty)
    }

    @Test func anUnreadableLeaseNeverDropsAJob() async throws {
        let rig = try HostRig()
        let leased = try #require(await rig.relay.claimJobs(zpl: zpl(for: "a"), id: "a"))
        for lease in ["garbage", "", "2099-01-01T00:00:00Z", "2099-01-01T00:00:00.123Z"] {
            let job = RelayJob(
                id: "a", printerId: leased.printerId, label: leased.label, copy: 1, zpl: leased.zpl,
                claimToken: leased.claimToken, leaseExpiresAt: lease, attempt: 1, host: "usb", port: 0
            )
            #expect(HostLoop.leaseHasExpired(lease, now: Date()) == false)
            try await rig.spool.write(SpoolEntry.claimed(job, at: Date()))
        }
        _ = await rig.loop.tick()
        #expect(await rig.writes().count == 1)
        #expect(HostLoop.leaseHasExpired("2020-01-01T00:00:00Z", now: Date()))
        #expect(HostLoop.leaseHasExpired("2020-01-01T00:00:00.500Z", now: Date()))
    }

    @Test func aJobWithNoLabelDataIsFailedWithoutAWrite() async throws {
        let rig = try HostRig()
        await rig.relay.enqueue(zpl: "", id: "a")
        _ = await rig.loop.tick()
        #expect(await rig.writes().isEmpty)
        #expect(await rig.relay.reports.map(\.outcome) == [.failed])
    }

    @Test func aRefusedCredentialStopsTheCycleAndKeepsEverything() async throws {
        let rig = try HostRig()
        let leased = try #require(await rig.relay.claimJobs(zpl: zpl(for: "a"), id: "a"))
        try await rig.spool.write(SpoolEntry.claimed(leased, at: Date()).markedSending().reported(.ambiguous, error: "x"))
        await rig.relay.failNext(.heartbeat, .auth)
        #expect(await rig.loop.tick() == .authRejected)
        #expect(await rig.loop.currentStatus.authRejected)
        #expect(rig.raw.map(\.stage) == ["report"])
        // Config and the refused heartbeat were the only calls.
        #expect(await rig.relay.calls == [.config, .heartbeat])

        // A later cycle works again once the cloud accepts the credential.
        #expect(await rig.loop.tick() == .completed)
        #expect(await rig.loop.currentStatus.authRejected == false)
        #expect(await rig.relay.reports.map(\.outcome) == [.ambiguous])
    }

    @Test func aRefusedCredentialOnReportKeepsTheEntryAndSendsNothingMore() async throws {
        let rig = try HostRig()
        await rig.relay.enqueue(zpl: zpl(for: "a"), id: "a")
        await rig.relay.enqueue(zpl: zpl(for: "b"), id: "b")
        await rig.relay.failNext(.report, .auth)
        #expect(await rig.loop.tick() == .authRejected)
        #expect(rig.raw.map(\.stage).sorted() == ["claimed", "report"])
        #expect(await rig.writes().count == 1)
    }

    @Test func heartbeatCarriesPrinterStateSpoolDepthAndVersions() async throws {
        let rig = try HostRig()
        // Two outcomes from an earlier run are still waiting to be reported.
        for id in ["a", "b"] {
            let leased = try #require(await rig.relay.claimJobs(zpl: zpl(for: id), id: id))
            try await rig.spool.write(SpoolEntry.claimed(leased, at: Date()).markedSending().reported(.ambiguous, error: "x"))
        }
        _ = await rig.loop.tick()
        let first = try #require(await rig.relay.heartbeats.first)
        #expect(first.printerAttached == true)
        #expect(first.spoolDepth == 2)
        #expect(first.appVersion == "9.9 (99)" && first.osVersion == "iPadOS 18.0.0")
        #expect(first.relayVersion == "9.9 (99)")
        #expect(first.printerIds == [FakeRelay.printerId])
        #expect(first.probes.map(\.reachable) == [true])
        _ = await rig.loop.tick()
        #expect(await rig.relay.heartbeats.last?.spoolDepth == 0)
    }

    @Test(arguments: [
        UsbPrinterStatus(driver: .unknown),
        UsbPrinterStatus(driver: .printerPresentDriverNotRunning, printerAttached: true),
        UsbPrinterStatus(driver: .running, printerAttached: nil),
    ])
    func claimsOnlyWhenThePrinterIsAttachedAndTheDriverReachable(status: UsbPrinterStatus) async throws {
        let rig = try HostRig(transport: FakeUsbTransport(status: status))
        await rig.relay.enqueue(zpl: zpl(for: "a"), id: "a")
        _ = await rig.loop.tick()
        #expect(await rig.relay.calls.contains(.claim) == false)
        #expect(await rig.relay.calls.contains(.heartbeat))
        #expect(await rig.relay.heartbeats.last?.probes.map(\.reachable) == [false])
        #expect(await rig.relay.heartbeats.last?.printerAttached == status.printerAttached)
        #expect(await rig.relay.pendingCount == 1)

        await rig.transport.setStatus(FakeUsbTransport.readyStatus)
        _ = await rig.loop.tick()
        #expect(await rig.writes().count == 1)
    }

    @Test func aJobClaimedBeforeAnUnplugWaitsForTheReplugInsteadOfSending() async throws {
        let rig = try HostRig()
        await rig.relay.enqueue(zpl: zpl(for: "a"), id: "a")
        await rig.relay.failNext(.sending, .network)
        _ = await rig.loop.tick()
        await rig.transport.setStatus(UsbPrinterStatus(driver: .unknown))
        _ = await rig.loop.tick()
        #expect(rig.raw.map(\.stage) == ["claimed"])
        #expect(await rig.writes().isEmpty)
        await rig.transport.setStatus(FakeUsbTransport.readyStatus)
        _ = await rig.loop.tick()
        #expect(await rig.writes().count == 1)
        #expect(rig.raw.isEmpty)
    }

    @Test func aPrinterTheCloudDisabledGetsNoClaimAndNoBytes() async throws {
        let rig = try HostRig()
        await rig.relay.enqueue(zpl: zpl(for: "a"), id: "a")
        await rig.relay.setPrinterEnabled(false)
        _ = await rig.loop.tick()
        #expect(await rig.relay.calls.contains(.claim) == false)
        #expect(await rig.writes().isEmpty)
    }

    @Test func nothingIsClaimedBeyondTheSpoolLimit() async throws {
        let rig = try HostRig(timing: HostLoop.Timing(poll: .milliseconds(10), heartbeat: 0, claimLimit: 5, maxSpool: 2))
        for id in ["a", "b", "c", "d"] { await rig.relay.enqueue(zpl: zpl(for: id), id: id) }
        await rig.relay.failNext(.sending, .network, .network)
        _ = await rig.loop.tick()
        #expect(rig.raw.count == 2)
        await rig.relay.failNext(.sending, .network, .network)
        _ = await rig.loop.tick()
        #expect(rig.raw.count == 2)
        #expect(await rig.relay.pendingCount == 2)
    }

    @Test func stopWaitsForTheSendInProgressAndStartsNothingNew() async throws {
        let transport = GatedTransport()
        let directory = TempDirectory()
        let relay = FakeRelay()
        await relay.enqueue(zpl: zpl(for: "a"), id: "a")
        await relay.enqueue(zpl: zpl(for: "b"), id: "b")
        let loop = HostLoop(relay: relay, transport: transport, spool: try HostSpool(directory: directory.url), identity: testIdentity, timing: fastTiming)
        await loop.start()
        await transport.waitUntilSending()

        let stopped = Task { await loop.stop() }
        try await Task.sleep(for: .milliseconds(100))
        #expect(await loop.isRunning, "stop returned while a send was still writing")
        await transport.releaseSend()
        await stopped.value

        #expect(await loop.isRunning == false)
        #expect(await transport.writes.count == 1)
        #expect(await relay.reports.map(\.jobId) == ["a"])
        // The second job was claimed but never sent; it waits claimed for the next start.
        #expect(rawEntries(in: directory.url).map(\.stage) == ["claimed"])
    }

    @Test func theLoopKeepsPollingAndCanBeRestarted() async throws {
        let rig = try HostRig()
        await rig.loop.start()
        await rig.relay.enqueue(zpl: zpl(for: "a"), id: "a")
        #expect(await eventually { await rig.relay.reports.count == 1 })
        await rig.loop.stop()
        let callsAfterStop = await rig.relay.calls.count
        try await Task.sleep(for: .milliseconds(80))
        #expect(await rig.relay.calls.count == callsAfterStop)

        await rig.relay.enqueue(zpl: zpl(for: "b"), id: "b")
        await rig.loop.start()
        #expect(await eventually { await rig.relay.reports.count == 2 })
        await rig.loop.stop()
        #expect(await rig.writes().count == 2)
    }

    @Test func concurrentTicksJoinInsteadOfOverlapping() async throws {
        let rig = try HostRig()
        for id in ["a", "b", "c"] { await rig.relay.enqueue(zpl: zpl(for: id), id: id) }
        async let one = rig.loop.tick()
        async let two = rig.loop.tick()
        _ = await (one, two)
        #expect(await rig.writes().count == 3)
        #expect(await rig.relay.reports.count == 3)
    }
}

/// Counts how often the host credential is touched.
final class CountingCredentialStore: HostCredentialStore, @unchecked Sendable {
    private let inner: SecretHostCredentialStore
    private let lock = NSLock()
    private var counts = (load: 0, save: 0, delete: 0)

    init(secrets: InMemorySecretStore) { inner = SecretHostCredentialStore(secrets: secrets) }

    var loads: Int { lock.withLock { counts.load } }
    var touches: Int { lock.withLock { counts.load + counts.save + counts.delete } }

    func load() throws -> HostCredential? {
        lock.withLock { counts.load += 1 }
        return try inner.load()
    }

    func save(_ credential: HostCredential) throws {
        lock.withLock { counts.save += 1 }
        try inner.save(credential)
    }

    func delete() throws {
        lock.withLock { counts.delete += 1 }
        try inner.delete()
    }
}

private let relayBase = "/api/printing/relay"
private let enrolledJSON = #"{"relayId":"relay-1","token":"enroll-secret-token","label":"Desk","printer":{"id":"p1","name":"Kids printer","usbSerial":"FAKE0001","campusId":1}}"#
private let configJSON = #"{"apiVersion":1,"relayId":"relay-1","label":"Desk","printerIds":["p1"],"printers":[{"id":"p1","name":"Kids printer","usbSerial":"FAKE0001","campusId":1}]}"#

private func relayServer(enroll: MockURLProtocol.Reply = .json(200, enrolledJSON)) -> MockServer {
    MockServer { request in
        switch request.url?.path {
        case relayBase + "/enroll": enroll
        case relayBase + "/config": .json(200, configJSON)
        case relayBase + "/heartbeat":
            .json(200, #"{"ok":true,"serverTime":"now","printers":[{"id":"p1","name":"Kids printer","enabled":true,"host":"usb","port":0}]}"#)
        case relayBase + "/claim": .json(200, #"{"jobs":[],"rejectedPrinterIds":[]}"#)
        default: .json(404, "{}")
        }
    }
}

private func storedCredential(_ token: String = "stored-secret-token") -> InMemorySecretStore {
    InMemorySecretStore(#"{"relayId":"relay-1","token":"\#(token)"}"#)
}

@MainActor
private func makeController(
    server: MockServer, secrets: InMemorySecretStore, arguments: [String] = [],
    transport: FakeUsbTransport = FakeUsbTransport(), directory: TempDirectory = TempDirectory()
) throws -> (HostController, CountingCredentialStore) {
    let store = CountingCredentialStore(secrets: secrets)
    let controller = try HostController.make(
        arguments: arguments, baseURL: server.baseURL, credentials: store, transport: transport,
        spoolDirectory: directory.url, session: RelayAPIClient.makeSession(protocolClasses: [MockURLProtocol.self]),
        identity: testIdentity, timing: fastTiming
    )
    return (controller, store)
}

@MainActor
private func makeController(
    secrets: InMemorySecretStore, relay: FakeRelay, directory: TempDirectory,
    transport: any UsbPrinterTransport = FakeUsbTransport()
) throws -> HostController {
    HostController(
        backend: .real(
            credentials: SecretHostCredentialStore(secrets: secrets),
            makeRelay: { _ in relay },
            enroll: { _ in throw RelayEnrollFailure.network }
        ),
        transport: transport, spool: try HostSpool(directory: directory.url), identity: testIdentity, timing: fastTiming
    )
}

@MainActor
struct HostControllerEnrollmentTests {
    @Test func enrollSavesTheCredentialThenFetchesConfigAndLogsNoToken() async throws {
        let server = relayServer()
        let secrets = InMemorySecretStore()
        let (controller, _) = try makeController(server: server, secrets: secrets)
        #expect(await controller.enroll(code: "  ABCD-1234 \n") == nil)

        let stored = try JSONDecoder().decode(HostCredential.self, from: Data(try #require(secrets.current).utf8))
        #expect(stored == HostCredential(relayId: "relay-1", token: "enroll-secret-token"))
        #expect(controller.enrollment == .enrolled)
        #expect(controller.printerName == "Kids printer")
        #expect(controller.error == nil)

        let requests = server.requests
        #expect(requests.map { $0.url?.path } == [relayBase + "/enroll", relayBase + "/config"])
        #expect(requests[0].value(forHTTPHeaderField: "Authorization") == nil)
        let bodyData = try #require(requests[0].httpBody)
        let body = try #require(JSONSerialization.jsonObject(with: bodyData) as? [String: String])
        #expect(body["code"] == "ABCD-1234" && body["usbSerial"] == "FAKE0001")
        #expect(body["appVersion"] == "9.9 (99)" && body["osVersion"] == "iPadOS 18.0.0")
        #expect(requests[1].value(forHTTPHeaderField: "Authorization") == "Bearer enroll-secret-token")
        #expect(requests[1].value(forHTTPHeaderField: "x-relay-id") == "relay-1")

        #expect(!"\(stored)".contains("enroll-secret-token") && !"\(String(reflecting: stored))".contains("enroll-secret-token"))
        var dumped = ""
        dump(stored, to: &dumped)
        #expect(!dumped.contains("enroll-secret-token"))
    }

    @Test func aPrinterConflictSurfacesItsReasonAndLeavesNoCredential() async throws {
        let server = relayServer(enroll: .error(409, "printer_conflict", reason: "serial_in_use"))
        let secrets = InMemorySecretStore()
        let (controller, store) = try makeController(server: server, secrets: secrets)
        #expect(await controller.enroll(code: "ABCD") == .enrollment(.printerConflict(.serialInUse)))
        #expect(controller.error?.message == "This printer is already in use by another device.")
        #expect(secrets.current == nil)
        #expect(controller.enrollment == .notEnrolled)
        #expect(server.requests.count == 1)
        #expect(store.touches == 1, "only the launch read touched the store")
    }

    @Test(arguments: [
        (MockURLProtocol.Reply.error(409, "conflict"), RelayEnrollFailure.codeUsed),
        (.error(410, "code_expired"), .codeExpired),
        (.error(404, "invalid_code"), .invalidCode),
        (.error(429, "rate_limited"), .throttled),
        (.error(501, "enrollment_disabled"), .disabled),
        (.error(500, "oops"), .network),
    ])
    func everyEnrollFailureLeavesNoPartialCredential(reply: MockURLProtocol.Reply, expected: RelayEnrollFailure) async throws {
        let server = relayServer(enroll: reply)
        let secrets = InMemorySecretStore()
        let (controller, _) = try makeController(server: server, secrets: secrets)
        #expect(await controller.enroll(code: "ABCD") == .enrollment(expected))
        #expect(secrets.current == nil)
        #expect(server.requests.map { $0.url?.path } == [relayBase + "/enroll"])
    }

    @Test func aLostConnectionLeavesNoCredential() async throws {
        let server = MockServer { _ in throw URLError(.notConnectedToInternet) }
        let secrets = InMemorySecretStore()
        let (controller, _) = try makeController(server: server, secrets: secrets)
        #expect(await controller.enroll(code: "ABCD") == .enrollment(.network))
        #expect(secrets.current == nil)
    }

    @Test func aFailedEnrollKeepsTheEarlierCredential() async throws {
        let server = relayServer(enroll: .error(410, "code_expired"))
        let secrets = storedCredential("keep-me")
        let (controller, _) = try makeController(server: server, secrets: secrets)
        #expect(await controller.enroll(code: "ABCD") == .enrollment(.codeExpired))
        #expect(try #require(secrets.current).contains("keep-me"))
        #expect(controller.enrollment == .enrolled)
    }

    @Test func aSuccessfulReEnrollReplacesTheCredential() async throws {
        let server = relayServer()
        let secrets = storedCredential("old-token")
        let (controller, _) = try makeController(server: server, secrets: secrets)
        #expect(await controller.enroll(code: "ABCD") == nil)
        let stored = try #require(secrets.current)
        #expect(stored.contains("enroll-secret-token") && !stored.contains("old-token"))
    }

    @Test func enrollNeedsAReadyPrinterAndMakesNoRequest() async throws {
        let server = relayServer()
        let secrets = InMemorySecretStore()
        for status in [UsbPrinterStatus(driver: .unknown), UsbPrinterStatus(driver: .running, printerAttached: true, usbSerial: nil)] {
            let (controller, _) = try makeController(server: server, secrets: secrets, transport: FakeUsbTransport(status: status))
            #expect(await controller.enroll(code: "ABCD") == .printerNotReady)
        }
        #expect(server.requests.isEmpty && secrets.current == nil)
    }

    @Test func anEmptyCodeIsRejectedWithoutARequest() async throws {
        let server = relayServer()
        let (controller, _) = try makeController(server: server, secrets: InMemorySecretStore())
        #expect(await controller.enroll(code: " \n") == .enrollment(.invalidCode))
        #expect(server.requests.isEmpty)
    }

    @Test func aCredentialThatCannotBeSavedIsReportedAndNothingIsStored() async throws {
        let server = relayServer()
        let secrets = InMemorySecretStore()
        secrets.failWrites = true
        let (controller, _) = try makeController(server: server, secrets: secrets)
        #expect(await controller.enroll(code: "ABCD") == .credentialUnavailable)
        #expect(secrets.current == nil)
        #expect(server.requests.map { $0.url?.path } == [relayBase + "/enroll"])
        #expect(controller.enrollment == .notEnrolled)
    }

    @Test func unenrollDeletesOnlyTheHostCredential() async throws {
        let server = relayServer()
        let host = storedCredential()
        let checkin = InMemorySecretStore("checkin-bearer")
        let directory = TempDirectory()
        let (controller, _) = try makeController(server: server, secrets: host, directory: directory)
        let seed = try HostSpool(directory: directory.url)
        try await seed.write(SpoolEntry.claimed(
            RelayJob(id: "j1", printerId: "p1", label: "Ada", copy: 1, zpl: "^XA", claimToken: "c", leaseExpiresAt: "x", attempt: 1, host: "usb", port: 0),
            at: Date()
        ))

        await controller.unenroll()
        #expect(host.current == nil)
        #expect(checkin.current == "checkin-bearer")
        #expect(controller.enrollment == .notEnrolled)
        #expect(controller.isLoopRunning == false)
        #expect(rawEntries(in: directory.url).map(\.id) == ["j1"], "unenroll must not touch the spool")
    }

    @Test func aKeychainThatWillNotAnswerIsNotTreatedAsNotEnrolled() async throws {
        let server = relayServer()
        let secrets = storedCredential()
        let unreadable = UnreadableSecretStore(secrets)
        unreadable.failReads = true
        let directory = TempDirectory()
        let controller = HostController(
            backend: .real(
                credentials: SecretHostCredentialStore(secrets: unreadable),
                makeRelay: { try RelayAPIClient(baseURL: server.baseURL, relayId: $0.relayId, token: $0.token, session: RelayAPIClient.makeSession(protocolClasses: [MockURLProtocol.self])) },
                enroll: { _ in throw RelayEnrollFailure.network }
            ),
            transport: FakeUsbTransport(), spool: try HostSpool(directory: directory.url), identity: testIdentity, timing: fastTiming
        )
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(controller.enrollment == .launching)
        #expect(controller.error == .credentialUnavailable)

        unreadable.failReads = false
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(controller.enrollment == .enrolled)
        #expect(controller.error == nil)
        await controller.unenroll()
    }
}

@MainActor
struct HostControllerLifecycleTests {
    @Test func theLoopRunsOnlyWhileTheAppIsActive() async throws {
        let relay = FakeRelay()
        let controller = try makeController(secrets: storedCredential(), relay: relay, directory: TempDirectory())
        #expect(controller.isLoopRunning == false)

        controller.scenePhaseChanged(.inactive)
        await controller.settled()
        #expect(controller.isLoopRunning == false)

        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(controller.isLoopRunning)
        #expect(await eventually { await relay.calls.contains(.heartbeat) })

        // A system sheet is not a backgrounding.
        controller.scenePhaseChanged(.inactive)
        await controller.settled()
        #expect(controller.isLoopRunning)

        controller.scenePhaseChanged(.background)
        await controller.settled()
        #expect(controller.isLoopRunning == false)
        let calls = await relay.calls.count
        try await Task.sleep(for: .milliseconds(100))
        #expect(await relay.calls.count == calls, "the loop kept calling the relay in the background")

        await relay.enqueue(zpl: zpl(for: "a"), id: "a")
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(controller.isLoopRunning)
        #expect(await eventually { await relay.reports.map(\.jobId) == ["a"] })
        controller.scenePhaseChanged(.background)
        await controller.settled()
    }

    @Test func quickPhaseFlipsEndWhereTheLastOneSays() async throws {
        let relay = FakeRelay()
        let controller = try makeController(secrets: storedCredential(), relay: relay, directory: TempDirectory())
        for _ in 0..<5 {
            controller.scenePhaseChanged(.active)
            controller.scenePhaseChanged(.background)
        }
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(controller.isLoopRunning)
        controller.scenePhaseChanged(.background)
        await controller.settled()
        #expect(controller.isLoopRunning == false)
    }

    @Test func noCredentialMeansNotEnrolledAndNoLoop() async throws {
        let relay = FakeRelay()
        let controller = try makeController(secrets: InMemorySecretStore(), relay: relay, directory: TempDirectory())
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(controller.enrollment == .notEnrolled)
        #expect(controller.isLoopRunning == false)
        #expect(await relay.calls.isEmpty)
    }

    @Test func aRefusedCredentialStopsTheLoopSurfacesAnErrorAndWipesNothing() async throws {
        let relay = FakeRelay()
        let secrets = storedCredential()
        let directory = TempDirectory()
        let controller = try makeController(secrets: secrets, relay: relay, directory: directory)
        let leased = try #require(await relay.claimJobs(zpl: zpl(for: "a"), id: "a"))
        try await HostSpool(directory: directory.url)
            .write(SpoolEntry.claimed(leased, at: Date()).markedSending().reported(.ambiguous, error: "x"))
        await relay.failNext(.heartbeat, .auth)

        controller.scenePhaseChanged(.active)
        #expect(await eventuallyOnMain { controller.error == .authRejected })
        await controller.settled()
        #expect(controller.isLoopRunning == false)
        #expect(controller.error?.message.contains("Enroll again") == true)
        #expect(try #require(secrets.current).contains("stored-secret-token"))
        #expect(rawEntries(in: directory.url).map(\.stage) == ["report"])

        // Going to the background and back does not hammer a relay that refused us.
        let calls = await relay.calls.count
        controller.scenePhaseChanged(.background)
        controller.scenePhaseChanged(.active)
        await controller.settled()
        try await Task.sleep(for: .milliseconds(100))
        #expect(await relay.calls.count == calls)
        #expect(controller.isLoopRunning == false)

        // Retrying is the user's call.
        controller.retryAfterAuthError()
        #expect(await eventually { await relay.reports.map(\.outcome) == [.ambiguous] })
        #expect(controller.error == nil)
        controller.scenePhaseChanged(.background)
        await controller.settled()
    }

    @Test func enrollingWhileActiveStartsTheLoopAndAStaleLoopStops() async throws {
        let server = relayServer()
        let secrets = InMemorySecretStore()
        let (controller, _) = try makeController(server: server, secrets: secrets)
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(controller.enrollment == .notEnrolled && controller.isLoopRunning == false)

        #expect(await controller.enroll(code: "ABCD") == nil)
        #expect(controller.isLoopRunning)
        #expect(await eventually { server.requests.contains { $0.url?.path == relayBase + "/heartbeat" } })
        controller.scenePhaseChanged(.background)
        await controller.settled()
        #expect(controller.isLoopRunning == false)
    }
}

@MainActor
struct HostRelaySelectionTests {
    @Test func theFakeRelayArgumentIsExplicit() {
        #expect(HostRelayMode.fakeRelayArgument == "-FavorHostFakeRelay")
        #expect(HostRelayMode.resolve(arguments: ["app", "-FavorHostFakeRelay"]) == .fake)
        #expect(HostRelayMode.resolve(arguments: ["app"]) == .real)
        #expect(HostRelayMode.resolve(arguments: ["app", "-FavorUITestMock", "FavorHostFakeRelay"]) == .real)
    }

    @Test func fakeRelayModeIgnoresAStoredCredentialAndSendsNothingOverHTTP() async throws {
        let server = relayServer()
        let secrets = storedCredential()
        let transport = FakeUsbTransport()
        let (controller, store) = try makeController(server: server, secrets: secrets, arguments: ["-FavorHostFakeRelay"], transport: transport)
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(controller.enrollment == .fakeRelay)
        // The fake's demo label prints, so the loop really ran.
        #expect(await eventually { await transport.writes.count == 1 })
        #expect(await eventually { await controller.fakeRelay?.reports.count == 1 })

        #expect(await controller.enroll(code: "ABCD") == .fakeRelayActive)
        await controller.unenroll()
        controller.scenePhaseChanged(.background)
        await controller.settled()

        #expect(server.requests.isEmpty, "the fake relay reached the HTTP layer")
        #expect(store.touches == 0, "the fake relay mode touched the host credential")
        #expect(try #require(secrets.current).contains("stored-secret-token"))
    }

    @Test func fakeRelayJobsNeverMixWithTheRealSpool() async throws {
        let real = TempDirectory()
        let server = relayServer()
        let leased = RelayJob(id: "real-1", printerId: FakeRelay.printerId, label: "Ada", copy: 1, zpl: "^XA^FDreal^FS^XZ", claimToken: "c", leaseExpiresAt: "x", attempt: 1, host: "usb", port: 0)
        try await HostSpool(directory: real.url).write(SpoolEntry.claimed(leased, at: Date()))
        let transport = FakeUsbTransport()
        let controller = try HostController.make(
            arguments: ["-FavorHostFakeRelay"], baseURL: server.baseURL, credentials: CountingCredentialStore(secrets: InMemorySecretStore()),
            transport: transport, spoolDirectory: TempDirectory().url, identity: testIdentity, timing: fastTiming
        )
        controller.scenePhaseChanged(.active)
        #expect(await eventually { await transport.writes.count == 1 })
        controller.scenePhaseChanged(.background)
        await controller.settled()
        #expect(rawEntries(in: real.url).map(\.id) == ["real-1"])
    }

    @Test func withoutTheArgumentAStoredCredentialSelectsTheRealRelay() async throws {
        let server = relayServer()
        let (controller, store) = try makeController(server: server, secrets: storedCredential("real-token"))
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(controller.enrollment == .enrolled)
        #expect(await eventually { server.requests.contains { $0.url?.path == relayBase + "/heartbeat" } })
        controller.scenePhaseChanged(.background)
        await controller.settled()
        #expect(store.loads >= 1)
        #expect(server.requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer real-token" })
    }

    @Test func withoutTheArgumentAndWithoutACredentialNothingIsContacted() async throws {
        let server = relayServer()
        let (controller, _) = try makeController(server: server, secrets: InMemorySecretStore())
        controller.scenePhaseChanged(.active)
        await controller.settled()
        controller.scenePhaseChanged(.background)
        await controller.settled()
        #expect(controller.enrollment == .notEnrolled)
        #expect(server.requests.isEmpty)
    }
}
