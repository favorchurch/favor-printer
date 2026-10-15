import SwiftUI

struct RootView: View {
    let host: HostController
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack { HostStatusView(host: host) }
            .onChange(of: scenePhase, initial: true) { _, phase in host.scenePhaseChanged(phase) }
    }
}

struct ConfigErrorView: View {
    let message: String

    var body: some View {
        ContentUnavailableView("Cannot start", systemImage: "exclamationmark.triangle", description: Text(message))
    }
}
