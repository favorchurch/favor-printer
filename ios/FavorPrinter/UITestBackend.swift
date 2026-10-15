#if DEBUG
import Foundation

/// An in-process stand-in for the relay, used only by the XCUITest target (Debug builds, launched
/// with `-FavorUITestMock`). It never touches the network, the Keychain or UserDefaults.
enum UITestHarness {
    static let flag = "-FavorUITestMock"
    /// The host's printer is attached but the driver extension is not running.
    static let driverOffFlag = "-FavorUITestDriverOff"
    /// The one enrollment code the mocked relay refuses, with a 409 printer conflict.
    static let conflictCode = "CONFLICT"

    static var isActive: Bool { ProcessInfo.processInfo.arguments.contains(flag) }
}

extension UITestHarness {
    /// A host that never reaches the network or the Keychain. With `-FavorHostFakeRelay` it runs on `FakeRelay`, and the
    /// printer is the fake one only with `-FavorHostFakeTransport` too. Otherwise it starts not enrolled, and the mocked enroll call accepts any code except `conflictCode`.
    @MainActor static func makeHost() -> HostController? {
        let arguments = ProcessInfo.processInfo.arguments
        let transport = FakeUsbTransport(
            status: arguments.contains(driverOffFlag)
                ? UsbPrinterStatus(driver: .printerPresentDriverNotRunning, printerAttached: true)
                : FakeUsbTransport.readyStatus
        )
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "ui-test-host-\(UUID().uuidString)", directoryHint: .isDirectory)
        guard let baseURL = URL(string: "https://relay.invalid") else { return nil }
        if arguments.contains(HostRelayMode.fakeRelayArgument) {
            // The printer comes from the arguments too: tests pass `-FavorHostFakeTransport` for a fake one.
            return try? HostController.make(arguments: arguments, baseURL: baseURL, spoolDirectory: directory)
        }
        guard let spool = try? HostSpool(directory: directory) else { return nil }
        let relay = FakeRelay()
        return HostController(
            backend: .real(
                credentials: SecretHostCredentialStore(secrets: MockSecretStore(nil)),
                makeRelay: { _ in relay },
                enroll: { request in
                    if request.code == conflictCode { throw RelayEnrollFailure.printerConflict(.serialInUse) }
                    return try JSONDecoder().decode(
                        RelayCredentials.self,
                        from: Data(#"{"relayId":"ui-relay","token":"ui-token","printer":{"id":"fake-printer-1","name":"Kids desk"}}"#.utf8)
                    )
                }
            ),
            transport: transport, spool: spool
        )
    }
}

final class MockSecretStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    init(_ value: String?) { self.value = value }
    func read() throws -> String? { lock.withLock { value } }
    func write(_ secret: String) throws { lock.withLock { value = secret } }
    func delete() throws { lock.withLock { value = nil } }
}
#endif
