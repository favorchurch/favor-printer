import Foundation
import Testing
@testable import FavorPrinter

// No test here touches IOKit or hardware: the transport runs against `ScriptedDext`, and the mapping is pure.

/// Stands in for the dext. `handler` answers each user-client call and every call is recorded.
final class ScriptedDext: DextBackend, @unchecked Sendable {
    struct Call: Equatable {
        var selector: Int
        var scalarInput: [UInt64]
        var structInput: [UInt8]
        var scalarOutputCount = 0
        var structOutputCapacity = 0
    }

    private let lock = NSLock()
    private var recorded: [Call] = []
    private var openedCount = 0
    private var closedCount = 0
    private let mode: Mode
    private let visible: Bool
    let handler: @Sendable (Call) -> DextReply

    enum Mode {
        case connected
        case noService
        case openFailed(Int32)
    }

    init(
        printerVisible: Bool = false,
        mode: Mode = .connected,
        handler: @escaping @Sendable (Call) -> DextReply = { _ in DextReply(code: 0, scalars: [], data: []) }
    ) {
        visible = printerVisible
        self.mode = mode
        self.handler = handler
    }

    var calls: [Call] { lock.withLock { recorded } }
    var opened: Int { lock.withLock { openedCount } }
    var closed: Int { lock.withLock { closedCount } }

    func connect() -> DextConnectResult {
        switch mode {
        case .connected:
            lock.withLock { openedCount += 1 }
            return .connected(ScriptedConnection(dext: self))
        case .noService:
            return .noService
        case .openFailed(let code):
            return .openFailed(code: code)
        }
    }

    func printerVisible() -> Bool { visible }

    fileprivate func record(_ call: Call) { lock.withLock { recorded.append(call) } }
    fileprivate func recordClose() { lock.withLock { closedCount += 1 } }

    /// A send reply: the dext accepted `written` bytes and the USB result was `usb`.
    static func sendReply(written: Int, usb: Int32 = 0) -> DextReply {
        DextReply(code: 0, scalars: [UInt64(written), UInt64(UInt32(bitPattern: usb))], data: [])
    }
}

struct ScriptedConnection: DextConnection {
    let dext: ScriptedDext

    func call(selector: Int, scalarInput: [UInt64], structInput: [UInt8], scalarOutputCount: Int, structOutputCapacity: Int) -> DextReply {
        let call = ScriptedDext.Call(
            selector: selector, scalarInput: scalarInput, structInput: structInput,
            scalarOutputCount: scalarOutputCount, structOutputCapacity: structOutputCapacity
        )
        dext.record(call)
        // Like IOKit, hand back no more than the caller made room for.
        var reply = dext.handler(call)
        reply.scalars = Array(reply.scalars.prefix(scalarOutputCount))
        reply.data = Array(reply.data.prefix(structOutputCapacity))
        return reply
    }

    func close() { dext.recordClose() }
}

/// Every connection the transport opened was closed, on whatever path it took.
private func expectBalanced(_ dext: ScriptedDext, opened: Int = 1, sourceLocation: SourceLocation = #_sourceLocation) {
    #expect(dext.opened == opened, sourceLocation: sourceLocation)
    #expect(dext.closed == opened, sourceLocation: sourceLocation)
}

struct FakeUsbTransportTests {
    @Test func sendSucceedsWithTheByteCountAndRecordsThePayload() async {
        let fake = FakeUsbTransport()
        let zpl = Data("^XA^FDFAVOR HOST TEST^FS^XZ".utf8)

        let result = await fake.send(zpl)

        #expect(result == .success(zpl.count))
        #expect(await fake.writes == [zpl])
    }

    @Test func scriptedSendResultsAreConsumedInOrderThenDefaultToSuccess() async {
        let fake = FakeUsbTransport()
        await fake.enqueueSend(.failure(.notAttached), .success(1))

        let first = await fake.send(Data("a".utf8))
        let second = await fake.send(Data("bb".utf8))
        let third = await fake.send(Data("ccc".utf8))

        #expect(first == .failure(.notAttached))
        #expect(second == .success(1))
        #expect(third == .success(3))
    }

    @Test func aFailedSendIsStillRecordedBecauseBytesMayHaveGoneOut() async {
        let fake = FakeUsbTransport()
        await fake.enqueueSend(.failure(.writeFailed(code: IOReturnCode.timeout, bytesWritten: 4)))
        let zpl = Data("^XA^XZ".utf8)

        _ = await fake.send(zpl)

        #expect(await fake.writes == [zpl])
    }

    @Test func readStatusAnswersScriptedResultsAndTimesOutWhenTheScriptIsEmpty() async {
        let fake = FakeUsbTransport()
        let reply = Data([0x02] + Array("030,0,0".utf8) + [0x03])
        await fake.enqueueRead(.success(reply))

        #expect(await fake.readStatus() == .success(reply))
        #expect(await fake.readStatus() == .failure(.timeout))
        #expect(await fake.readCalls == 2)
    }

    @Test func statusIsScriptableAndDefaultsToAReadyPrinter() async {
        let fake = FakeUsbTransport()
        #expect(await fake.status().driver == .running)

        let unplugged = UsbPrinterStatus(driver: .unknown)
        await fake.setStatus(unplugged)

        let status = await fake.status()
        #expect(status == unplugged)
        #expect(status.printerAttached == nil)
        #expect(await fake.statusCalls == 2)
    }
}

