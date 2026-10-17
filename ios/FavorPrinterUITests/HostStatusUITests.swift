import XCTest

/// Drives the Printer Host screen against the fake relay and fake printer (`-FavorHostFakeRelay -FavorHostFakeTransport`) and the mocked
/// enrollment (Debug builds only, launched with `-FavorUITestMock`).
@MainActor
final class HostStatusUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func openHost(_ extra: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-FavorUITestMock"] + extra
        app.launch()
        XCTAssertTrue(app.staticTexts["host-enrollment"].waitForExistence(timeout: 10))
        return app
    }

    private func text(_ app: XCUIApplication, _ id: String) -> String {
        app.staticTexts[id].label
    }

    private func wait(_ app: XCUIApplication, _ id: String, equals expected: String, file: StaticString = #filePath, line: UInt = #line) {
        let element = app.staticTexts[id]
        let predicate = NSPredicate(format: "label == %@", expected)
        let result = XCTWaiter().wait(for: [expectation(for: predicate, evaluatedWith: element)], timeout: 10)
        XCTAssertEqual(result, .completed, "\(id) is \"\(element.label)\", expected \"\(expected)\"", file: file, line: line)
    }

    /// Every control on the host screen has a VoiceOver label.
    private func assertLabelled(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let keyboard = app.keyboards.firstMatch
        let keyboardFrame = keyboard.exists ? keyboard.frame : .null
        for query in [app.buttons, app.textFields] {
            for control in query.allElementsBoundByIndex where control.exists && control.isHittable && !keyboardFrame.intersects(control.frame) {
                XCTAssertFalse(control.label.isEmpty, "unlabelled control: \(control.debugDescription)", file: file, line: line)
            }
        }
    }

    func testFakeRelayShowsStatusAndPrintsTheSyntheticLabel() {
        let app = openHost(["-FavorHostFakeRelay", "-FavorHostFakeTransport"])
        wait(app, "host-headline", equals: "Ready")
        wait(app, "host-printer", equals: "Attached")
        wait(app, "host-driver", equals: "Running")
        wait(app, "host-running", equals: "Running")
        XCTAssertEqual(text(app, "host-enrollment"), "Fake relay (test build)")
        XCTAssertFalse(app.buttons["unenroll-button"].exists)
        assertLabelled(app)

        // The demo job queued by the fake relay prints on its own; a synthetic one follows.
        let predicate = NSPredicate(format: "label BEGINSWITH 'Sent'")
        XCTAssertEqual(XCTWaiter().wait(for: [expectation(for: predicate, evaluatedWith: app.staticTexts["host-last-job"])], timeout: 10), .completed)
        wait(app, "host-spool", equals: "0")
        wait(app, "host-last-error", equals: "None")

        let synthetic = app.buttons["host-synthetic-label"]
        XCTAssertTrue(synthetic.exists)
        XCTAssertEqual(synthetic.label, "Print synthetic test label")
        synthetic.tap()
        wait(app, "host-spool", equals: "0")
        XCTAssertTrue(text(app, "host-last-job").hasPrefix("Sent"))
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS '^XA' OR label CONTAINS 'Synthetic test'")).element.exists)
    }

    func testEnrollFormRefusesAConflictThenEnrollsAndUnenrolls() {
        let app = openHost([])
        wait(app, "host-headline", equals: "Not enrolled")
        XCTAssertEqual(text(app, "host-enrollment"), "Not enrolled")
        let enrollmentHelp = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "An RSVP admin")).firstMatch
        XCTAssertTrue(enrollmentHelp.exists)
        XCTAssertTrue(enrollmentHelp.label.contains("one-time code"))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Hand over from")).firstMatch.exists)
        XCTAssertFalse(app.buttons["host-synthetic-label"].exists)
        wait(app, "host-running", equals: "Paused")

        let field = app.textFields["enroll-code-field"]
        let enroll = app.buttons["enroll-button"]
        XCTAssertFalse(enroll.isEnabled)
        assertLabelled(app)

        field.tap()
        field.typeText("CONFLICT")
        XCTAssertTrue(enroll.isEnabled)
        enroll.tap()
        let error = app.staticTexts["host-error"]
        XCTAssertTrue(error.waitForExistence(timeout: 10))
        XCTAssertEqual(error.label, "This printer is already in use by another device.")
        XCTAssertEqual(text(app, "host-enrollment"), "Not enrolled")

        field.tap()
        field.press(forDuration: 1.0)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
        field.typeText("GOOD-CODE")
        enroll.tap()
        XCTAssertTrue(app.buttons["unenroll-button"].waitForExistence(timeout: 10))
        XCTAssertTrue(text(app, "host-enrollment").hasPrefix("Enrolled"))
        XCTAssertFalse(error.exists)
        wait(app, "host-running", equals: "Running")
        assertLabelled(app)

        app.buttons["unenroll-button"].tap()
        let confirm = app.buttons.matching(identifier: "unenroll-confirm").firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(app.textFields["enroll-code-field"].waitForExistence(timeout: 10))
        XCTAssertEqual(text(app, "host-enrollment"), "Not enrolled")
    }

    func testDriverNotRunningShowsTheSettingsHintAndRefusesEnrollment() {
        let app = openHost(["-FavorUITestDriverOff"])
        wait(app, "host-headline", equals: "Needs attention")
        wait(app, "host-driver", equals: "Printer seen, driver not running")
        let hint = app.staticTexts["host-driver-hint"].label
        XCTAssertTrue(hint.contains("Settings > Favor Printer > Drivers"))
        XCTAssertTrue(hint.contains("Unplug and replug the printer"))
        XCTAssertTrue(hint.contains("restart the iPad"))

        let field = app.textFields["enroll-code-field"]
        field.tap()
        field.typeText("GOOD-CODE")
        app.buttons["enroll-button"].tap()
        XCTAssertTrue(app.staticTexts["host-error"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["host-error"].label.hasPrefix("The printer is not ready."))
    }

    func testUnpluggedPrinterShowsNotSeenAndCableSteps() {
        let app = openHost(["-FavorUITestScenario", "unplugged"])

        wait(app, "host-headline", equals: "Needs attention")
        wait(app, "host-printer", equals: "Not seen")
        XCTAssertTrue(app.staticTexts["host-driver-hint"].label.contains("USB-C port"))
    }
}
