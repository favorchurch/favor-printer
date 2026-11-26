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

    func testUpdateAvailableShowsLatestBuildAndTheOTAInstallAction() {
        let app = XCUIApplication()
        app.launchArguments = ["-FavorUITestMock", "-FavorUITestUpdate", "ota"]
        app.launch()

        XCTAssertTrue(app.staticTexts["update-available"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["update-latest"].label, "0.3.0 (9)")
        XCTAssertEqual(app.buttons["update-button"].label, "Open install page")
        XCTAssertEqual(app.staticTexts["app-version"].label, "0.2.0 (4)")
    }

    func testUpdateAvailableOnTestFlightOpensTestFlightNotAnInstallLink() {
        let app = XCUIApplication()
        app.launchArguments = ["-FavorUITestMock", "-FavorUITestUpdate", "testflight"]
        app.launch()

        XCTAssertTrue(app.staticTexts["update-available"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["update-button"].label, "Update in TestFlight")
    }

    func testNoUpdateStateShowsTheInstalledVersionOnly() {
        let app = XCUIApplication()
        app.launchArguments = ["-FavorUITestMock"]
        app.launch()

        XCTAssertEqual(app.staticTexts["app-version"].label, "0.2.0 (4)")
        XCTAssertFalse(app.staticTexts["update-available"].exists)
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
