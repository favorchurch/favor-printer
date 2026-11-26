import Foundation
import Testing
@testable import FavorPrinter

private let bundleID = "church.favor.printer.ios"
private let host = "rsvp.favor.church"
private let otaLink = "itms-services://?action=download-manifest&url=https://rsvp.favor.church/downloads/ipad/manifest.plist"
private let installed = InstalledBuild(version: "0.2.0", build: "4")

private func metadata(
    schema: Any = 1, bundle: Any = bundleID, channel: Any = "ota", version: Any = "0.3.0", build: Any = "9",
    released: Any = true, install: Any? = otaLink
) -> Data {
    var object: [String: Any] = ["schemaVersion": schema, "bundleId": bundle, "channel": channel, "version": version, "build": build, "released": released]
    if let install { object["installURL"] = install }
    return try! JSONSerialization.data(withJSONObject: object)
}

private func evaluate(
    _ body: Data, kind: DistributionKind = .ota, installedBuild: InstalledBuild = installed
) -> UpdateCheck.Outcome {
    result(.reply(status: 200, body: body), kind: kind, installedBuild: installedBuild)
}

private func result(
    _ fetched: UpdateCheck.FetchResult, kind: DistributionKind = .ota, installedBuild: InstalledBuild = installed
) -> UpdateCheck.Outcome {
    UpdateCheck.evaluate(installed: installedBuild, distribution: kind, expectedBundleID: bundleID, trustedInstallHost: host, fetched: fetched)
}

struct UpdateCheckModelTests {
    @Test func aNewerBuildOffersTheOTAInstallLink() throws {
        let outcome = evaluate(metadata())
        let prompt = try #require(outcome.prompt)
        #expect(prompt.version == "0.3.0")
        #expect(prompt.build == 9)
        #expect(prompt.action == .install(URL(string: otaLink)!))
    }

    @Test func buildsCompareAsNumbersNotText() {
        #expect(evaluate(metadata(build: "10"), installedBuild: InstalledBuild(version: "0.2.0", build: "9")).prompt != nil)
        #expect(evaluate(metadata(build: "9"), installedBuild: InstalledBuild(version: "0.2.0", build: "10")).prompt == nil)
        #expect(evaluate(metadata(build: 12)).prompt?.build == 12)
    }

    @Test func anEqualOrOlderBuildNeverPrompts() {
        #expect(evaluate(metadata(build: "4")) == .noPrompt(.upToDate))
        #expect(evaluate(metadata(build: "3")) == .noPrompt(.upToDate))
        #expect(evaluate(metadata(build: "0")) == .noPrompt(.upToDate))
        // A newer marketing version does not matter when the build is not newer.
        #expect(evaluate(metadata(version: "9.9.9", build: "4")) == .noPrompt(.upToDate))
    }

