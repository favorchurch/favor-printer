import Foundation
import Testing
@testable import FavorPrinter

struct DeviceAPIClientTests {
    // MARK: register

    @Test func registerPostsContractBodyWithoutCredential() async throws {
        let server = MockServer { _ in .json(201, Fixture.registered()) }
        let registration = try await server.client().register(campusId: 1, label: "  Manila   Kids\tiPad 2 ")

        let request = try #require(server.requests.first)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/api/native/v1/device/register")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        let body = try #require(request.httpBody)
        let object = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(object["campusId"] as? Int == 1)
        #expect(object["label"] as? String == "Manila Kids iPad 2")
        #expect(object.count == 2)

        #expect(registration.token == Fixture.token)
        #expect(registration.grant.status == .pending)
        #expect(registration.grant.id == Fixture.id)
        #expect(registration.grant.approvedAt == nil)
        #expect(registration.grant.revokedAt == nil)
    }

    @Test func registerParsesFractionalAndWholeSecondTimestamps() async throws {
        let whole = Fixture.registered().replacingOccurrences(of: "2026-10-12T09:00:00.000Z", with: "2026-10-12T09:00:00Z")
        let server = MockServer { _ in .json(201, whole) }
        let registration = try await server.client().register(campusId: 1, label: "iPad")
        #expect(registration.grant.createdAt == Date(timeIntervalSince1970: 1_791_795_600))
    }

    @Test func registerRejectsBadInputWithoutRequest() async throws {
        let server = MockServer { _ in .json(201, Fixture.registered()) }
        let client = try server.client()
        for (campus, label) in [(1, "   "), (1, ""), (1, String(repeating: "x", count: 81)), (0, "iPad"), (-3, "iPad")] {
            await #expect(throws: APIError.self) { try await client.register(campusId: campus, label: label) }
        }
        #expect(server.requests.isEmpty)
    }

    @Test func registerAccepts80CharacterLabel() async throws {
        let server = MockServer { _ in .json(201, Fixture.registered()) }
        _ = try await server.client().register(campusId: 1, label: String(repeating: "x", count: 80))
        #expect(server.requests.count == 1)
    }

