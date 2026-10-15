import Foundation

/// What `DriverKitUsbTransport` needs from IOKit, so everything above this seam runs against a scripted backend in tests.
protocol DextBackend: Sendable {
    /// Finds the dext service and opens a user client on it.
    func connect() -> DextConnectResult
    /// Best effort: whether the ZD421 shows up in the IORegistry at all, driver or not.
    func printerVisible() -> Bool
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

/// The real backend. Looks the dext up through the IORegistry on every call and opens a fresh user client, so a
/// replug or a driver reload needs no reconnect logic.
struct IOKitDextBackend: DextBackend {
    static let printerVendorID = 0x0A5F
    static let printerProductID = 389

    func connect() -> DextConnectResult {
        let services = Self.services(matching: Self.driverMatch())
        defer { services.forEach { IOObjectRelease($0) } }
        guard !services.isEmpty else { return .noService }
        var failure = IOReturnCode.notFound
        for service in services {
            var connection: io_connect_t = 0
            let code = IOServiceOpen(service, mach_task_self_, 0, &connection)
            if code == KERN_SUCCESS { return .connected(IOKitDextConnection(connection: connection)) }
            failure = code
        }
        return .openFailed(code: failure)
    }

    func printerVisible() -> Bool {
        ["IOUSBHostDevice", "IOUSBHostInterface"].contains { className in
            let match = IOServiceMatching(className) as NSMutableDictionary
            match["IOPropertyMatch"] = ["idVendor": Self.printerVendorID, "idProduct": Self.printerProductID]
            let found = Self.services(matching: match)
            found.forEach { IOObjectRelease($0) }
            return !found.isEmpty
        }
    }

    /// Every dext instance. Only the USB-matched printer personality exists, so this is zero or one.
    private static func driverMatch() -> NSMutableDictionary {
        let match = IOServiceMatching("IOUserService") as NSMutableDictionary
        match["IOPropertyMatch"] = ["IOUserClass": "FavorZplDriver"]
        return match
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

private struct IOKitDextConnection: DextConnection {
    let connection: io_connect_t

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
        return DextReply(code: code, scalars: scalars, data: code == KERN_SUCCESS ? Array(data.prefix(dataCount)) : [])
    }

    func close() {
        IOServiceClose(connection)
    }
}
