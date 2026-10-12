import Foundation

/// Per-build settings. The RSVP base URL comes from Config/*.xcconfig through Info.plist.
struct AppConfig: Sendable, Equatable {
    let rsvpBaseURL: URL

    enum Failure: Error, Equatable {
        case missing
        case insecure
    }

    init(rsvpBaseURL: URL) throws {
        guard rsvpBaseURL.scheme?.lowercased() == "https", rsvpBaseURL.host?.isEmpty == false else {
            throw Failure.insecure
        }
        self.rsvpBaseURL = rsvpBaseURL
    }

    init(info: [String: Any]?) throws {
        guard let raw = (info?["RSVPBaseURL"] as? String)?.trimmingCharacters(in: .whitespaces),
              let url = URL(string: raw)
        else { throw Failure.missing }
        try self.init(rsvpBaseURL: url)
    }

    static func load(bundle: Bundle = .main) throws -> AppConfig {
        try AppConfig(info: bundle.infoDictionary)
    }
}
