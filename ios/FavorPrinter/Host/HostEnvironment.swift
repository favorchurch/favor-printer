import Foundation
import Observation
import UIKit

/// iPad settings the setup guide can read. Guided Access is the only one iOS reports: Auto-Lock is not detectable.
@MainActor
@Observable
final class HostEnvironment {
    private(set) var isGuidedAccessEnabled: Bool

    @ObservationIgnored private let readGuidedAccess: @MainActor () -> Bool
    @ObservationIgnored private let notificationCenter: NotificationCenter
    @ObservationIgnored nonisolated(unsafe) private var observer: (any NSObjectProtocol)?

    init(
        guidedAccess: @escaping @MainActor () -> Bool = { UIAccessibility.isGuidedAccessEnabled },
        notificationCenter: NotificationCenter = .default
    ) {
        readGuidedAccess = guidedAccess
        self.notificationCenter = notificationCenter
        isGuidedAccessEnabled = guidedAccess()
        observer = notificationCenter.addObserver(
            forName: UIAccessibility.guidedAccessStatusDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    deinit {
        if let observer { notificationCenter.removeObserver(observer) }
    }

    /// Re-reads the signals. Runs on the system's change notification and whenever the app becomes active.
    func refresh() {
        isGuidedAccessEnabled = readGuidedAccess()
    }
}
