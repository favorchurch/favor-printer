import XCTest

@MainActor
extension HostStatusUITests {
    func testUnpluggedPrinterShowsNotSeenAndCableSteps() {
        let app = XCUIApplication()
        app.launchArguments = ["-FavorUITestMock", "-FavorUITestScenario", "unplugged"]
        app.launch()

        let headline = app.staticTexts["host-headline"]
        XCTAssertTrue(headline.waitForExistence(timeout: 10))
        XCTAssertEqual(headline.label, "Not enrolled")
        XCTAssertEqual(app.staticTexts["host-enrollment"].label, "Not enrolled")
        XCTAssertEqual(app.staticTexts["host-printer"].label, "Not seen")
        XCTAssertTrue(app.staticTexts["host-driver-hint"].label.contains("USB-C port"))
    }

    func testKeepAliveInterruptionShowsWhyBackgroundPrintingPaused() {
        let app = XCUIApplication()
        app.launchArguments = ["-FavorUITestMock", "-FavorUITestScenario", "keepAliveInterrupted"]
        app.launch()

        XCTAssertEqual(app.staticTexts["keep-alive-internal-note"].label, "Available in Internal builds only.")
        let note = app.staticTexts["keep-alive-interruption-note"]
        XCTAssertTrue(note.waitForExistence(timeout: 10))
        XCTAssertTrue(note.label.contains("Another app took the audio"))
        XCTAssertFalse(app.switches["keep-alive-toggle"].label.isEmpty)
    }
}
