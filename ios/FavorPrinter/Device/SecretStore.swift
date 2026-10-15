import Foundation
import Security

/// Holds the device bearer secret. The only place it may be persisted.
protocol SecretStore: Sendable {
    func read() throws -> String?
    func write(_ secret: String) throws
    func delete() throws
}

struct KeychainError: Error, Equatable {
    let status: OSStatus
}

struct KeychainSecretStore: SecretStore {
    let service: String
    let account: String

    init(service: String = "church.favor.printer.device", account: String = "bearer") {
        self.service = service
        self.account = account
    }

    private var item: KeychainCredentialItem { KeychainCredentialItem(service: service, account: account) }

    func read() throws -> String? { try item.read() }
    func write(_ secret: String) throws { try item.write(secret) }
    func delete() throws { try item.delete() }
}

/// Holds the cloud relay credential independently from the check-in bearer.
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
