import Foundation

/// What `DriverKitUsbTransport` needs from IOKit, so everything above this seam runs against a scripted backend in tests.
protocol DextBackend: Sendable {
    /// Finds the dext service and opens a user client on it.
    func connect() -> DextConnectResult
    /// Best effort: whether the ZD421 shows up in the IORegistry at all, driver or not.
    func printerVisible() -> Bool
    /// Best effort: whether a dext from another bundle (e.g. the spike app's) is attached for this printer.
    func foreignDriverPresent() -> Bool
}

enum DextConnectResult {
    case connected(DextConnection)
    /// No dext instance exists.
    case noService
    /// A dext instance exists but no user client would open. `code` is the last `IOServiceOpen` result.
    case openFailed(code: Int32)
}

struct DextReply {
    /// `IOConnectCallMethod`'s return. The other fields are meaningless unless this is 0.
    var code: Int32
    var scalars: [UInt64]
    /// Structure output as returned. Its length is not trustworthy: callers trim with a scalar byte count or a NUL.
    var data: [UInt8]

    /// Builds a reply from the buffers handed to `IOConnectCallMethod` and the counts it wrote back, so a dext that
    /// returned fewer scalars than requested shows up as a short array instead of as zeros.
    init(kernelCode: Int32, scalars: [UInt64], scalarCount: Int, data: [UInt8], dataCount: Int) {
        code = kernelCode
        self.scalars = kernelCode == IOReturnCode.success ? Array(scalars.prefix(max(scalarCount, 0))) : []
        self.data = kernelCode == IOReturnCode.success ? Array(data.prefix(max(dataCount, 0))) : []
    }

    init(code: Int32, scalars: [UInt64], data: [UInt8]) {
        self.code = code
        self.scalars = scalars
        self.data = data
    }

    /// A reply that claims success but carries fewer scalars than the ABI promises is a dext/app mismatch.
    /// Report it as a failed call instead of letting callers index past the end.
    func requiring(scalars count: Int) -> DextReply {
        guard code == IOReturnCode.success, scalars.count < count else { return self }
        return DextReply(code: IOReturnCode.badArgument, scalars: [], data: [])
    }
}

protocol DextConnection {
    func call(selector: Int, scalarInput: [UInt64], structInput: [UInt8], scalarOutputCount: Int, structOutputCapacity: Int) -> DextReply
    func close()
}

extension DextConnection {
    func call(
        selector: Int, scalarInput: [UInt64] = [], structInput: [UInt8] = [], scalarOutputCount: Int = 0, structOutputCapacity: Int = 0
    ) -> DextReply {
        call(
            selector: selector, scalarInput: scalarInput, structInput: structInput,
            scalarOutputCount: scalarOutputCount, structOutputCapacity: structOutputCapacity
        )
    }
}

/// The IOKit calls that create, find and end handles. Injectable so a test can count what happens to each handle.
/// `IOConnectCallMethod` stays direct: it neither creates nor ends a handle.
struct IOKitHandleOps: Sendable {
    /// Every dext instance that could be ours or hold the printer: our class name or the printer's VID/PID, from any
    /// bundle. Callers tell them apart with `driverIdentity`.
    var driverServices: @Sendable () -> [io_service_t]
    /// The bundle identifier of the dext behind a service: `IOUserServerName`, else `CFBundleIdentifier`.
    var driverIdentity: @Sendable (io_service_t) -> String?
    /// Printer entries in the IORegistry (device or interface, VID 0x0A5F PID 389), driver or not.
    var printerServices: @Sendable () -> [io_service_t]
    /// `IOServiceOpen`: the result code and, on success, the connection handle.
    var open: @Sendable (io_service_t) -> (code: Int32, connection: io_connect_t)
    /// `IOObjectRelease`, for service handles only.
    var release: @Sendable (io_object_t) -> Void
    /// `IOServiceClose`, which destroys a connection handle. Connections are never also released.
    var close: @Sendable (io_connect_t) -> Void

