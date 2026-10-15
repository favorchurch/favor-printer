import Foundation
import Security

/// Holds one secret. The only place the relay credential may be persisted.
protocol SecretStore: Sendable {
    func read() throws -> String?
    func write(_ secret: String) throws
    func delete() throws
}

struct KeychainError: Error, Equatable {
    let status: OSStatus
}

/// Holds the cloud relay credential.
struct KeychainHostCredentialStore: SecretStore {
    let service: String
    let account: String

    init(service: String = "church.favor.printer.relay", account: String = "bearer") {
        self.service = service
        self.account = account
    }

    private var item: KeychainCredentialItem { KeychainCredentialItem(service: service, account: account) }

    func read() throws -> String? { try item.read() }
    func write(_ secret: String) throws { try item.write(secret) }
    func delete() throws { try item.delete() }
}

private struct KeychainCredentialItem {
    let service: String
    let account: String

    private var identity: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }

    func read() throws -> String? {
        var query = identity
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        guard let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func write(_ secret: String) throws {
        let data = Data(secret.utf8)
        // Readable after first unlock so queued work can replay while the iPad is locked; never leaves the device.
        let accessible = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        // The accessibility class is enforced on updates too, so an item left by an earlier
        // build can never keep a class that would let the secret leave the device in a backup.
        let update = SecItemUpdate(
            identity as CFDictionary,
            [kSecValueData as String: data, kSecAttrAccessible as String: accessible] as CFDictionary
        )
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw KeychainError(status: update) }

        var add = identity
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = accessible
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    func delete() throws {
        let status = SecItemDelete(identity as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }
}

/// Builds before the relay-only app kept a bearer in the Keychain under this service. Nothing reads it any more:
/// launch deletes it, once.
enum StaleDeviceBearer {
    static let service = "church.favor.printer.device"
    /// The grant record that went with it: non-secret, and equally unused now.
    static let recordKey = "church.favor.printer.device.record"
    static let doneKey = "church.favor.printer.device.cleaned"

    /// Returns whether the item is gone. A failed delete (a locked Keychain) is retried on the next launch.
    @discardableResult
    static func deleteOnce(
        in store: any SecretStore = KeychainHostCredentialStore(service: service),
        defaults: UserDefaults = .standard
    ) -> Bool {
        if defaults.bool(forKey: doneKey) { return true }
        do { try store.delete() } catch { return false }
        defaults.removeObject(forKey: recordKey)
        defaults.set(true, forKey: doneKey)
        return true
    }
}
