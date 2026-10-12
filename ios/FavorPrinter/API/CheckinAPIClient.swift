import Foundation

/// Authenticated check-in calls. Every method takes the bearer secret from the caller and sends
/// the campus the grant was approved for; the server decides what that campus may touch.
protocol CheckinAPI: Sendable {
    func definitions(token: String, campusId: Int) async throws -> [CheckinDefinition]
    func occurrences(token: String, campusId: Int, definitionName: String) async throws -> [CheckinOccurrence]
    func contacts(token: String, campusId: Int, definitionName: String, eventId: String, query: String) async throws -> [CheckinContact]
    func family(token: String, campusId: Int, definitionName: String, eventId: String, anchorAliasId: Int) async throws -> KidsFamilyResult
    func checkIn(token: String, _ request: CheckinRequest) async throws -> CheckinOutcome
    func familyCheckIn(token: String, _ request: FamilyCheckinRequest) async throws -> FamilyCheckinResult
    func printers(token: String, campusId: Int, definitionName: String, eventId: String) async throws -> [PairablePrinter]
    func enqueuePrint(token: String, _ request: PrintEnqueueRequest) async throws -> PrintEnqueueOutcome
    func printStatus(token: String, campusId: Int, definitionName: String, eventId: String, printerId: String, attendanceIds: [Int]) async throws -> PrintStatus
}

extension DeviceAPIClient: CheckinAPI {
    static let contactQueryRange = 2...100
    static let contactLimit = 20

    func definitions(token: String, campusId: Int) async throws -> [CheckinDefinition] {
        let response: DefinitionsResponse = try await get("checkin/definitions", token, [campus(campusId)])
        return response.definitions
    }

    func occurrences(token: String, campusId: Int, definitionName: String) async throws -> [CheckinOccurrence] {
        let response: OccurrencesResponse = try await get("checkin/occurrences", token, [campus(campusId), definition(definitionName)])
        return response.occurrences
    }

    func contacts(token: String, campusId: Int, definitionName: String, eventId: String, query: String) async throws -> [CheckinContact] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.contactQueryRange.contains(trimmed.count) else {
            throw APIError.invalidInput("Type at least 2 letters to search.")
        }
        let response: ContactsResponse = try await get(
            "checkin/contacts", token,
            [campus(campusId), definition(definitionName), .init(name: "eventId", value: eventId),
             .init(name: "query", value: trimmed), .init(name: "limit", value: String(Self.contactLimit))]
        )
        return response.contacts
    }

    func family(token: String, campusId: Int, definitionName: String, eventId: String, anchorAliasId: Int) async throws -> KidsFamilyResult {
        let response: ResultResponse<KidsFamilyResult> = try await get(
            "checkin/family", token,
            [campus(campusId), definition(definitionName), .init(name: "eventId", value: eventId),
             .init(name: "anchorAliasId", value: String(anchorAliasId))]
        )
        return response.result
    }

    func checkIn(token: String, _ request: CheckinRequest) async throws -> CheckinOutcome {
        let response: ResultResponse<CheckinOutcome> = try await post("checkin/check-in", token, request)
        return response.result
    }

    func familyCheckIn(token: String, _ request: FamilyCheckinRequest) async throws -> FamilyCheckinResult {
        let response: ResultResponse<FamilyCheckinResult> = try await post("checkin/family/check-in", token, request)
        return response.result
    }

    func printers(token: String, campusId: Int, definitionName: String, eventId: String) async throws -> [PairablePrinter] {
        let response: PrintersResponse = try await get(
            "checkin/printers", token,
            [campus(campusId), definition(definitionName), .init(name: "eventId", value: eventId)]
        )
        return response.printers
    }

    func enqueuePrint(token: String, _ request: PrintEnqueueRequest) async throws -> PrintEnqueueOutcome {
        let response: ResultResponse<PrintEnqueueOutcome> = try await post("checkin/print/enqueue", token, request)
        return response.result
    }

    func printStatus(token: String, campusId: Int, definitionName: String, eventId: String, printerId: String, attendanceIds: [Int]) async throws -> PrintStatus {
        let response: ResultResponse<PrintStatus> = try await get(
            "checkin/print/status", token,
            [campus(campusId), definition(definitionName), .init(name: "eventId", value: eventId),
             .init(name: "printerId", value: printerId),
             .init(name: "attendanceIds", value: attendanceIds.map(String.init).joined(separator: ","))]
        )
        return response.result
    }

    // MARK: - Plumbing

    private func campus(_ id: Int) -> URLQueryItem { .init(name: "campusId", value: String(id)) }
    private func definition(_ name: String) -> URLQueryItem { .init(name: "definitionName", value: name) }

    private func authorize(_ request: inout URLRequest, _ token: String) throws {
        // Never send a secret that is not in the documented shape: it could only be a bug.
        guard Self.isWellFormedToken(token) else { throw APIError.server(status: 401, code: .malformedToken) }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    private func get<Response: Versioned>(_ path: String, _ token: String, _ query: [URLQueryItem]) async throws -> Response {
        var request = makeRequest(path: path, method: "GET", query: query)
        try authorize(&request, token)
        let response: Response = try await send(request, expecting: 200)
        return try versioned(response)
    }

    private func post<Response: Versioned>(_ path: String, _ token: String, _ body: some Encodable) async throws -> Response {
        var request = makeRequest(path: path, method: "POST")
        try authorize(&request, token)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let response: Response = try await send(request, expecting: 200)
        return try versioned(response)
    }

    private func versioned<Response: Versioned>(_ response: Response) throws -> Response {
        guard response.apiVersion == 1 else { throw APIError.invalidResponse }
        return response
    }
}
