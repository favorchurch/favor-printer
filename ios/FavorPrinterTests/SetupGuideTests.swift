import Foundation
import Testing
import UIKit
@testable import FavorPrinter

private func signals(
    attached: Bool? = true, driver: DriverAvailability? = .running, enrollment: HostEnrollment = .enrolled,
    name: String? = nil, guidedAccess: Bool = true, keepAlive: Bool? = nil, active: Bool = false, interrupted: Bool = false
) -> SetupSignals {
    SetupSignals(
        printerAttached: attached, driver: driver, enrollment: enrollment, printerName: name, isGuidedAccessEnabled: guidedAccess,
        keepAlivePreferenceEnabled: keepAlive, isKeepAliveActive: active, isKeepAliveInterrupted: interrupted
    )
}

private func step(_ id: SetupStepID, _ input: SetupSignals) throws -> SetupStep {
    try #require(SetupGuide.steps(for: input).first { $0.id == id })
}

struct SetupGuideStateTests {
    struct Case: Sendable, CustomStringConvertible {
        let label: String
        let id: SetupStepID
        let input: SetupSignals
        let state: SetupStepState
        var description: String { label }
    }

    static let cases: [Case] = [
        Case(label: "cable: attached", id: .cable, input: signals(attached: true, driver: nil), state: .done),
        Case(label: "cable: driver running without attached flag", id: .cable, input: signals(attached: nil, driver: .running), state: .done),
        Case(label: "cable: driver blocked implies seen", id: .cable, input: signals(attached: nil, driver: .printerPresentDriverNotRunning), state: .done),
        Case(label: "cable: nothing seen", id: .cable, input: signals(attached: nil, driver: .unknown), state: .actionNeeded),
        Case(label: "cable: no reading yet", id: .cable, input: signals(attached: nil, driver: nil), state: .actionNeeded),

        Case(label: "driver: running", id: .driver, input: signals(driver: .running), state: .done),
        Case(label: "driver: seen, not running", id: .driver, input: signals(attached: true, driver: .printerPresentDriverNotRunning), state: .actionNeeded),
        Case(label: "driver: attached, driver unknown", id: .driver, input: signals(attached: true, driver: .unknown), state: .actionNeeded),
        Case(label: "driver: no printer", id: .driver, input: signals(attached: nil, driver: .unknown), state: .pending),
        Case(label: "driver: no reading yet", id: .driver, input: signals(attached: nil, driver: nil), state: .pending),

        Case(label: "enrollment: launching", id: .enrollment, input: signals(enrollment: .launching), state: .pending),
        Case(label: "enrollment: not enrolled", id: .enrollment, input: signals(enrollment: .notEnrolled), state: .actionNeeded),
        Case(label: "enrollment: enrolled", id: .enrollment, input: signals(enrollment: .enrolled), state: .done),
        Case(label: "enrollment: fake relay", id: .enrollment, input: signals(enrollment: .fakeRelay), state: .done),

        Case(label: "guided access: on", id: .guidedAccess, input: signals(guidedAccess: true), state: .done),
        Case(label: "guided access: off", id: .guidedAccess, input: signals(guidedAccess: false), state: .actionNeeded),

        Case(label: "auto-lock: always manual (guided access on)", id: .autoLock, input: signals(guidedAccess: true), state: .manualCheck),
        Case(label: "auto-lock: always manual (everything wrong)", id: .autoLock, input: signals(attached: nil, driver: nil, enrollment: .notEnrolled, guidedAccess: false), state: .manualCheck),

        Case(label: "background: no preference", id: .background, input: signals(keepAlive: nil), state: .notApplicable),
        Case(label: "background: no preference ignores audio flags", id: .background, input: signals(keepAlive: nil, active: true, interrupted: true), state: .notApplicable),
        Case(label: "background: off", id: .background, input: signals(keepAlive: false), state: .info),
        Case(label: "background: on", id: .background, input: signals(keepAlive: true), state: .done),
        Case(label: "background: active", id: .background, input: signals(keepAlive: true, active: true), state: .done),
        Case(label: "background: interrupted", id: .background, input: signals(keepAlive: true, active: true, interrupted: true), state: .actionNeeded),
        Case(label: "background: off wins over a stale interruption", id: .background, input: signals(keepAlive: false, interrupted: true), state: .info),
    ]

