import Foundation

enum RelayFailure: Error, Sendable, Equatable {
    case auth
    case network
    case stale
    case insecureBaseURL
    case invalidResponse
    /// A claim was refused because an admin handed these printers to another host. Terminal for them: not a network error.
    case printerHandedOver([String])
}

/// What kind of host this is, sent with enroll and every heartbeat. Unknown values from the cloud decode to nil.
enum RelayHostKind: String, Codable, Sendable { case mac, ipad }

/// A heartbeat's lifecycle. Absent means active to the cloud.
enum RelayLifecycle: String, Codable, Sendable { case active, paused }

enum RelayEnrollReason: String, Codable, Sendable, CaseIterable {
    case targetNotFound = "target_not_found"
    case targetDisabled = "target_disabled"
    case campusMismatch = "campus_mismatch"
    case targetSerialMismatch = "target_serial_mismatch"
    case serialOtherCampus = "serial_other_campus"
    case serialDuplicateHasJobs = "serial_duplicate_has_jobs"
    case serialInUse = "serial_in_use"
    case printerNameTaken = "printer_name_taken"
    /// The printer's current host is live. An admin must confirm a handover and issue a new code.
    case hostActive = "host_active"
    case unknown
}

enum RelayEnrollFailure: Error, Sendable, Equatable {
    case printerConflict(RelayEnrollReason)
    case codeUsed
    case invalidRequest
    case codeExpired
    case invalidCode
    case throttled
    case disabled
    case network
}

struct RelayEnrollRequest: Encodable, Sendable, Equatable {
    let code: String
    let usbSerial: String
    let appVersion: String
    let osVersion: String
    var hostKind: RelayHostKind = .ipad
}

struct RelayPrinter: Codable, Sendable, Equatable {
    let id: String
    let name: String
    let usbSerial: String?
    let campusId: Int?
}

struct RelayCredentials: Decodable, Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    let relayId: String
    let token: String
    let label: String?
    let printer: RelayEnrolledPrinter?
    /// Set when this enrollment moved the printer off another host. Absent from an older cloud.
    let handedOverFrom: RelayHandedOverFrom?

    var description: String { "RelayCredentials(relayId: \(relayId), token: <redacted>)" }
    var debugDescription: String { description }
    var customMirror: Mirror { Mirror(self, children: ["relayId": relayId, "label": label as Any, "printer": printer as Any, "handedOverFrom": handedOverFrom as Any]) }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        relayId = try container.decode(String.self, forKey: .relayId)
        token = try container.decode(String.self, forKey: .token)
        label = (try? container.decode(String.self, forKey: .label))
            .flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        printer = try? container.decodeIfPresent(RelayEnrolledPrinter.self, forKey: .printer)
        handedOverFrom = try? container.decodeIfPresent(RelayHandedOverFrom.self, forKey: .handedOverFrom)
    }

    private enum Keys: String, CodingKey { case relayId, token, label, printer, handedOverFrom }
}

/// The host an enrollment took the printer from: its kind and label, never its id. Either may be absent or unknown.
struct RelayHandedOverFrom: Decodable, Sendable, Equatable {
    let hostKind: RelayHostKind?
    let label: String?

    init(hostKind: RelayHostKind?, label: String?) {
        self.hostKind = hostKind
        self.label = label
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        hostKind = (try? container.decodeIfPresent(String.self, forKey: .hostKind)).flatMap(RelayHostKind.init(rawValue:))
        label = (try? container.decodeIfPresent(String.self, forKey: .label))
            .flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    }

    private enum Keys: String, CodingKey { case hostKind, label }

    /// "Took over from Mac 'Front desk'", or a shorter form when the cloud sent less.
    var summary: String {
        let kind = hostKind.map { $0 == .mac ? "Mac" : "iPad" }
        switch (kind, label) {
        case let (kind?, label?): return "Took over from \(kind) '\(label)'"
        case (_?, nil): return "Took over from \(hostKind == .mac ? "a Mac" : "an iPad")"
        case let (nil, label?): return "Took over from '\(label)'"
        case (nil, nil): return "Took over from another host"
        }
    }
}

struct RelayEnrolledPrinter: Decodable, Sendable, Equatable {
    let id: String?
    let name: String
    let usbSerial: String?
    let campusId: Int?

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        name = try container.decode(String.self, forKey: .name)
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .name, in: container, debugDescription: "Invalid printer name")
        }
        id = try? container.decode(String.self, forKey: .id)
        usbSerial = try? container.decodeIfPresent(String.self, forKey: .usbSerial)
        campusId = try? container.decodeIfPresent(Int.self, forKey: .campusId)
    }

    private enum Keys: String, CodingKey { case id, name, usbSerial, campusId }
}

struct RelayJob: Decodable, Sendable, Equatable {
    let id: String
    let printerId: String
    let label: String
    let copy: Int
    let zpl: String
    let claimToken: String
    let leaseExpiresAt: String
    let attempt: Int
    let host: String
    let port: Int
}