struct IOReturnMappingTests {
    private let detached = [IOReturnCode.noDevice, IOReturnCode.notAttached, IOReturnCode.offline]

    @Test func ioReturnCodesMatchIOKitHeader() {
        #expect(UInt32(bitPattern: IOReturnCode.noDevice) == 0xE000_02C0)
        #expect(UInt32(bitPattern: IOReturnCode.badArgument) == 0xE000_02C2)
        #expect(UInt32(bitPattern: IOReturnCode.timeout) == 0xE000_02D6)
        #expect(UInt32(bitPattern: IOReturnCode.offline) == 0xE000_02D7)
        #expect(UInt32(bitPattern: IOReturnCode.notReady) == 0xE000_02D8)
        #expect(UInt32(bitPattern: IOReturnCode.notAttached) == 0xE000_02D9)
        #expect(UInt32(bitPattern: IOReturnCode.notFound) == 0xE000_02F0)
        #expect(UInt32(bitPattern: IOReturnCode.usbTransactionTimeout) == 0xE000_4051)
    }

    @Test func openFailureThatMeansTheDeviceIsGoneIsNotAttached() {
        for code in detached {
            #expect(UsbTransportError.forOpen(code: code) == .notAttached)
        }
    }

    @Test func otherOpenFailuresKeepTheirCode() {
        let denied = Int32(bitPattern: 0xE000_02E2)
        #expect(UsbTransportError.forOpen(code: denied) == .openFailed(code: denied))
        #expect(UsbTransportError.forOpen(code: IOReturnCode.notReady) == .openFailed(code: IOReturnCode.notReady))
    }

    @Test func fullWriteSucceedsWithTheCount() {
        let result = UsbTransportError.writeOutcome(callCode: 0, driverCode: 0, written: 99, expected: 99)
        #expect(result == .success(99))
    }

    @Test func writeThatAcceptedFewerBytesIsAShortWrite() {
        let result = UsbTransportError.writeOutcome(callCode: 0, driverCode: 0, written: 40, expected: 99)
        #expect(result == .failure(.shortWrite(written: 40, expected: 99)))
    }

    @Test func usbFailureKeepsTheBytesAlreadyWritten() {
        let result = UsbTransportError.writeOutcome(
            callCode: 0, driverCode: IOReturnCode.usbTransactionTimeout, written: 16384, expected: 40000
        )
        #expect(result == .failure(.writeFailed(code: IOReturnCode.usbTransactionTimeout, bytesWritten: 16384)))
    }

    @Test func detachBeforeAnyByteIsNotAttachedButAfterSomeBytesItKeepsTheCount() {
        for code in detached {
            let early = UsbTransportError.writeOutcome(callCode: 0, driverCode: code, written: 0, expected: 10)
            let late = UsbTransportError.writeOutcome(callCode: 0, driverCode: code, written: 4, expected: 10)
            #expect(early == .failure(.notAttached))
            #expect(late == .failure(.writeFailed(code: code, bytesWritten: 4)))
        }
    }

    @Test func aDetachCodeFromAFailedCallNeverClaimsNothingWasSent() {
        // The dext may have put bytes on the wire before the call died, so only a dext-reported detach can be notAttached.
        for code in detached {
            let result = UsbTransportError.writeOutcome(callCode: code, driverCode: 0, written: 0, expected: 10)
            #expect(result == .failure(.writeFailed(code: code, bytesWritten: 0)))
        }
    }

    @Test func aFailedCallWinsOverTheDriverCodeAndKeepsEarlierChunks() {
        let result = UsbTransportError.writeOutcome(
            callCode: IOReturnCode.notReady, driverCode: IOReturnCode.timeout, written: 262_144, expected: 300_000
        )
        #expect(result == .failure(.writeFailed(code: IOReturnCode.notReady, bytesWritten: 262_144)))
    }

    @Test func readMapsTimeoutsDetachAndOtherFailures() {
        let reply = Data([1, 2, 3])
        #expect(UsbTransportError.readOutcome(callCode: 0, driverCode: 0, data: reply) == .success(reply))
        #expect(UsbTransportError.readOutcome(callCode: 0, driverCode: 0, data: Data()) == .success(Data()))
        for code in [IOReturnCode.timeout, IOReturnCode.usbTransactionTimeout] {
            #expect(UsbTransportError.readOutcome(callCode: 0, driverCode: code, data: Data()) == .failure(.timeout))
            #expect(UsbTransportError.readOutcome(callCode: code, driverCode: 0, data: Data()) == .failure(.timeout))
        }
        for code in detached {
            #expect(UsbTransportError.readOutcome(callCode: code, driverCode: 0, data: Data()) == .failure(.notAttached))
        }
        #expect(
            UsbTransportError.readOutcome(callCode: IOReturnCode.notFound, driverCode: 0, data: Data())
                == .failure(.readFailed(code: IOReturnCode.notFound))
        )
    }

    @Test func aFailedReadCallWinsOverTheDriverCode() {
        let a = UsbTransportError.readOutcome(callCode: IOReturnCode.notFound, driverCode: IOReturnCode.timeout, data: Data())
        let b = UsbTransportError.readOutcome(callCode: IOReturnCode.timeout, driverCode: IOReturnCode.notFound, data: Data())
        #expect(a == .failure(.readFailed(code: IOReturnCode.notFound)))
        #expect(b == .failure(.timeout))
    }

    @Test func availabilityIsDerivedFromServiceUserClientAndRegistry() {
        func derive(_ service: Bool, _ opens: Bool, _ visible: Bool) -> DriverAvailability {
            .derive(serviceMatched: service, userClientOpens: opens, printerVisible: visible)
        }
        #expect(derive(true, true, false) == .running)
        #expect(derive(true, true, true) == .running)
        #expect(derive(false, false, true) == .printerPresentDriverNotRunning)
        #expect(derive(true, false, false) == .printerPresentDriverNotRunning)
        #expect(derive(true, false, true) == .printerPresentDriverNotRunning)
        #expect(derive(false, false, false) == .unknown)
    }
}

