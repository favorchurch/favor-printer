import XCTest

/// Drives the real app against the in-process mock backend (`-FavorUITestMock`, Debug builds only).
@MainActor
final class CheckinFlowUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-FavorUITestMock"] + extra
        app.launch()
        return app
    }

    private func tap(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.waitForExistence(timeout: 10), "missing \(element)", file: file, line: line)
        element.tap()
    }

    /// Every button, text field, switch and picker on screen must have a VoiceOver label. SwiftUI nests an
    /// unlabelled inner element inside a labelled row (Toggle, Button), and the keyboard's own keys are
    /// not ours, so a control counts as labelled when it or an enclosing control of the same kind is.
    private func assertControlsLabelled(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let keyboard = app.keyboards.firstMatch
        // The prediction bar sits just above the keyboard, so cover it too.
        let keyboardFrame = keyboard.exists ? keyboard.frame.insetBy(dx: 0, dy: -80) : .null
        for query in [app.buttons, app.textFields, app.switches, app.popUpButtons] {
            let controls = query.allElementsBoundByIndex.filter { $0.exists && $0.isHittable }
            for control in controls where control.label.isEmpty && !keyboardFrame.intersects(control.frame) {
                let enclosed = controls.contains { !$0.label.isEmpty && $0.frame.contains(control.frame) }
                XCTAssertTrue(enclosed, "unlabelled control: \(control.debugDescription)", file: file, line: line)
            }
        }
    }

    func testRegisterApproveSearchCheckInAndPrintStatus() {
        let app = launch()

        // Register.
        let campus = app.textFields["campus-field"]
        XCTAssertTrue(campus.waitForExistence(timeout: 10))
        campus.tap()
        campus.typeText("1")
        let name = app.textFields["label-field"]
        name.tap()
        name.typeText("UI test iPad")
        assertControlsLabelled(app)
        tap(app.buttons["register-button"])

        // Pending, then the mocked admin approval arrives on the next status check.
        XCTAssertTrue(app.staticTexts["Waiting for approval"].waitForExistence(timeout: 10))
        assertControlsLabelled(app)
        tap(app.buttons["check-again"])

        // Definition and occurrence.
        tap(app.buttons["definition-grp-71"])
        assertControlsLabelled(app)
        tap(app.buttons["occurrence-34886"])

        // Search.
        let search = app.textFields["search-field"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText("Maria")
        assertControlsLabelled(app)
        tap(app.buttons["search-button"])
        tap(app.buttons["contact-12310"])

        // Event check-in.
        tap(app.buttons["check-in-button"])
        XCTAssertTrue(app.staticTexts["Checked in"].waitForExistence(timeout: 10))
        assertControlsLabelled(app)

        // Print label and print status.
        tap(app.buttons["print-link"])
        tap(app.buttons["printer-8b57de32-e4ef-4608-9e80-5c5e21b8d063"])
        assertControlsLabelled(app)
        tap(app.buttons["print-button"])
        let chip = app.staticTexts["print-chip"]
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        XCTAssertEqual(chip.label, "Kids desk: Ready")
        XCTAssertTrue(app.staticTexts["job-job-1"].exists)
        assertControlsLabelled(app)
    }

    func testKidsFamilyCheckInShowsResult() {
        let app = launch(["-FavorUITestApproved"])
        tap(app.buttons["definition-grp-71"])
        tap(app.buttons["occurrence-34886"])
        let search = app.textFields["search-field"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText("Maria")
        tap(app.buttons["search-button"])
        tap(app.buttons["contact-12310"])
        tap(app.buttons["family-link"])

        let submit = app.buttons["family-submit"]
        XCTAssertTrue(submit.waitForExistence(timeout: 10))
        XCTAssertEqual(submit.label, "Check in 2 kids")
        assertControlsLabelled(app)
        tap(submit)
        XCTAssertTrue(app.staticTexts["Maria S. checked in"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Jose S. checked in"].exists)
        XCTAssertTrue(app.buttons["print-link"].exists)
    }

    func testOfflineBlocksCheckInAndSaysSo() {
        let app = launch(["-FavorUITestApproved", "-FavorUITestOffline"])
        XCTAssertTrue(app.staticTexts["offline-banner"].waitForExistence(timeout: 10))
        let failure = app.staticTexts["failure"]
        XCTAssertTrue(failure.waitForExistence(timeout: 10))
        XCTAssertTrue(failure.label.contains("No network connection"))
        XCTAssertFalse(app.buttons["definition-grp-71"].exists)
    }
}
