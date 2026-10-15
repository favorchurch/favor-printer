import Foundation
import Testing
@testable import FavorPrinter

private final class PausedBeatHarness: @unchecked Sendable {
    private let lock = NSLock()
    private var began = 0
    private var endedIds: [Int] = []

    var beganCount: Int { lock.withLock { began } }
    var ended: [Int] { lock.withLock { endedIds } }

    func begin(_ expiration: @escaping @MainActor () -> Void) -> Int {
        lock.withLock { began += 1; return began }
    }

    func end(_ id: Int) { lock.withLock { endedIds.append(id) } }
}

private let handoverTiming = HostLoop.Timing(poll: .milliseconds(10), heartbeat: 60)
private let enrolledBase = #"{"relayId":"relay-1","token":"enroll-secret-token","label":"Desk","printer":{"id":"p1","name":"Kids printer","usbSerial":"FAKE0001","campusId":1}"#

private func storedHandoverCredential() -> InMemorySecretStore {
    InMemorySecretStore(#"{"relayId":"relay-1","token":"stored-secret-token"}"#)
}

@MainActor
private func controller(
    relay: FakeRelay, harness: PausedBeatHarness = PausedBeatHarness(), timing: HostLoop.Timing = handoverTiming,
    secrets: InMemorySecretStore = storedHandoverCredential(),
    enroll: @escaping @Sendable (RelayEnrollRequest) async throws -> RelayCredentials = { _ in throw RelayEnrollFailure.network }
) throws -> HostController {
    HostController(
        backend: .real(credentials: SecretHostCredentialStore(secrets: secrets), makeRelay: { _ in relay }, enroll: enroll),
        transport: FakeUsbTransport(), spool: try HostSpool(directory: TempDirectory().url), identity: testIdentity, timing: timing,
        beginBackgroundTask: { harness.begin($0) }, endBackgroundTask: { harness.end($0) }
    )
}

private func first(_ server: MockServer) -> URLRequest { server.requests[0] }

private func enrollServer(_ reply: MockURLProtocol.Reply) -> MockServer {
    MockServer { request in
        switch request.url?.path {
        case "/api/printing/relay/enroll": reply
        case "/api/printing/relay/config":
            .json(200, #"{"apiVersion":1,"relayId":"relay-1","label":"Desk","printerIds":["p1"],"printers":[{"id":"p1","name":"Kids printer","usbSerial":"FAKE0001","campusId":1}]}"#)
        default: .json(404, "{}")
        }
    }
}

@MainActor
private func enrollingController(server: MockServer) throws -> HostController {
    try HostController.make(
        arguments: [], baseURL: server.baseURL, credentials: SecretHostCredentialStore(secrets: InMemorySecretStore()),
        transport: FakeUsbTransport(), spoolDirectory: TempDirectory().url,
        session: RelayAPIClient.makeSession(protocolClasses: [MockURLProtocol.self]), identity: testIdentity, timing: handoverTiming
    )
}

struct HostKindAndLifecycleWireTests {
    @Test func everyHeartbeatCarriesHostKindIpadAndLifecycleActive() async throws {
        let rig = try HostRig()
        _ = await rig.loop.tick()
        _ = await rig.loop.tick()
        let beats = await rig.relay.heartbeats
        #expect(beats.count >= 2)
        #expect(beats.allSatisfy { $0.hostKind == .ipad && $0.lifecycle == .active })
    }

    @Test func heartbeatEncodesTheNewFieldsAndOmitsThemWhenNil() throws {
        let base = RelayHeartbeatRequest(printerIds: ["p1"], relayVersion: "1", spoolDepth: 0, probes: [], appVersion: nil, osVersion: nil, printerAttached: nil)
        let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(base)) as? [String: Any])
        #expect(json["hostKind"] as? String == "ipad" && json["lifecycle"] as? String == "active")
        var paused = base
        paused.lifecycle = .paused
        let pausedJSON = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(paused)) as? [String: Any])
        #expect(pausedJSON["lifecycle"] as? String == "paused")
        var bare = base
        bare.hostKind = nil
        bare.lifecycle = nil
        let bareJSON = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(bare)) as? [String: Any])
        #expect(bareJSON["hostKind"] == nil && bareJSON["lifecycle"] == nil)
    }

    @Test func enrollRequestCarriesHostKindIpad() async throws {
        let server = MockServer { _ in .json(200, enrolledBase + "}") }
        _ = try await RelayAPIClient.enroll(
            baseURL: server.baseURL, request: .init(code: "1", usbSerial: "s", appVersion: "1", osVersion: "iPadOS"),
            session: RelayAPIClient.makeSession(protocolClasses: [MockURLProtocol.self])
        )
        let data = try #require(first(server).httpBody)
        let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(body["hostKind"] == "ipad")
    }

    @Test func theFakeRelayAcceptsAndRecordsTheNewFields() async throws {
        let relay = FakeRelay()
        let body = RelayHeartbeatRequest(
            printerIds: [FakeRelay.printerId], relayVersion: "1", spoolDepth: 0, probes: [], appVersion: nil, osVersion: nil,
            printerAttached: true, hostKind: .ipad, lifecycle: .paused
        )
        _ = try await relay.heartbeat(body)
        let beat = try #require(await relay.heartbeats.last)
        #expect(beat.hostKind == .ipad && beat.lifecycle == .paused)
        await relay.setHandover(.listed)
        let listed = try await relay.claim(printerIds: [FakeRelay.printerId], limit: 1)
        #expect(listed.handedOverPrinterIds == [FakeRelay.printerId] && listed.jobs.isEmpty)
        await relay.setHandover(.forbidden)
        await #expect(throws: RelayFailure.printerHandedOver([FakeRelay.printerId])) {
            try await relay.claim(printerIds: [FakeRelay.printerId], limit: 1)
        }
    }
}

