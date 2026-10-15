import Foundation
import Testing
@testable import FavorPrinter

struct HostCredentialTests {
    @Test func checkinAndHostCredentialsUseIndependentKeychainItems() throws {
        #expect(KeychainSecretStore().service == "church.favor.printer.device")
        #expect(KeychainHostCredentialStore().service == "church.favor.printer.relay")
        let service = "church.favor.printer.tests.\(UUID().uuidString)"
        let checkin = KeychainSecretStore(service: service + ".checkin", account: "bearer")
        let host = KeychainHostCredentialStore(service: service + ".host", account: "bearer")
        defer { try? checkin.delete(); try? host.delete() }
        try checkin.write("checkin-secret")
        try host.write("host-secret")
        #expect(try checkin.read() == "checkin-secret")
        #expect(try host.read() == "host-secret")

        try host.write("rotated-host-secret")
        #expect(try checkin.read() == "checkin-secret")
        try checkin.delete()
        #expect(try host.read() == "rotated-host-secret")
        try checkin.write("new-checkin-secret")
        try host.delete()
        #expect(try checkin.read() == "new-checkin-secret")
        #expect(try host.read() == nil)
    }
}