struct RelayClaimResponse: Decodable, Sendable, Equatable {
    let jobs: [RelayJob]
    let rejectedPrinterIds: [String]
    /// The rejected ids an admin handed to another host. Absent from an older cloud.
    let handedOverPrinterIds: [String]

    init(jobs: [RelayJob], rejectedPrinterIds: [String], handedOverPrinterIds: [String] = []) {
        self.jobs = jobs
        self.rejectedPrinterIds = rejectedPrinterIds
        self.handedOverPrinterIds = handedOverPrinterIds
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        jobs = try container.decode([RelayJob].self, forKey: .jobs)
        rejectedPrinterIds = try container.decode([String].self, forKey: .rejectedPrinterIds)
        handedOverPrinterIds = (try? container.decodeIfPresent([String].self, forKey: .handedOverPrinterIds)) ?? []
    }

    private enum Keys: String, CodingKey { case jobs, rejectedPrinterIds, handedOverPrinterIds }
}

struct RelayProbe: Encodable, Sendable, Equatable {
    let printerId: String
    let reachable: Bool
    let checkedAt: String
    let error: String?
    let status: String?
}

struct RelayHeartbeatRequest: Encodable, Sendable, Equatable {
    let printerIds: [String]
    let relayVersion: String
    let spoolDepth: Int
    let probes: [RelayProbe]
    let appVersion: String?
    let osVersion: String?
    let printerAttached: Bool?
    var hostKind: RelayHostKind? = .ipad
    var lifecycle: RelayLifecycle? = .active
}

struct RelayHeartbeatResponse: Decodable, Sendable, Equatable {
    struct Printer: Decodable, Sendable, Equatable {
        let id: String
        let name: String
        let enabled: Bool
        let host: String
        let port: Int
    }
    let ok: Bool
    let serverTime: String
    let printers: [Printer]
}

struct RelayConfigResponse: Decodable, Sendable, Equatable {
    let apiVersion: Int
    let relayId: String
    let label: String
    let printerIds: [String]
    let printers: [RelayPrinter]
}

struct RelayTestPrintResponse: Decodable, Sendable, Equatable {
    let apiVersion: Int
    let testId: String
    let printerId: String
    let zpl: String
}

enum RelayRenameRequest: Encodable, Sendable, Equatable {
    case label(String)
    case printer(printerId: String, name: String)

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        switch self {
        case .label(let label): try container.encode(label, forKey: .label)
        case .printer(let printerId, let name):
            try container.encode(printerId, forKey: .printerId)
            try container.encode(name, forKey: .name)
        }
    }

    private enum Keys: String, CodingKey { case label, printerId, name }
}

struct RelayRenameResponse: Decodable, Sendable, Equatable {
    let apiVersion: Int
    let relayId: String
    let label: String?
    let printer: RelayPrinter?
}

enum RelayReportOutcome: String, Encodable, Sendable { case sent, failed, ambiguous }

private struct RelayErrorBody: Decodable {
    let error: String?
    let reason: String?
    let printerIds: [String]?
}

private struct RelayStatusBody: Decodable { let status: String }
private struct ClaimBody: Encodable { let printerIds: [String]; let limit: Int }
private struct PrinterIdBody: Encodable { let printerId: String }
private struct ClaimTokenBody: Encodable { let claimToken: String }
private struct ReportBody: Encodable {
    let claimToken: String
    let outcome: RelayReportOutcome
    let error: String?

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode(claimToken, forKey: .claimToken)
        try container.encode(outcome, forKey: .outcome)
        try container.encodeIfPresent(error, forKey: .error)
    }

    private enum Keys: String, CodingKey { case claimToken, outcome, error }
}

