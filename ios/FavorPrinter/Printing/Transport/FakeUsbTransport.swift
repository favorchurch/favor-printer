#if DEBUG
import Foundation

/// Scriptable `UsbPrinterTransport` for tests and the DEBUG fake relay. It never touches IOKit.
///
/// - `send` records the payload of every call, including ones scripted to fail, because a failed write may still
///   have put bytes on the wire. It answers with the next scripted result, or `.success(zpl.count)` when none is queued.
/// - `readStatus` answers with the next scripted result, or `.failure(.timeout)` when none is queued (a silent printer).
/// - `status` answers with `scriptedStatus`.
actor FakeUsbTransport: UsbPrinterTransport {
    static let readyStatus = UsbPrinterStatus(
        driver: .running, printerAttached: true, stage: 8, lastError: nil,
        bulkOutAddress: 0x01, bulkInAddress: 0x81, usbSerial: "FAKE0001"
    )

    private(set) var writes: [Data] = []
    private(set) var statusCalls = 0
    private(set) var readCalls = 0
    private var scriptedStatus: UsbPrinterStatus
    private var sendScript: [Result<Int, UsbTransportError>] = []
    private var readScript: [Result<Data, UsbTransportError>] = []

    init(status: UsbPrinterStatus = FakeUsbTransport.readyStatus) {
        scriptedStatus = status
    }

    func setStatus(_ status: UsbPrinterStatus) {
        scriptedStatus = status
    }

    func enqueueSend(_ results: Result<Int, UsbTransportError>...) {
        sendScript.append(contentsOf: results)
    }

    func enqueueRead(_ results: Result<Data, UsbTransportError>...) {
        readScript.append(contentsOf: results)
    }

    func status() async -> UsbPrinterStatus {
        statusCalls += 1
        return scriptedStatus
    }

    func send(_ zpl: Data) async -> Result<Int, UsbTransportError> {
        writes.append(zpl)
        return sendScript.isEmpty ? .success(zpl.count) : sendScript.removeFirst()
    }

    func readStatus() async -> Result<Data, UsbTransportError> {
        readCalls += 1
        return readScript.isEmpty ? .failure(.timeout) : readScript.removeFirst()
    }
}
#endif
