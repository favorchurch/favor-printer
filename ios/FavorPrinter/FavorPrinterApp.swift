import SwiftUI

@main
struct FavorPrinterApp: App {
    @State private var session: DeviceSession?
    @State private var service: CheckinService?
    @State private var configError: String?

    var body: some Scene {
        WindowGroup {
            Group {
                if let session, let service {
                    RootView(session: session, service: service)
                } else if let configError {
                    ConfigErrorView(message: configError)
                } else {
                    ProgressView()
                }
            }
            .task { await bootstrap() }
        }
    }

    private func bootstrap() async {
        guard session == nil else { return }
        #if DEBUG
        if UITestHarness.isActive {
            let (model, checkin) = UITestHarness.makeSession()
            session = model
            service = checkin
            await model.start()
            return
        }
        #endif
        do {
            let config = try AppConfig.load()
            let client = try DeviceAPIClient(baseURL: config.rsvpBaseURL)
            let model = DeviceSession(api: client, secrets: KeychainSecretStore(), records: UserDefaultsRecordStore())
            session = model
            service = CheckinService(session: model, api: client, connectivity: NetworkMonitor())
            await model.start()
        } catch {
            configError = "This build has no valid HTTPS RSVP address."
        }
    }
}
