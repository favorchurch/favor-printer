import Foundation
import Testing
@testable import FavorPrinter

struct AppConfigTests {
    @Test func readsHTTPSBaseURL() throws {
        let config = try AppConfig(info: ["RSVPBaseURL": " https://rsvp.favor.church "])
        #expect(config.rsvpBaseURL.absoluteString == "https://rsvp.favor.church")
    }

    @Test func rejectsMissingAndInsecureValues() {
        #expect(throws: AppConfig.Failure.missing) { try AppConfig(info: nil) }
        #expect(throws: AppConfig.Failure.missing) { try AppConfig(info: ["RSVPBaseURL": ""]) }
        #expect(throws: AppConfig.Failure.insecure) { try AppConfig(info: ["RSVPBaseURL": "http://rsvp.favor.church"]) }
        #expect(throws: AppConfig.Failure.insecure) { try AppConfig(info: ["RSVPBaseURL": "https://"]) }
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
}
