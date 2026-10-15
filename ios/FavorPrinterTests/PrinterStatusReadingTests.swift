#if DEBUG
import Foundation
import Testing
@testable import FavorPrinter

struct PrinterStatusReadingTests {
    @Test func sendsTheCommandThenShowsByteCountAndPrintableAscii() async {
        let transport = FakeUsbTransport()
        let answer = Data([0x02] + Array("030,0,0,1245".utf8) + [0x0D, 0x0A, 0x02] + Array("000,0".utf8) + [0x03])
        await transport.enqueueRead(.success(answer))

        let reading = await PrinterStatusReading.read(from: transport)

        #expect(await transport.writes == [Data("~HS".utf8)])
        #expect(reading == .reply(byteCount: answer.count, text: ".030,0,0,1245\n.000,0."))
        #expect(reading.summary == "\(answer.count) bytes\n.030,0,0,1245\n.000,0.")
    }

    @Test func aSilentPrinterIsATypedTimeout() async {
        let transport = FakeUsbTransport()
        #expect(await PrinterStatusReading.read(from: transport) == .failure(.timeout))
        #expect(await transport.readCalls == 1)
    }

    @Test func aFailedWriteIsReportedAndNothingIsRead() async {
        let transport = FakeUsbTransport()
        await transport.enqueueSend(.failure(.notAttached))
        await transport.enqueueRead(.success(Data("never read".utf8)))

        #expect(await PrinterStatusReading.read(from: transport) == .failure(.notAttached))
        #expect(await transport.readCalls == 0)
    }

    @Test func aFailedReadKeepsItsCode() async {
        let transport = FakeUsbTransport()
        await transport.enqueueRead(.failure(.readFailed(code: -536870212)))
        #expect(await PrinterStatusReading.read(from: transport) == .failure(.readFailed(code: -536870212)))
    }

    @Test func nonPrintableBytesBecomeDotsAndLineBreaksCollapse() {
        let data = Data([0x41, 0x00, 0xFF, 0x7F, 0x0D, 0x0A, 0x0A, 0x42])
        #expect(PrinterStatusReading.printable(data) == "A...\nB")
        #expect(PrinterStatusReading.printable(Data()) == "")
    }
}

/// A printer whose first non-probe send waits for the test, and which counts writes in progress at once.
private actor HeldSendTransport: UsbPrinterTransport {
    private(set) var writes: [Data] = []
    private(set) var inFlight = 0
    private(set) var mostInFlight = 0
    private var held: CheckedContinuation<Void, Never>?
    private var gateOpen = false

    func openGate() {
        gateOpen = true
        held?.resume()
        held = nil
    }

    func status() async -> UsbPrinterStatus { FakeUsbTransport.readyStatus }

    func send(_ zpl: Data) async -> Result<Int, UsbTransportError> {
        inFlight += 1
        mostInFlight = max(mostInFlight, inFlight)
        writes.append(zpl)
        if zpl != PrinterStatusReading.command, !gateOpen {
            await withCheckedContinuation { held = $0 }
        }
        inFlight -= 1
        return .success(zpl.count)
    }

    func readStatus() async -> Result<Data, UsbTransportError> {
        .success(Data("ok".utf8))
    }
}

@MainActor
struct HostPrinterStatusControllerTests {
    private func makeController(relay: FakeRelay, transport: any UsbPrinterTransport) throws -> HostController {
        HostController(
            backend: .real(
                credentials: SecretHostCredentialStore(secrets: InMemorySecretStore(#"{"relayId":"relay-1","token":"t"}"#)),
                makeRelay: { _ in relay },
                enroll: { _ in throw RelayEnrollFailure.network }
            ),
            transport: transport, spool: try HostSpool(directory: TempDirectory().url), identity: testIdentity, timing: fastTiming
        )
    }

    @Test func readsThroughTheControllerAndTheLoopKeepsRunning() async throws {
        let transport = FakeUsbTransport()
        await transport.enqueueRead(.success(Data("OK".utf8)))
        let controller = try makeController(relay: FakeRelay(), transport: transport)
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(controller.isLoopRunning)

        #expect(await controller.readPrinterStatus() == .reply(byteCount: 2, text: "OK"))
        #expect(controller.isLoopRunning)
        #expect(controller.isReadingPrinterStatus == false)

        controller.scenePhaseChanged(.background)
        await controller.settled()
    }

    @Test func neverWritesWhileAJobIsSendingAndNeverStartsAJobDuringTheRead() async throws {
        let transport = HeldSendTransport()
        let relay = FakeRelay()
        await relay.enqueue(zpl: zpl(for: "a"), id: "a")
        await relay.enqueue(zpl: zpl(for: "b"), id: "b")
        let controller = try makeController(relay: relay, transport: transport)
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(await eventually { await transport.writes.count == 1 })

        // Job a is held mid-send. The probe has to wait for it.
        let probe = Task { await controller.readPrinterStatus() }
        try await Task.sleep(for: .milliseconds(150))
        #expect(await transport.writes == [Data(zpl(for: "a").utf8)], "~HS went out while a job was sending")

        await transport.openGate()
        #expect(await probe.value == .reply(byteCount: 2, text: "ok"))
        #expect(await transport.mostInFlight == 1)
        #expect(await eventually { await relay.reports.map(\.jobId).sorted() == ["a", "b"] })

        let writes = await transport.writes
        let probeAt = try #require(writes.firstIndex(of: PrinterStatusReading.command))
        #expect(probeAt == 1, "the second job started before the probe finished")

        controller.scenePhaseChanged(.background)
        await controller.settled()
    }

    @Test func aSecondReadWhileOneRunsIsRefused() async throws {
        let transport = HeldSendTransport()
        let relay = FakeRelay()
        await relay.enqueue(zpl: zpl(for: "a"), id: "a")
        let controller = try makeController(relay: relay, transport: transport)
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(await eventually { await transport.writes.count == 1 })

        let first = Task { await controller.readPrinterStatus() }
        #expect(await eventuallyOnMain { controller.isReadingPrinterStatus })
        #expect(await controller.readPrinterStatus() == .busy)

        await transport.openGate()
        _ = await first.value
        controller.scenePhaseChanged(.background)
        await controller.settled()
    }
}
#endif
