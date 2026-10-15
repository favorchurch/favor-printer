import Foundation

/// Raw ZPL in, bytes written or a typed failure out. The one seam between the host loop and the USB printer.
protocol UsbPrinterTransport: Sendable {
    func status() async -> UsbPrinterStatus
    /// Writes `zpl` to the printer's bulk OUT endpoint. Success carries the byte count, equal to `zpl.count`.
    func send(_ zpl: Data) async -> Result<Int, UsbTransportError>
    /// Reads whatever the printer answers on bulk IN, e.g. after sending `~HS`.
    func readStatus() async -> Result<Data, UsbTransportError>
}

enum DriverAvailability: Sendable, Equatable {
    /// The dext service is matched and its user client opens.
    case running
    /// An IOUSBHost device or interface with VID 0x0A5F PID 389 is visible but there is no working dext service:
    /// the driver is disabled or has not loaded yet.
    case printerPresentDriverNotRunning
    /// Neither is visible, e.g. no printer attached. Whether the driver is enabled cannot be inferred.
    case unknown

    /// The one place the three states are derived. `printerVisible` is a best-effort IORegistry lookup.
    /// A matched service whose user client will not open counts as not running: the printer is certainly there.
    /// `serviceMatched` is about our dext only: a driver from another bundle never counts, so a foreign dext holding the
    /// printer shows up as `.printerPresentDriverNotRunning`, never `.running`.
    static func derive(serviceMatched: Bool, userClientOpens: Bool, printerVisible: Bool) -> DriverAvailability {
        if serviceMatched && userClientOpens { return .running }
        if serviceMatched || printerVisible { return .printerPresentDriverNotRunning }
        return .unknown
    }
}

struct UsbPrinterStatus: Sendable, Equatable {
    var driver: DriverAvailability
    /// True when the printer is known to be attached, nil when unknown. Never false: the IORegistry lookup is
    /// best effort, so not seeing the printer proves nothing.
    var printerAttached: Bool?
    /// Start-up stage the dext reached (8 is ready), nil when the dext could not be queried.
    var stage: UInt32?
    /// IOReturn recorded by the dext at that stage, or the user-client open failure. Nil when there is none.
    var lastError: Int32?
    var bulkOutAddress: UInt8?
    var bulkInAddress: UInt8?
    var usbSerial: String?
    /// ABI version the dext reported, nil when it could not be queried.
    var abiVersion: UInt32?
    /// A dext from another bundle is attached for the printer and ours is not running. The spike app's dext does this.
    var foreignDriver: Bool

    init(
        driver: DriverAvailability,
        printerAttached: Bool? = nil,
        stage: UInt32? = nil,
        lastError: Int32? = nil,
        bulkOutAddress: UInt8? = nil,
        bulkInAddress: UInt8? = nil,
        usbSerial: String? = nil,
        abiVersion: UInt32? = nil,
        foreignDriver: Bool = false
    ) {
        self.driver = driver
        self.printerAttached = printerAttached
        self.stage = stage
        self.lastError = lastError
        self.bulkOutAddress = bulkOutAddress
        self.bulkInAddress = bulkInAddress
        self.usbSerial = usbSerial
        self.abiVersion = abiVersion
        self.foreignDriver = foreignDriver
    }
}

enum UsbTransportError: Error, Sendable, Equatable {
    /// No dext service to talk to and no printer seen: the driver is off or not loaded.
    case driverNotFound
    /// The printer went away, or no printer is attached.
    case notAttached
    case openFailed(code: Int32)
    /// `bytesWritten` is what the printer is known to have accepted before the failure.
    case writeFailed(code: Int32, bytesWritten: Int)
    case shortWrite(written: Int, expected: Int)
    case timeout
    case readFailed(code: Int32)
    /// The dext's user-client ABI is not the one this app was built for (`actual` is nil when it did not say). Nothing was sent.
    case abiMismatch(expected: UInt32, actual: UInt32?)
}