struct DriverKitUsbTransportTests {
    private func statusReply(stage: UInt64 = 8, error: Int32 = 0, out: UInt64 = 0x01, bulkIn: UInt64 = 0x81, serial: [UInt8] = []) -> DextReply {
        DextReply(code: 0, scalars: [stage, UInt64(UInt32(bitPattern: error)), out, bulkIn], data: serial)
    }

    // MARK: status

    @Test func runningStatusReportsStageEndpointsAndSerial() async {
        let dext = ScriptedDext { _ in statusReply(serial: Array("D2J123456".utf8)) }
        let status = await DriverKitUsbTransport(backend: dext).status()

        #expect(status == UsbPrinterStatus(
            driver: .running, printerAttached: true, stage: 8, lastError: nil,
            bulkOutAddress: 0x01, bulkInAddress: 0x81, usbSerial: "D2J123456"
        ))
        #expect(dext.calls == [.init(
            selector: kFavorZplSelectorStatus, scalarInput: [], structInput: [],
            scalarOutputCount: Int(kFavorZplStatusFieldCount), structOutputCapacity: Int(kFavorZplMaxSerialBytes)
        )])
        expectBalanced(dext)
    }

    @Test func serialStopsAtTheFirstNulEvenWithStaleBytesAfterIt() async {
        let dext = ScriptedDext { _ in statusReply(serial: Array("D2J1".utf8) + [0] + Array("stale".utf8)) }
        let status = await DriverKitUsbTransport(backend: dext).status()

        #expect(status.usbSerial == "D2J1")
    }

    @Test func statusWhenTheStatusCallFailsStaysRunningWithTheCodeAndNoDetails() async {
        let dext = ScriptedDext { _ in DextReply(code: IOReturnCode.notReady, scalars: [], data: []) }
        let status = await DriverKitUsbTransport(backend: dext).status()

        #expect(status == UsbPrinterStatus(driver: .running, printerAttached: true, lastError: IOReturnCode.notReady))
        expectBalanced(dext)
    }

    @Test func statusWithTooFewScalarsIsAMismatchNotACrash() async {
        let dext = ScriptedDext { _ in DextReply(code: 0, scalars: [8], data: []) }
        let status = await DriverKitUsbTransport(backend: dext).status()

        #expect(status == UsbPrinterStatus(driver: .running, printerAttached: true, lastError: IOReturnCode.badArgument))
        expectBalanced(dext)
    }

    @Test func statusKeepsADextErrorAndOmitsMissingEndpointsAndSerial() async {
        let failure = IOReturnCode.notFound
        let dext = ScriptedDext { _ in statusReply(stage: 6, error: failure, out: 0, bulkIn: 0, serial: [0, 0, 0]) }
        let status = await DriverKitUsbTransport(backend: dext).status()

        #expect(status.driver == .running)
        #expect(status.stage == 6)
        #expect(status.lastError == failure)
        #expect(status.bulkOutAddress == nil)
        #expect(status.bulkInAddress == nil)
        #expect(status.usbSerial == nil)
    }

    @Test func statusIsUnknownWithNoServiceAndAnUnseenPrinter() async {
        let dext = ScriptedDext(printerVisible: false, mode: .noService)
        let status = await DriverKitUsbTransport(backend: dext).status()

        #expect(status == UsbPrinterStatus(driver: .unknown))
        #expect(status.printerAttached == nil)
    }

    @Test func statusSaysPrinterPresentDriverNotRunningWhenOnlyTheRegistryShowsIt() async {
        let dext = ScriptedDext(printerVisible: true, mode: .noService)
        let status = await DriverKitUsbTransport(backend: dext).status()

        #expect(status.driver == .printerPresentDriverNotRunning)
        #expect(status.printerAttached == true)
        #expect(status.stage == nil)
    }

    @Test func statusWithAServiceThatWillNotOpenReportsTheOpenCode() async {
        let code = Int32(bitPattern: 0xE000_02E2)
        let dext = ScriptedDext(mode: .openFailed(code))
        let status = await DriverKitUsbTransport(backend: dext).status()

        #expect(status.driver == .printerPresentDriverNotRunning)
        #expect(status.printerAttached == true)
        #expect(status.lastError == code)
    }

    // MARK: send

    @Test func sendWritesTheBytesThroughTheSendSelectorAndCloses() async {
        let zpl = Data("^XA^FO50,50^FDFAVOR HOST TEST^FS^XZ".utf8)
        let dext = ScriptedDext { _ in ScriptedDext.sendReply(written: zpl.count) }

        let result = await DriverKitUsbTransport(backend: dext).send(zpl)

        #expect(result == .success(zpl.count))
        #expect(dext.calls.map(\.selector) == [kFavorZplSelectorSendRaw])
        #expect(dext.calls.first?.structInput == [UInt8](zpl))
        #expect(dext.opened == 1)
        #expect(dext.closed == 1)
    }

    @Test func emptySendSucceedsWithoutOpeningTheDriver() async {
        let dext = ScriptedDext()
        let result = await DriverKitUsbTransport(backend: dext).send(Data())

        #expect(result == .success(0))
        #expect(dext.opened == 0)
    }

    @Test func eachSendOpensAFreshConnection() async {
        let dext = ScriptedDext { call in ScriptedDext.sendReply(written: call.structInput.count) }
        let transport = DriverKitUsbTransport(backend: dext)

        _ = await transport.send(Data("a".utf8))
        _ = await transport.send(Data("b".utf8))

        #expect(dext.opened == 2)
        #expect(dext.closed == 2)
    }

    @Test func payloadLargerThanTheABILimitIsSplitInOrderAndSumsTheBytes() async {
        let limit = Int(kFavorZplMaxSendBytes)
        let zpl = Data((0..<(limit * 2 + 100)).map { UInt8(truncatingIfNeeded: $0) })
        let dext = ScriptedDext { call in ScriptedDext.sendReply(written: call.structInput.count) }

        let result = await DriverKitUsbTransport(backend: dext).send(zpl)

        #expect(result == .success(zpl.count))
        #expect(dext.calls.map(\.structInput.count) == [limit, limit, 100])
        #expect(dext.calls.flatMap(\.structInput) == [UInt8](zpl))
    }

    @Test func failureInALaterChunkReportsEveryByteAlreadyWrittenAndStops() async {
        let limit = Int(kFavorZplMaxSendBytes)
        let zpl = Data(repeating: 0x41, count: limit + 50)
        let dext = ScriptedDext { call in
            call.structInput.count == limit
                ? ScriptedDext.sendReply(written: limit)
                : ScriptedDext.sendReply(written: 10, usb: IOReturnCode.usbTransactionTimeout)
        }

        let result = await DriverKitUsbTransport(backend: dext).send(zpl)

        #expect(result == .failure(.writeFailed(code: IOReturnCode.usbTransactionTimeout, bytesWritten: limit + 10)))
        #expect(dext.calls.count == 2)
    }

    @Test func dextAcceptingFewerBytesWithoutAnErrorIsAShortWrite() async {
        let dext = ScriptedDext { _ in ScriptedDext.sendReply(written: 3) }
        let result = await DriverKitUsbTransport(backend: dext).send(Data(repeating: 0x41, count: 10))

        #expect(result == .failure(.shortWrite(written: 3, expected: 10)))
        #expect(dext.calls.count == 1)
    }

    @Test func failedUserClientCallKeepsTheCodeWithNothingWrittenForThatChunk() async {
        let dext = ScriptedDext { _ in DextReply(code: IOReturnCode.notReady, scalars: [0, 0], data: []) }
        let result = await DriverKitUsbTransport(backend: dext).send(Data("^XA^XZ".utf8))

        #expect(result == .failure(.writeFailed(code: IOReturnCode.notReady, bytesWritten: 0)))
    }

    @Test func sendWithoutADextServiceBlamesTheDriverOnlyWhenThePrinterIsVisible() async {
        let zpl = Data("^XA^XZ".utf8)
        let driverOff = ScriptedDext(printerVisible: true, mode: .noService)
        let unplugged = ScriptedDext(printerVisible: false, mode: .noService)

        #expect(await DriverKitUsbTransport(backend: driverOff).send(zpl) == .failure(.driverNotFound))
        #expect(await DriverKitUsbTransport(backend: unplugged).send(zpl) == .failure(.notAttached))
    }

    @Test func sendWhenTheUserClientWillNotOpenMapsTheOpenCode() async {
        let code = Int32(bitPattern: 0xE000_02E2)
        let gone = ScriptedDext(mode: .openFailed(IOReturnCode.noDevice))
        let refused = ScriptedDext(mode: .openFailed(code))
        let zpl = Data("^XA^XZ".utf8)

        #expect(await DriverKitUsbTransport(backend: gone).send(zpl) == .failure(.notAttached))
        #expect(await DriverKitUsbTransport(backend: refused).send(zpl) == .failure(.openFailed(code: code)))
    }

    // MARK: read status

    @Test func readStatusReturnsExactlyTheBytesTheDextReportedAndPassesTheTimeout() async {
        let answer = Array("030,0,0,0,000,0,0,0,000,0,0,0".utf8)
        let dext = ScriptedDext { _ in
            // The kernel may hand back the whole buffer: only the dext's byte count counts.
            DextReply(code: 0, scalars: [UInt64(answer.count), 0], data: answer + [UInt8](repeating: 0, count: 20))
        }

        let result = await DriverKitUsbTransport(backend: dext, readTimeoutMs: 750).readStatus()

        #expect(result == .success(Data(answer)))
        #expect(dext.calls == [.init(
            selector: kFavorZplSelectorReadStatus, scalarInput: [750], structInput: [],
            scalarOutputCount: Int(kFavorZplReadResultCount), structOutputCapacity: Int(kFavorZplMaxReadBytes)
        )])
    }

    @Test func readTimeoutFromTheDextIsATimeout() async {
        let dext = ScriptedDext { _ in
            DextReply(code: 0, scalars: [0, UInt64(UInt32(bitPattern: IOReturnCode.usbTransactionTimeout))], data: [])
        }
        let result = await DriverKitUsbTransport(backend: dext).readStatus()

        #expect(result == .failure(.timeout))
    }

    @Test func missingBulkInEndpointIsATypedReadFailure() async {
        let dext = ScriptedDext { _ in DextReply(code: IOReturnCode.notFound, scalars: [0, 0], data: []) }
        let result = await DriverKitUsbTransport(backend: dext).readStatus()

        #expect(result == .failure(.readFailed(code: IOReturnCode.notFound)))
    }

    @Test func readWithNoDextServiceIsTyped() async {
        let dext = ScriptedDext(printerVisible: true, mode: .noService)
        let result = await DriverKitUsbTransport(backend: dext).readStatus()

        #expect(result == .failure(.driverNotFound))
    }
}

