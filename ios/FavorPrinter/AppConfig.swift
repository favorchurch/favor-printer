import Foundation

/// Per-build settings. The RSVP base URL comes from Config/*.xcconfig through Info.plist.
struct AppConfig: Sendable, Equatable {
    /// The only host a Release build may talk to: real device credentials never leave production.
    static let productionHost = "rsvp.favor.church"
    /// Debug builds without a configured host default here, matching Config/Debug.xcconfig.
    static let previewHost = "rsvp-preview.favor.church"

    /// Mirrors the build configuration so Release policy is testable from a Debug test run.
    enum Build: Sendable, Equatable {
        case debug
        case release

        static var current: Build {
            #if DEBUG
            .debug
            #else
            .release
            #endif
        }
    }

    let rsvpBaseURL: URL
    /// Where the iPad update metadata lives. Nil when absent or unusable: the update check then stays off and the app runs normally.
    let updateMetadataURL: URL?

    enum Failure: Error, Equatable {
        case missing
        case insecure
        case nonProduction
    }

    init(rsvpBaseURL: URL, updateMetadataURL: URL? = nil, build: Build = .current) throws {
        guard rsvpBaseURL.scheme?.lowercased() == "https", rsvpBaseURL.host?.isEmpty == false else {
            throw Failure.insecure
        }
        if build == .release {
            let isProductionOrigin = rsvpBaseURL.host?.lowercased() == Self.productionHost
                && (rsvpBaseURL.port ?? 443) == 443
            guard isProductionOrigin else { throw Failure.nonProduction }
        }
        self.rsvpBaseURL = rsvpBaseURL
        self.updateMetadataURL = updateMetadataURL.flatMap { Self.isUsableUpdateURL($0, build: build) ? $0 : nil }
    }

    /// HTTPS with no credentials. A Release build reads it from production only, like the relay.
    private static func isUsableUpdateURL(_ url: URL, build: Build) -> Bool {
        guard url.scheme?.lowercased() == "https", let host = url.host?.lowercased(), !host.isEmpty,
              url.user == nil, url.password == nil
        else { return false }
        return build == .debug || (host == productionHost && (url.port ?? 443) == 443)
    }

    private static func updateMetadataURL(info: [String: Any]?) -> URL? {
        let raw = (info?["UpdateMetadataURL"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return raw.flatMap { $0.isEmpty ? nil : URL(string: $0) }
    }

    init(info: [String: Any]?, build: Build = .current) throws {
        // A value pasted or templated into the plist can carry newlines as well as spaces.
        let raw = (info?["RSVPBaseURL"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw == nil || raw?.isEmpty == true {
            // Debug defaults to the preview host; a Release build must be configured.
            guard build == .debug, let preview = URL(string: "https://\(Self.previewHost)") else {
                throw Failure.missing
            }
            try self.init(rsvpBaseURL: preview, updateMetadataURL: Self.updateMetadataURL(info: info), build: build)
            return
        }
        guard let raw, let url = URL(string: raw) else { throw Failure.missing }
        try self.init(rsvpBaseURL: url, updateMetadataURL: Self.updateMetadataURL(info: info), build: build)
    }

    static func load(bundle: Bundle = .main, build: Build = .current) throws -> AppConfig {
        try AppConfig(info: bundle.infoDictionary, build: build)
    }

    /// Launch order: the stale device bearer goes first, so a build with a bad RSVP address still cleans up.
    static func loadAfterCleanup(
        cleanUp: () -> Void = { StaleDeviceBearer.deleteOnce() },
        load: () throws -> AppConfig = { try AppConfig.load() }
    ) throws -> AppConfig {
        cleanUp()
        return try load()
    }
}
