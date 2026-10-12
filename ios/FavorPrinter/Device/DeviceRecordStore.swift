import Foundation

/// Non-secret device state that survives a restart. The bearer secret is never in here.
struct DeviceRecord: Codable, Sendable, Equatable {
    var grant: DeviceGrant?
    var revoked: Bool
}

protocol DeviceRecordStore: Sendable {
    func load() -> DeviceRecord?
    func save(_ record: DeviceRecord)
    func clear()
}

struct UserDefaultsRecordStore: DeviceRecordStore, @unchecked Sendable {
    // UserDefaults is documented thread-safe.
    private let defaults: UserDefaults
    private let key = "church.favor.printer.device.record"

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func load() -> DeviceRecord? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(DeviceRecord.self, from: data)
    }

    func save(_ record: DeviceRecord) {
        guard let data = try? JSONEncoder().encode(record) else { return }
        defaults.set(data, forKey: key)
    }

    func clear() { defaults.removeObject(forKey: key) }
}
