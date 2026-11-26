import Foundation

/// How this copy of the app reached the iPad. Only OTA and TestFlight installs are ever offered an update, each through
/// its own channel: an OTA install link would replace a TestFlight build with one TestFlight does not manage.
enum DistributionKind: Sendable, Equatable {
    case ota
    case testFlight
    case development
    case unknown

    /// The metadata channel that applies to this kind. Development and unknown builds have none, so they never prompt.
    var channel: String? {
        switch self {
        case .ota: "ota"
        case .testFlight: "testflight"
        case .development, .unknown: nil
        }
    }

    /// TestFlight installs carry a `sandboxReceipt` and no embedded provisioning profile. An OTA (development-signed)
    /// install carries a profile. Anything else, such as the simulator or an App Store install, is unknown.
    static func classify(isDebugBuild: Bool, receiptName: String?, hasEmbeddedProfile: Bool) -> DistributionKind {
        if isDebugBuild { return .development }
        if receiptName == "sandboxReceipt" { return .testFlight }
        if hasEmbeddedProfile { return .ota }
        return .unknown
    }

    static func current(bundle: Bundle = .main) -> DistributionKind {
        #if DEBUG
        let isDebugBuild = true
        #else
        let isDebugBuild = false
        #endif
        return classify(
            isDebugBuild: isDebugBuild,
            receiptName: bundle.appStoreReceiptURL?.lastPathComponent,
            hasEmbeddedProfile: bundle.url(forResource: "embedded", withExtension: "mobileprovision") != nil
        )
    }
}

/// The version and build number this app was built with.
struct InstalledBuild: Sendable, Equatable {
    let version: String
    let build: String

    var buildNumber: Int? { UpdateCheck.parseBuild(build) }
    var summary: String { "\(version) (\(build))" }

    static func current(bundle: Bundle = .main) -> InstalledBuild {
        InstalledBuild(
            version: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown",
            build: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "Unknown"
        )
    }
}

/// What the Host screen does when the person taps the update button.
enum UpdateAction: Sendable, Equatable {
    /// An `itms-services` link to the OTA install manifest.
    case install(URL)
    /// Opens the TestFlight app, which owns updates for TestFlight builds.
    case openTestFlight

    var url: URL {
        switch self {
        case .install(let url): url
        case .openTestFlight: UpdateCheck.testFlightURL
        }
    }

    var buttonTitle: String {
        switch self {
        case .install: "Install update"
        case .openTestFlight: "Open TestFlight"
        }
    }
}

struct UpdatePrompt: Sendable, Equatable {
    let version: String
    let build: Int
    let action: UpdateAction

    var summary: String { "\(version) (\(build))" }
}

/// Decides whether to offer an update. Pure: it reads nothing but its arguments, and every doubt means no prompt.
enum UpdateCheck {
    static let supportedSchema = 1
    static let maxBodyBytes = 64 * 1024
    static let testFlightURL = URL(string: "itms-beta://")!

    enum FetchResult: Sendable, Equatable {
        case reply(status: Int, body: Data)
        case networkFailure
    }

    /// A reason no update is offered although the metadata was read normally.
    enum Skip: Sendable, Equatable {
        case notApplicable, installedBuildUnreadable, upToDate, notReleased
        case wrongBundle, wrongChannel, missingInstallURL, badInstallURL
    }

    /// The metadata could not be fetched or understood. These are the outcomes that back the schedule off.
    enum Failure: Sendable, Equatable {
        case network
        case httpStatus(Int)
        case tooLarge
        case malformed
        case unknownSchema
    }

    enum Outcome: Sendable, Equatable {
        case prompt(UpdatePrompt)
        case noPrompt(Skip)
        case failed(Failure)

        var prompt: UpdatePrompt? {
            if case .prompt(let prompt) = self { prompt } else { nil }
        }

        var isFailure: Bool {
            if case .failed = self { true } else { false }
        }
    }

    /// The published metadata, schema 1. `build` may be a JSON string or integer. `installURL` matters for OTA only.
    private struct Envelope: Decodable { let schemaVersion: Int }

    private struct Metadata: Decodable {
        let bundleId: String
        let channel: String
        let version: String
        let build: String
        let released: Bool
        let installURL: String?