    @Test func malformedMetadataNeverPrompts() {
        let bad: [Data] = [
            Data(), Data("not json".utf8), Data("[]".utf8), Data("null".utf8), Data("{".utf8),
            Data(#"{"schemaVersion":1}"#.utf8),
            metadata(build: "4.1"), metadata(build: "-1"), metadata(build: ""), metadata(build: "abc"), metadata(build: 1.5),
            metadata(build: "99999999999999999999"), metadata(version: ""), metadata(version: "<b>1</b>"),
            metadata(version: String(repeating: "1", count: 40)), metadata(released: "yes"), metadata(bundle: 7), metadata(schema: "1"),
        ]
        for body in bad {
            let outcome = evaluate(body)
            #expect(outcome.prompt == nil)
            #expect(outcome == .failed(.malformed), "\(String(decoding: body, as: UTF8.self))")
        }
    }

    @Test func anUnknownSchemaVersionNeverPrompts() {
        for schema in [0, 2, 99, -1] {
            #expect(evaluate(metadata(schema: schema)) == .failed(.unknownSchema))
        }
        // A future schema may reshape every other field, so it is refused before the fields are read.
        #expect(evaluate(Data(#"{"schemaVersion":2,"releases":[]}"#.utf8)) == .failed(.unknownSchema))
    }

    @Test func aWrongBundleIDOrChannelNeverPrompts() {
        #expect(evaluate(metadata(bundle: "church.favor.printer.ios.tests")) == .noPrompt(.wrongBundle))
        #expect(evaluate(metadata(bundle: "")) == .noPrompt(.wrongBundle))
        #expect(evaluate(metadata(channel: "testflight")) == .noPrompt(.wrongChannel))
        #expect(evaluate(metadata(channel: "OTA")) == .noPrompt(.wrongChannel))
        #expect(evaluate(metadata(channel: "")) == .noPrompt(.wrongChannel))
        #expect(evaluate(metadata(channel: "ota"), kind: .testFlight) == .noPrompt(.wrongChannel))
    }

    @Test func anUnreleasedBuildNeverPrompts() {
        #expect(evaluate(metadata(released: false)) == .noPrompt(.notReleased))
        #expect(evaluate(metadata(channel: "testflight", released: false), kind: .testFlight) == .noPrompt(.notReleased))
    }

    @Test func anOTAUpdateWithoutAnInstallURLNeverPrompts() {
        #expect(evaluate(metadata(install: nil)) == .noPrompt(.missingInstallURL))
        #expect(evaluate(metadata(install: "")) == .noPrompt(.missingInstallURL))
        #expect(evaluate(metadata(install: NSNull())) == .noPrompt(.missingInstallURL))
    }

    @Test func anOTAInstallURLMustBeTheManifestLinkOnTheMetadataHost() {
        let bad = [
            "https://rsvp.favor.church/downloads/ipad/FavorPrinter.ipa",
            "http://rsvp.favor.church/downloads/ipad/manifest.plist",
            "itms-services://?action=download-manifest&url=http://rsvp.favor.church/manifest.plist",
            "itms-services://?action=download-manifest&url=https://evil.example/manifest.plist",
            "itms-services://?action=download-manifest&url=https://rsvp.favor.church.evil.example/manifest.plist",
            "itms-services://?action=download-manifest&url=https://rsvp.favor.church@evil.example/manifest.plist",
            "itms-services://?action=download-manifest&url=https://user:pw@rsvp.favor.church/manifest.plist",
            "itms-services://?action=download-manifest",
            "itms-services://?action=download&url=https://rsvp.favor.church/manifest.plist",
            "itms-services://?action=download-manifest&url=https://rsvp.favor.church/a&url=https://evil.example/b",
            "itms-services://evil.example/path?action=download-manifest&url=https%3A%2F%2Frsvp.favor.church%2Fdownloads%2Fipad%2Fmanifest.plist",
            "itms-services://evil.example?action=download-manifest&url=https://rsvp.favor.church/manifest.plist",
            "itms-services:///path?action=download-manifest&url=https://rsvp.favor.church/manifest.plist",
            "itms-services://:443?action=download-manifest&url=https://rsvp.favor.church/manifest.plist",
            "itms-services://user@?action=download-manifest&url=https://rsvp.favor.church/manifest.plist",
            "itms-services://?action=download-manifest&url=https://rsvp.favor.church/manifest.plist&extra=1",
            "itms-services://?action=download-manifest&url=https://rsvp.favor.church/manifest.plist#frag",
            "itms-services://?action=download-manifest&url=https://rsvp.favor.church/other/manifest.plist",
            "itms-services://?action=download-manifest&url=https://rsvp.favor.church/downloads/ipad/manifest.plist?x=1",
            "itms-services://?action=download-manifest&url=https://rsvp.favor.church/downloads/ipad/manifest.plist%23f",
            "itms-services://?action=download-manifest&url=https://rsvp.favor.church:8443/downloads/ipad/manifest.plist",
            "itms-services://?action=download-manifest&action=download-manifest&url=https://rsvp.favor.church/downloads/ipad/manifest.plist",
            "javascript:alert(1)", "itms-beta://", "not a url",
        ]
        for link in bad {
            #expect(evaluate(metadata(install: link)) == .noPrompt(.badInstallURL), "\(link)")
        }
        #expect(evaluate(metadata(install: otaLink)).prompt != nil)
        // A percent-encoded manifest URL is the same canonical shape.
        let encoded = "itms-services://?action=download-manifest&url=https%3A%2F%2Frsvp.favor.church%2Fdownloads%2Fipad%2Fmanifest.plist"
        #expect(evaluate(metadata(install: encoded)).prompt != nil)
        #expect(evaluate(metadata(install: "itms-services:///?action=download-manifest&url=https://rsvp.favor.church/downloads/ipad/manifest.plist")).prompt != nil)
    }

    @Test func anOTAInstallURLMustBeHostlessAndCarryOnlyActionAndURL() {
        let manifest = "https%3A%2F%2Frsvp.favor.church%2Fdownloads%2Fipad%2Fmanifest.plist"
        let query = "action=download-manifest&url=\(manifest)"
        // Each differs from the canonical link in one way only.
        let refused = [
            "itms-services://evil.example/path?\(query)",
            "itms-services://evil.example?\(query)",
            "itms-services:///path?\(query)",
            "itms-services://?\(query)&extra=1",
            "itms-services://?extra=1&\(query)",
        ]
        for link in refused {
            #expect(evaluate(metadata(install: link)) == .noPrompt(.badInstallURL), "\(link)")
        }
        #expect(evaluate(metadata(install: "itms-services://?\(query)")).prompt != nil)
        #expect(evaluate(metadata(install: "itms-services:///?\(query)")).prompt != nil)
    }

    @Test func aTestFlightBuildNeverGetsTheOTAInstallURL() throws {
        let withLink = try #require(evaluate(metadata(channel: "testflight", install: otaLink), kind: .testFlight).prompt)
        #expect(withLink.action == .openTestFlight)
        #expect(withLink.action.url == UpdateCheck.testFlightURL)
        #expect(withLink.action.url.scheme != "itms-services")
        // TestFlight needs no install URL, and a hostile one is not read.
        let without = try #require(evaluate(metadata(channel: "testflight", install: nil), kind: .testFlight).prompt)
        #expect(without.action == .openTestFlight)
        let hostile = try #require(evaluate(metadata(channel: "testflight", install: "https://evil.example"), kind: .testFlight).prompt)
        #expect(hostile.action == .openTestFlight)
    }

    @Test func theActionLabelsNameTheDistributionChannel() throws {
        let ota = try #require(evaluate(metadata()).prompt)
        #expect(ota.action.buttonTitle == "Open install page")
        let testFlight = try #require(evaluate(metadata(channel: "testflight"), kind: .testFlight).prompt)
        #expect(testFlight.action.buttonTitle == "Update in TestFlight")
    }

    @Test func aNetworkFailureOrNon200StatusNeverPrompts() {
        #expect(result(.networkFailure) == .failed(.network))
        for status in [100, 201, 204, 301, 304, 400, 403, 404, 429, 500, 503] {
            // The body is a valid, newer release, so only the status stops it.
            #expect(result(.reply(status: status, body: metadata())) == .failed(.httpStatus(status)))
        }
    }

    @Test func anOversizedBodyNeverPrompts() {
        let padding = String(repeating: "x", count: UpdateCheck.maxBodyBytes)
        #expect(evaluate(metadata(version: "0.3.0", install: otaLink + "?" + padding)) == .failed(.tooLarge))
    }

    @Test func developmentAndUnknownBuildsNeverPrompt() {
        for kind in [DistributionKind.development, .unknown] {
            #expect(evaluate(metadata(), kind: kind) == .noPrompt(.notApplicable))
            #expect(evaluate(metadata(channel: "testflight"), kind: kind) == .noPrompt(.notApplicable))
            #expect(result(.networkFailure, kind: kind) == .noPrompt(.notApplicable))
        }
    }

    @Test func anUnreadableInstalledBuildNeverPrompts() {
        for build in ["", "Unknown", "4.1", "-1"] {
            #expect(evaluate(metadata(), installedBuild: InstalledBuild(version: "0.2.0", build: build)) == .noPrompt(.installedBuildUnreadable))
        }
    }

    @Test func onlyFetchAndParseFailuresBackTheScheduleOff() {
        #expect(UpdateCheck.Outcome.failed(.network).isFailure)
        #expect(!UpdateCheck.Outcome.noPrompt(.upToDate).isFailure)
        #expect(!UpdateCheck.Outcome.noPrompt(.notReleased).isFailure)
    }
}

struct DistributionKindTests {
    @Test func classifiesHowTheBuildWasInstalled() {
        typealias Kind = DistributionKind
        #expect(Kind.classify(isDebugBuild: true, receiptName: "sandboxReceipt", hasEmbeddedProfile: true) == .development)
        #expect(Kind.classify(isDebugBuild: false, receiptName: "sandboxReceipt", hasEmbeddedProfile: false) == .testFlight)
        #expect(Kind.classify(isDebugBuild: false, receiptName: nil, hasEmbeddedProfile: true) == .ota)
        #expect(Kind.classify(isDebugBuild: false, receiptName: "receipt", hasEmbeddedProfile: true) == .ota)
        #expect(Kind.classify(isDebugBuild: false, receiptName: nil, hasEmbeddedProfile: false) == .unknown)
        #expect(Kind.classify(isDebugBuild: false, receiptName: "receipt", hasEmbeddedProfile: false) == .unknown)
    }

