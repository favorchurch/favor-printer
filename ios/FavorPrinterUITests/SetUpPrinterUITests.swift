import XCTest

/// The "Set up printer" action on the host screen, against the fake relay and a fake printer. Set
/// `TEST_RUNNER_PRINTER_EVIDENCE_DIR` to also save a screenshot of each state there.
@MainActor
final class SetUpPrinterUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func open(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-FavorUITestMock", "-FavorHostFakeRelay", "-FavorHostFakeTransport"] + extra
        app.launch()
        XCTAssertTrue(app.staticTexts["host-printer"].waitForExistence(timeout: 10))
        return app
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        guard let dir = ProcessInfo.processInfo.environment["PRINTER_EVIDENCE_DIR"] else { return }
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("ipad-\(name).png"))
    }

    private func button(_ app: XCUIApplication) -> XCUIElement {
        let button = app.buttons["host-setup-printer"]
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        return button
    }

    private func status(_ app: XCUIApplication, contains text: String, timeout: TimeInterval = 30) {
        let element = app.staticTexts["host-setup-printer-status"]
        let predicate = NSPredicate(format: "label CONTAINS %@", text)
        XCTAssertEqual(XCTWaiter().wait(for: [expectation(for: predicate, evaluatedWith: element)], timeout: timeout), .completed,
                       "status is \"\(element.label)\", expected it to contain \"\(text)\"")
    }

    func testConfirmThenRunThenDone() {
        let app = open(["-FavorHostFakeSendDelayMs", "1500"])
        let setup = button(app)
        XCTAssertEqual(setup.label, "Set up printer")
        snap(app, "setup-button")

        setup.tap()
        let confirm = app.buttons.matching(identifier: "host-setup-printer-confirm").firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'cutter' AND label CONTAINS 'blank labels'")).firstMatch.exists)
        snap(app, "setup-confirm")

        confirm.tap()
        status(app, contains: "Setting up")
        XCTAssertFalse(setup.isEnabled)
        snap(app, "setup-running")

        status(app, contains: "Printer set up")
        XCTAssertTrue(setup.isEnabled)
        snap(app, "setup-done")
    }

    func testFailureNamesTheStep() {
        let app = open(["-FavorHostFakeSetupFailure"])
        button(app).tap()
        app.buttons.matching(identifier: "host-setup-printer-confirm").firstMatch.tap()
        status(app, contains: "Calibrate failed")
        XCTAssertTrue(button(app).isEnabled)
        snap(app, "setup-failed")
    }

    func testCancelSendsNothing() {
        let app = open()
        button(app).tap()
        XCTAssertTrue(app.buttons.matching(identifier: "host-setup-printer-confirm").firstMatch.waitForExistence(timeout: 5))
        // An iPad popover has no Cancel button: tapping outside dismisses it.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.95)).tap()
        XCTAssertTrue(XCTWaiter().wait(for: [expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons.matching(identifier: "host-setup-printer-confirm").firstMatch)], timeout: 5) == .completed)
        XCTAssertFalse(app.staticTexts["host-setup-printer-status"].exists)
    }
}
