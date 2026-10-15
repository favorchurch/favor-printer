import Foundation
import Testing
@testable import FavorPrinter

struct RelayClientTests {
    @Test func authenticatedCallsUseRelayWireContractAndTenSecondTimeout() async throws {
        let server = MockServer { request in
            switch request.url?.path {
            case "/api/printing/relay/claim": .json(200, #"{"jobs":[],"rejectedPrinterIds":[]}"#)
            case "/api/printing/relay/heartbeat": .json(200, #"{"ok":true,"serverTime":"now","printers":[]}"#)
            case "/api/printing/relay/config": .json(200, #"{"apiVersion":1,"relayId":"relay-test","label":"Desk","printerIds":[],"printers":[]}"#)
            case "/api/printing/relay/test-print": .json(200, #"{"apiVersion":1,"testId":"t1","printerId":"p1","zpl":"^XA^XZ"}"#)
            case "/api/printing/relay/rename": .json(200, #"{"apiVersion":1,"relayId":"relay-test","label":"New desk"}"#)
            case "/api/printing/relay/jobs/j1/sending", "/api/printing/relay/jobs/j1/report": .json(200, #"{"status":"sent"}"#)
            default: .json(404, "{}")
            }
        }
        let client = try server.relayClient(relayId: "relay-test", token: "secret-relay-token")
        _ = try await client.claim(printerIds: ["p1"], limit: 3)
        _ = try await client.heartbeat(.init(
            printerIds: ["p1"], relayVersion: "1.2.3", spoolDepth: 0,
            probes: [.init(printerId: "p1", reachable: true, checkedAt: "now", error: nil, status: nil)],
            appVersion: "1.2.3", osVersion: "iPadOS 18", printerAttached: true
        ))
        _ = try await client.config()
        _ = try await client.testPrint(printerId: "p1")
        _ = try await client.rename(.label("New desk"))
        _ = try await client.rename(.printer(printerId: "p1", name: "Kids printer"))
        #expect(try await client.sending(jobId: "j1", claimToken: "claim") == .ok(status: "sent"))
        #expect(try await client.report(jobId: "j1", claimToken: "claim", outcome: .sent) == .ok(status: "sent"))

        #expect(server.requests.count == 8)
        for request in server.requests {
            #expect(request.httpMethod == "POST")
            #expect(request.url?.scheme == "https")
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer secret-relay-token")
            #expect(request.value(forHTTPHeaderField: "x-relay-id") == "relay-test")
            #expect(request.timeoutInterval == 10)
        }
        let claim = try #require(server.requests.first { $0.url?.path.hasSuffix("/claim") == true })
        let claimData = try #require(claim.httpBody)
        let claimBody = try #require(JSONSerialization.jsonObject(with: claimData) as? [String: Any])
        #expect(claimBody["printerIds"] as? [String] == ["p1"])
        #expect(claimBody["limit"] as? Int == 3)
        let heartbeat = try #require(server.requests.first { $0.url?.path.hasSuffix("/heartbeat") == true })
        let heartbeatBody = try #require(JSONSerialization.jsonObject(with: try requestBodyData(heartbeat)) as? [String: Any])
        #expect(heartbeatBody["printerIds"] as? [String] == ["p1"])
        #expect(heartbeatBody["relayVersion"] as? String == "1.2.3")
        #expect(heartbeatBody["spoolDepth"] as? Int == 0)
        #expect(heartbeatBody["appVersion"] as? String == "1.2.3")
        #expect(heartbeatBody["osVersion"] as? String == "iPadOS 18")
        #expect(heartbeatBody["printerAttached"] as? Bool == true)
        let probe = try #require((heartbeatBody["probes"] as? [[String: Any]])?.first)
        #expect(probe["printerId"] as? String == "p1")
        #expect(probe["reachable"] as? Bool == true)
        #expect(probe["checkedAt"] as? String == "now")
        let testPrint = try #require(server.requests.first { $0.url?.path.hasSuffix("/test-print") == true })
        let testPrintBody = try #require(JSONSerialization.jsonObject(with: try requestBodyData(testPrint)) as? [String: String])
        #expect(testPrintBody == ["printerId": "p1"])
        let renameRequests = server.requests.filter { $0.url?.path.hasSuffix("/rename") == true }
        #expect(renameRequests.count == 2)
        #expect(try JSONSerialization.jsonObject(with: try requestBodyData(renameRequests[0])) as? [String: String] == ["label": "New desk"])
        #expect(try JSONSerialization.jsonObject(with: try requestBodyData(renameRequests[1])) as? [String: String] == ["printerId": "p1", "name": "Kids printer"])
        let sending = try #require(server.requests.first { $0.url?.path.hasSuffix("/sending") == true })
        #expect(try JSONSerialization.jsonObject(with: try requestBodyData(sending)) as? [String: String] == ["claimToken": "claim"])
        let report = try #require(server.requests.first { $0.url?.path.hasSuffix("/report") == true })
        let reportData = try #require(report.httpBody)
        let reportBody = try #require(JSONSerialization.jsonObject(with: reportData) as? [String: Any])
        #expect(reportBody["claimToken"] as? String == "claim")
        #expect(reportBody["outcome"] as? String == "sent")
        #expect(reportBody["error"] == nil)
    }

    @Test func enrollSendsOnlyTheOneTimeCredentialWithoutBearer() async throws {
        let server = MockServer { _ in
            .json(200, #"{"relayId":"r1","token":"returned-secret","label":"Desk","printer":{"id":"p1","name":"Kids","usbSerial":"serial-1","campusId":2}}"#)
        }
        let credentials = try await RelayAPIClient.enroll(
            baseURL: server.baseURL,
            request: .init(code: "123456", usbSerial: "serial-1", appVersion: "1.0", osVersion: "iPadOS 18"),
            session: RelayAPIClient.makeSession(protocolClasses: [MockURLProtocol.self])
        )
        #expect(credentials.relayId == "r1")
        #expect(credentials.token == "returned-secret")
        #expect(!String(describing: credentials).contains("returned-secret"))
        #expect(!String(reflecting: credentials).contains("returned-secret"))
        let request = try #require(server.requests.first)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/api/printing/relay/enroll")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(request.value(forHTTPHeaderField: "x-relay-id") == nil)
        #expect(request.timeoutInterval == 10)
        let bodyData = try #require(request.httpBody)
        let body = try #require(JSONSerialization.jsonObject(with: bodyData) as? [String: String])
        #expect(body == ["code": "123456", "usbSerial": "serial-1", "appVersion": "1.0", "osVersion": "iPadOS 18"])
    }

    @Test func enrollIgnoresMalformedOptionalLabelAndPrinterMetadata() async throws {
        let server = MockServer { _ in .json(200, #"{"relayId":"r1","token":"returned-secret","label":42,"printer":{}}"#) }
        let credentials = try await RelayAPIClient.enroll(
            baseURL: server.baseURL,
            request: .init(code: "123456", usbSerial: "serial-1", appVersion: "1.0", osVersion: "iPadOS 18"),
            session: RelayAPIClient.makeSession(protocolClasses: [MockURLProtocol.self])
        )
        #expect(credentials.label == nil)
        #expect(credentials.printer == nil)
    }

    @Test(arguments: RelayEnrollReason.allCases.filter { $0 != .unknown })
    func enrollPreservesPrinterConflictReason(reason: RelayEnrollReason) async throws {
        let server = MockServer { _ in .error(409, "printer_conflict", reason: reason.rawValue) }
        await #expect(throws: RelayEnrollFailure.printerConflict(reason)) {
            try await RelayAPIClient.enroll(
                baseURL: server.baseURL,
                request: .init(code: "123456", usbSerial: "serial", appVersion: "1", osVersion: "iPadOS"),
                session: RelayAPIClient.makeSession(protocolClasses: [MockURLProtocol.self])
            )
        }
    }

    @Test func enrollMapsUnknownConflictAndStatusFailuresLikeCloudService() async throws {
        let cases: [(MockURLProtocol.Reply, RelayEnrollFailure)] = [
            (.error(409, "printer_conflict", reason: "future_reason"), .printerConflict(.unknown)),
            (.error(409, "conflict"), .codeUsed),
            (.error(400, "bad_request"), .invalidRequest),
            (.error(410, "code_expired"), .codeExpired),
            (.error(404, "not_found"), .invalidCode),
            (.error(429, "throttled"), .throttled),
            (.error(501, "disabled"), .disabled),
            (.error(503, "unavailable"), .network),
        ]
        for (reply, expected) in cases {
            let server = MockServer { _ in reply }
            await #expect(throws: expected) {
                try await RelayAPIClient.enroll(
                    baseURL: server.baseURL,
                    request: .init(code: "123456", usbSerial: "serial", appVersion: "1", osVersion: "iPadOS"),
                    session: RelayAPIClient.makeSession(protocolClasses: [MockURLProtocol.self])
                )
            }
        }
    }

    @Test(arguments: [401, 500, 502, 503])
    func relayCallsClassifyAuthAndServerFailures(status: Int) async throws {
        let server = MockServer { _ in .json(status, "{}") }
        let expected: RelayFailure = status == 401 ? .auth : .network
        await #expect(throws: expected) { try await server.relayClient().config() }
    }

    @Test func transportFailuresAreNetworkErrorsForRelayAndEnrollment() async throws {
        let relay = MockServer { _ in throw URLError(.notConnectedToInternet) }
        await #expect(throws: RelayFailure.network) { try await relay.relayClient().config() }
        let enrollment = MockServer { _ in throw URLError(.notConnectedToInternet) }
        await #expect(throws: RelayEnrollFailure.network) {
            try await RelayAPIClient.enroll(
                baseURL: enrollment.baseURL,
                request: .init(code: "123456", usbSerial: "serial", appVersion: "1", osVersion: "iPadOS"),
                session: RelayAPIClient.makeSession(protocolClasses: [MockURLProtocol.self])
            )
        }
    }

    @Test(arguments: [403, 404, 409])
    func sendingAndReportTreatGoneClaimsAsStale(status: Int) async throws {
        let server = MockServer { _ in .json(status, "{}") }
        let client = try server.relayClient()
        #expect(try await client.sending(jobId: "j1", claimToken: "claim") == .stale)
        #expect(try await client.report(jobId: "j1", claimToken: "claim", outcome: .failed) == .stale)
    }

    @Test func redirectsAreNotFollowed() async throws {
        let other = MockServer { _ in .json(200, #"{"apiVersion":1,"relayId":"r","label":"x","printerIds":[],"printers":[]}"#) }
        let origin = MockServer { _ in
            .init(status: 302, body: Data(), headers: ["Location": "https://\(other.host)/api/printing/relay/config"])
        }
        await #expect(throws: RelayFailure.network) { try await origin.relayClient().config() }
        #expect(other.requests.isEmpty)
    }

    @Test func clientRequiresHTTPSAndErrorsDoNotContainCredentials() {
        #expect(throws: RelayFailure.insecureBaseURL) {
            try RelayAPIClient(baseURL: URL(string: "http://relay.example")!, relayId: "id", token: "secret")
        }
        #expect(!String(describing: RelayFailure.auth).contains("secret"))
        let client = try! RelayAPIClient(baseURL: URL(string: "https://relay.example")!, relayId: "r1", token: "secret")
        #expect(!String(describing: client).contains("secret"))
        #expect(!String(reflecting: client).contains("secret"))
    }
}

private func requestBodyData(_ request: URLRequest) throws -> Data {
    try #require(request.httpBody)
}