    @Test func onlyOTAAndTestFlightHaveAChannel() {
        #expect(DistributionKind.ota.channel == "ota")
        #expect(DistributionKind.testFlight.channel == "testflight")
        #expect(DistributionKind.development.channel == nil)
        #expect(DistributionKind.unknown.channel == nil)
    }

    @Test func aTestRunIsADevelopmentBuild() {
        #expect(DistributionKind.current() == .development)
    }
}

struct UpdateCheckPolicyTests {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    @Test func theFirstCheckIsAlwaysDue() {
        let policy = UpdateCheckPolicy()
        #expect(policy.isDue(.foreground, now: t0))
        #expect(policy.isDue(.periodic, now: t0))
    }

    @Test func theForegroundIntervalIsAtLeastSixHours() {
        var policy = UpdateCheckPolicy()
        policy.record(failed: false, at: t0)
        #expect(!policy.isDue(.periodic, now: t0.addingTimeInterval(6 * 3600 - 1)))
        #expect(policy.isDue(.periodic, now: t0.addingTimeInterval(6 * 3600)))
    }

    @Test func resumeChecksAreSpacedSoRapidForegroundingCannotFlood() {
        var policy = UpdateCheckPolicy()
        policy.record(failed: false, at: t0)
        #expect(!policy.isDue(.foreground, now: t0.addingTimeInterval(60)))
        #expect(!policy.isDue(.foreground, now: t0.addingTimeInterval(15 * 60 - 1)))
        #expect(policy.isDue(.foreground, now: t0.addingTimeInterval(15 * 60)))
    }

