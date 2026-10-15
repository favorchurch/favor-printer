import Foundation
import os

/// Talks to the FavorPrinterDriver dext through its IOKit user client (ABI in FavorZplUserClientABI.h).
///
/// Every call opens a fresh user client. Calls run one at a time on a private queue because the IOKit calls block.
/// Only sizes and IOReturn codes are logged, never the ZPL.
final class DriverKitUsbTransport: UsbPrinterTransport {
    private let backend: DextBackend
    private let readTimeoutMs: UInt64
    private let queue = DispatchQueue(label: "church.favor.printer.usb-transport")
    private let log = Logger(subsystem: "church.favor.printer.ios", category: "usb-transport")

    init(backend: DextBackend = IOKitDextBackend(), readTimeoutMs: UInt64 = 1000) {
        self.backend = backend
        self.readTimeoutMs = readTimeoutMs
    }

    func status() async -> UsbPrinterStatus {
        await onQueue { self.statusNow() }
    }

    func send(_ zpl: Data) async -> Result<Int, UsbTransportError> {
        await onQueue { self.sendNow(zpl) }
    }

    func readStatus() async -> Result<Data, UsbTransportError> {
        await onQueue { self.readNow() }
    }

    private func onQueue<T: Sendable>(_ work: @escaping @Sendable () -> T) async -> T {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: work()) }
        }
    }

    // MARK: Operations (run on `queue`)

    private func statusNow() -> UsbPrinterStatus {
        switch backend.connect() {
        case .connected(let connection):
            defer { connection.close() }
            return Self.runningStatus(from: connection)
        case .noService:
            let visible = backend.printerVisible()
            let driver = DriverAvailability.derive(serviceMatched: false, userClientOpens: false, printerVisible: visible)
            return UsbPrinterStatus(
                driver: driver, printerAttached: driver == .unknown ? nil : true,
                foreignDriver: visible && backend.foreignDriverPresent()
            )
        case .openFailed(let code):
            return UsbPrinterStatus(driver: .printerPresentDriverNotRunning, printerAttached: true, lastError: code)
        }
    }

    private static func statusReply(from connection: DextConnection) -> DextReply {
        connection.call(
            selector: kFavorZplSelectorStatus,
            scalarOutputCount: Int(kFavorZplStatusFieldCount), structOutputCapacity: Int(kFavorZplMaxSerialBytes)
        ).requiring(scalars: Int(kFavorZplStatusFieldCount))
    }

    private static func runningStatus(from connection: DextConnection) -> UsbPrinterStatus {
        var status = UsbPrinterStatus(driver: .running, printerAttached: true)
        let reply = statusReply(from: connection)
        guard reply.code == IOReturnCode.success else {
            status.lastError = reply.code
            return status
        }
        let version = UInt32(truncatingIfNeeded: reply.scalars[Int(kFavorZplStatusABIVersion)])
        status.abiVersion = version
        // A dext speaking another ABI cannot be used, so it is not "running" however alive it is.
        if version != UInt32(kFavorZplABIVersion) { status.driver = .printerPresentDriverNotRunning }
        status.stage = UInt32(truncatingIfNeeded: reply.scalars[Int(kFavorZplStatusStage)])
        let error = Int32(truncatingIfNeeded: reply.scalars[Int(kFavorZplStatusError)])
        status.lastError = error == IOReturnCode.success ? nil : error
        status.bulkOutAddress = endpointAddress(reply.scalars[Int(kFavorZplStatusBulkOutAddress)])
        status.bulkInAddress = endpointAddress(reply.scalars[Int(kFavorZplStatusBulkInAddress)])
        // The kernel may leave the output size untouched when the dext returns no serial: stop at the first NUL.
        let serial = String(decoding: reply.data.prefix { $0 != 0 }, as: UTF8.self)
        status.usbSerial = serial.isEmpty ? nil : serial
        return status
    }

    private static func endpointAddress(_ scalar: UInt64) -> UInt8? {
        scalar == 0 ? nil : UInt8(truncatingIfNeeded: scalar)
    }

    private func sendNow(_ zpl: Data) -> Result<Int, UsbTransportError> {
        if zpl.isEmpty { return .success(0) }
        return withConnection { connection in
            let expected = zpl.count
            var written = 0
            while written < expected {
                let start = zpl.startIndex + written
                let chunk = [UInt8](zpl[start..<(start + min(expected - written, Int(kFavorZplMaxSendBytes)))])
                let reply = connection.call(
                    selector: kFavorZplSelectorSendRaw, structInput: chunk, scalarOutputCount: Int(kFavorZplSendResultCount)
                ).requiring(scalars: Int(kFavorZplSendResultCount))
                let answered = reply.code == IOReturnCode.success
                // The dext cannot have accepted more than it was offered.
                let chunkWritten = answered
                    ? min(Int(clamping: reply.scalars[Int(kFavorZplSendResultBytesWritten)]), chunk.count) : 0
                let driverCode = answered
                    ? Int32(truncatingIfNeeded: reply.scalars[Int(kFavorZplSendResultIOReturn)]) : IOReturnCode.success
                if answered && driverCode == IOReturnCode.success && chunkWritten >= chunk.count {
                    written += chunk.count
                    continue
                }
                log.error("send stopped at \(written + chunkWritten, privacy: .public) of \(expected, privacy: .public) bytes, code \(reply.code, privacy: .public)/\(driverCode, privacy: .public)")
                return UsbTransportError.writeOutcome(
                    callCode: reply.code, driverCode: driverCode, written: written + chunkWritten, expected: expected
                )
            }
            return .success(written)
        }
    }

    private func readNow() -> Result<Data, UsbTransportError> {
        withConnection { connection in
            let reply = connection.call(
                selector: kFavorZplSelectorReadStatus, scalarInput: [readTimeoutMs],
                scalarOutputCount: Int(kFavorZplReadResultCount), structOutputCapacity: Int(kFavorZplMaxReadBytes)
            ).requiring(scalars: Int(kFavorZplReadResultCount))
            let answered = reply.code == IOReturnCode.success
            let driverCode = answered
                ? Int32(truncatingIfNeeded: reply.scalars[Int(kFavorZplReadResultIOReturn)]) : IOReturnCode.success
            // Trust the dext's byte count over the returned output size, which the kernel may leave untouched.
            let bytesRead = answered
                ? min(Int(clamping: reply.scalars[Int(kFavorZplReadResultBytesRead)]), Int(kFavorZplMaxReadBytes)) : 0
            let outcome = UsbTransportError.readOutcome(
                callCode: reply.code, driverCode: driverCode, data: Data(reply.data.prefix(bytesRead))
            )
            if case .failure(let error) = outcome {
                log.error("read failed: \(String(describing: error), privacy: .public)")
            }
            return outcome
        }
    }

    /// Refuses before any send or read when the dext does not speak this app's ABI.
    private static func abiMismatch(on connection: DextConnection) -> UsbTransportError? {
        let expected = UInt32(kFavorZplABIVersion)
        let reply = statusReply(from: connection)
        if reply.code == IOReturnCode.badArgument { return .abiMismatch(expected: expected, actual: nil) }
        guard reply.code == IOReturnCode.success else { return .forOpen(code: reply.code) }
        let actual = UInt32(truncatingIfNeeded: reply.scalars[Int(kFavorZplStatusABIVersion)])
        return actual == expected ? nil : .abiMismatch(expected: expected, actual: actual)
    }

    private func withConnection<T>(_ body: (DextConnection) -> Result<T, UsbTransportError>) -> Result<T, UsbTransportError> {
        switch backend.connect() {
        case .connected(let connection):
            defer { connection.close() }
            if let mismatch = Self.abiMismatch(on: connection) {
                log.error("refusing to use the driver: \(String(describing: mismatch), privacy: .public)")
                return .failure(mismatch)
            }
            return body(connection)
        case .noService:
            // With the printer visible the driver is off or not loaded. Otherwise assume the printer is unplugged.
            return .failure(backend.printerVisible() ? .driverNotFound : .notAttached)
        case .openFailed(let code):
            log.error("open failed: \(code, privacy: .public)")
            return .failure(.forOpen(code: code))
        }
    }
}
