import Foundation
import Security
import Testing
@testable import FavorPrinter

struct AppConfigTests {
    @Test func readsHTTPSBaseURL() throws {
        let config = try AppConfig(info: ["RSVPBaseURL": " https://rsvp.favor.church "])
        #expect(config.rsvpBaseURL.absoluteString == "https://rsvp.favor.church")
    }

    @Test func rejectsInsecureValues() {
        #expect(throws: AppConfig.Failure.insecure) { try AppConfig(info: ["RSVPBaseURL": "http://rsvp.favor.church"], build: .debug) }
        #expect(throws: AppConfig.Failure.insecure) { try AppConfig(info: ["RSVPBaseURL": "http://rsvp.favor.church"], build: .release) }
        #expect(throws: AppConfig.Failure.insecure) { try AppConfig(info: ["RSVPBaseURL": "https://"], build: .debug) }
    }

    @Test func debugDefaultsToThePreviewHost() throws {
        let missing = try AppConfig(info: nil, build: .debug)
        #expect(missing.rsvpBaseURL.absoluteString == "https://rsvp-preview.favor.church")
        #expect(try AppConfig(info: ["RSVPBaseURL": "   "], build: .debug) == missing)
    }

    @Test func debugAcceptsBranchPreviewHosts() throws {
        let config = try AppConfig(info: ["RSVPBaseURL": "https://my-branch.vercel.app"], build: .debug)
        #expect(config.rsvpBaseURL.host == "my-branch.vercel.app")
    }

    @Test func releaseRejectsEveryNonProductionHost() {
        for host in [
            "rsvp-preview.favor.church", "my-branch.vercel.app", "evil.example.com",
            "rsvp.favor.church.evil.com", "localhost", "rsvp.favor.church:8443",
        ] {
            #expect(throws: AppConfig.Failure.nonProduction) {
                try AppConfig(rsvpBaseURL: URL(string: "https://\(host)")!, build: .release)
            }
        }
        #expect(throws: AppConfig.Failure.nonProduction) {
            try AppConfig(info: ["RSVPBaseURL": "https://rsvp-preview.favor.church"], build: .release)
        }
    }

    @Test func releaseAcceptsOnlyTheProductionOriginAndMustBeConfigured() throws {
        let config = try AppConfig(rsvpBaseURL: URL(string: "https://rsvp.favor.church")!, build: .release)
        #expect(config.rsvpBaseURL.host == "rsvp.favor.church")
        #expect(throws: AppConfig.Failure.missing) { try AppConfig(info: nil, build: .release) }
        #expect(throws: AppConfig.Failure.missing) { try AppConfig(info: ["RSVPBaseURL": ""], build: .release) }
        // Garbage input is rejected whatever the parser makes of it.
        #expect(throws: AppConfig.Failure.self) { try AppConfig(info: ["RSVPBaseURL": "no such url"], build: .release) }
    }

    @Test func thisBuildShipsAnHTTPSBaseURLFromItsXcconfig() throws {
        let config = try AppConfig.load()
        #expect(config.rsvpBaseURL.scheme == "https")
        #expect(config.rsvpBaseURL.host?.isEmpty == false)
    }
}

struct KeychainSecretStoreTests {
    private func store() -> KeychainSecretStore {
        KeychainSecretStore(service: "church.favor.printer.tests.\(UUID().uuidString)", account: "bearer")
    }

    @Test func writeReadOverwriteDelete() throws {
        let store = store()
        defer { try? store.delete() }
        #expect(try store.read() == nil)
        try store.write(Fixture.token)
        #expect(try store.read() == Fixture.token)
        try store.write("checkin_device_" + String(repeating: "b", count: 43))
        #expect(try store.read() == "checkin_device_" + String(repeating: "b", count: 43))
        try store.delete()
        #expect(try store.read() == nil)
        try store.delete()
    }

    @Test func separateServicesDoNotShareSecrets() throws {
        let first = store(), second = store()
        defer { try? first.delete(); try? second.delete() }
        try first.write(Fixture.token)
        #expect(try second.read() == nil)
    }

    @Test func writeEnforcesThisDeviceOnlyAccessibilityOnAnExistingItem() throws {
        let store = store()
        defer { try? store.delete() }
        // An item left by an earlier build: readable, but backup-eligible (it can leave the device).
        let stale: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: store.service,
            kSecAttrAccount as String: store.account,
            kSecValueData as String: Data("stale".utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        #expect(SecItemAdd(stale as CFDictionary, nil) == errSecSuccess)

        try store.write(Fixture.token)

        #expect(try store.read() == Fixture.token)
        #expect(accessibility(of: store) == (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String))
    }

    private func accessibility(of store: KeychainSecretStore) -> String? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: store.service,
            kSecAttrAccount as String: store.account,
            kSecReturnAttributes as String: true,
        ]
        query[kSecAttrSynchronizable as String] = false
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return (item as? [String: Any])?[kSecAttrAccessible as String] as? String
    }
}
