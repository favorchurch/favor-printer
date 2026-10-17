import XCTest

@MainActor
final class OnboardingUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func waitForTitle(_ title: XCUIElement, equals expected: String) {
        let predicate = NSPredicate(format: "label == %@", expected)
        expectation(for: predicate, evaluatedWith: title)
        waitForExpectations(timeout: 10)
    }

    func testSkippingUnmetEnrollmentDoesNotMarkItDone() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-FavorUITestMock", "-FavorUITestScenario", "backgroundEnabled", "-FavorUITestResetOnboarding",
        ]
        app.launch()

        let title = app.staticTexts["onboarding-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        for expectedTitle in ["Printer driver", "Connect the printer", "Enroll this printer"] {
            app.buttons["onboarding-continue"].tap()
            waitForTitle(title, equals: expectedTitle)
        }
        let enrollmentState = app.staticTexts["onboarding-step-enrollment-state"]
        for expectedTitle in ["Guided Access and Auto-Lock", "Background printing", "You're ready"] {
            app.buttons["onboarding-continue"].tap()
            waitForTitle(title, equals: expectedTitle)
        }
        XCTAssertEqual(enrollmentState.label, "Action needed", "skipping enrollment must not mark it complete")
    }

    func testFirstRunOnboardingCanReachStatusWithAccessibleControls() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-FavorUITestMock", "-FavorUITestScenario", "backgroundEnabled", "-FavorUITestResetOnboarding",
        ]
        app.launch()

        let title = app.staticTexts["onboarding-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        XCTAssertEqual(title.label, "Welcome")
        XCTAssertTrue(app.staticTexts["onboarding-welcome-copy"].label.localizedCaseInsensitiveContains("check-in happens in Favor RSVP on other devices"))
        XCTAssertEqual(app.buttons["onboarding-continue"].label, "Continue setup")

        app.buttons["onboarding-continue"].tap()
        XCTAssertEqual(title.label, "Printer driver")
        XCTAssertEqual(app.staticTexts["onboarding-step-driver-state"].label, "Done")
        app.buttons["onboarding-continue"].tap()
        XCTAssertEqual(title.label, "Connect the printer")
        XCTAssertEqual(app.staticTexts["onboarding-step-cable-state"].label, "Done")

        app.buttons["onboarding-continue"].tap()
        XCTAssertEqual(title.label, "Enroll this printer")
        let code = app.textFields["onboarding-enroll-code"]
        let enroll = app.buttons["onboarding-enroll-button"]
        XCTAssertEqual(code.label, "One-time enrollment code")
        XCTAssertEqual(enroll.label, "Enroll this printer")
        let enrollmentState = app.staticTexts["onboarding-step-enrollment-state"]
        XCTAssertEqual(enrollmentState.label, "Action needed")

        code.tap()
        code.typeText("GOOD-CODE")
        enroll.tap()
        let enrolled = NSPredicate(format: "label == %@", "Done")
        expectation(for: enrolled, evaluatedWith: enrollmentState)
        waitForExpectations(timeout: 10)

        app.buttons["onboarding-continue"].tap()
        XCTAssertEqual(title.label, "Guided Access and Auto-Lock")
        XCTAssertEqual(app.staticTexts["onboarding-step-guidedAccess-state"].label, "Done")
        XCTAssertEqual(app.staticTexts["onboarding-step-autoLock-state"].label, "Check by hand")
        app.buttons["onboarding-continue"].tap()
        XCTAssertEqual(title.label, "Background printing")
        XCTAssertEqual(app.staticTexts["onboarding-step-background-state"].label, "Done")
        app.buttons["onboarding-continue"].tap()
        XCTAssertEqual(title.label, "You're ready")
        for button in app.buttons.allElementsBoundByIndex where button.isHittable {
            XCTAssertFalse(button.label.isEmpty, "unlabelled onboarding button: \(button.debugDescription)")
        }
        app.buttons["onboarding-finish"].tap()

        XCTAssertTrue(app.staticTexts["host-enrollment"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["setup-guide-button"].exists)
        XCTAssertEqual(app.buttons["setup-guide-button"].label, "Open setup guide")
        app.buttons["setup-guide-button"].tap()
        XCTAssertEqual(title.label, "Welcome")
        let closeGuide = app.buttons["onboarding-close"]
        XCTAssertEqual(closeGuide.label, "Close setup guide")
        closeGuide.tap()
        XCTAssertTrue(app.staticTexts["host-enrollment"].waitForExistence(timeout: 10))
        XCTAssertFalse(title.exists)
        app.buttons["setup-guide-button"].tap()
        XCTAssertEqual(title.label, "Welcome")

        app.terminate()
        let relaunched = XCUIApplication()
        relaunched.launchArguments = ["-FavorUITestMock", "-FavorUITestRespectOnboarding"]
        relaunched.launch()
        XCTAssertTrue(relaunched.staticTexts["host-enrollment"].waitForExistence(timeout: 10))
        XCTAssertFalse(relaunched.staticTexts["onboarding-title"].exists)

        relaunched.terminate()
        let alreadyEnrolled = XCUIApplication()
        alreadyEnrolled.launchArguments = [
            "-FavorUITestMock", "-FavorUITestScenario", "enrolled",
            "-FavorUITestResetOnboarding", "-FavorUITestRespectOnboarding",
        ]
        alreadyEnrolled.launch()
        XCTAssertTrue(alreadyEnrolled.staticTexts["host-enrollment"].waitForExistence(timeout: 10))
        XCTAssertFalse(alreadyEnrolled.staticTexts["onboarding-title"].exists)
    }
}
