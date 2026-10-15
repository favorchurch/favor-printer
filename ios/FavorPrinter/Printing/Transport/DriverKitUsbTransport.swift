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
        switch probeCandidates() {
        case .ours(let connection, let reply, let diagnostic):
            defer { connection.close() }
            return Self.runningStatus(from: reply, diagnostic: diagnostic)
        case .unavailable(let candidatesFound, let openFailure, let statusFailure, let mismatch, let foreign, let diagnostic):
            let visible = backend.printerVisible()
            var status = UsbPrinterStatus(
                driver: candidatesFound || visible ? .printerPresentDriverNotRunning : .unknown,
                printerAttached: candidatesFound || visible ? true : nil,
                foreignDriver: foreign
            )
#if DEBUG
            status.debugDiagnostic = diagnostic
#endif
            if let mismatch {
                status.abiVersion = mismatch.actual
                status.lastError = IOReturnCode.badArgument
            } else if let openFailure {
                status.lastError = openFailure
            } else if let statusFailure {
                status.lastError = statusFailure
            }
            return status
        }
    }

    private static func statusReply(from connection: DextConnection) -> DextReply {
        connection.call(
            selector: kFavorZplSelectorStatus,
            scalarOutputCount: Int(kFavorZplStatusFieldCount), structOutputCapacity: Int(kFavorZplMaxSerialBytes)
        ).requiring(scalars: Int(kFavorZplStatusFieldCount))
    }

    private static func runningStatus(from reply: DextReply, diagnostic: String?) -> UsbPrinterStatus {
        var status = UsbPrinterStatus(driver: .running, printerAttached: true)
#if DEBUG
        status.debugDiagnostic = diagnostic
#endif
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

    private enum CandidateProbe {
        case ours(DextConnection, DextReply, String?)
        case unavailable(candidatesFound: Bool, openFailure: Int32?, statusFailure: Int32?, mismatch: ABIMismatch?, foreign: Bool, diagnostic: String?)
    }

    private struct ABIMismatch {
        var actual: UInt32?
    }

    private func probeCandidates() -> CandidateProbe {
        let candidates = backend.candidates()
        var lines: [String] = ["candidates: \(candidates.count)"]
        var openFailure: Int32?
        var statusFailure: Int32?
        var mismatch: ABIMismatch?
        var foreign = false
        var ours: (DextConnection, DextReply)?
        for (index, candidate) in candidates.enumerated() {
            let identity = candidate.identityHint.map { ", hint=\($0)" } ?? ""
            guard candidate.openCode == IOReturnCode.success, let connection = candidate.connection else {
                openFailure = candidate.openCode
                lines.append("#\(index + 1) class=\(candidate.className)\(identity) open=0x\(String(UInt32(bitPattern: candidate.openCode), radix: 16)) magic=unavailable abi=unavailable stage=unavailable result=open-failed")
                continue
            }
            let reply = Self.statusReply(from: connection)
            if reply.code != IOReturnCode.success, reply.code != IOReturnCode.badArgument {
                if statusFailure == nil { statusFailure = reply.code }
                lines.append("#\(index + 1) class=\(candidate.className)\(identity) open=success magic=unavailable abi=unavailable stage=unavailable result=status-failed (status=0x\(String(UInt32(bitPattern: reply.code), radix: 16)))")
                connection.close()
                continue
            }
            let hasMagic = reply.code == IOReturnCode.success && reply.scalars.count > Int(kFavorZplStatusDriverMagic)
            let magic = hasMagic ? UInt32(truncatingIfNeeded: reply.scalars[Int(kFavorZplStatusDriverMagic)]) : nil
            let hasVersion = reply.code == IOReturnCode.success && reply.scalars.count > Int(kFavorZplStatusABIVersion)
            let version = hasVersion ? UInt32(truncatingIfNeeded: reply.scalars[Int(kFavorZplStatusABIVersion)]) : nil
            let stage = reply.code == IOReturnCode.success && reply.scalars.count > Int(kFavorZplStatusStage)
                ? String(UInt32(truncatingIfNeeded: reply.scalars[Int(kFavorZplStatusStage)])) : "unavailable"
            let magicText = magic.map { String(format: "0x%08X", $0) } ?? "unavailable"
            let versionText = version.map(String.init) ?? "unavailable"
            let trace = "#\(index + 1) class=\(candidate.className)\(identity) open=success magic=\(magicText) abi=\(versionText) stage=\(stage)"
            if reply.code == IOReturnCode.badArgument {
                if mismatch == nil { mismatch = ABIMismatch(actual: nil) }
                lines.append("\(trace) result=abi-mismatch (status=bad-argument)")
                connection.close()
                continue
            }
            if magic == UInt32(kFavorZplDriverMagic) {
                if version == UInt32(kFavorZplABIVersion) {
                    lines.append("\(trace) result=ours")
                    if ours == nil { ours = (connection, reply) }
                    else { connection.close() }
                    continue
                }
                if mismatch == nil { mismatch = ABIMismatch(actual: version) }
                lines.append("\(trace) result=abi-mismatch")
            } else {
                foreign = true
                lines.append("\(trace) result=foreign (status=0x\(String(UInt32(bitPattern: reply.code), radix: 16)))")
            }
            connection.close()
        }
        if let ours {
            return .ours(ours.0, ours.1, Self.debugDiagnostic(lines))
        }
        return .unavailable(
            candidatesFound: !candidates.isEmpty, openFailure: openFailure, statusFailure: statusFailure, mismatch: mismatch,
            foreign: foreign, diagnostic: Self.debugDiagnostic(lines)
        )
    }

    private static func debugDiagnostic(_ lines: [String]) -> String? {
        #if DEBUG
        lines.joined(separator: "\n")
        #else
        nil
        #endif
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

    private func withConnection<T>(_ body: (DextConnection) -> Result<T, UsbTransportError>) -> Result<T, UsbTransportError> {
        switch probeCandidates() {
        case .ours(let connection, _, _):
            defer { connection.close() }
            return body(connection)
        case .unavailable(let found, let openFailure, let statusFailure, let mismatch, _, _):
            if let mismatch {
                let failure = UsbTransportError.abiMismatch(expected: UInt32(kFavorZplABIVersion), actual: mismatch.actual)
                log.error("refusing to use the driver: \(String(describing: failure), privacy: .public)")
                return .failure(failure)
            }
            if let openFailure {
                log.error("open failed: \(openFailure, privacy: .public)")
                return .failure(.forOpen(code: openFailure))
            }
            if let statusFailure { return .failure(.forOpen(code: statusFailure)) }
            return .failure(found || backend.printerVisible() ? .driverNotFound : .notAttached)
        }
    }
}