private final class CallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func next() -> Int {
        lock.withLock {
            defer { count += 1 }
            return count
        }
    }
}

struct DriverKitUsbTransportEdgeTests {
    private let limit = Int(kFavorZplMaxSendBytes)

    @Test func sendAsksForTheSendResultScalars() async {
        let dext = ScriptedDext { call in ScriptedDext.sendReply(written: call.structInput.count) }
        _ = await DriverKitUsbTransport(backend: dext).send(Data("^XA^XZ".utf8))

        #expect(dext.calls.first?.scalarOutputCount == Int(kFavorZplSendResultCount))
    }

    @Test func aUsbErrorAfterEveryByteWasAcceptedIsStillAFailure() async {
        let zpl = Data(repeating: 0x41, count: 100)
        let dext = ScriptedDext { _ in ScriptedDext.sendReply(written: 100, usb: IOReturnCode.usbTransactionTimeout) }

        let result = await DriverKitUsbTransport(backend: dext).send(zpl)

        #expect(result == .failure(.writeFailed(code: IOReturnCode.usbTransactionTimeout, bytesWritten: 100)))
        expectBalanced(dext)
    }

    @Test func aUsbErrorOnTheSecondChunkAfterAFullFirstChunkKeepsTheFirstChunk() async {
        let zpl = Data(repeating: 0x41, count: limit * 2)
        let counter = CallCounter()
        let dext = ScriptedDext { _ in
            counter.next() == 0
                ? ScriptedDext.sendReply(written: limit)
                : ScriptedDext.sendReply(written: limit, usb: IOReturnCode.usbTransactionTimeout)
        }

        let result = await DriverKitUsbTransport(backend: dext).send(zpl)

        #expect(result == .failure(.writeFailed(code: IOReturnCode.usbTransactionTimeout, bytesWritten: limit * 2)))
    }