    @Test func failuresBackOffDoublingUpToTheForegroundInterval() {
        var policy = UpdateCheckPolicy()
        var waits: [TimeInterval] = []
        for _ in 0..<8 {
            policy.record(failed: true, at: t0)
            waits.append(policy.nextDue(.foreground).timeIntervalSince(t0))
        }
        // 5 min doubles, but never waits less than the resume spacing and never more than six hours.
        let minutes: [TimeInterval] = [15, 15, 20, 40, 80, 160, 320, 360]
        #expect(waits == minutes.map { $0 * 60 })
        #expect(waits.allSatisfy { $0 >= UpdateCheckPolicy.resumeSpacing && $0 <= UpdateCheckPolicy.foregroundInterval })
    }

    @Test func aSuccessClearsTheBackoff() {
        var policy = UpdateCheckPolicy()
        for _ in 0..<4 { policy.record(failed: true, at: t0) }
        policy.record(failed: false, at: t0)
        #expect(policy.consecutiveFailures == 0)
        #expect(policy.nextDue(.foreground) == t0.addingTimeInterval(15 * 60))
    }
}

private final class Calls: @unchecked Sendable {
    private let lock = NSLock()
    private var urls: [URL] = []
    var urlsSeen: [URL] { lock.withLock { urls } }
    func record(_ url: URL) { lock.withLock { urls.append(url) } }
}

private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 2_000_000)
    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }
}

@MainActor
struct UpdateCheckerTests {
    private let metadataURL = URL(string: "https://rsvp.favor.church/downloads/ipad/update.json")!

    private func checker(
        kind: DistributionKind = .ota, url: URL?? = nil, clock: Clock, calls: Calls,
        replies: @escaping @Sendable (Int) -> UpdateCheck.FetchResult
    ) -> UpdateChecker {
        UpdateChecker(
            installed: installed, distribution: kind, expectedBundleID: bundleID, metadataURL: url ?? metadataURL,
            fetch: { url in calls.record(url); return replies(calls.urlsSeen.count) },
            now: { clock.now }
        )
    }

    @Test func aLaunchCheckSetsThePromptFromTheFetchedMetadata() async {
        let calls = Calls()
        let checker = checker(clock: Clock(), calls: calls) { _ in .reply(status: 200, body: metadata()) }
        await checker.checkIfDue(.foreground)
        #expect(checker.prompt?.build == 9)
        #expect(calls.urlsSeen == [metadataURL])
    }

    @Test func resumeChecksInsideTheSpacingDoNotFetchAgain() async {
        let calls = Calls()
        let clock = Clock()
        let checker = checker(clock: clock, calls: calls) { _ in .reply(status: 200, body: metadata()) }
        await checker.checkIfDue(.foreground)
        clock.advance(60)
        await checker.checkIfDue(.foreground)
        await checker.checkIfDue(.periodic)
        #expect(calls.urlsSeen.count == 1)
        clock.advance(15 * 60)
        await checker.checkIfDue(.foreground)
        #expect(calls.urlsSeen.count == 2)
        clock.advance(6 * 3600)
        await checker.checkIfDue(.periodic)
        #expect(calls.urlsSeen.count == 3)
    }