    @Test(arguments: cases) func stateMapping(_ c: Case) throws {
        #expect(try step(c.id, c.input).state == c.state)
    }

    @Test func stepsAreAlwaysInSetupOrder() {
        #expect(SetupGuide.steps(for: signals()).map(\.id) == SetupStepID.allCases)
        #expect(SetupGuide.steps(for: signals(attached: nil, driver: nil, enrollment: .launching, guidedAccess: false)).map(\.id) == SetupStepID.allCases)
    }
}

struct SetupGuideContentTests {
    @Test func driverFixesComeInOrder() throws {
        let fixes = try step(.driver, signals(driver: .printerPresentDriverNotRunning)).instructions
        #expect(fixes.count == 3)
        #expect(fixes[0].contains("Settings > Favor Printer > Drivers"))
        #expect(fixes[1].localizedCaseInsensitiveContains("unplug and replug"))
        #expect(fixes[2].localizedCaseInsensitiveContains("restart the iPad"))
    }

    @Test func driverWithNoPrinterPointsToTheCableStep() throws {
        let driver = try step(.driver, signals(attached: nil, driver: .unknown))
        #expect(driver.instructions.joined().contains("Printer cable"))
        #expect(!driver.instructions.joined().contains("Settings > Favor Printer"))
    }

    @Test func cableStepNamesDataCableAndReplug() throws {
        let text = try step(.cable, signals(attached: nil, driver: .unknown)).instructions.joined(separator: " ")
        #expect(text.contains("USB-C"))
        #expect(text.localizedCaseInsensitiveContains("no hub"))
        #expect(text.localizedCaseInsensitiveContains("charge-only"))
        #expect(text.localizedCaseInsensitiveContains("unplug and replug"))
    }

    @Test func notEnrolledExplainsTheAdminFlowAndWhereTheCodeGoes() throws {
        let text = try step(.enrollment, signals(enrollment: .notEnrolled)).instructions.joined(separator: " ")
        #expect(text.contains("RSVP admin"))
        #expect(text.contains("printing panel"))
        #expect(text.contains("Hand over from <host>"))
        #expect(text.localizedCaseInsensitiveContains("one-time code"))
        #expect(text.localizedCaseInsensitiveContains("this screen"))
    }

    @Test func enrolledShowsTheNameAndSaysRenamingIsAdminOnly() throws {
        let named = try step(.enrollment, signals(enrollment: .enrolled, name: "Kids desk"))
        #expect(named.summary.contains("Kids desk"))
        #expect(named.instructions.joined().contains("read-only"))
        #expect(named.instructions.joined().contains("Renaming happens in RSVP admin"))
        let unnamed = try step(.enrollment, signals(enrollment: .enrolled, name: nil))
        #expect(unnamed.state == .done)
        #expect(unnamed.summary == "Enrolled")
    }

    @Test func guidedAccessNamesTheSettingsPathAndTripleClick() throws {
        let text = try step(.guidedAccess, signals(guidedAccess: false)).instructions.joined(separator: " ")
        #expect(text.contains("Settings > Accessibility > Guided Access"))
        #expect(text.localizedCaseInsensitiveContains("triple-click"))
        #expect(!text.contains("://"), "no private URL schemes")
    }

    @Test func autoLockIsAManualCheckWithTheSettingsPath() throws {
        let autoLock = try step(.autoLock, signals())
        #expect(autoLock.instructions.joined().contains("Settings > Display & Brightness > Auto-Lock > Never"))
    }

    @Test func backgroundSummaryReportsOnOffActiveAndInterrupted() throws {
        #expect(try step(.background, signals(keepAlive: false)).summary == "Off")
        #expect(try step(.background, signals(keepAlive: true)).summary == "On")
        #expect(try step(.background, signals(keepAlive: true, active: true)).summary == "Active")
        let interrupted = try step(.background, signals(keepAlive: true, active: true, interrupted: true))
        #expect(interrupted.summary == "Interrupted")
        #expect(interrupted.instructions.joined().localizedCaseInsensitiveContains("another app took the audio"))
    }

