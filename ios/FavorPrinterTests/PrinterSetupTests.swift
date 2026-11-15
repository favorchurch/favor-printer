#if DEBUG
import Foundation
import Testing
@testable import FavorPrinter

private let expectedPayloads = [Data("^XA^MMC^XZ".utf8), Data("~JC".utf8), Data("^XA^JUS^XZ".utf8)]

/// Holds the first setup write until the test opens the gate. Job writes pass through.
private actor GatedSetupTransport: UsbPrinterTransport {
    private(set) var writes: [Data] = []
    private var held: CheckedContinuation<Void, Never>?
    private var gateOpen = false

    func openGate() {
        gateOpen = true
        held?.resume()
        held = nil
    }

    func status() async -> UsbPrinterStatus { FakeUsbTransport.readyStatus }

    func send(_ zpl: Data) async -> Result<Int, UsbTransportError> {
        writes.append(zpl)
        if zpl == PrinterSetup.continuousMediaCommand, !gateOpen {
            await withCheckedContinuation { held = $0 }
        }
        return .success(zpl.count)
    }

    func readStatus() async -> Result<Data, UsbTransportError> { .failure(.timeout) }
}

struct PrinterSetupTests {
    @Test func sendsThreeSeparateWritesInOrder() async {
        let transport = FakeUsbTransport()
        #expect(await PrinterSetup.run(on: transport) == .done)
        #expect(await transport.writes == expectedPayloads)
    }

    @Test(arguments: [(0, PrinterSetup.Step.continuousMedia), (1, .calibrate), (2, .saveMediaTracking)])
    func stopsAtTheFirstFailureAndNamesTheStep(failingIndex: Int, step: PrinterSetup.Step) async {
        let transport = FakeUsbTransport()
        var script: [Result<Int, UsbTransportError>] = [.success(1), .success(1), .success(1)]
        script[failingIndex] = .failure(.notAttached)
        for result in script { await transport.enqueueSend(result) }

        #expect(await PrinterSetup.run(on: transport) == .failed(step: step, error: .notAttached))
        #expect(await transport.writes == Array(expectedPayloads.prefix(failingIndex + 1)))
    }
}

@MainActor
struct HostPrinterSetupControllerTests {
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

    @Test func runsThroughTheControllerAndTheLoopResumes() async throws {
        let transport = FakeUsbTransport()
        let controller = try makeController(relay: FakeRelay(), transport: transport)
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(controller.isLoopRunning)

        #expect(await controller.setUpPrinter() == .done)
        #expect(await transport.writes == expectedPayloads)
        #expect(controller.isLoopRunning)
        #expect(controller.isSettingUpPrinter == false)

        controller.scenePhaseChanged(.background)
        await controller.settled()
    }

    @Test func aFailureThroughTheControllerStillResumesTheLoop() async throws {
        let transport = FakeUsbTransport()
        await transport.enqueueSend(.success(1), .failure(.notAttached))
        let controller = try makeController(relay: FakeRelay(), transport: transport)
        controller.scenePhaseChanged(.active)
        await controller.settled()

        #expect(await controller.setUpPrinter() == .failed(step: .calibrate, error: .notAttached))
        #expect(await transport.writes == Array(expectedPayloads.prefix(2)))
        #expect(controller.isLoopRunning)

        controller.scenePhaseChanged(.background)
        await controller.settled()
    }

    @Test func theLoopIsStoppedDuringSetupAndNoJobInterleaves() async throws {
        let transport = GatedSetupTransport()
        let relay = FakeRelay()
        let controller = try makeController(relay: relay, transport: transport)
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(controller.isLoopRunning)

        let setup = Task { await controller.setUpPrinter() }
        #expect(await eventually { await transport.writes == [PrinterSetup.continuousMediaCommand] })
        #expect(controller.isLoopRunning == false, "the loop was still running while the printer was being set up")

        // A job arriving mid-setup must wait: nothing but setup bytes may reach the wire.
        await relay.enqueue(zpl: zpl(for: "a"), id: "a")
        try await Task.sleep(for: .milliseconds(150))
        #expect(await transport.writes == [PrinterSetup.continuousMediaCommand])

        await transport.openGate()
        #expect(await setup.value == .done)
        #expect(await eventually { await relay.reports.map(\.jobId) == ["a"] })

        let writes = await transport.writes
        #expect(Array(writes.prefix(3)) == expectedPayloads, "a job was written between setup commands")
        #expect(writes.count == 4)
        #expect(controller.isLoopRunning)

        controller.scenePhaseChanged(.background)
        await controller.settled()
    }

    @Test func aSecondSetupWhileOneRunsIsBusy() async throws {
        let transport = GatedSetupTransport()
        let controller = try makeController(relay: FakeRelay(), transport: transport)
        controller.scenePhaseChanged(.active)
        await controller.settled()

        let first = Task { await controller.setUpPrinter() }
        #expect(await eventuallyOnMain { controller.isSettingUpPrinter })
        #expect(await controller.setUpPrinter() == .busy)

        await transport.openGate()
        #expect(await first.value == .done)
        #expect(await transport.writes == expectedPayloads)
        #expect(controller.isSettingUpPrinter == false)

        controller.scenePhaseChanged(.background)
        await controller.settled()
    }
}
#endif
