import Foundation
import Security
@testable import FavorPrinter

/// Routes requests by host so each test owns an isolated handler and tests can run in parallel.
final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    struct Reply {
        var status: Int
        var body: Data
        var headers: [String: String] = [:]
    }

    typealias Handler = @Sendable (URLRequest) throws -> Reply

    private static let lock = NSLock()
    nonisolated(unsafe) private static var handlers: [String: Handler] = [:]

    static func register(host: String, handler: @escaping Handler) {
        lock.withLock { handlers[host] = handler }
    }

    static func unregister(host: String) {
        lock.withLock { handlers[host] = nil }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let handler = request.url?.host.flatMap { host in Self.lock.withLock { Self.handlers[host] } }
        guard let handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        do {
            let reply = try handler(Self.withBody(request))
            let response = HTTPURLResponse(
                url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: reply.body)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    /// URLSession hands protocols a body stream; materialize it so handlers can assert on bytes.
    private static func withBody(_ request: URLRequest) -> URLRequest {
        guard request.httpBody == nil, let stream = request.httpBodyStream else { return request }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        var copy = request
        copy.httpBody = data
        return copy
    }
}

/// A client wired to a mock host, plus the request log.
final class MockServer: @unchecked Sendable {
    let host = "t\(UUID().uuidString.prefix(8).lowercased()).test"
    private let lock = NSLock()
    private var log: [URLRequest] = []

    var baseURL: URL { URL(string: "https://\(host)")! }
    var requests: [URLRequest] { lock.withLock { log } }

    init(_ handler: @escaping @Sendable (URLRequest) throws -> MockURLProtocol.Reply) {
        MockURLProtocol.register(host: host) { [weak self] request in
            self?.lock.withLock { self?.log.append(request) }
            return try handler(request)
        }
    }

    deinit { MockURLProtocol.unregister(host: host) }

    func relayClient(relayId: String = "relay-test", token: String = "relay-token") throws -> RelayAPIClient {
        try RelayAPIClient(
            baseURL: baseURL, relayId: relayId, token: token,
            session: RelayAPIClient.makeSession(protocolClasses: [MockURLProtocol.self])
        )
    }
}

extension MockURLProtocol.Reply {
    static func json(_ status: Int, _ json: String) -> Self {
        .init(status: status, body: Data(json.utf8), headers: ["Content-Type": "application/json", "Cache-Control": "no-store"])
    }

    static func error(_ status: Int, _ code: String) -> Self { .json(status, #"{"error":"\#(code)"}"#) }
    static func error(_ status: Int, _ code: String, reason: String) -> Self {
        .json(status, #"{"error":"\#(code)","reason":"\#(reason)"}"#)
    }
}

final class InMemorySecretStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    var failWrites = false
    var failDeletes = false

    init(_ value: String? = nil) { self.value = value }

    var current: String? { lock.withLock { value } }

    func read() throws -> String? { current }

    func write(_ secret: String) throws {
        if failWrites { throw KeychainError(status: -25299) }
        lock.withLock { value = secret }
    }

    func delete() throws {
        if failDeletes { throw KeychainError(status: -25300) }
        lock.withLock { value = nil }
    }
}

/// Wraps a secret store so a test can make reads fail like a locked iPad's keychain
/// (errSecInteractionNotAllowed) while the stored value stays where it is.
final class UnreadableSecretStore: SecretStore, @unchecked Sendable {
    private let inner: any SecretStore
    private let lock = NSLock()
    private var blocked = false

    init(_ inner: any SecretStore) { self.inner = inner }

    var failReads: Bool {
        get { lock.withLock { blocked } }
        set { lock.withLock { blocked = newValue } }
    }

    func read() throws -> String? {
        if lock.withLock({ blocked }) { throw KeychainError(status: errSecInteractionNotAllowed) }
        return try inner.read()
    }

    func write(_ secret: String) throws { try inner.write(secret) }
    func delete() throws { try inner.delete() }
}