    @Test func aFailureShowsNoPromptAndBacksOff() async {
        let calls = Calls()
        let clock = Clock()
        let checker = checker(clock: clock, calls: calls) { count in
            count == 1 ? .reply(status: 200, body: metadata()) : .networkFailure
        }
        await checker.checkIfDue(.foreground)
        #expect(checker.prompt != nil)
        clock.advance(15 * 60)
        await checker.checkIfDue(.foreground)
        #expect(calls.urlsSeen.count == 2)
        #expect(checker.prompt == nil)
        // After failures 1 to 4 the next resume waits 15, 15, 20 and 40 minutes: one minute early is not allowed.
        for (minutes, expectedCalls) in [(15.0, 3), (15.0, 4), (20.0, 5), (39.0, 5), (1.0, 6)] as [(Double, Int)] {
            clock.advance(minutes * 60)
            await checker.checkIfDue(.foreground)
            #expect(calls.urlsSeen.count == expectedCalls, "after +\(minutes) min")
        }
    }

    @Test func aLaterNoPromptOutcomeWithdrawsAPromptThatWasShown() async {
        let calls = Calls()
        let clock = Clock()
        let checker = checker(clock: clock, calls: calls) { count in
            .reply(status: 200, body: metadata(released: count == 1))
        }
        await checker.checkIfDue(.foreground)
        #expect(checker.prompt != nil)
        clock.advance(15 * 60)
        await checker.checkIfDue(.foreground)
        #expect(checker.prompt == nil)
    }

    @Test func buildsWithoutAChannelOrAMetadataURLNeverFetch() async {
        for (kind, url) in [(DistributionKind.development, metadataURL), (.unknown, metadataURL), (.ota, nil), (.testFlight, nil)] as [(DistributionKind, URL?)] {
            let calls = Calls()
            let checker = checker(kind: kind, url: .some(url), clock: Clock(), calls: calls) { _ in .reply(status: 200, body: metadata()) }
            await checker.checkIfDue(.foreground)
            await checker.runWhileForeground()
            #expect(calls.urlsSeen.isEmpty)
            #expect(checker.prompt == nil)
        }
    }

    @Test func theInstalledVersionIsAlwaysAvailableToTheScreen() {
        let checker = checker(clock: Clock(), calls: Calls()) { _ in .networkFailure }
        #expect(checker.installed.summary == "0.2.0 (4)")
    }
}

struct UpdateMetadataFetcherTests {
    private func fetch(_ reply: @escaping @Sendable (URLRequest) throws -> MockURLProtocol.Reply) async -> (UpdateCheck.FetchResult, [URLRequest]) {
        let server = MockServer(reply)
        let url = server.baseURL.appending(path: "downloads/ipad/update.json")
        let result = await UpdateMetadataFetcher.fetch(url, session: UpdateMetadataFetcher.makeSession(protocolClasses: [MockURLProtocol.self]))
        return (result, server.requests)
    }

    @Test func sendsABareGETWithNoCredentialOrIdentifier() async throws {
        let (result, requests) = await fetch { _ in .json(200, "{}") }
        #expect(result == .reply(status: 200, body: Data("{}".utf8)))
        let request = try #require(requests.first)
        #expect(requests.count == 1)
        #expect(request.httpMethod == "GET")
        #expect(request.httpBody == nil)
        #expect(request.url?.query == nil)
        let headers = Set((request.allHTTPHeaderFields ?? [:]).keys.map { $0.lowercased() })
        #expect(headers.isDisjoint(with: ["authorization", "x-relay-id", "cookie", "x-device-id", "x-printer-id"]))
        #expect(request.httpShouldHandleCookies == false)
    }

    @Test func reportsTheStatusAndNeverFollowsAnErrorBodyIntoAPrompt() async {
        let (result, _) = await fetch { _ in .error(500, "boom") }
        guard case .reply(let status, _) = result else { Issue.record("expected a reply"); return }
        #expect(status == 500)
    }

    @Test func aTransportErrorIsANetworkFailure() async {
        let (result, _) = await fetch { _ in throw URLError(.notConnectedToInternet) }
        #expect(result == .networkFailure)
    }

    @Test func stopsReadingAnUnboundedBody() async {
        let big = Data(repeating: 0x20, count: UpdateCheck.maxBodyBytes * 4)
        let (result, _) = await fetch { _ in .init(status: 200, body: big) }
        guard case .reply(_, let body) = result else { Issue.record("expected a reply"); return }
        #expect(body.count == UpdateCheck.maxBodyBytes + 1)
        #expect(UpdateCheck.evaluate(installed: installed, distribution: .ota, expectedBundleID: bundleID, trustedInstallHost: host, fetched: result) == .failed(.tooLarge))
    }
}
