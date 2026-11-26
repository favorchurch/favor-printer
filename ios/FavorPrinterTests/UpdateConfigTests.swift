import Foundation
import Testing
@testable import FavorPrinter

struct UpdateConfigTests {
    private static let ios = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()

    private func config(_ url: String?, build: AppConfig.Build = .release, base: String = "https://rsvp.favor.church") throws -> AppConfig {
        var info: [String: Any] = ["RSVPBaseURL": base]
        if let url { info["UpdateMetadataURL"] = url }
        return try AppConfig(info: info, build: build)
    }

    @Test func readsTheMetadataURLFromInfoPlist() throws {
        let url = "https://rsvp.favor.church/downloads/ipad/update.json"
        #expect(try config(url).updateMetadataURL?.absoluteString == url)
        #expect(try config("\n \(url) \n").updateMetadataURL?.absoluteString == url)
    }

    @Test func aMissingOrUnusableURLTurnsTheCheckOffWithoutFailingTheConfig() throws {
        let unusable = [
            nil, "", "  ", "$(UPDATE_METADATA_URL)", "no such url", "http://rsvp.favor.church/update.json", "https://",
            "https://user:pw@rsvp.favor.church/update.json", "https://rsvp.favor.church:8443/update.json",
            "https://rsvp-preview.favor.church/update.json", "https://evil.example/update.json", "file:///update.json",
        ]
        for url in unusable {
            #expect(try config(url).updateMetadataURL == nil, "\(url ?? "nil")")
        }
    }

    @Test func debugAcceptsAnyHTTPSHostLikeTheRelayURL() throws {
        let preview = "https://rsvp-preview.favor.church/downloads/ipad/update.json"
        #expect(try config(preview, build: .debug, base: "https://rsvp-preview.favor.church").updateMetadataURL?.absoluteString == preview)
        #expect(try config("http://rsvp-preview.favor.church/update.json", build: .debug, base: "https://rsvp-preview.favor.church").updateMetadataURL == nil)
    }

    @Test func everyBuildConfigurationDeclaresAnHTTPSMetadataURL() throws {
        let pairs = [("Debug", "Info-Debug"), ("Internal", "Info-Internal"), ("TestFlight", "Info-Internal"), ("Release", "Info")]
        for (xcconfig, plist) in pairs {
            let text = try String(contentsOf: Self.ios.appending(path: "Config/\(xcconfig).xcconfig"), encoding: .utf8)
            let line = try #require(text.split(separator: "\n").first { $0.hasPrefix("UPDATE_METADATA_URL") }, "\(xcconfig)")
            #expect(line.contains("https:/$()/"), "\(xcconfig)")
            let data = try Data(contentsOf: Self.ios.appending(path: "Config/\(plist).plist"))
            let info = try #require(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
            #expect(info["UpdateMetadataURL"] as? String == "$(UPDATE_METADATA_URL)", "\(plist)")
        }
    }
}
