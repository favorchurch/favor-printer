import Foundation
import Security
import Testing
@testable import FavorPrinter

struct AppConfigTests {
    @Test func readsHTTPSBaseURL() throws {
        let config = try AppConfig(info: ["RSVPBaseURL": " https://rsvp.favor.church "])
        #expect(config.rsvpBaseURL.absoluteString == "https://rsvp.favor.church")
    }

    @Test func trimsNewlinesAsWellAsWhitespaceFromTheConfiguredURL() throws {
        let config = try AppConfig(info: ["RSVPBaseURL": "\n https://rsvp.favor.church \n"], build: .release)
        #expect(config.rsvpBaseURL.absoluteString == "https://rsvp.favor.church")
        let preview = try AppConfig(info: ["RSVPBaseURL": "\n\thttps://rsvp-preview.favor.church\t\n"], build: .debug)
        #expect(preview.rsvpBaseURL.absoluteString == "https://rsvp-preview.favor.church")
    }

    @Test func aNewlineOnlyValueIsEmptyAndDebugFallsBackToThePreviewHost() throws {
        let config = try AppConfig(info: ["RSVPBaseURL": "\n \n"], build: .debug)
        #expect(config.rsvpBaseURL.absoluteString == "https://rsvp-preview.favor.church")
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

struct KeychainHostCredentialStoreTests {
    private let token = "relay-secret-a"

    private func store() -> KeychainHostCredentialStore {
        KeychainHostCredentialStore(service: "church.favor.printer.tests.\(UUID().uuidString)", account: "bearer")
    }

    @Test func writeReadOverwriteDelete() throws {
        let store = store()
        defer { try? store.delete() }
        #expect(try store.read() == nil)
        try store.write(token)
        #expect(try store.read() == token)
        try store.write("relay-secret-b")
        #expect(try store.read() == "relay-secret-b")
        try store.delete()
        #expect(try store.read() == nil)
        try store.delete()
    }

    @Test func separateServicesDoNotShareSecrets() throws {
        let first = store(), second = store()
        defer { try? first.delete(); try? second.delete() }
        try first.write(token)
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

        try store.write(token)

        #expect(try store.read() == token)
        #expect(accessibility(of: store) == (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String))
    }

    private func accessibility(of store: KeychainHostCredentialStore) -> String? {
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
