import Foundation

/// What the setup guide reads from the host. Plain values, so every state maps without hardware.
struct SetupSignals: Sendable, Equatable {
    var printerAttached: Bool?
    var driver: DriverAvailability?
    var enrollment: HostEnrollment
    var printerName: String?
    var isGuidedAccessEnabled: Bool
    /// nil when this build has no keep-alive (everything but Internal and TestFlight): the background step is hidden.
    var keepAlivePreferenceEnabled: Bool?
    var isKeepAliveActive: Bool
    var isKeepAliveInterrupted: Bool
}

enum SetupStepID: String, CaseIterable, Sendable {
    case cable, driver, enrollment, guidedAccess, autoLock, background
}

enum SetupStepState: Sendable, Equatable {
    case done
    /// The volunteer has to do something.
    case actionNeeded
    /// Waiting on an earlier step, or the first reading has not arrived.
    case pending
    /// Cannot be detected: the volunteer checks it by hand.
    case manualCheck
    /// A setting that is off by choice and needs nothing.
    case info
    /// Not part of this build. The screen leaves it out.
    case notApplicable
}

struct SetupStep: Sendable, Equatable, Identifiable {
    let id: SetupStepID
    let title: String
    let state: SetupStepState
    /// One short line: the current value or why the step is in this state.
    let summary: String
    /// What to do, in order. Empty when `state` is `done`, `info` or `notApplicable` and there is nothing to add.
    let instructions: [String]
}

/// Maps host signals to the guided setup steps. Instructions name Settings paths in words only: no private URL schemes.
enum SetupGuide {
    static func steps(for signals: SetupSignals) -> [SetupStep] {
        let cableSeen = printerSeen(signals)
        return [
            cable(seen: cableSeen),
            driver(signals, printerSeen: cableSeen),
            enrollment(signals),
            guidedAccess(signals),
            autoLock(),
            background(signals),
        ]
    }

    /// The printer is known to be on the cable. A running or blocked driver implies it, since the dext only matches an
    /// attached printer; `printerAttached` is never false, only true or unknown.
    private static func printerSeen(_ signals: SetupSignals) -> Bool {
        signals.printerAttached == true || signals.driver == .running || signals.driver == .printerPresentDriverNotRunning
    }

    private static func cable(seen: Bool) -> SetupStep {
        if seen {
            return SetupStep(id: .cable, title: "Printer cable", state: .done, summary: "Printer seen", instructions: [])
        }
        return SetupStep(
            id: .cable, title: "Printer cable", state: .actionNeeded, summary: "Printer not seen",
            instructions: [
                "Plug the Zebra directly into the iPad's USB-C port with a data cable. No hub, and not a charge-only cable.",
                "Unplug and replug the cable once.",
            ]
        )
    }

    private static func driver(_ signals: SetupSignals, printerSeen: Bool) -> SetupStep {
        let title = "Printer driver"
        if signals.driver == .running {
            return SetupStep(id: .driver, title: title, state: .done, summary: "Running", instructions: [])
        }
        guard printerSeen else {
            return SetupStep(
                id: .driver, title: title, state: .pending, summary: "Waiting for the printer",
                instructions: ["Connect the printer first. See Printer cable."]
            )
        }
        return SetupStep(
            id: .driver, title: title, state: .actionNeeded, summary: "Printer seen, driver not running",
            instructions: [
                "Open Settings > Favor Printer > Drivers and turn the driver on.",
                "Unplug and replug the printer.",
                "If it still says not running, restart the iPad.",
            ]
        )
    }

    private static func enrollment(_ signals: SetupSignals) -> SetupStep {
        let title = "Enrollment"
        switch signals.enrollment {
        case .launching:
            return SetupStep(id: .enrollment, title: title, state: .pending, summary: "Checking", instructions: [])
        case .notEnrolled:
            return SetupStep(
                id: .enrollment, title: title, state: .actionNeeded, summary: "Not enrolled",
                instructions: [
                    "An RSVP admin opens the printing panel and picks the existing campus printer, or adds it.",
                    "If the printer is hosted on another device, the admin chooses \"Hand over from <host>\".",
                    "The admin gets a one-time code. Type it on this screen.",
                ]
            )
        case .enrolled, .fakeRelay:
            let name = signals.printerName.map { "Printer: \($0)" } ?? "Enrolled"
            return SetupStep(
                id: .enrollment, title: title, state: .done, summary: name,
                instructions: ["The printer name is read-only here. Renaming happens in RSVP admin."]
            )
        }
    }

    private static func guidedAccess(_ signals: SetupSignals) -> SetupStep {
        let title = "Guided Access"
        if signals.isGuidedAccessEnabled {
            return SetupStep(id: .guidedAccess, title: title, state: .done, summary: "On", instructions: [])
        }
        return SetupStep(
            id: .guidedAccess, title: title, state: .actionNeeded, summary: "Off",
            instructions: [
                "Turn on Settings > Accessibility > Guided Access.",
                "Open Favor Printer and triple-click the top button (the Home button on iPads that have one) to start.",
            ]
        )
    }

    private static func autoLock() -> SetupStep {
        SetupStep(
            id: .autoLock, title: "Auto-Lock", state: .manualCheck, summary: "Check by hand",
            instructions: ["Set Settings > Display & Brightness > Auto-Lock > Never. The app cannot read this setting."]
        )
    }

    private static func background(_ signals: SetupSignals) -> SetupStep {
        let title = "Background printing"
        guard let enabled = signals.keepAlivePreferenceEnabled else {
            return SetupStep(id: .background, title: title, state: .notApplicable, summary: "", instructions: [])
        }
        guard enabled else {
            return SetupStep(
                id: .background, title: title, state: .info, summary: "Off",
                instructions: ["Printing pauses while the app is in the background. Keep it open on screen."]
            )
        }
        if signals.isKeepAliveInterrupted {
            return SetupStep(
                id: .background, title: title, state: .actionNeeded, summary: "Interrupted",
                instructions: [
                    "Another app took the audio. Printing pauses in the background until it resumes or you bring this app to the front.",
                ]
            )
        }
        return SetupStep(
            id: .background, title: title, state: .done, summary: signals.isKeepAliveActive ? "Active" : "On", instructions: []
        )
    }
}