@MainActor
struct HostPausedHeartbeatTests {
    @Test func backgroundSendsOnePausedBeatUnderABackgroundTaskThenActiveOnReturn() async throws {
        let relay = FakeRelay()
        let harness = PausedBeatHarness()
        let host = try controller(relay: relay, harness: harness)
        host.scenePhaseChanged(.active)
        await host.settled()
        #expect(await eventually { await relay.heartbeats.count == 1 })
        #expect(await relay.heartbeats.first?.lifecycle == .active)

        host.scenePhaseChanged(.background)
        await host.settled()
        #expect(await eventually { await relay.heartbeats.last?.lifecycle == .paused })
        #expect(await relay.heartbeats.filter { $0.lifecycle == .paused }.count == 1)
        #expect(await relay.heartbeats.last?.hostKind == .ipad)
        #expect(await eventuallyOnMain { harness.ended == [1] })
        #expect(host.isLoopRunning == false)

        host.scenePhaseChanged(.active)
        await host.settled()
        #expect(await eventually { await relay.heartbeats.last?.lifecycle == .active })
        #expect(await relay.heartbeats.count == 3)
        host.scenePhaseChanged(.background)
        await host.settled()
    }

    @Test func aFailedPausedBeatIsIgnored() async throws {
        let relay = FakeRelay()
        let harness = PausedBeatHarness()
        let host = try controller(relay: relay, harness: harness)
        host.scenePhaseChanged(.active)
        await host.settled()
        #expect(await eventually { await relay.heartbeats.count == 1 })

        await relay.failNext(.heartbeat, .network)
        host.scenePhaseChanged(.background)
        await host.settled()
        #expect(await eventuallyOnMain { harness.ended == [1] })
        #expect(await relay.heartbeats.count == 1)
        #expect(host.isLoopRunning == false)
        #expect(host.error == nil)
        #expect(host.enrollment == .enrolled)
    }

    @Test func aPausedBeatNeverWaitsForOrCutsShortASendInFlight() async throws {
        let relay = FakeRelay()
        await relay.enqueue(zpl: zpl(for: "slow"), id: "slow")
        let transport = GatedTransport()
        let loop = HostLoop(relay: relay, transport: transport, spool: try HostSpool(directory: TempDirectory().url), identity: testIdentity, timing: handoverTiming)
        await loop.start()
        await transport.waitUntilSending()
        await loop.sendPausedHeartbeat()
        #expect(await relay.heartbeats.last?.lifecycle == .paused)
        #expect(await relay.reports.isEmpty, "the send is still open")
        let stopped = Task { await loop.stop() }
        await transport.releaseSend()
        await stopped.value
        #expect(await relay.reports.map(\.outcome) == [.sent])
        #expect(await transport.writes.count == 1)
    }