    static let live = IOKitHandleOps(
        driverServices: {
            let byClass = IOServiceMatching("IOUserService") as NSMutableDictionary
            byClass["IOPropertyMatch"] = ["IOUserClass": IOKitDextBackend.driverClassName]
            let byPrinter = IOServiceMatching("IOUserService") as NSMutableDictionary
            byPrinter["IOPropertyMatch"] = [
                "idVendor": IOKitDextBackend.printerVendorID, "idProduct": IOKitDextBackend.printerProductID,
            ]
            return IOKitHandleOps.distinct([byClass, byPrinter].flatMap(IOKitHandleOps.services(matching:)))
        },
        driverIdentity: { service in
            IOKitHandleOps.identity(of: { IORegistryEntryCreateCFProperty(service, $0 as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String })
        },
        printerServices: {
            ["IOUSBHostDevice", "IOUSBHostInterface"].flatMap { className -> [io_service_t] in
                let match = IOServiceMatching(className) as NSMutableDictionary
                match["IOPropertyMatch"] = [
                    "idVendor": IOKitDextBackend.printerVendorID, "idProduct": IOKitDextBackend.printerProductID,
                ]
                return IOKitHandleOps.services(matching: match)
            }
        },
        open: { service in
            var connection: io_connect_t = 0
            let code = IOServiceOpen(service, mach_task_self_, 0, &connection)
            return (code, connection)
        },
        release: { _ = IOObjectRelease($0) },
        close: { _ = IOServiceClose($0) }
    )

    /// `IOUserServerName`, else `CFBundleIdentifier`, from whatever reads a string property.
    static func identity(of property: (String) -> String?) -> String? {
        for key in ["IOUserServerName", "CFBundleIdentifier"] {
            if let value = property(key) { return value }
        }
        return nil
    }

    /// One handle per registry entry: the class and VID/PID queries can both find the same dext.
    private static func distinct(_ services: [io_service_t]) -> [io_service_t] {
        var seen = Set<UInt64>()
        return services.filter { service in
            var entryID: UInt64 = 0
            guard IORegistryEntryGetRegistryEntryID(service, &entryID) == KERN_SUCCESS else { return true }
            if seen.insert(entryID).inserted { return true }
            IOObjectRelease(service)
            return false
        }
    }

    private static func services(matching match: NSMutableDictionary) -> [io_service_t] {
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, match, &iterator) == KERN_SUCCESS else { return [] }
        defer { IOObjectRelease(iterator) }
        var found: [io_service_t] = []
        var service = IOIteratorNext(iterator)
        while service != 0 {
            found.append(service)
            service = IOIteratorNext(iterator)
        }
        return found
    }
}

/// The real backend. Looks the dext up through the IORegistry on every call and opens a fresh user client, so a
/// replug or a driver reload needs no reconnect logic. Each service handle is released once, each connection
/// handle closed once.
struct IOKitDextBackend: DextBackend {
    static let printerVendorID = 0x0A5F
    static let printerProductID = 389
    /// The production dext's `IOUserClass`. No other bundle (the spike's was `FavorZplDriver`) uses it.
    static let driverClassName = "FavorPrinterUsbDriver"
    /// The production dext's bundle identifier, the only identity this backend opens.
    static let driverBundleID = "church.favor.printer.ios.driver"

    var ops = IOKitHandleOps.live

    func connect() -> DextConnectResult {
        let services = ops.driverServices()
        defer { services.forEach(ops.release) }
        // A service with our class name from another bundle is somebody else's driver: never open its user client.
        let ours = services.filter { ops.driverIdentity($0) == Self.driverBundleID }
        guard !ours.isEmpty else { return .noService }
        var failure = IOReturnCode.notFound
        for service in ours {
            let opened = ops.open(service)
            if opened.code == KERN_SUCCESS {
                return .connected(IOKitDextConnection(connection: opened.connection, closeHandle: ops.close))
            }
            failure = opened.code
        }
        return .openFailed(code: failure)
    }

    func printerVisible() -> Bool {
        let found = ops.printerServices()
        found.forEach(ops.release)
        return !found.isEmpty
    }

    func foreignDriverPresent() -> Bool {
        let services = ops.driverServices()
        defer { services.forEach(ops.release) }
        return services.contains { ops.driverIdentity($0) != Self.driverBundleID }
    }
}

struct IOKitDextConnection: DextConnection {
    let connection: io_connect_t
    /// `IOServiceClose`. It destroys the handle (IOKitLib.h: "should not be released with IOObjectRelease"), so
    /// nothing else is called on `connection`: releasing as well would drop a port right twice.
    let closeHandle: @Sendable (io_connect_t) -> Void

    func call(selector: Int, scalarInput: [UInt64], structInput: [UInt8], scalarOutputCount: Int, structOutputCapacity: Int) -> DextReply {
        var scalars = [UInt64](repeating: 0, count: scalarOutputCount)
        var scalarCount = UInt32(scalarOutputCount)
        var data = [UInt8](repeating: 0, count: structOutputCapacity)
        var dataCount = structOutputCapacity
        let code = IOConnectCallMethod(
            connection, UInt32(selector),
            scalarInput, UInt32(scalarInput.count),
            structInput, structInput.count,
            &scalars, &scalarCount,
            &data, &dataCount
        )
        return DextReply(kernelCode: code, scalars: scalars, scalarCount: Int(scalarCount), data: data, dataCount: dataCount)
    }

    func close() {
        closeHandle(connection)
    }
}
