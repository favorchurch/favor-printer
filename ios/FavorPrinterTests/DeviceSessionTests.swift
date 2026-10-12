import Foundation
import Testing
@testable import FavorPrinter

@MainActor
struct DeviceSessionTests {
    let api = FakeDeviceAPI()
    let secrets = InMemorySecretStore()
    let records = InMemoryRecordStore()

    func session() -> DeviceSession { DeviceSession(api: api, secrets: secrets, records: records) }

    func registered(_ session: DeviceSession) async {
        await api.setRegister(.success(DeviceRegistration(grant: Fixture.deviceGrant(.pending), token: Fixture.token)))
        await session.register(campusId: 1, label: "Manila Kids iPad 2")
    }

    // MARK: registration

    @Test func registrationStoresSecretOnlyInSecretStoreAndShowsPending() async {
        let session = session()
        await registered(session)

        #expect(session.state == .pending(Fixture.deviceGrant(.pending)))
        #expect(secrets.current == Fixture.token)
        let saved = try? JSONEncoder().encode(records.load())
        #expect(saved != nil)
        #expect(!String(decoding: saved ?? Data(), as: UTF8.self).contains(Fixture.token))
    }

    @Test func registrationFailureKeepsStateAndShowsMessage() async {
        let session = session()
        await session.start()
        await api.setRegister(.failure(.server(status: 429, code: .throttled)))
        await session.register(campusId: 1, label: "iPad")

        #expect(session.state == .unregistered)
        #expect(session.notice == APIError.server(status: 429, code: .throttled).message)
        #expect(secrets.current == nil)
    }

    @Test func registrationWithKeychainWriteFailureDoesNotAdvance() async {
        secrets.failWrites = true
        let session = session()
        await session.start()
        await registered(session)

        #expect(session.state == .unregistered)
        #expect(session.notice != nil)
        #expect(records.load() == nil)
    }

    // MARK: status transitions

    @Test func pendingBecomesApproved() async {
        let session = session()
        await registered(session)
        await api.setStatus(.success(Fixture.deviceGrant(.approved)))
        await session.refresh()

        #expect(session.state == .approved(Fixture.deviceGrant(.approved)))
        #expect(secrets.current == Fixture.token)
        #expect(await api.statusTokens == [Fixture.token])
    }

    @Test func revokedStatusWipesSecretAndPersistsRevoked() async {
        let session = session()
        await registered(session)
        await api.setStatus(.success(Fixture.deviceGrant(.revoked)))
        await session.refresh()

        #expect(session.state == .revoked(label: "Manila Kids iPad 2"))
        #expect(secrets.current == nil)
        #expect(records.load()?.revoked == true)
    }

    @Test(arguments: [
        APIError.server(status: 401, code: .missingToken),
        .server(status: 401, code: .malformedToken),
        .server(status: 401, code: .unknownDevice),
        .server(status: 403, code: .deviceRevoked),
        .unexpected(status: 401, code: nil),
    ])
    func unauthorizedOrRevokedResponseWipesSecret(error: APIError) async {
        let session = session()
        await registered(session)
        await api.setStatus(.failure(error))
        await session.refresh()

        #expect(session.state == .revoked(label: "Manila Kids iPad 2"))
        #expect(secrets.current == nil)
        #expect(records.load()?.revoked == true)
    }

    @Test(arguments: [
        APIError.server(status: 429, code: .throttled),
        .server(status: 503, code: .unavailable),
        .server(status: 400, code: .badRequest),
        .transport,
        .invalidResponse,
        .unexpected(status: 500, code: nil),
    ])
    func transientFailureKeepsSecretAndState(error: APIError) async {
        let session = session()
        await registered(session)
        await api.setStatus(.failure(error))
        await session.refresh()

        #expect(session.state == .pending(Fixture.deviceGrant(.pending)))
        #expect(secrets.current == Fixture.token)
        #expect(session.notice == error.message)
    }