/// Swift client for the outbound cloud relay API. Requests never follow redirects.
struct RelayAPIClient: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    static let timeout: TimeInterval = 10

    private let baseURL: URL
    private let relayId: String
    private let token: String
    private let session: URLSession

    var description: String { "RelayAPIClient(baseURL: \(baseURL), relayId: \(relayId), token: <redacted>)" }
    var debugDescription: String { description }
    var customMirror: Mirror { Mirror(self, children: ["baseURL": baseURL, "relayId": relayId]) }

    init(baseURL: URL, relayId: String, token: String, session: URLSession = RelayAPIClient.makeSession()) throws {
        guard baseURL.scheme?.lowercased() == "https", baseURL.host?.isEmpty == false else {
            throw RelayFailure.insecureBaseURL
        }
        self.baseURL = baseURL
        self.relayId = relayId
        self.token = token
        self.session = session
    }

    static func makeSession(protocolClasses: [AnyClass]? = nil) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        configuration.waitsForConnectivity = false
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        if let protocolClasses { configuration.protocolClasses = protocolClasses }
        return URLSession(configuration: configuration)
    }

    static func enroll(
        baseURL: URL,
        request body: RelayEnrollRequest,
        session: URLSession = RelayAPIClient.makeSession()
    ) async throws -> RelayCredentials {
        guard baseURL.scheme?.lowercased() == "https", baseURL.host?.isEmpty == false else {
            throw RelayFailure.insecureBaseURL
        }
        var request = URLRequest(url: baseURL.appending(path: "api/printing/relay/enroll"), timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let data: Data
        let response: URLResponse
        do { (data, response) = try await perform(request, using: session) }
        catch { throw RelayEnrollFailure.network }
        guard let http = response as? HTTPURLResponse else { throw RelayEnrollFailure.network }
        if (200..<300).contains(http.statusCode) {
            do {
                let credentials = try JSONDecoder().decode(RelayCredentials.self, from: data)
                guard !credentials.relayId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      !credentials.token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw RelayFailure.invalidResponse
                }
                return credentials
            } catch { throw RelayEnrollFailure.network }
        }
        throw enrollmentFailure(status: http.statusCode, data: data)
    }

    func claim(printerIds: [String], limit: Int) async throws -> RelayClaimResponse {
        try await post("/claim", body: ClaimBody(printerIds: printerIds, limit: limit), as: RelayClaimResponse.self)
    }

    func heartbeat(_ body: RelayHeartbeatRequest) async throws -> RelayHeartbeatResponse {
        try await post("/heartbeat", body: body, as: RelayHeartbeatResponse.self)
    }

    func config() async throws -> RelayConfigResponse {
        try await post("/config", body: EmptyBody(), as: RelayConfigResponse.self)
    }

    func testPrint(printerId: String) async throws -> RelayTestPrintResponse {
        try await post("/test-print", body: PrinterIdBody(printerId: printerId), as: RelayTestPrintResponse.self)
    }

    func rename(_ body: RelayRenameRequest) async throws -> RelayRenameResponse {
        try await post("/rename", body: body, as: RelayRenameResponse.self)
    }

    func sending(jobId: String, claimToken: String) async throws -> RelayJobCallResult {
        try await jobCall("/jobs/\(jobId)/sending", body: ClaimTokenBody(claimToken: claimToken))
    }

    func report(jobId: String, claimToken: String, outcome: RelayReportOutcome, error: String? = nil) async throws -> RelayJobCallResult {
        try await jobCall("/jobs/\(jobId)/report", body: ReportBody(claimToken: claimToken, outcome: outcome, error: error))
    }

    private func jobCall(_ path: String, body: some Encodable) async throws -> RelayJobCallResult {
        do {
            let response = try await post(path, body: body, as: RelayStatusBody.self)
            return .ok(status: response.status)
        } catch RelayFailure.stale { return .stale }
    }

    private func post<Response: Decodable & Sendable>(_ path: String, body: some Encodable, as: Response.Type) async throws -> Response {
        var request = URLRequest(url: endpoint(path), timeoutInterval: Self.timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(relayId, forHTTPHeaderField: "x-relay-id")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await Self.perform(request, using: session)
        guard let http = response as? HTTPURLResponse else { throw RelayFailure.network }
        if http.statusCode == 401 { throw RelayFailure.auth }
        guard (200..<300).contains(http.statusCode) else {
            if path == "/claim", http.statusCode == 403,
               let body = try? JSONDecoder().decode(RelayErrorBody.self, from: data),
               body.error == "forbidden", body.reason == "printer_handed_over" {
                throw RelayFailure.printerHandedOver(body.printerIds ?? [])
            }
            if http.statusCode >= 500 { throw RelayFailure.network }
            if path.hasPrefix("/jobs/"), [403, 404, 409].contains(http.statusCode) { throw RelayFailure.stale }
            throw RelayFailure.network
        }
        do { return try JSONDecoder().decode(Response.self, from: data) }
        catch { throw RelayFailure.invalidResponse }
    }

    private func endpoint(_ path: String) -> URL { baseURL.appending(path: "api/printing/relay\(path)") }

    private static func perform(_ request: URLRequest, using session: URLSession) async throws -> (Data, URLResponse) {
        do { return try await session.data(for: request, delegate: RelayRefuseRedirects()) }
        catch { throw RelayFailure.network }
    }

    private static func enrollmentFailure(status: Int, data: Data) -> RelayEnrollFailure {
        let error = try? JSONDecoder().decode(RelayErrorBody.self, from: data)
        if status == 409 {
            if ["conflict", "code_used"].contains(error?.error), error?.reason == nil { return .codeUsed }
            return .printerConflict(error?.reason.flatMap(RelayEnrollReason.init(rawValue:)) ?? .unknown)
        }
        if status == 501 || error?.error == "enrollment_disabled" { return .disabled }
        if status == 429 { return .throttled }
        if status == 400 || status == 422 { return .invalidRequest }
        if status == 410 || ["code_expired", "expired"].contains(error?.error) { return .codeExpired }
        if [401, 403, 404].contains(status) || error?.error == "invalid_code" { return .invalidCode }
        return .network
    }
}

enum RelayJobCallResult: Sendable, Equatable {
    case ok(status: String)
    case stale
}

private struct EmptyBody: Encodable { }

private final class RelayRefuseRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? { nil }
}