        private enum Keys: String, CodingKey { case bundleId, channel, version, build, released, installURL }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: Keys.self)
            bundleId = try container.decode(String.self, forKey: .bundleId)
            channel = try container.decode(String.self, forKey: .channel)
            version = try container.decode(String.self, forKey: .version)
            if let text = try? container.decode(String.self, forKey: .build) {
                build = text
            } else {
                build = String(try container.decode(Int.self, forKey: .build))
            }
            released = try container.decode(Bool.self, forKey: .released)
            installURL = try container.decodeIfPresent(String.self, forKey: .installURL)
        }
    }

    static func evaluate(
        installed: InstalledBuild,
        distribution: DistributionKind,
        expectedBundleID: String,
        trustedInstallHost: String?,
        fetched: FetchResult
    ) -> Outcome {
        guard let channel = distribution.channel else { return .noPrompt(.notApplicable) }
        guard let installedBuild = installed.buildNumber else { return .noPrompt(.installedBuildUnreadable) }
        let body: Data
        switch fetched {
        case .networkFailure: return .failed(.network)
        case .reply(let status, _) where status != 200: return .failed(.httpStatus(status))
        case .reply(_, let data): body = data
        }
        guard body.count <= maxBodyBytes else { return .failed(.tooLarge) }
        let decoder = JSONDecoder()
        guard let envelope = try? decoder.decode(Envelope.self, from: body) else { return .failed(.malformed) }
        guard envelope.schemaVersion == supportedSchema else { return .failed(.unknownSchema) }
        guard let metadata = try? decoder.decode(Metadata.self, from: body),
              let latestBuild = parseBuild(metadata.build),
              isDisplayableVersion(metadata.version)
        else { return .failed(.malformed) }

        guard metadata.bundleId == expectedBundleID else { return .noPrompt(.wrongBundle) }
        guard metadata.channel == channel else { return .noPrompt(.wrongChannel) }
        guard metadata.released else { return .noPrompt(.notReleased) }
        guard latestBuild > installedBuild else { return .noPrompt(.upToDate) }

        let action: UpdateAction
        switch distribution {
        case .testFlight:
            action = .openTestFlight
        default:
            guard let raw = metadata.installURL, !raw.isEmpty else { return .noPrompt(.missingInstallURL) }
            guard let url = otaInstallURL(raw, trustedHost: trustedInstallHost) else { return .noPrompt(.badInstallURL) }
            action = .install(url)
        }
        return .prompt(UpdatePrompt(version: metadata.version, build: latestBuild, action: action))
    }

    /// Digits only, so "10" outranks "9" and "1.2" or "-3" are unreadable rather than guessed.
    static func parseBuild(_ text: String) -> Int? {
        guard !text.isEmpty, text.count <= 9, text.allSatisfy(\.isASCII), text.allSatisfy(\.isNumber) else { return nil }
        return Int(text)
    }

    private static func isDisplayableVersion(_ version: String) -> Bool {
        guard !version.isEmpty, version.count <= 32 else { return false }
        return version.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || ".-+".contains($0)) }
    }

    /// `itms-services://?action=download-manifest&url=https://<trusted host>/...` and nothing else.
    static func otaInstallURL(_ raw: String, trustedHost: String?) -> URL? {
        guard let trustedHost, !trustedHost.isEmpty,
              let components = URLComponents(string: raw),
              components.scheme?.lowercased() == "itms-services",
              let items = components.queryItems,
              items.filter({ $0.name == "action" }).map(\.value) == ["download-manifest"],
              let manifest = items.filter({ $0.name == "url" }).compactMap(\.value).first,
              items.filter({ $0.name == "url" }).count == 1,
              let manifestComponents = URLComponents(string: manifest),
              manifestComponents.scheme?.lowercased() == "https",
              manifestComponents.user == nil, manifestComponents.password == nil,
              manifestComponents.host?.lowercased() == trustedHost.lowercased(),
              let url = components.url
        else { return nil }
        return url
    }
}

/// When a check may run. Launch and resume checks are spaced by `resumeSpacing`. While the app stays in the foreground
/// the next check waits `foregroundInterval` (6 h). After a failure every trigger waits longer, doubling up to that same cap.
struct UpdateCheckPolicy: Sendable, Equatable {
    static let foregroundInterval: TimeInterval = 6 * 60 * 60
    static let resumeSpacing: TimeInterval = 15 * 60
    static let backoffBase: TimeInterval = 5 * 60

    enum Trigger: Sendable { case foreground, periodic }

    private(set) var lastAttempt: Date?
    private(set) var consecutiveFailures = 0

    func backoff() -> TimeInterval {
        guard consecutiveFailures > 0 else { return 0 }
        return min(Self.foregroundInterval, Self.backoffBase * pow(2, Double(min(consecutiveFailures - 1, 8))))
    }

    func nextDue(_ trigger: Trigger) -> Date {
        guard let lastAttempt else { return .distantPast }
        let spacing = trigger == .periodic ? Self.foregroundInterval : Self.resumeSpacing
        return lastAttempt.addingTimeInterval(max(spacing, backoff()))
    }

    func isDue(_ trigger: Trigger, now: Date) -> Bool { now >= nextDue(trigger) }

    mutating func record(failed: Bool, at date: Date) {
        lastAttempt = date
        consecutiveFailures = failed ? consecutiveFailures + 1 : 0
    }
}