    @Test(arguments: [(400, "bad_request", APIErrorCode.badRequest), (429, "throttled", .throttled), (503, "unavailable", .unavailable)])
    func registerMapsErrors(status: Int, raw: String, code: APIErrorCode) async throws {
        let server = MockServer { _ in .error(status, raw) }
        await #expect(throws: APIError.server(status: status, code: code)) {
            try await server.client().register(campusId: 1, label: "iPad")
        }
    }

    @Test func registerRejectsMalformedSuccess() async throws {
        let cases = [
            Fixture.registered(token: "checkin_device_short"),
            Fixture.registered(token: "device_" + String(repeating: "a", count: 43)),
            Fixture.registered(token: Fixture.token + "x"),
            Fixture.registered(campusId: 2),
            Fixture.registered().replacingOccurrences(of: #""apiVersion":1"#, with: #""apiVersion":2"#),
            #"{"apiVersion":1,"grant":\#(Fixture.grant(status: "approved")),"token":"\#(Fixture.token)"}"#,
            #"{"apiVersion":1,"grant":\#(Fixture.grant())}"#,
            "not json",
        ]
        for body in cases {
            let server = MockServer { _ in .json(201, body) }
            await #expect(throws: APIError.invalidResponse) { try await server.client().register(campusId: 1, label: "iPad") }
        }
    }

    @Test func registerRequiresStatus201() async throws {
        let server = MockServer { _ in .json(200, Fixture.registered()) }
        await #expect(throws: APIError.unexpected(status: 200, code: nil)) {
            try await server.client().register(campusId: 1, label: "iPad")
        }
    }

    // MARK: status

    @Test(arguments: ["pending", "approved", "revoked"])
    func statusReturnsEachKnownState(raw: String) async throws {
        let server = MockServer { _ in .json(200, Fixture.statusBody(raw)) }
        let grant = try await server.client().status(token: Fixture.token)

        let request = try #require(server.requests.first)
        #expect(request.httpMethod == "GET")
        #expect(request.url?.path == "/api/native/v1/device/status")
        #expect(request.url?.query == nil)
        #expect(request.httpBody == nil)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(Fixture.token)")
        #expect(grant.status.rawValue == raw)
        #expect(grant.campusId == 1)
        #expect((grant.revokedAt != nil) == (raw == "revoked"))
        #expect((grant.approvedAt != nil) == (raw != "pending"))
    }

    @Test func statusAllowsRevokedGrantThatWasNeverApproved() async throws {
        let body = Fixture.statusBody("revoked").replacingOccurrences(of: #""approvedAt":"2026-10-12T09:03:00.000Z""#, with: #""approvedAt":null"#)
        let server = MockServer { _ in .json(200, body) }
        let grant = try await server.client().status(token: Fixture.token)
        #expect(grant.status == .revoked)
        #expect(grant.approvedAt == nil)
    }

    /// Every row of the contract's error table, as the status endpoint can see them.
    @Test(arguments: [
        (401, "missing_token", APIErrorCode.missingToken),
        (401, "malformed_token", .malformedToken),
        (401, "unknown_device", .unknownDevice),
        (403, "device_pending", .devicePending),
        (403, "device_revoked", .deviceRevoked),
        (403, "wrong_campus", .wrongCampus),
        (403, "definition_forbidden", .definitionForbidden),
        (403, "occurrence_forbidden", .occurrenceForbidden),
        (403, "printer_forbidden", .printerForbidden),
        (429, "throttled", .throttled),
        (503, "unavailable", .unavailable),
        (400, "bad_request", .badRequest),
    ])
    func statusMapsEveryContractError(status: Int, raw: String, code: APIErrorCode) async throws {
        let server = MockServer { _ in .error(status, raw) }
        await #expect(throws: APIError.server(status: status, code: code)) {
            try await server.client().status(token: Fixture.token)
        }
    }

    @Test func errorTableCoversEveryCode() {
        // Keeps the arguments above honest: adding a code to the enum needs a row there.
        #expect(APIErrorCode.allCases.count == 12)
    }

    @Test func statusRejectsWrongApiVersionAndGarbage() async throws {
        for body in [Fixture.statusBody("approved", apiVersion: 2), "{}", "[]", "", #"{"apiVersion":1,"grant":{"id":"x"}}"#] {
            let server = MockServer { _ in .json(200, body) }
            await #expect(throws: APIError.invalidResponse) { try await server.client().status(token: Fixture.token) }
        }
    }

    @Test func unknownCodesAndBodiesBecomeUnexpected() async throws {
        let cases: [(MockURLProtocol.Reply, APIError)] = [
            (.error(401, "teapot"), .unexpected(status: 401, code: "teapot")),
            (.json(500, "<html>boom</html>"), .unexpected(status: 500, code: nil)),
            (.json(405, #"{"error":"method_not_allowed"}"#), .unexpected(status: 405, code: "method_not_allowed")),
        ]
        for (reply, expected) in cases {
            let server = MockServer { _ in reply }
            await #expect(throws: expected) { try await server.client().status(token: Fixture.token) }
        }
    }

    @Test func redirectsAreNotFollowedAndDoNotLeakTheCredential() async throws {
        let other = MockServer { _ in .json(200, Fixture.statusBody("approved")) }
        let origin = MockServer { _ in
            .init(status: 302, body: Data(), headers: ["Location": "https://\(other.host)/api/native/v1/device/status"])
        }
        await #expect(throws: APIError.unexpected(status: 302, code: nil)) {
            try await origin.client().status(token: Fixture.token)
        }
        #expect(other.requests.isEmpty)
    }

    @Test func transportFailureIsReported() async throws {
        let server = MockServer { _ in throw URLError(.notConnectedToInternet) }
        await #expect(throws: APIError.transport) { try await server.client().status(token: Fixture.token) }
    }

    // MARK: setup and messages

    @Test func clientRequiresHTTPS() {
        #expect(throws: APIError.insecureBaseURL) { try DeviceAPIClient(baseURL: URL(string: "http://rsvp.favor.church")!) }
        #expect(throws: APIError.insecureBaseURL) { try DeviceAPIClient(baseURL: URL(string: "https://")!) }
    }

    @Test func baseURLWithPathPrefixKeepsIt() async throws {
        let server = MockServer { _ in .json(200, Fixture.statusBody("pending")) }
        let client = try DeviceAPIClient(
            baseURL: server.baseURL.appending(path: "preview"),
            session: DeviceAPIClient.makeSession(protocolClasses: [MockURLProtocol.self])
        )
        _ = try await client.status(token: Fixture.token)
        #expect(server.requests.first?.url?.path == "/preview/api/native/v1/device/status")
    }

    @Test func messagesNeverEchoServerText() {
        let hostile = APIError.unexpected(status: 500, code: "secret-token-123")
        #expect(!hostile.message.contains("secret"))
        for code in APIErrorCode.allCases {
            #expect(!APIError.server(status: 400, code: code).message.isEmpty)
        }
    }

    @Test func onlyUnauthorizedAndRevokedInvalidateTheCredential() {
        for code in APIErrorCode.allCases {
            #expect(APIError.server(status: 401, code: code).invalidatesCredential)
            let expected = code == .deviceRevoked
            #expect(APIError.server(status: 403, code: code).invalidatesCredential == expected)
        }
        #expect(APIError.unexpected(status: 401, code: nil).invalidatesCredential)
        for error: APIError in [.transport, .invalidResponse, .server(status: 429, code: .throttled), .server(status: 503, code: .unavailable), .unexpected(status: 500, code: nil)] {
            #expect(!error.invalidatesCredential)
        }
    }
}