    @Test func devicePendingErrorFromAnyCallReturnsToPending() async {
        let session = session()
        await registered(session)
        await api.setStatus(.success(Fixture.deviceGrant(.approved)))
        await session.refresh()
        session.report(APIError.server(status: 403, code: .devicePending))

        #expect(session.state == .pending(Fixture.deviceGrant(.approved)))
        #expect(secrets.current == Fixture.token)
    }

    @Test func reportingUnauthorizedFromACheckInCallRevokes() async {
        let session = session()
        await registered(session)
        session.report(APIError.server(status: 401, code: .unknownDevice))

        #expect(session.state == .revoked(label: "Manila Kids iPad 2"))
        #expect(secrets.current == nil)
    }

    @Test func missingSecretWhileRegisteredReturnsToRevoked() async {
        let session = session()
        await registered(session)
        try? secrets.delete()
        await session.refresh()

        #expect(session.state == .revoked(label: nil))
        #expect(await api.statusTokens.isEmpty)
    }

    // MARK: launch and restart

    @Test func launchWithoutSecretIsUnregistered() async {
        records.save(DeviceRecord(grant: Fixture.deviceGrant(.approved), revoked: false))
        let session = session()
        await session.start()

        #expect(session.state == .unregistered)
        #expect(records.load() == nil)
    }

    @Test func launchWithSecretChecksTheServer() async {
        secrets.failWrites = false
        try? secrets.write(Fixture.token)
        records.save(DeviceRecord(grant: Fixture.deviceGrant(.pending), revoked: false))
        await api.setStatus(.success(Fixture.deviceGrant(.approved)))
        let session = session()
        await session.start()

        #expect(session.state == .approved(Fixture.deviceGrant(.approved)))
        #expect(await api.statusTokens == [Fixture.token])
    }

    @Test func launchWithRevokedRecordWipesLingeringSecretWithoutNetwork() async {
        try? secrets.write(Fixture.token)
        records.save(DeviceRecord(grant: Fixture.deviceGrant(.approved), revoked: true))
        let session = session()
        await session.start()

        #expect(session.state == .revoked(label: "Manila Kids iPad 2"))
        #expect(secrets.current == nil)
        #expect(await api.statusTokens.isEmpty)
    }

    @Test func failedWipeIsRetriedOnNextLaunch() async {
        let session = session()
        await registered(session)
        secrets.failDeletes = true
        await api.setStatus(.failure(.server(status: 401, code: .unknownDevice)))
        await session.refresh()
        #expect(session.state == .revoked(label: "Manila Kids iPad 2"))
        #expect(secrets.current == Fixture.token)

        secrets.failDeletes = false
        let relaunched = DeviceSession(api: api, secrets: secrets, records: records)
        await relaunched.start()
        #expect(relaunched.state == .revoked(label: "Manila Kids iPad 2"))
        #expect(secrets.current == nil)
    }

    @Test func registerAgainClearsRevokedState() async {
        let session = session()
        await registered(session)
        session.report(APIError.server(status: 403, code: .deviceRevoked))
        session.registerAgain()

        #expect(session.state == .unregistered)
        #expect(records.load() == nil)
        #expect(secrets.current == nil)
    }

    // MARK: client and session together

    @Test func realClientUnauthorizedResponseWipesKeychainSecret() async throws {
        let server = MockServer { request in
            request.url?.path.hasSuffix("register") == true ? .json(201, Fixture.registered()) : .error(401, "unknown_device")
        }
        let keychain = KeychainSecretStore(service: "church.favor.printer.tests.\(UUID().uuidString)", account: "bearer")
        defer { try? keychain.delete() }
        let session = DeviceSession(api: try server.client(), secrets: keychain, records: records)

        await session.register(campusId: 1, label: "Manila Kids iPad 2")
        #expect(try keychain.read() == Fixture.token)
        await session.refresh()

        #expect(session.state == .revoked(label: "Manila Kids iPad 2"))
        #expect(try keychain.read() == nil)
        let status = try #require(server.requests.last)
        #expect(status.value(forHTTPHeaderField: "Authorization") == "Bearer \(Fixture.token)")
    }
}
