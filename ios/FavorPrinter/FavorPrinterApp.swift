import SwiftUI

@main
struct FavorPrinterApp: App {
    @State private var host: HostController?
    @State private var configError: String?

    var body: some Scene {
        WindowGroup {
            Group {
                if let host {
                    RootView(host: host)
                } else if let configError {
                    ConfigErrorView(message: configError)
                } else {
                    ProgressView()
                }
            }
            .task { bootstrap() }
        }
    }

    private func bootstrap() {
        guard host == nil else { return }
        #if DEBUG
        if UITestHarness.isActive {
            host = UITestHarness.makeHost()
            return
        }
        #endif
        let config: AppConfig
        do { config = try AppConfig.loadAfterCleanup() } catch {
            configError = "This build has no valid HTTPS RSVP address."
            return
        }
        do { host = try HostController.make(baseURL: config.rsvpBaseURL) } catch {
            configError = "The print queue on this iPad could not be opened."
        }
    }
}