    @Test func connectionsAreClosedOnFailingPaths() async {
        let zpl = Data("^XA^XZ".utf8)
        let short = ScriptedDext { _ in ScriptedDext.sendReply(written: 1) }
        let failed = ScriptedDext { _ in DextReply(code: IOReturnCode.notReady, scalars: [], data: []) }
        let timedOut = ScriptedDext { _ in DextReply(code: 0, scalars: [0, UInt64(UInt32(bitPattern: IOReturnCode.timeout))], data: []) }
        let noBulkIn = ScriptedDext { _ in DextReply(code: IOReturnCode.notFound, scalars: [], data: []) }

        _ = await DriverKitUsbTransport(backend: short).send(zpl)
        _ = await DriverKitUsbTransport(backend: failed).send(zpl)
        _ = await DriverKitUsbTransport(backend: timedOut).readStatus()
        _ = await DriverKitUsbTransport(backend: noBulkIn).readStatus()

        for dext in [short, failed, timedOut, noBulkIn] { expectBalanced(dext) }
    }

    @Test func successfulReadClosesTheConnection() async {
        let dext = ScriptedDext { _ in DextReply(code: 0, scalars: [2, 0], data: [0x02, 0x03]) }
        let result = await DriverKitUsbTransport(backend: dext).readStatus()

        #expect(result == .success(Data([0x02, 0x03])))
        expectBalanced(dext)
    }

    @Test func noConnectionIsOpenedOrClosedWhenThereIsNothingToOpen() async {
        let none = ScriptedDext(mode: .noService)
        let refused = ScriptedDext(mode: .openFailed(IOReturnCode.notReady))
        _ = await DriverKitUsbTransport(backend: none).send(Data("x".utf8))
        _ = await DriverKitUsbTransport(backend: refused).readStatus()

        expectBalanced(none, opened: 0)
        expectBalanced(refused, opened: 0)
    }

