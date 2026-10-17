import XCTest

@MainActor
extension HostStatusUITests {
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
