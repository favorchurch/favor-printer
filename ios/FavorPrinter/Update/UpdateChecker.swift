import Foundation
import Observation

/// Fetches the update metadata. It sends a bare GET: no credential, cookie, relay id or body, and nothing about this
/// iPad or its people.
enum UpdateMetadataFetcher {
    static let timeout: TimeInterval = 15

    static func makeSession(protocolClasses: [AnyClass]? = nil) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        configuration.waitsForConnectivity = false
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        if let protocolClasses { configuration.protocolClasses = protocolClasses }
        return URLSession(configuration: configuration)
    }

    static func fetch(_ url: URL, session: URLSession = makeSession()) async -> UpdateCheck.FetchResult {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else { return .networkFailure }
            var body = Data()
            // One byte past the cap is enough for the model to refuse it, without reading an unbounded body.
            for try await byte in bytes {
                body.append(byte)
                if body.count > UpdateCheck.maxBodyBytes { break }
            }
            return .reply(status: http.statusCode, body: body)
        } catch {
            return .networkFailure
        }
    }
}

/// Runs the update check for the Host screen. It is separate from the host loop: it never touches the spool, the relay
/// or the printer, and a failure leaves the screen as it was, with no update prompt.
@MainActor @Observable
final class UpdateChecker {
    typealias Fetch = @Sendable (URL) async -> UpdateCheck.FetchResult

    let installed: InstalledBuild
    private(set) var prompt: UpdatePrompt?

    @ObservationIgnored private let distribution: DistributionKind
    @ObservationIgnored private let expectedBundleID: String
    @ObservationIgnored private let metadataURL: URL?
    @ObservationIgnored private let fetch: Fetch
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var policy = UpdateCheckPolicy()
    @ObservationIgnored private var isChecking = false

    init(
        installed: InstalledBuild,
        distribution: DistributionKind,
        expectedBundleID: String,
        metadataURL: URL?,
        fetch: @escaping Fetch = { await UpdateMetadataFetcher.fetch($0) },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.installed = installed
        self.distribution = distribution
        self.expectedBundleID = expectedBundleID
        self.metadataURL = metadataURL
        self.fetch = fetch
        self.now = now
    }

    static func live(config: AppConfig, bundle: Bundle = .main) -> UpdateChecker {
        UpdateChecker(
            installed: .current(bundle: bundle),
            distribution: .current(bundle: bundle),
            expectedBundleID: bundle.bundleIdentifier ?? "",
            metadataURL: config.updateMetadataURL
        )
    }

    private var isEnabled: Bool { metadataURL != nil && distribution.channel != nil }

    /// Checks when the schedule allows it. Concurrent calls collapse into one request.
    func checkIfDue(_ trigger: UpdateCheckPolicy.Trigger) async {
        guard isEnabled, let metadataURL, !isChecking, policy.isDue(trigger, now: now()) else { return }
        isChecking = true
        defer { isChecking = false }
        let fetched = await fetch(metadataURL)
        // Leaving the foreground cancels the request. That is not a server failure, so it neither backs off nor clears.
        guard !Task.isCancelled else { return }
        let outcome = UpdateCheck.evaluate(
            installed: installed,
            distribution: distribution,
            expectedBundleID: expectedBundleID,
            trustedInstallHost: metadataURL.host,
            fetched: fetched
        )
        policy.record(failed: outcome.isFailure, at: now())
        prompt = outcome.prompt
    }

    /// Checks on entering the foreground, then again every 6 hours until cancelled (the screen leaves the foreground).
    func runWhileForeground() async {
        guard isEnabled else { return }
        await checkIfDue(.foreground)
        while !Task.isCancelled {
            let wait = max(60, policy.nextDue(.periodic).timeIntervalSince(now()))
            do { try await Task.sleep(for: .seconds(wait)) } catch { return }
            await checkIfDue(.periodic)
        }
    }
}