    @Test func aSuccessfulSendWithNoScalarsIsAFailureNotASilentSuccess() async {
        let dext = ScriptedDext { _ in DextReply(code: 0, scalars: [], data: []) }
        let result = await DriverKitUsbTransport(backend: dext).send(Data("^XA^XZ".utf8))

        #expect(result == .failure(.writeFailed(code: IOReturnCode.badArgument, bytesWritten: 0)))
    }

    @Test func aSuccessfulReadWithNoScalarsIsAFailureNotAnEmptyAnswer() async {
        let dext = ScriptedDext { _ in DextReply(code: 0, scalars: [], data: []) }
        let result = await DriverKitUsbTransport(backend: dext).readStatus()

        #expect(result == .failure(.readFailed(code: IOReturnCode.badArgument)))
    }

    @Test func absurdByteCountsFromTheDextDoNotTrapOrExceedWhatWasAsked() async {
        let huge = UInt64.max
        let send = ScriptedDext { _ in DextReply(code: 0, scalars: [huge, 0], data: []) }
        let read = ScriptedDext { _ in DextReply(code: 0, scalars: [huge, 0], data: [UInt8](repeating: 0x41, count: Int(kFavorZplMaxReadBytes))) }

        #expect(await DriverKitUsbTransport(backend: send).send(Data("^XA^XZ".utf8)) == .success(6))
        let answer = await DriverKitUsbTransport(backend: read).readStatus()
        #expect(answer == .success(Data(repeating: 0x41, count: Int(kFavorZplMaxReadBytes))))
    }

    @Test func aDextReportingMoreBytesThanOfferedWithAUsbErrorIsCappedAtTheOffer() async {
        let dext = ScriptedDext { _ in
            DextReply(code: 0, scalars: [UInt64.max, UInt64(UInt32(bitPattern: IOReturnCode.usbTransactionTimeout))], data: [])
        }
        let result = await DriverKitUsbTransport(backend: dext).send(Data("^XA^XZ".utf8))

        #expect(result == .failure(.writeFailed(code: IOReturnCode.usbTransactionTimeout, bytesWritten: 6)))
    }

    @Test func kernelReplyKeepsOnlyWhatTheKernelWroteBack() {
        let reply = DextReply(kernelCode: 0, scalars: [7, 0, 0, 0], scalarCount: 1, data: [1, 2, 3, 4], dataCount: 2)
        #expect(reply.scalars == [7])
        #expect(reply.data == [1, 2])
        #expect(reply.requiring(scalars: 2).code == IOReturnCode.badArgument)

        let failed = DextReply(kernelCode: IOReturnCode.notReady, scalars: [7], scalarCount: 1, data: [1], dataCount: 1)
        #expect(failed.scalars.isEmpty && failed.data.isEmpty)
    }

    @Test func payloadExactlyAtTheLimitIsOneCallAndTwiceTheLimitIsTwo() async {
        let one = ScriptedDext { call in ScriptedDext.sendReply(written: call.structInput.count) }
        let two = ScriptedDext { call in ScriptedDext.sendReply(written: call.structInput.count) }

        #expect(await DriverKitUsbTransport(backend: one).send(Data(count: limit)) == .success(limit))
        #expect(await DriverKitUsbTransport(backend: two).send(Data(count: limit * 2)) == .success(limit * 2))
        #expect(one.calls.count == 1)
        #expect(two.calls.count == 2)
    }

    @Test func aSlicedPayloadIsSentFromItsOwnStart() async {
        let base = Data((0..<(limit + 50)).map { UInt8(truncatingIfNeeded: $0 / 7) })
        let slice = base.dropFirst(5)
        let dext = ScriptedDext { call in ScriptedDext.sendReply(written: call.structInput.count) }

        let result = await DriverKitUsbTransport(backend: dext).send(slice)

        #expect(result == .success(slice.count))
        #expect(dext.calls.flatMap(\.structInput) == [UInt8](slice))
    }
}

private final class StepCounter: @unchecked Sendable {
    let gate: UnsafeMutablePointer<FavorZplGate>
    var steps = 0
    var releaseAfter: Int?

    init(gate: UnsafeMutablePointer<FavorZplGate>, releaseAfter: Int?) {
        self.gate = gate
        self.releaseAfter = releaseAfter
    }
}

/// Fake IOKit handle calls that count what happens to each handle.
private final class HandleLog: @unchecked Sendable {
    private let lock = NSLock()
    private var opens: [io_service_t] = []
    private var releases: [io_object_t] = []
    private var closes: [io_connect_t] = []
    var driverServices: [io_service_t] = []
    var printerServices: [io_service_t] = []
    var openResults: [io_service_t: (code: Int32, connection: io_connect_t)] = [:]

    var opened: [io_service_t] { lock.withLock { opens } }
    var released: [io_object_t] { lock.withLock { releases } }
    var closed: [io_connect_t] { lock.withLock { closes } }

    func countsPerHandle(_ handles: [UInt32]) -> [UInt32: Int] {
        Dictionary(handles.map { ($0, 1) }, uniquingKeysWith: +)
    }

