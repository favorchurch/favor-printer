import Foundation
import Testing
@testable import FavorPrinter

struct CheckinAPIClientTests {
    let token = Fixture.token

    func client(_ reply: @escaping @Sendable (URLRequest) -> MockURLProtocol.Reply) throws -> (DeviceAPIClient, MockServer) {
        let server = MockServer { reply($0) }
        return (try server.client(), server)
    }

    func queryItems(_ request: URLRequest) -> [String: String] {
        let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        return Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
    }

    // MARK: requests

    @Test func definitionsSendsBearerAndCampusOnly() async throws {
        let (client, server) = try client { _ in
            .json(200, #"{"apiVersion":1,"definitions":[{"definitionName":"grp-71","title":"Kids","campusId":1,"source":"group","sourceId":71}]}"#)
        }
        defer { withExtendedLifetime(server) {} }
        let definitions = try await client.definitions(token: token, campusId: 1)

        #expect(definitions.map(\.definitionName) == ["grp-71"])
        let request = try #require(server.requests.first)
        #expect(request.url?.path == "/api/native/v1/checkin/definitions")
        #expect(request.httpMethod == "GET")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
        #expect(queryItems(request) == ["campusId": "1"])
        #expect(!request.url!.absoluteString.contains(token))
    }

    @Test func contactsEncodesQueryAndRefusesShortOrLongSearch() async throws {
        let (client, server) = try client { _ in
            .json(200, #"{"apiVersion":1,"contacts":[{"contactId":"12310","personId":12309,"firstName":"Maria","lastName":"Santos","preferredName":null,"age":9,"gender":"Female","campusIds":["1"]}]}"#)
        }
        defer { withExtendedLifetime(server) {} }
        let contacts = try await client.contacts(token: token, campusId: 1, definitionName: "grp-71", eventId: "34886", query: "  María & Jo  ")

        #expect(contacts.first?.contactId == "12310")
        #expect(contacts.first?.displayName == "Maria Santos")
        let query = queryItems(try #require(server.requests.first))
        #expect(query["query"] == "María & Jo")
        #expect(query["limit"] == "20")
        #expect(query["eventId"] == "34886")
        #expect(query["definitionName"] == "grp-71")

        for bad in ["", " a ", String(repeating: "x", count: 101)] {
            await #expect(throws: APIError.self) {
                _ = try await client.contacts(token: token, campusId: 1, definitionName: "grp-71", eventId: "1", query: bad)
            }
        }
        #expect(server.requests.count == 1)
    }

    @Test func checkInPostsExactBodyAndReadsOutcome() async throws {
        let (client, server) = try client { _ in
            .json(200, #"{"apiVersion":1,"result":{"ok":true,"data":{"outcome":"checked-in","attendanceId":48191}}}"#)
        }
        defer { withExtendedLifetime(server) {} }
        let outcome = try await client.checkIn(
            token: token, CheckinRequest(campusId: 1, definitionName: "grp-71", eventId: "34886", contactId: "12310")
        )

        #expect(outcome == .checkedIn(attendanceId: 48191))
        let request = try #require(server.requests.first)
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let sentBody = try #require(request.httpBody)
        let body = try #require(try JSONSerialization.jsonObject(with: sentBody) as? [String: Any])
        #expect(Set(body.keys) == ["campusId", "definitionName", "eventId", "contactId"])
        #expect(body["eventId"] as? String == "34886")
    }

    @Test func checkInDomainRefusalIsAFailedOutcomeNotSuccess() async throws {
        let (client, server) = try client { _ in
            .json(200, #"{"apiVersion":1,"result":{"ok":false,"code":"business","message":"Already checked in."}}"#)
        }
        defer { withExtendedLifetime(server) {} }
        let outcome = try await client.checkIn(
            token: token, CheckinRequest(campusId: 1, definitionName: "grp-71", eventId: "1", contactId: "2")
        )
        #expect(outcome == .failed(code: "business", message: "Already checked in."))
    }

    @Test func familyDecodesFoundAndNotFound() async throws {
        let found = #"{"apiVersion":1,"result":{"found":true,"siblings":[{"eligible":true,"personId":1,"personAliasId":12310,"displayName":"Maria S.","age":9,"checkedIn":false,"role":"Child"},{"eligible":false,"displayName":"Tito","age":null,"checkedIn":false}],"choices":[{"phoneNumberId":5,"adultPersonId":9,"label":"Ana","maskedPhone":"•••1234"}],"selectedChoiceId":null,"remember":false,"remembered":null}}"#
        let (client, server) = try client { request in
            request.url!.query!.contains("anchorAliasId=1") ? .json(200, found) : .json(200, #"{"apiVersion":1,"result":{"found":false}}"#)
        }
        defer { withExtendedLifetime(server) {} }
        guard case .found(let family) = try await client.family(token: token, campusId: 1, definitionName: "g", eventId: "1", anchorAliasId: 1)
        else { Issue.record("expected a family"); return }
        #expect(family.siblings.compactMap(\.selectableAliasId) == [12310])
        #expect(family.choices.first?.maskedPhone == "•••1234")
        let none = try await client.family(token: token, campusId: 1, definitionName: "g", eventId: "1", anchorAliasId: 2)
        #expect(none == .notFound)
    }

    @Test func familyCheckInDecodesPartialSuccessAndPrintOutcomes() async throws {
        let body = #"{"apiVersion":1,"result":{"children":[{"childAliasId":1,"status":"checked-in","attendanceId":9,"targets":[{"eventId":"1","ok":true,"attendanceId":9}]},{"childAliasId":2,"status":"failed","attendanceId":null,"targets":[{"eventId":"1","ok":false,"message":"Not eligible"}]}],"printAttendanceIds":[9],"pickup":{"saved":false},"print":{"status":"not-queued","code":"printer_not_found","retry":true,"message":"Printer missing"}}}"#
        let (client, server) = try client { _ in .json(200, body) }
        defer { withExtendedLifetime(server) {} }
        let result = try await client.familyCheckIn(token: token, FamilyCheckinRequest(
            campusId: 1, definitionName: "grp-71", eventId: "1", anchorAliasId: 1, targetEventIds: ["1"], childAliasIds: [1, 2],
            pickup: .init(choiceId: 5, remember: true), print: .init(actionId: "a", printerId: nil)
        ))

        #expect(result.children.map(\.status) == [.checkedIn, .failed])
        #expect(result.children[1].targets.first?.message == "Not eligible")
        #expect(result.print == .notQueued(code: "printer_not_found", retry: true, message: "Printer missing"))
        let sentBody = try #require(server.requests.first?.httpBody)
        let sent = try #require(try JSONSerialization.jsonObject(with: sentBody) as? [String: Any])
        #expect((sent["pickup"] as? [String: Any])?["choiceId"] as? Int == 5)
        #expect((sent["print"] as? [String: Any])?["actionId"] as? String == "a")
        #expect(sent["campusId"] as? Int == 1)
    }

    @Test func printersEnqueueAndStatusRoundTrip() async throws {
        let (client, server) = try client { request in
            switch request.url!.path {
            case "/api/native/v1/checkin/printers":
                .json(200, #"{"apiVersion":1,"printers":[{"id":"p1","name":"Kids desk","laptopLabel":null,"campusId":1,"campusLabel":"MNL","health":"status_unknown"}]}"#)
            case "/api/native/v1/checkin/print/enqueue":
                .json(200, #"{"apiVersion":1,"result":{"ok":true,"created":true,"jobIds":["j1"],"refused":[{"attendanceId":3,"code":"not_attended"}]}}"#)
            default:
                .json(200, #"{"apiVersion":1,"result":{"state":"enrolled","chip":{"tone":"ok","text":"Ready"},"printer":{"id":"p1","name":"Kids desk"},"printerName":null,"jobs":[{"id":"j1","actionId":"a","status":"sent","reviewReason":null,"copy":1,"reprintOf":null,"kind":"child","printerId":"p1","lastError":null,"createdAt":"2026-10-12T09:00:00.000Z","sentAt":null,"canReprint":true}]}}"#)
            }
        }
        defer { withExtendedLifetime(server) {} }
        let printers = try await client.printers(token: token, campusId: 1, definitionName: "g", eventId: "1")
        #expect(printers.first?.health == .statusUnknown)

        let outcome = try await client.enqueuePrint(token: token, PrintEnqueueRequest(
            campusId: 1, definitionName: "g", eventId: "1", actionId: "a", attendanceIds: [3, 4], printerId: "p1"
        ))
        #expect(outcome == .queued(created: true, jobIds: ["j1"], refused: [PrintRefusal(attendanceId: 3, code: "not_attended")]))

        let status = try await client.printStatus(token: token, campusId: 1, definitionName: "g", eventId: "1", printerId: "p1", attendanceIds: [3, 4])
        #expect(status.isSettled)
        guard case .enrolled(_, let name, let jobs) = status else { Issue.record("expected enrolled"); return }
        #expect(name == "Kids desk")
        #expect(jobs.first?.status == "sent")
        let statusQuery = queryItems(try #require(server.requests.last))
        #expect(statusQuery["attendanceIds"] == "3,4")
        #expect(statusQuery["printerId"] == "p1")
    }

    @Test func pendingPrintJobKeepsStatusUnsettled() {
        let job = PrintJob(id: "1", status: "queued", reviewReason: nil, kind: "child", lastError: nil, canReprint: false)
        #expect(!PrintStatus.enrolled(chip: .init(tone: "info", text: "Queued"), printerName: "P", jobs: [job]).isSettled)
        #expect(!PrintStatus.enrolled(chip: .init(tone: "info", text: "Queued"), printerName: "P", jobs: []).isSettled)
        #expect(PrintStatus.off.isSettled)
    }

    // MARK: contract errors

    @Test(arguments: [
        (403, "wrong_campus", APIErrorCode.wrongCampus),
        (403, "definition_forbidden", .definitionForbidden),
        (403, "occurrence_forbidden", .occurrenceForbidden),
        (403, "printer_forbidden", .printerForbidden),
        (403, "device_revoked", .deviceRevoked),
        (403, "device_pending", .devicePending),
        (401, "unknown_device", .unknownDevice),
        (429, "throttled", .throttled),
        (503, "unavailable", .unavailable),
    ])
    func contractErrorsSurfaceAsTypedErrorsWithDistinctMessages(status: Int, raw: String, code: APIErrorCode) async throws {
        let (client, server) = try client { _ in .error(status, raw) }
        defer { withExtendedLifetime(server) {} }
        await #expect(throws: APIError.server(status: status, code: code)) {
            _ = try await client.definitions(token: token, campusId: 1)
        }
        #expect(!APIError.server(status: status, code: code).message.isEmpty)
    }

    @Test func crossCampusDisabledDefinitionAndRevokedHaveDifferentClearMessages() {
        let wrongCampus = APIError.server(status: 403, code: .wrongCampus).message
        let disabled = APIError.server(status: 403, code: .definitionForbidden).message
        let revoked = APIError.server(status: 403, code: .deviceRevoked).message
        #expect(wrongCampus.contains("own campus"))
        #expect(disabled.contains("turned off") && disabled.contains("another campus"))
        #expect(revoked.contains("Register it again"))
        #expect(Set([wrongCampus, disabled, revoked]).count == 3)
    }

    @Test func malformedTokenIsNeverSent() async throws {
        let (client, server) = try client { _ in .json(200, #"{"apiVersion":1,"definitions":[]}"#) }
        defer { withExtendedLifetime(server) {} }
        await #expect(throws: APIError.server(status: 401, code: .malformedToken)) {
            _ = try await client.definitions(token: "not a token", campusId: 1)
        }
        #expect(server.requests.isEmpty)
    }

    @Test func wrongApiVersionAndBadBodyAreInvalidResponses() async throws {
        let (v2, s2) = try client { _ in .json(200, #"{"apiVersion":2,"definitions":[]}"#) }
        defer { withExtendedLifetime(s2) {} }
        await #expect(throws: APIError.invalidResponse) { _ = try await v2.definitions(token: token, campusId: 1) }
        let (bad, s3) = try client { _ in .json(200, #"{"apiVersion":1,"definitions":[{"title":1}]}"#) }
        defer { withExtendedLifetime(s3) {} }
        await #expect(throws: APIError.invalidResponse) { _ = try await bad.definitions(token: token, campusId: 1) }
    }
}
