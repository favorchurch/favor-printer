import XCTest

/// Captures the iPad setup-guide and status states as named screenshot attachments. `ios/scripts/capture-ux-screenshots.sh`
/// runs this class and exports the attachments as `<state>.png`. Each method drives one `UITestBackend` scenario to one screen,
/// then asserts the screen shows what the file name claims, so a stale or wrong screen fails instead of being photographed.
@MainActor
final class ScreenshotUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(_ arguments: [String]) -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["-FavorUITestMock"] + arguments
        app.launch()
        return app
    }

    private static let pageTitles = [
        "Welcome", "Printer driver", "Connect the printer", "Enroll this printer",
        "Guided Access and Auto-Lock", "Background printing",
    ]

    /// Opens the setup guide for `scenario` (first run, onboarding reset) and taps Continue to the page titled `title`,
    /// waiting for each page to show before the next tap.
    private func guide(_ scenario: String, reaching title: String) -> XCUIApplication {
        let app = launch(["-FavorUITestScenario", scenario, "-FavorUITestResetOnboarding"])
        let heading = app.staticTexts["onboarding-title"]
        XCTAssertTrue(heading.waitForExistence(timeout: 10))
        guard let target = Self.pageTitles.firstIndex(of: title) else {
            XCTFail("unknown page \(title)")
            return app
        }
        for page in Self.pageTitles.indices.dropFirst().prefix(target) {
            app.buttons["onboarding-continue"].tap()
            expect(app, "onboarding-title", equals: Self.pageTitles[page])
        }
        return app
    }

    private func expect(_ app: XCUIApplication, _ id: String, equals expected: String, file: StaticString = #filePath, line: UInt = #line) {
        let element = app.staticTexts[id]
        let predicate = NSPredicate(format: "label == %@", expected)
        let result = XCTWaiter().wait(for: [expectation(for: predicate, evaluatedWith: element)], timeout: 10)
        XCTAssertEqual(result, .completed, "\(id) is \"\(element.label)\", expected \"\(expected)\"", file: file, line: line)
    }

    private func capture(_ state: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = state
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testOnboardingWelcome() {
        _ = guide("notEnrolled", reaching: "Welcome")
        capture("onboarding-welcome")
    }

    func testDriverNotRunning() {
        let app = guide("driverNotRunning", reaching: "Printer driver")
        expect(app, "onboarding-step-driver-state", equals: "Action needed")
        capture("driver-not-running")
    }

    func testPrinterNotSeen() {
        let app = guide("unplugged", reaching: "Connect the printer")
        expect(app, "onboarding-step-cable-state", equals: "Action needed")
        capture("printer-not-seen")
    }

    func testEnrollmentHelp() {
        let app = guide("notEnrolled", reaching: "Enroll this printer")
        expect(app, "onboarding-step-enrollment-state", equals: "Action needed")
        XCTAssertTrue(app.textFields["onboarding-enroll-code"].exists)
        capture("enrollment-help")
    }

    func testGuidedAccess() {
        let app = guide("guidedAccessOff", reaching: "Guided Access and Auto-Lock")
        expect(app, "onboarding-step-guidedAccess-state", equals: "Action needed")
        capture("guided-access")
    }

    func testBackgroundOn() {
        let app = guide("backgroundEnabled", reaching: "Background printing")
        expect(app, "onboarding-step-background-state", equals: "Done")
        capture("background-on")
    }

    func testBackgroundInterrupted() {
        let app = guide("keepAliveInterrupted", reaching: "Background printing")
        expect(app, "onboarding-step-background-state", equals: "Action needed")
        capture("background-interrupted")
    }

    func testStatusReady() {
        let app = launch(["-FavorHostFakeRelay", "-FavorHostFakeTransport"])
        expect(app, "host-headline", equals: "Ready")
        expect(app, "host-last-error", equals: "None")
        capture("status-ready")
    }

    func testStatusNeedsAttention() {
        let app = launch(["-FavorUITestDriverOff"])
        expect(app, "host-headline", equals: "Needs attention")
        expect(app, "host-driver", equals: "Printer seen, driver not running")
        capture("status-needs-attention")
    }
}
