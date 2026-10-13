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
        MockURLProtocol.register(host: host) { [unowned self] request in
            lock.withLock { log.append(request) }
            return try handler(request)
        }
    }

    deinit { MockURLProtocol.unregister(host: host) }

    func client() throws -> DeviceAPIClient {
        try DeviceAPIClient(baseURL: baseURL, session: DeviceAPIClient.makeSession(protocolClasses: [MockURLProtocol.self]))
    }
}

extension MockURLProtocol.Reply {
    static func json(_ status: Int, _ json: String) -> Self {
        .init(status: status, body: Data(json.utf8), headers: ["Content-Type": "application/json", "Cache-Control": "no-store"])
    }

    static func error(_ status: Int, _ code: String) -> Self { .json(status, #"{"error":"\#(code)"}"#) }
}

enum Fixture {
    static let token = "checkin_device_" + String(repeating: "a", count: 43)
    static let id = "3c026625-4597-4787-a36c-871f1d052ab6"

    static func grant(status: String = "pending", campusId: Int = 1, label: String = "Manila Kids iPad 2") -> String {
        let approved = status == "pending" ? "null" : #""2026-10-12T09:03:00.000Z""#
        let revoked = status == "revoked" ? #""2026-10-12T10:00:00.000Z""# : "null"
        return #"{"id":"\#(id)","campusId":\#(campusId),"label":"\#(label)","status":"\#(status)","createdAt":"2026-10-12T09:00:00.000Z","approvedAt":\#(approved),"revokedAt":\#(revoked)}"#
    }

    static func registered(campusId: Int = 1, token: String = Fixture.token) -> String {
        #"{"apiVersion":1,"grant":\#(grant(campusId: campusId)),"token":"\#(token)"}"#
    }

    static func statusBody(_ status: String, apiVersion: Int = 1) -> String {
        #"{"apiVersion":\#(apiVersion),"grant":\#(grant(status: status))}"#
    }

    static func deviceGrant(_ status: DeviceStatus = .pending) -> DeviceGrant {
        DeviceGrant(
            id: id, campusId: 1, label: "Manila Kids iPad 2", status: status,
            createdAt: Date(timeIntervalSince1970: 1_790_000_000),
            approvedAt: status == .pending ? nil : Date(timeIntervalSince1970: 1_790_000_100),
            revokedAt: status == .revoked ? Date(timeIntervalSince1970: 1_790_000_200) : nil
        )
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

final class InMemoryRecordStore: DeviceRecordStore, @unchecked Sendable {
    private let lock = NSLock()
    private var record: DeviceRecord?

    init(_ record: DeviceRecord? = nil) { self.record = record }

    func load() -> DeviceRecord? { lock.withLock { record } }
    func save(_ record: DeviceRecord) { lock.withLock { self.record = record } }
    func clear() { lock.withLock { record = nil } }
}

actor FakeDeviceAPI: DeviceAPI {
    var registerResult: Result<DeviceRegistration, APIError> = .failure(.transport)
    var statusResult: Result<DeviceGrant, APIError> = .failure(.transport)
    private(set) var statusTokens: [String] = []
    /// Runs inside `status` before it answers, to hold a request in flight.
    var statusGate: (@Sendable () async -> Void)?

    func setRegister(_ result: Result<DeviceRegistration, APIError>) { registerResult = result }
    func setGate(_ gate: (@Sendable () async -> Void)?) { statusGate = gate }
    func setStatus(_ result: Result<DeviceGrant, APIError>) { statusResult = result }

    func register(campusId: Int, label: String) async throws -> DeviceRegistration {
        try registerResult.get()
    }

    func status(token: String) async throws -> DeviceGrant {
        statusTokens.append(token)
        if let statusGate { await statusGate() }
        return try statusResult.get()
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
