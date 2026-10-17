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
        #expect(named.instructions.joined().contains("RSVP admin"))
        let unnamed = try step(.enrollment, signals(enrollment: .enrolled, name: nil))
        #expect(unnamed.state == .done)
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
        #expect(environment.isGuidedAccessEnabled)
        on.isOn = false
        center.post(name: UIAccessibility.guidedAccessStatusDidChangeNotification, object: nil)
        #expect(!environment.isGuidedAccessEnabled)
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
    func start() throws {}
    func resume() throws { if failResume { throw URLError(.unknown) } }
    func stop() {}
    func interrupt(_ event: KeepAliveAudioInterruption) { onInterruption?(event) }
}

@MainActor
private enum SetupControllerFactory {
    static func make(
        environment: HostEnvironment = HostEnvironment(guidedAccess: { true }, notificationCenter: NotificationCenter()),
        audio: (any KeepAliveAudioSession)? = nil, preference: KeepAlivePreference? = nil
    ) throws -> HostController {
        HostController(
            backend: .real(
                credentials: SecretHostCredentialStore(secrets: storedCredential()),
                makeRelay: { _ in FakeRelay() },
                enroll: { _ in throw RelayEnrollFailure.network }
            ),
            transport: FakeUsbTransport(), spool: try HostSpool(directory: TempDirectory().url),
            identity: testIdentity, timing: fastTiming,
            keepAliveAudio: audio, keepAlivePreference: preference, environment: environment
        )
    }
}

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

    @Test func buildWithoutPreferenceHidesTheStepEvenAfterAnInterruption() async throws {
        let audio = RecordingAudio()
        let controller = try SetupControllerFactory.make(audio: audio, preference: nil)
        controller.scenePhaseChanged(.background)
        await controller.settled()
        audio.interrupt(.began)
        #expect(backgroundStep(controller)?.state == .notApplicable)
        #expect(!controller.isKeepAliveInterrupted)
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

    @Test func switchingTheSettingOffReadsOffNotInterrupted() async throws {
        let (preference, cleanup) = try makePreference()
        defer { cleanup() }
        let controller = try SetupControllerFactory.make(audio: RecordingAudio(), preference: preference)
        preference.isEnabled = false
        #expect(backgroundStep(controller)?.state == .info)
        #expect(backgroundStep(controller)?.summary == "Off")
    }
}