    @Test func noPausedBeatWhenNothingWasEverHeard() async throws {
        let relay = FakeRelay()
        let harness = PausedBeatHarness()
        let host = try controller(relay: relay, harness: harness)
        host.scenePhaseChanged(.background)
        await host.settled()
        #expect(await relay.heartbeats.isEmpty)
    }
}

@MainActor
struct HostEnrollmentHandoverTests {
    @Test func hostActiveConflictShowsTheHandoverCopy() async throws {
        let server = enrollServer(.error(409, "printer_conflict", reason: "host_active"))
        let host = try enrollingController(server: server)
        #expect(await host.enroll(code: "ABCD") == .enrollment(.printerConflict(.hostActive)))
        #expect(host.error?.message == "This printer is active on another host. Ask an RSVP admin to confirm a handover, then use the new code.")
        #expect(host.enrollment == .notEnrolled)
    }

    @Test func handedOverFromIsShownAfterEnroll() async throws {
        let server = enrollServer(.json(200, enrolledBase + #","handedOverFrom":{"hostKind":"mac","label":"Front desk"}}"#))
        let host = try enrollingController(server: server)
        #expect(await host.enroll(code: "ABCD") == nil)
        #expect(host.handedOverFrom == RelayHandedOverFrom(hostKind: .mac, label: "Front desk"))
        #expect(host.handedOverFrom?.summary == "Took over from Mac 'Front desk'")
        let data = try #require(first(server).httpBody)
        let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(body["hostKind"] == "ipad")
        await host.unenroll()
        #expect(host.handedOverFrom == nil)
    }

    @Test func absentOrUnknownHandoverFieldsAreTolerated() async throws {
        let absentServer = enrollServer(.json(200, enrolledBase + "}"))
        let unknownServer = enrollServer(.json(200, enrolledBase + #","handedOverFrom":{"hostKind":"toaster","label":null,"extra":1},"future":true}"#))
        let absent = try await RelayAPIClient.enroll(
            baseURL: absentServer.baseURL,
            request: .init(code: "1", usbSerial: "s", appVersion: "1", osVersion: "i"),
            session: RelayAPIClient.makeSession(protocolClasses: [MockURLProtocol.self])
        )
        #expect(absent.handedOverFrom == nil)
        let unknown = try await RelayAPIClient.enroll(
            baseURL: unknownServer.baseURL,
            request: .init(code: "1", usbSerial: "s", appVersion: "1", osVersion: "i"),
            session: RelayAPIClient.makeSession(protocolClasses: [MockURLProtocol.self])
        )
        #expect(unknown.handedOverFrom == RelayHandedOverFrom(hostKind: nil, label: nil))
        #expect(unknown.handedOverFrom?.summary == "Took over from another host")
        #expect(RelayHandedOverFrom(hostKind: .ipad, label: nil).summary == "Took over from an iPad")
    }
}

struct HostPrinterHandedOverTests {
    @Test func aClaim403IsTerminalNotANetworkError() async throws {
        let server = MockServer { _ in .json(403, #"{"error":"forbidden","reason":"printer_handed_over","printerIds":["p1"]}"#) }
        let client = try server.relayClient(relayId: "r", token: "t")
        await #expect(throws: RelayFailure.printerHandedOver(["p1"])) { try await client.claim(printerIds: ["p1"], limit: 1) }
        let other = MockServer { _ in .json(403, #"{"error":"forbidden"}"#) }
        await #expect(throws: RelayFailure.network) { try await other.relayClient(relayId: "r", token: "t").claim(printerIds: ["p1"], limit: 1) }
    }

    @Test func aClaim200MayListHandedOverIdsAndOlderCloudsOmitThem() async throws {
        let listed = MockServer { _ in .json(200, #"{"jobs":[],"rejectedPrinterIds":["p1"],"handedOverPrinterIds":["p1"],"future":1}"#) }
        #expect(try await listed.relayClient(relayId: "r", token: "t").claim(printerIds: ["p1"], limit: 1).handedOverPrinterIds == ["p1"])
        let older = MockServer { _ in .json(200, #"{"jobs":[],"rejectedPrinterIds":[]}"#) }
        #expect(try await older.relayClient(relayId: "r", token: "t").claim(printerIds: ["p1"], limit: 1).handedOverPrinterIds == [])
    }

    @Test func aForbiddenClaimStopsClaimingWithNoRetryStormAndKeepsTheJob() async throws {
        let rig = try HostRig()
        await rig.relay.enqueue(zpl: zpl(for: "a"), id: "a")
        await rig.relay.setHandover(.forbidden)
        for _ in 0..<6 { _ = await rig.loop.tick() }
        #expect(await rig.relay.calls.filter { $0 == .claim }.count == 1)
        let status = await rig.loop.currentStatus
        #expect(status.printerMoved && !status.authRejected)
        #expect(await rig.relay.pendingCount == 1)
        #expect(await rig.writes().isEmpty)
        let heartbeatsAtMove = await rig.relay.heartbeats.count
        _ = await rig.loop.tick()
        #expect(await rig.relay.heartbeats.count == heartbeatsAtMove)

        // Stopping and starting the same loop (background and back) does not resume claiming.
        await rig.loop.start()
        await rig.loop.stop()
        _ = await rig.loop.tick()
        #expect(await rig.relay.calls.filter { $0 == .claim }.count == 1)

        // An app relaunch builds a new loop, which asks again.
        await rig.relay.setHandover(nil)
        let relaunched = try rig.restarted()
        _ = await relaunched.tick()
        #expect(await eventually { await rig.writes().count == 1 })
    }

    @Test func handedOverPrinterIdsOnA200ClaimStopsClaiming() async throws {
        let rig = try HostRig()
        await rig.relay.setHandover(.listed)
        for _ in 0..<5 { _ = await rig.loop.tick() }
        #expect(await rig.relay.calls.filter { $0 == .claim }.count == 1)
        #expect(await rig.loop.currentStatus.printerMoved)
    }

    @Test func aSendingJobIsStillReportedAmbiguousAndNeverResentWhenThePrinterMoved() async throws {
        let rig = try HostRig()
        let leased = try #require(await rig.relay.claimJobs(zpl: zpl(for: "x"), id: "x"))
        try await rig.spool.write(SpoolEntry.claimed(leased, at: Date()).markedSending())
        await rig.relay.setHandover(.forbidden)
        for _ in 0..<3 { _ = await rig.loop.tick() }
        #expect(await rig.relay.reports.map(\.outcome) == [.ambiguous])
        #expect(await rig.writes().isEmpty)
    }

    @Test func aSendingRejectionForAMovedPrinterIsStaleAndNeverResent() async throws {
        let rig = try HostRig()
        await rig.relay.enqueue(zpl: zpl(for: "m"), id: "m")
        await rig.relay.failNext(.sending, .stale)
        _ = await rig.loop.tick()
        _ = await rig.loop.tick()
        #expect(await rig.writes().isEmpty)
        #expect(await rig.relay.staleIds == ["m"])
        #expect(await rig.relay.reports.isEmpty)
        #expect(rig.raw.isEmpty)
    }

    @MainActor
    @Test func reEnrollingResumesClaimingAndTheCredentialIsKeptMeanwhile() async throws {
        let relay = FakeRelay()
        let secrets = storedHandoverCredential()
        let host = try controller(relay: relay, secrets: secrets) { _ in
            try JSONDecoder().decode(RelayCredentials.self, from: Data((enrolledBase + "}").utf8))
        }
        await relay.setHandover(.forbidden)
        host.scenePhaseChanged(.active)
        await host.settled()
        #expect(await eventuallyOnMain { host.status.printerMoved })
        #expect(host.enrollment == .enrolled && host.error == nil)
        #expect(secrets.current != nil)

        await relay.setHandover(nil)
        await relay.enqueue(zpl: zpl(for: "back"), id: "back")
        #expect(await host.enroll(code: "NEWCODE") == nil)
        #expect(await eventually { await relay.reports.map(\.jobId) == ["back"] })
        #expect(host.status.printerMoved == false)
        host.scenePhaseChanged(.background)
        await host.settled()
    }
}
