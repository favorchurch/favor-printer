import Foundation

/// The relay id and bearer token the cloud issued at enrollment. Never printed, logged or reflected.
struct HostCredential: Codable, Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    let relayId: String
    let token: String

    var description: String { "HostCredential(relayId: \(relayId), token: <redacted>)" }
    var debugDescription: String { description }
    var customMirror: Mirror { Mirror(self, children: ["relayId": relayId]) }
}

/// Holds the host credential as one item, so it is either whole or absent.
protocol HostCredentialStore: Sendable {
    func load() throws -> HostCredential?
    func save(_ credential: HostCredential) throws
    func delete() throws
}

/// Stores the credential as a single JSON string in a `SecretStore` (the Keychain in the app).
struct SecretHostCredentialStore: HostCredentialStore {
    private let secrets: any SecretStore

    init(secrets: any SecretStore = KeychainHostCredentialStore()) { self.secrets = secrets }

    func load() throws -> HostCredential? {
        guard let raw = try secrets.read() else { return nil }
        // An unreadable item is treated as absent: enrolling again replaces it.
        return try? JSONDecoder().decode(HostCredential.self, from: Data(raw.utf8))
    }

    func save(_ credential: HostCredential) throws {
        let data = try JSONEncoder().encode(credential)
        try secrets.write(String(decoding: data, as: UTF8.self))
    }

    func delete() throws { try secrets.delete() }
}