    var ops: IOKitHandleOps {
        IOKitHandleOps(
            driverServices: { self.driverServices },
            printerServices: { self.printerServices },
            open: { service in
                self.lock.withLock { self.opens.append(service) }
                return self.openResults[service] ?? (code: IOReturnCode.notReady, connection: 0)
            },
            release: { handle in self.lock.withLock { self.releases.append(handle) } },
            close: { handle in self.lock.withLock { self.closes.append(handle) } }
        )
    }
}

struct IOKitHandleLifetimeTests {
    @Test func aConnectionIsClosedOnceAndNeverReleasedWhileEachServiceIsReleasedOnce() {
        let log = HandleLog()
        log.driverServices = [100, 101]
        log.openResults = [100: (IOReturnCode.notReady, 0), 101: (0, 7)]

        guard case .connected(let connection) = IOKitDextBackend(ops: log.ops).connect() else {
            Issue.record("expected a connection")
            return
        }
        connection.close()

        #expect(log.opened == [100, 101])
        #expect(log.countsPerHandle(log.released) == [100: 1, 101: 1])
        #expect(log.closed == [7])
        #expect(!log.released.contains(7))
    }

    @Test func aReplugOpensANewConnectionAndEveryHandleIsStillEndedExactlyOnce() {
        let log = HandleLog()
        log.driverServices = [100]
        log.openResults = [100: (0, 7), 102: (0, 8)]
        let backend = IOKitDextBackend(ops: log.ops)

        if case .connected(let first) = backend.connect() { first.close() }
        log.driverServices = [102]   // the dext service after a replug
        if case .connected(let second) = backend.connect() { second.close() }

        #expect(log.closed == [7, 8])
        #expect(log.countsPerHandle(log.released) == [100: 1, 102: 1])
        #expect(Set(log.released).isDisjoint(with: Set(log.closed)))
    }

    @Test func serviceHandlesAreReleasedWhenNothingOpens() {
        let log = HandleLog()
        log.driverServices = [100, 101]
        log.openResults = [100: (IOReturnCode.notReady, 0), 101: (IOReturnCode.notReady, 0)]

        guard case .openFailed(let code) = IOKitDextBackend(ops: log.ops).connect() else {
            Issue.record("expected openFailed")
            return
        }

        #expect(code == IOReturnCode.notReady)
        #expect(log.countsPerHandle(log.released) == [100: 1, 101: 1])
        #expect(log.closed.isEmpty)
    }

    @Test func printerLookupReleasesWhatItFoundAndReportsVisibility() {
        let log = HandleLog()
        let backend = IOKitDextBackend(ops: log.ops)
        #expect(!backend.printerVisible())

        log.printerServices = [200, 201]
        #expect(backend.printerVisible())
        #expect(log.countsPerHandle(log.released) == [200: 1, 201: 1])
    }

    @Test func noServiceReleasesNothingAndOpensNothing() {
        let log = HandleLog()
        guard case .noService = IOKitDextBackend(ops: log.ops).connect() else {
            Issue.record("expected noService")
            return
        }
        #expect(log.opened.isEmpty && log.released.isEmpty && log.closed.isEmpty)
    }
}

private final class SharedGate: @unchecked Sendable {
    let gate = UnsafeMutablePointer<FavorZplGate>.allocate(capacity: 1)
    /// Only touched while holding the gate.
    let holders = UnsafeMutablePointer<Int>.allocate(capacity: 1)
    let overlaps = UnsafeMutablePointer<Int>.allocate(capacity: 1)

    init() {
        gate.initialize(to: FavorZplGate())
        holders.initialize(to: 0)
        overlaps.initialize(to: 0)
    }

    deinit {
        gate.deallocate()
        holders.deallocate()
        overlaps.deallocate()
    }
}

struct TransferGateTests {
    private static let step: @convention(c) (UnsafeMutableRawPointer?) -> Void = { context in
        let counter = Unmanaged<StepCounter>.fromOpaque(context!).takeUnretainedValue()
        counter.steps += 1
        if let releaseAfter = counter.releaseAfter, counter.steps >= releaseAfter { FavorZplGateRelease(counter.gate) }
    }

    private func drain(inFlight: Bool, releaseAfter: Int?, maxWaitMs: UInt32 = 100) -> (drained: Bool, steps: Int, canFree: Bool) {
        let gate = UnsafeMutablePointer<FavorZplGate>.allocate(capacity: 1)
        gate.initialize(to: FavorZplGate())
        defer { gate.deallocate() }
        if inFlight { _ = FavorZplGateTryAcquire(gate) }
        let counter = StepCounter(gate: gate, releaseAfter: releaseAfter)
        let drained = FavorZplGateCloseAndDrain(gate, maxWaitMs, 10, Self.step, Unmanaged.passUnretained(counter).toOpaque())
        return (drained, counter.steps, FavorZplGateCanFreePipes(gate))
    }

    @Test func stopOnAnIdleGateDrainsWithoutWaiting() {
        let result = drain(inFlight: false, releaseAfter: nil)
        #expect(result.drained)
        #expect(result.canFree)
        #expect(result.steps == 0)
    }

    @Test func stopWaitsUntilTheTransferInFlightLeaves() {
        let result = drain(inFlight: true, releaseAfter: 3)
        #expect(result.drained)
        #expect(result.canFree)
        #expect(result.steps == 3)
    }

