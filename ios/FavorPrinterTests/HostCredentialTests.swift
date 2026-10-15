import Foundation
import Testing
@testable import FavorPrinter

struct HostCredentialTests {
    @Test func theHostCredentialLivesUnderTheRelayService() {
        #expect(KeychainHostCredentialStore().service == "church.favor.printer.relay")
        #expect(KeychainHostCredentialStore().service != StaleDeviceBearer.service)
    }
}

struct StaleDeviceBearerTests {
    private func defaults() -> UserDefaults {
        UserDefaults(suiteName: "church.favor.printer.tests.\(UUID().uuidString)")!
    }

    @Test func deletesAnOlderBuildsBearerAndItsRecordOnce() throws {
        let defaults = defaults()
        defaults.set(Data("record".utf8), forKey: StaleDeviceBearer.recordKey)
        let store = InMemorySecretStore("old-device-bearer")

        #expect(StaleDeviceBearer.deleteOnce(in: store, defaults: defaults))
        #expect(store.current == nil)
        #expect(defaults.data(forKey: StaleDeviceBearer.recordKey) == nil)

        // Done: a later launch does not touch the store again.
        try store.write("written-later")
        #expect(StaleDeviceBearer.deleteOnce(in: store, defaults: defaults))
        #expect(store.current == "written-later")
    }

    @Test func aKeychainThatWillNotDeleteIsRetriedOnTheNextLaunch() {
        let defaults = defaults()
        let store = InMemorySecretStore("old-device-bearer")
        store.failDeletes = true
        #expect(StaleDeviceBearer.deleteOnce(in: store, defaults: defaults) == false)
        #expect(store.current == "old-device-bearer")

        store.failDeletes = false
        #expect(StaleDeviceBearer.deleteOnce(in: store, defaults: defaults))
        #expect(store.current == nil)
    }

    @Test func neverReadsTheItem() {
        let store = InMemorySecretStore("old-device-bearer")
        let unreadable = UnreadableSecretStore(store)
        unreadable.failReads = true
        #expect(StaleDeviceBearer.deleteOnce(in: unreadable, defaults: defaults()))
        #expect(store.current == nil)
    }

    @Test func deletesTheRealKeychainItemAndLeavesTheRelayCredential() throws {
        let service = "church.favor.printer.tests.\(UUID().uuidString)"
        let stale = KeychainHostCredentialStore(service: service + ".device", account: "bearer")
        let host = KeychainHostCredentialStore(service: service + ".relay", account: "bearer")
        defer { try? stale.delete(); try? host.delete() }
        try stale.write("old-device-bearer")
        try host.write("host-secret")

        #expect(StaleDeviceBearer.deleteOnce(in: stale, defaults: defaults()))
        #expect(try stale.read() == nil)
        #expect(try host.read() == "host-secret")
    }
}
