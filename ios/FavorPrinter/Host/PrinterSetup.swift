import Foundation

/// The "Set up printer" action: puts a Zebra printer in continuous-media mode, calibrates it and saves the
/// setting. It prints blank labels and runs the cutter. Payloads are fixed commands, never label content.
enum PrinterSetup {
    enum Step: Sendable, Equatable, CaseIterable {
        case continuousMedia
        case calibrate
        case saveMediaTracking

        var payload: Data {
            switch self {
            case .continuousMedia: PrinterSetup.continuousMediaCommand
            case .calibrate: PrinterSetup.calibrateCommand
            case .saveMediaTracking: PrinterSetup.saveMediaTrackingCommand
            }
        }

        var title: String {
            switch self {
            case .continuousMedia: "Set continuous media"
            case .calibrate: "Calibrate"
            case .saveMediaTracking: "Save media setting"
            }
        }
    }

    enum Outcome: Sendable, Equatable {
        case done
        case failed(step: Step, error: UsbTransportError)
        /// Another setup is already running.
        case busy
    }

    /// `^MMC` sets the print mode to tear-off with the cutter (continuous media).
    static let continuousMediaCommand = Data("^XA^MMC^XZ".utf8)
    /// `~JC` calibrates the media sensor, feeding blank labels.
    static let calibrateCommand = Data("~JC".utf8)
    /// `^JUS` saves the current configuration to the printer.
    static let saveMediaTrackingCommand = Data("^XA^JUS^XZ".utf8)

    /// Sends the three commands in order as separate writes and stops at the first failure.
    static func run(on transport: any UsbPrinterTransport) async -> Outcome {
        for step in Step.allCases {
            if case .failure(let error) = await transport.send(step.payload) {
                return .failed(step: step, error: error)
            }
        }
        return .done
    }
}
