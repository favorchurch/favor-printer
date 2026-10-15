import Foundation

/// What `DriverKitUsbTransport` needs from IOKit, so everything above this seam runs against a scripted backend in tests.
protocol DextBackend: Sendable {
    /// Opens each candidate service. Registry identity is diagnostic context only; the status handshake identifies us.
    func candidates() -> [DextCandidate]
    /// Best effort: whether the ZD421 shows up in the IORegistry at all, driver or not.
    func printerVisible() -> Bool
}

struct DextCandidate: Sendable {
    var className: String
    /// Registry identity is a hint for diagnostics, never a reason to reject a candidate.
    var identityHint: String?
    var openCode: Int32
    var connection: DextConnection?
}

struct DextReply: Sendable {
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

protocol DextConnection: Sendable {
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

/// The IOKit calls that find, open, query and end handles. Injectable for candidate selection and lifetime tests.
struct IOKitHandleOps: Sendable {
    /// All IOUserService entries, without IOPropertyMatch filters.
    var driverServices: @Sendable () -> [io_service_t]
    /// IOUserService children of matching printer interfaces, used as a fallback discovery path.
    var fallbackDriverServices: @Sendable () -> [io_service_t]
    /// Optional registry identity hint for diagnostics.
    var driverIdentity: @Sendable (io_service_t) -> String?
    /// Runtime registry class name for diagnostics.
    var className: @Sendable (io_service_t) -> String
    /// Printer entries in the IORegistry (device or interface, VID 0x0A5F PID 389), driver or not.
    var printerServices: @Sendable () -> [io_service_t]
    /// `IOServiceOpen`: the result code and, on success, the connection handle.
    var open: @Sendable (io_service_t) -> (code: Int32, connection: io_connect_t)
    /// `IOObjectRelease`, for service handles only.
    var release: @Sendable (io_object_t) -> Void
    /// `IOServiceClose`, which destroys a connection handle. Connections are never also released.
    var close: @Sendable (io_connect_t) -> Void
    /// User-client calls, injectable so candidate handshakes can be tested without IOKit or hardware.
    var call: @Sendable (io_connect_t, Int, [UInt64], [UInt8], Int, Int) -> DextReply

    static let live = IOKitHandleOps(
        driverServices: { IOKitHandleOps.services(matching: IOServiceMatching("IOUserService")) },
        fallbackDriverServices: { IOKitHandleOps.userServiceChildrenOfPrinterInterfaces() },
        driverIdentity: { service in
            IOKitHandleOps.identity(of: { IORegistryEntryCreateCFProperty(service, $0 as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String })
        },
        className: { service in IOObjectCopyClass(service)?.takeRetainedValue() as String? ?? "unknown" },
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
        close: { _ = IOServiceClose($0) },
        call: { connection, selector, scalarInput, structInput, scalarOutputCount, structOutputCapacity in
            var scalars = [UInt64](repeating: 0, count: scalarOutputCount)
            var scalarCount = UInt32(scalarOutputCount)
            var data = [UInt8](repeating: 0, count: structOutputCapacity)
            var dataCount = structOutputCapacity
            let code = IOConnectCallMethod(
                connection, UInt32(selector), scalarInput, UInt32(scalarInput.count), structInput, structInput.count,
                &scalars, &scalarCount, &data, &dataCount
            )
            return DextReply(kernelCode: code, scalars: scalars, scalarCount: Int(scalarCount), data: data, dataCount: dataCount)
        }
    )

    /// `IOUserServerName`, else `CFBundleIdentifier`, from whatever reads a string property.
    static func identity(of property: (String) -> String?) -> String? {
        for key in ["IOUserServerName", "CFBundleIdentifier"] {
            if let value = property(key) { return value }
        }
        return nil
    }

    /// One handle per registry entry: global and USB-interface child enumeration can find the same service.
    static func distinct(_ services: [io_service_t], release: (io_object_t) -> Void) -> [io_service_t] {
        var seen = Set<UInt64>()
        return services.filter { service in
            var entryID: UInt64 = 0
            guard IORegistryEntryGetRegistryEntryID(service, &entryID) == KERN_SUCCESS else { return true }
            if seen.insert(entryID).inserted { return true }
            release(service)
            return false
        }
    }

    static func services(matching match: CFMutableDictionary) -> [io_service_t] {
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

    static func userServiceChildrenOfPrinterInterfaces() -> [io_service_t] {
        let match = IOServiceMatching("IOUSBHostInterface") as NSMutableDictionary
        match["IOPropertyMatch"] = [
            "idVendor": IOKitDextBackend.printerVendorID, "idProduct": IOKitDextBackend.printerProductID,
        ]
        let interfaces = services(matching: match)
        defer { interfaces.forEach { _ = IOObjectRelease($0) } }
        var found: [io_service_t] = []
        for interface in interfaces {
            var iterator: io_iterator_t = 0
            guard IORegistryEntryGetChildIterator(interface, kIOServicePlane, &iterator) == KERN_SUCCESS else { continue }
            defer { _ = IOObjectRelease(iterator) }
            var child = IOIteratorNext(iterator)
            while child != 0 {
                if IOObjectConformsTo(child, "IOUserService") != 0 { found.append(child) }
                else { _ = IOObjectRelease(child) }
                child = IOIteratorNext(iterator)
            }
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
    /// Registry class and bundle hints retained for diagnostics and personality contract tests.
    static let driverClassName = "FavorPrinterUsbDriver"
    static let driverBundleID = "church.favor.printer.ios.driver"
    var ops = IOKitHandleOps.live

    func candidates() -> [DextCandidate] {
        let services = IOKitHandleOps.distinct(ops.driverServices() + ops.fallbackDriverServices(), release: ops.release)
        defer { services.forEach(ops.release) }
        return services.map { service in
            let opened = ops.open(service)
            let connection = opened.code == KERN_SUCCESS
                ? IOKitDextConnection(connection: opened.connection, callHandle: ops.call, closeHandle: ops.close) as DextConnection
                : nil
            return DextCandidate(
                className: ops.className(service), identityHint: ops.driverIdentity(service),
                openCode: opened.code, connection: connection
            )
        }
    }

    func printerVisible() -> Bool {
        let found = ops.printerServices()
        found.forEach(ops.release)
        return !found.isEmpty
    }
}

struct IOKitDextConnection: DextConnection {
    let connection: io_connect_t
    let callHandle: @Sendable (io_connect_t, Int, [UInt64], [UInt8], Int, Int) -> DextReply
    /// `IOServiceClose`. It destroys the handle (IOKitLib.h: "should not be released with IOObjectRelease"), so
    /// nothing else is called on `connection`: releasing as well would drop a port right twice.
    let closeHandle: @Sendable (io_connect_t) -> Void

    func call(selector: Int, scalarInput: [UInt64], structInput: [UInt8], scalarOutputCount: Int, structOutputCapacity: Int) -> DextReply {
        callHandle(connection, selector, scalarInput, structInput, scalarOutputCount, structOutputCapacity)
    }

    func close() {
        closeHandle(connection)
    }
}