    @Test func stopGivesUpAfterTheWaitAndSaysTheTransferIsStillRunning() {
        let result = drain(inFlight: true, releaseAfter: nil, maxWaitMs: 100)
        #expect(!result.drained)
        #expect(!result.canFree)
        #expect(result.steps == 10)
    }

    @Test func pipesAreNotFreeableWhileAStopWaitsOnATransfer() {
        var gate = FavorZplGate()
        #expect(FavorZplGateTryAcquire(&gate))
        FavorZplGateClose(&gate)
        #expect(!FavorZplGateCanFreePipes(&gate))
    }

    @Test func aTimedOutStopStaysNonFreeableEvenAfterTheTransferEndsLater() {
        let gate = UnsafeMutablePointer<FavorZplGate>.allocate(capacity: 1)
        gate.initialize(to: FavorZplGate())
        defer { gate.deallocate() }
        _ = FavorZplGateTryAcquire(gate)
        let counter = StepCounter(gate: gate, releaseAfter: nil)

        let drained = FavorZplGateCloseAndDrain(gate, 30, 10, Self.step, Unmanaged.passUnretained(counter).toOpaque())
        FavorZplGateRelease(gate)   // the transfer finally ends, after Stop gave up

        #expect(!drained)
        #expect(!FavorZplGateCanFreePipes(gate))
    }

    @Test func threadsContendingForTheGateNeverHoldItTogether() {
        let shared = SharedGate()
        DispatchQueue.concurrentPerform(iterations: 8) { _ in
            for _ in 0..<5000 where FavorZplGateTryAcquire(shared.gate) {
                shared.holders.pointee += 1
                if shared.holders.pointee > 1 { shared.overlaps.pointee += 1 }
                shared.holders.pointee -= 1
                FavorZplGateRelease(shared.gate)
            }
        }
        #expect(shared.overlaps.pointee == 0)
        #expect(FavorZplGateTryDrain(shared.gate))
    }

    @Test func onlyOneTransferHoldsTheGateAtATime() {
        var gate = FavorZplGate()
        #expect(FavorZplGateTryAcquire(&gate))
        #expect(!FavorZplGateTryAcquire(&gate))
        FavorZplGateRelease(&gate)
        #expect(FavorZplGateTryAcquire(&gate))
    }

    @Test func aClosedGateStartsNoNewTransferAndStaysClosedAfterARelease() {
        var gate = FavorZplGate()
        #expect(FavorZplGateTryAcquire(&gate))
        FavorZplGateClose(&gate)
        FavorZplGateRelease(&gate)

        #expect(!FavorZplGateTryAcquire(&gate))
        #expect(!FavorZplGateTryAcquire(&gate))
        #expect(FavorZplGateIsClosed(&gate))
    }

    @Test func aClosedGateWithATransferInFlightIsNotDrainedUntilItIsReleased() {
        var gate = FavorZplGate()
        #expect(FavorZplGateTryAcquire(&gate))
        FavorZplGateClose(&gate)

        #expect(FavorZplGateIsClosed(&gate))
        #expect(!FavorZplGateTryDrain(&gate))
        #expect(!FavorZplGateTryAcquire(&gate))
        FavorZplGateRelease(&gate)
        #expect(FavorZplGateTryDrain(&gate))
    }

    @Test func aGateIsOpenUntilItIsClosed() {
        var gate = FavorZplGate()
        #expect(!FavorZplGateIsClosed(&gate))
        FavorZplGateClose(&gate)
        #expect(FavorZplGateIsClosed(&gate))
    }

    @Test func aTransferInFlightDoesNotCloseTheGate() {
        var gate = FavorZplGate()
        #expect(FavorZplGateTryAcquire(&gate))
        #expect(!FavorZplGateIsClosed(&gate))
    }

    @Test func aDextReportedNoDeviceWithNothingWrittenIsNotAttached() async {
        // What the dext answers once Stop has closed its gate.
        let dext = ScriptedDext { _ in ScriptedDext.sendReply(written: 0, usb: IOReturnCode.noDevice) }
        let read = ScriptedDext { _ in DextReply(code: 0, scalars: [0, UInt64(UInt32(bitPattern: IOReturnCode.noDevice))], data: []) }

        #expect(await DriverKitUsbTransport(backend: dext).send(Data("^XA^XZ".utf8)) == .failure(.notAttached))
        #expect(await DriverKitUsbTransport(backend: read).readStatus() == .failure(.notAttached))
    }

    @Test func stopWaitsForTheTransferInFlightThenOwnsTheGate() {
        var gate = FavorZplGate()
        #expect(FavorZplGateTryAcquire(&gate))
        FavorZplGateClose(&gate)

        #expect(!FavorZplGateTryDrain(&gate))
        FavorZplGateRelease(&gate)
        #expect(FavorZplGateTryDrain(&gate))
        #expect(!FavorZplGateTryAcquire(&gate))
    }

    @Test func aTransferThatLosesTheRaceWithCloseGivesTheGateBack() {
        var gate = FavorZplGate()
        FavorZplGateClose(&gate)

        #expect(!FavorZplGateTryAcquire(&gate))
        // The failed acquire must not leave busy set, or Stop would wait for a transfer that never started.
        #expect(FavorZplGateTryDrain(&gate))
    }
}