    @Test func buildsWithoutKeepAliveNeverMentionSilentAudio() {
        let background = SetupGuide.steps(for: signals(keepAlive: nil)).first { $0.id == .background }
        #expect(background?.state == .notApplicable)
        #expect(background?.summary.isEmpty == true)
        #expect(background?.instructions.isEmpty == true)
        let allText = SetupGuide.steps(for: signals(attached: nil, driver: nil, enrollment: .notEnrolled, guidedAccess: false, keepAlive: nil))
            .flatMap { [$0.title, $0.summary] + $0.instructions }.joined(separator: " ").lowercased()
        #expect(!allText.contains("audio"))
        #expect(!allText.contains("silent"))
        #expect(!allText.contains("keep-alive"))
    }
}

/// Polls on the main actor until `condition` holds, for up to two seconds.
@MainActor
private func eventually(_ condition: @MainActor () -> Bool) async -> Bool {
    for _ in 0..<200 {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

@MainActor
private final class GuidedAccessSwitch {
    var isOn = false
}

@MainActor
struct HostEnvironmentTests {
    @Test func readsGuidedAccessAtStartAndOnRefresh() {
        let on = GuidedAccessSwitch()
        let environment = HostEnvironment(guidedAccess: { on.isOn }, notificationCenter: NotificationCenter())
        #expect(!environment.isGuidedAccessEnabled)
        on.isOn = true
        #expect(!environment.isGuidedAccessEnabled, "no re-read until told")
        environment.refresh()
        #expect(environment.isGuidedAccessEnabled)
    }

    @Test func updatesWhenTheSystemPostsAGuidedAccessChange() async {
        let center = NotificationCenter()
        let on = GuidedAccessSwitch()
        let environment = HostEnvironment(guidedAccess: { on.isOn }, notificationCenter: center)
        on.isOn = true
        center.post(name: UIAccessibility.guidedAccessStatusDidChangeNotification, object: nil)
        #expect(await eventually { environment.isGuidedAccessEnabled })
        on.isOn = false
        center.post(name: UIAccessibility.guidedAccessStatusDidChangeNotification, object: nil)
        #expect(await eventually { !environment.isGuidedAccessEnabled })
    }

    @Test func controllerReportsGuidedAccessInTheSetupSteps() throws {
        let on = GuidedAccessSwitch()
        let environment = HostEnvironment(guidedAccess: { on.isOn }, notificationCenter: NotificationCenter())
        let controller = try SetupControllerFactory.make(environment: environment)
        #expect(controller.setupSteps.first { $0.id == .guidedAccess }?.state == .actionNeeded)
        on.isOn = true
        controller.scenePhaseChanged(.active)
        #expect(controller.setupSteps.first { $0.id == .guidedAccess }?.state == .done, "becoming active re-reads Guided Access")
    }
}

@MainActor
private final class RecordingAudio: KeepAliveAudioSession {
    var onInterruption: (@MainActor (KeepAliveAudioInterruption) -> Void)?
    var failResume = false
    private(set) var startCount = 0
    func start() throws { startCount += 1 }
    func resume() throws { if failResume { throw URLError(.unknown) } }
    func stop() {}
    func interrupt(_ event: KeepAliveAudioInterruption) { onInterruption?(event) }
}

@MainActor
private enum SetupControllerFactory {
    static func make(
        environment: HostEnvironment = HostEnvironment(guidedAccess: { true }, notificationCenter: NotificationCenter()),
        audio: (any KeepAliveAudioSession)? = nil, preference: KeepAlivePreference? = nil,
        printer: UsbPrinterStatus = FakeUsbTransport.readyStatus, enrolled: Bool = true,
        enroll: @escaping @Sendable (RelayEnrollRequest) async throws -> RelayCredentials = { _ in throw RelayEnrollFailure.network }
    ) throws -> HostController {
        HostController(
            backend: .real(
                credentials: SecretHostCredentialStore(secrets: enrolled ? storedCredential() : InMemorySecretStore(nil)),
                makeRelay: { _ in FakeRelay() },
                enroll: enroll
            ),
            transport: FakeUsbTransport(status: printer), spool: try HostSpool(directory: TempDirectory().url),
            identity: testIdentity, timing: fastTiming,
            keepAliveAudio: audio, keepAlivePreference: preference, environment: environment
        )
    }
}

@MainActor
struct SetupControllerWiringTests {
    private func step(_ id: SetupStepID, _ controller: HostController) throws -> SetupStep {
        try #require(controller.setupSteps.first { $0.id == id })
    }

    @Test func unpluggedPrinterPointsToTheCable() async throws {
        let controller = try SetupControllerFactory.make(printer: UsbPrinterStatus(driver: .unknown))
        await controller.refreshPrinter()
        #expect(try step(.cable, controller).state == .actionNeeded)
        #expect(try step(.driver, controller).state == .pending)
    }

    @Test func blockedDriverShowsTheOrderedFixes() async throws {
        let controller = try SetupControllerFactory.make(
            printer: UsbPrinterStatus(driver: .printerPresentDriverNotRunning, printerAttached: true)
        )
        await controller.refreshPrinter()
        #expect(try step(.cable, controller).state == .done)
        let driver = try step(.driver, controller)
        #expect(driver.state == .actionNeeded)
        #expect(driver.instructions.count == 3)
        #expect(driver.instructions[0].contains("Settings > Favor Printer > Drivers"))
        #expect(driver.instructions[2].contains("restart the iPad"))
    }

    @Test func readyPrinterIsDoneForCableAndDriver() async throws {
        let controller = try SetupControllerFactory.make()
        await controller.refreshPrinter()
        #expect(try step(.cable, controller).state == .done)
        #expect(try step(.driver, controller).state == .done)
    }

    @Test func notEnrolledThenEnrolledWithThePrinterNameFromConfig() async throws {
        let controller = try SetupControllerFactory.make(
            enrolled: false,
            enroll: { _ in
                try JSONDecoder().decode(
                    RelayCredentials.self,
                    from: Data(#"{"relayId":"r","token":"t","printer":{"id":"p1","name":"Kids desk"}}"#.utf8)
                )
            }
        )
        #expect(try step(.enrollment, controller).state == .pending, "before the credential is read")
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(try step(.enrollment, controller).state == .actionNeeded)

        #expect(await controller.enroll(code: "ABC123") == nil)
        let enrollment = try step(.enrollment, controller)
        #expect(enrollment.state == .done)
        #expect(enrollment.summary.contains("Fake printer"), "the name comes from the relay config FakeRelay serves")
        controller.scenePhaseChanged(.background)
        await controller.settled()
    }

    @Test func autoLockStaysManualWhateverTheHostState() async throws {
        let controller = try SetupControllerFactory.make(printer: UsbPrinterStatus(driver: .unknown), enrolled: false)
        #expect(try step(.autoLock, controller).state == .manualCheck)
        let ready = try SetupControllerFactory.make()
        await ready.refreshPrinter()
        #expect(try step(.autoLock, ready).state == .manualCheck)
    }
}

#if DEBUG
struct UITestScenarioTests {
    @Test func scenarioNameFollowsTheFlag() {
        for scenario in UITestHarness.Scenario.allCases {
            #expect(UITestHarness.Scenario.resolve(arguments: ["-FavorUITestMock", "-FavorUITestScenario", scenario.rawValue]) == scenario)
        }
        #expect(UITestHarness.Scenario.resolve(arguments: ["-FavorUITestMock"]) == nil)
        #expect(UITestHarness.Scenario.resolve(arguments: ["-FavorUITestScenario"]) == nil)
        #expect(UITestHarness.Scenario.resolve(arguments: ["-FavorUITestScenario", "nonsense"]) == nil)
    }

    @MainActor
    @Test func everyScenarioReachesItsGuidanceState() async throws {
        func steps(_ scenario: UITestHarness.Scenario) async throws -> [SetupStepID: SetupStepState] {
            let host = try #require(UITestHarness.makeHost(arguments: ["-FavorUITestMock", "-FavorUITestScenario", scenario.rawValue]))
            host.scenePhaseChanged(.active)
            await host.settled()
            await host.refreshPrinter()
            let result = Dictionary(uniqueKeysWithValues: host.setupSteps.map { ($0.id, $0.state) })
            host.scenePhaseChanged(.background)
            await host.settled()
            return result
        }
        let driverOff = try await steps(.driverNotRunning)
        #expect(driverOff[.driver] == .actionNeeded && driverOff[.cable] == .done)
        let unplugged = try await steps(.unplugged)
        #expect(unplugged[.cable] == .actionNeeded && unplugged[.driver] == .pending)
        let notEnrolled = try await steps(.notEnrolled)
        #expect(notEnrolled[.enrollment] == .actionNeeded && notEnrolled[.guidedAccess] == .done && notEnrolled[.background] == .notApplicable)
        let enrolled = try await steps(.enrolled)
        #expect(enrolled[.enrollment] == .done)
        let interrupted = try await steps(.keepAliveInterrupted)
        #expect(interrupted[.background] == .actionNeeded)
        let guidedOff = try await steps(.guidedAccessOff)
        #expect(guidedOff[.guidedAccess] == .actionNeeded)
    }
}
#endif

@MainActor
struct KeepAliveInterruptionSignalTests {
    private func backgroundStep(_ controller: HostController) -> SetupStep? {
        controller.setupSteps.first { $0.id == .background }
    }

    private func makePreference() throws -> (KeepAlivePreference, () -> Void) {
        let name = "setup-guide-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        return (KeepAlivePreference(defaults: defaults), { defaults.removePersistentDomain(forName: name) })
    }

    @Test func buildWithoutPreferenceHidesTheStepAndNeverStartsAudio() async throws {
        let audio = RecordingAudio()
        let controller = try SetupControllerFactory.make(audio: audio, preference: nil)
        controller.scenePhaseChanged(.background)
        await controller.settled()
        audio.interrupt(.began)
        #expect(backgroundStep(controller)?.state == .notApplicable)
        #expect(audio.startCount == 0, "without a preference the audio is never started")
        controller.scenePhaseChanged(.active)
        await controller.settled()
    }

    @Test func interruptionShowsAndResumeClears() async throws {
        let (preference, cleanup) = try makePreference()
        defer { cleanup() }
        let audio = RecordingAudio()
        let controller = try SetupControllerFactory.make(audio: audio, preference: preference)
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(backgroundStep(controller)?.summary == "On")

        controller.scenePhaseChanged(.background)
        await controller.settled()
        #expect(backgroundStep(controller)?.summary == "Active")

        audio.interrupt(.began)
        await controller.settled()
        #expect(backgroundStep(controller)?.summary == "Interrupted")
        #expect(backgroundStep(controller)?.state == .actionNeeded)

        audio.interrupt(.ended)
        await controller.settled()
        #expect(backgroundStep(controller)?.summary == "Active")
        #expect(backgroundStep(controller)?.state == .done)

        controller.scenePhaseChanged(.active)
        await controller.settled()
    }

    @Test func failedResumeThatStopsTheAudioClearsTheInterruption() async throws {
        let (preference, cleanup) = try makePreference()
        defer { cleanup() }
        let audio = RecordingAudio()
        audio.failResume = true
        let controller = try SetupControllerFactory.make(audio: audio, preference: preference)
        controller.scenePhaseChanged(.background)
        await controller.settled()
        audio.interrupt(.began)
        await controller.settled()
        #expect(controller.isKeepAliveInterrupted)
        audio.interrupt(.ended)
        await controller.settled()
        #expect(!controller.isKeepAliveInterrupted, "the audio was given up, so nothing is waiting to resume")
        #expect(backgroundStep(controller)?.summary == "On")
        controller.scenePhaseChanged(.active)
        await controller.settled()
    }

    @Test func returningToTheForegroundClearsTheInterruption() async throws {
        let (preference, cleanup) = try makePreference()
        defer { cleanup() }
        let audio = RecordingAudio()
        let controller = try SetupControllerFactory.make(audio: audio, preference: preference)
        controller.scenePhaseChanged(.background)
        await controller.settled()
        audio.interrupt(.began)
        await controller.settled()
        #expect(controller.isKeepAliveInterrupted)
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(!controller.isKeepAliveInterrupted)
        #expect(backgroundStep(controller)?.summary == "On")
    }

    @Test func switchingTheSettingOffWhileInterruptedReadsOff() async throws {
        let (preference, cleanup) = try makePreference()
        defer { cleanup() }
        let audio = RecordingAudio()
        let controller = try SetupControllerFactory.make(audio: audio, preference: preference)
        controller.scenePhaseChanged(.background)
        await controller.settled()
        audio.interrupt(.began)
        await controller.settled()
        preference.isEnabled = false
        #expect(backgroundStep(controller)?.state == .info)
        #expect(backgroundStep(controller)?.summary == "Off")
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(!controller.isKeepAliveInterrupted)
    }
}
