import Foundation

protocol DeviceAPI: Sendable {
    func register(campusId: Int, label: String) async throws -> DeviceRegistration
    func status(token: String) async throws -> DeviceGrant
}

/// Redirects would carry the bearer header somewhere the contract never names, so none are followed.
private final class RefuseRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? { nil }
}

struct DeviceAPIClient: DeviceAPI {
    static let labelLimit = 80
    private static let tokenPrefix = "checkin_device_"

    static func isWellFormedToken(_ token: String) -> Bool {
        guard token.hasPrefix(tokenPrefix) else { return false }
        let secret = token.dropFirst(tokenPrefix.count)
        return secret.utf8.count == 43
            && secret.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x2D || $0 == 0x5F }
    }

    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession = DeviceAPIClient.makeSession()) throws {
        guard baseURL.scheme?.lowercased() == "https", baseURL.host?.isEmpty == false else {
            throw APIError.insecureBaseURL
        }
        self.baseURL = baseURL
        self.session = session
    }

    static func makeSession(protocolClasses: [AnyClass]? = nil) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        configuration.waitsForConnectivity = false
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        if let protocolClasses { configuration.protocolClasses = protocolClasses }
        return URLSession(configuration: configuration)
    }

    /// Trims and collapses whitespace like the server, then enforces 1-80 characters.
    static func normalizedLabel(_ raw: String) throws -> String {
        let collapsed = raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !collapsed.isEmpty else { throw APIError.invalidInput("Enter a name for this iPad.") }
        // UTF-16 length is the stricter of the plausible server counts.
        guard collapsed.utf16.count <= labelLimit else {
            throw APIError.invalidInput("Use \(labelLimit) characters or fewer for the name.")
        }
        return collapsed
    }

    func register(campusId: Int, label: String) async throws -> DeviceRegistration {
        guard campusId > 0 else { throw APIError.invalidInput("Enter a campus number.") }
        let body = RegisterRequest(campusId: campusId, label: try Self.normalizedLabel(label))
        var request = makeRequest(path: "device/register", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)

        let response: RegisterResponse = try await send(request, expecting: 201)
        guard response.apiVersion == 1,
              Self.isWellFormedToken(response.token),
              response.grant.status == .pending,
              response.grant.campusId == body.campusId
        else { throw APIError.invalidResponse }
        return DeviceRegistration(grant: response.grant, token: response.token)
    }

    func status(token: String) async throws -> DeviceGrant {
        var request = makeRequest(path: "device/status", method: "GET")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let response: StatusResponse = try await send(request, expecting: 200)
        guard response.apiVersion == 1 else { throw APIError.invalidResponse }
        return response.grant
    }

    // MARK: - Plumbing

    private func makeRequest(path: String, method: String) -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: "api/native/v1/\(path)"))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private func send<Response: Decodable>(_ request: URLRequest, expecting success: Int) async throws -> Response {
        let data: Data
        let urlResponse: URLResponse
        do {
            (data, urlResponse) = try await session.data(for: request, delegate: RefuseRedirects())
        } catch {
            throw APIError.transport
        }
        guard let http = urlResponse as? HTTPURLResponse else { throw APIError.invalidResponse }

        guard http.statusCode == success else {
            throw Self.error(status: http.statusCode, body: data)
        }
        do {
            return try Self.decoder.decode(Response.self, from: data)
        } catch {
            throw APIError.invalidResponse
        }
    }

    private static func error(status: Int, body: Data) -> APIError {
        let raw = (try? JSONDecoder().decode(ErrorEnvelope.self, from: body))?.error
        guard let raw, let code = APIErrorCode(rawValue: raw), status >= 400 else {
            return .unexpected(status: status, code: raw)
        }
        return .server(status: status, code: code)
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
            if let date = try? fractional.parse(raw) { return date }
            if let date = try? Date.ISO8601FormatStyle().parse(raw) { return date }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Invalid ISO 8601 date")
            )
        }
        return decoder
    }
}
