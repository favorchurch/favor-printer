import Foundation
import Observation
import SwiftUI

/// Which relay the host talks to. Chosen once at launch from the launch arguments, never from stored state.
enum HostRelayMode: Sendable, Equatable {
    /// The cloud relay, using the stored host credential if there is one.
    case real
    /// DEBUG only: `FakeRelay`. No host credential is read and no HTTP client is built.
    case fake

    static let fakeRelayArgument = "-FavorHostFakeRelay"

    static func resolve(arguments: [String]) -> HostRelayMode {
        #if DEBUG
        arguments.contains(fakeRelayArgument) ? .fake : .real
        #else
        .real
        #endif
    }
}

enum HostEnrollment: Sendable, Equatable {
    /// The stored credential has not been read yet (or the Keychain would not answer).
    case launching
    case notEnrolled
    case enrolled
    /// DEBUG fake-relay mode: always "enrolled" against `FakeRelay`.
    case fakeRelay
}

/// Why host work stopped or enrollment failed. `message` is safe to show a volunteer.
enum HostError: Error, Sendable, Equatable {
    case enrollment(RelayEnrollFailure)
    case printerNotReady
    case fakeRelayActive
    case credentialUnavailable
    case relayUnavailable
    case authRejected

    var message: String {
        switch self {
        case .enrollment(let failure): Self.message(for: failure)
        case .printerNotReady:
            "The printer is not ready. Plug it in, turn on the Favor Printer driver in Settings, then try again."
        case .fakeRelayActive: "This build runs against the fake relay. Enrollment is turned off."
        case .credentialUnavailable: "Could not read or save the relay key on this iPad. Nothing was removed; try again."
        case .relayUnavailable: "This build has no valid HTTPS relay address."
        case .authRejected: "The relay no longer accepts this iPad. Enroll again with a new code. Waiting jobs were kept."
        }
    }

    private static func message(for failure: RelayEnrollFailure) -> String {
        switch failure {
        case .printerConflict(let reason): message(for: reason)
        case .codeUsed: "That code was already used. Ask for a new one."
        case .invalidRequest: "The enrollment request was refused. Check the code and try again."
        case .codeExpired: "That code has expired. Ask for a new one."
        case .invalidCode: "That code is not valid."
        case .throttled: "Too many attempts. Wait a minute and try again."
        case .disabled: "Enrollment is turned off for now."
        case .network: "Could not reach the server. Check the connection and try again."
        }
    }

    private static func message(for reason: RelayEnrollReason) -> String {
        switch reason {
        case .targetNotFound: "The printer this code was made for no longer exists."
        case .targetDisabled: "The printer this code was made for is turned off."
        case .campusMismatch: "This printer belongs to a different campus than the code."
        case .targetSerialMismatch: "The attached printer is not the one this code was made for."
        case .serialOtherCampus: "This printer is already set up for another campus."
        case .serialDuplicateHasJobs: "This printer is already set up and has waiting jobs."
        case .serialInUse: "This printer is already in use by another device."
        case .printerNameTaken: "Another printer already has this name."
        case .unknown: "The server could not bind this printer."
        }
    }
}

/// Owns the host side of the iPad: enrollment, the credential, and the foreground-only print loop.
///
/// The loop runs only while the app is active. `scenePhaseChanged(_:)` stops it on background and starts it again on
/// active; there are no background tasks. Lifecycle changes run one at a time, in the order they arrive.
@MainActor
@Observable
final class HostController {
    enum Backend: Sendable {
        case real(
            credentials: any HostCredentialStore,
            makeRelay: @Sendable (HostCredential) throws -> any HostRelay,
            enroll: @Sendable (RelayEnrollRequest) async throws -> RelayCredentials
        )
        #if DEBUG
        case fake(FakeRelay)
        #endif
    }

    private(set) var enrollment: HostEnrollment = .launching
    private(set) var status = HostStatus()
    private(set) var error: HostError?
    private(set) var isLoopRunning = false
    private(set) var isEnrolling = false
    private(set) var printerName: String?

    @ObservationIgnored private let backend: Backend
    @ObservationIgnored private let transport: any UsbPrinterTransport
    @ObservationIgnored private let spool: HostSpool
    @ObservationIgnored private let identity: HostIdentity
    @ObservationIgnored private let timing: HostLoop.Timing
    @ObservationIgnored private let now: @Sendable () -> Date

    @ObservationIgnored private var relay: (any HostRelay)?
    @ObservationIgnored private var loop: HostLoop?
    @ObservationIgnored private var statusTask: Task<Void, Never>?
    @ObservationIgnored private var lifecycle: Task<Void, Never>?
    @ObservationIgnored private var isForeground = false
    @ObservationIgnored private var authBlocked = false

    init(
        backend: Backend,
        transport: any UsbPrinterTransport,
        spool: HostSpool,
        identity: HostIdentity = .current,
        timing: HostLoop.Timing = HostLoop.Timing(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.backend = backend
        self.transport = transport
        self.spool = spool
        self.identity = identity
        self.timing = timing
        self.now = now
    }

    /// Builds the controller for this launch. The relay is chosen by `arguments` alone: `-FavorHostFakeRelay` (DEBUG
    /// builds) selects `FakeRelay` without reading the host credential or building an HTTP client; otherwise a stored
    /// credential selects the cloud relay at `baseURL`, and none means not enrolled.
    static func make(
        arguments: [String] = CommandLine.arguments,
        baseURL: URL,
        credentials: any HostCredentialStore = SecretHostCredentialStore(),
        transport: (any UsbPrinterTransport)? = nil,
        spoolDirectory: URL? = nil,
        session: URLSession? = nil,
        identity: HostIdentity = .current,
        timing: HostLoop.Timing = HostLoop.Timing()
    ) throws -> HostController {
        switch HostRelayMode.resolve(arguments: arguments) {
        case .real:
            let spool = try HostSpool(directory: spoolDirectory ?? HostSpool.defaultDirectory())
            return HostController(
                backend: .real(
                    credentials: credentials,
                    makeRelay: { credential in
                        try RelayAPIClient(
                            baseURL: baseURL, relayId: credential.relayId, token: credential.token,
                            session: session ?? RelayAPIClient.makeSession()
                        )
                    },
                    enroll: { request in
                        try await RelayAPIClient.enroll(baseURL: baseURL, request: request, session: session ?? RelayAPIClient.makeSession())
                    }
                ),
                transport: transport ?? DriverKitUsbTransport(),
                spool: spool, identity: identity, timing: timing
            )
        case .fake:
            #if DEBUG
            // Fake jobs live apart from real ones: a real claimed job must never be printed or reported by the fake.
            let directory = try spoolDirectory ?? HostSpool.defaultDirectory().deletingLastPathComponent()
                .appending(path: "HostSpoolFake", directoryHint: .isDirectory)
            return HostController(
                backend: .fake(FakeRelay.demo()),
                transport: transport ?? FakeUsbTransport(),
                spool: try HostSpool(directory: directory), identity: identity, timing: timing
            )
            #else
            preconditionFailure("the fake relay is not compiled into this build")
            #endif
        }
    }

    #if DEBUG
    var fakeRelay: FakeRelay? {
        if case .fake(let relay) = backend { relay } else { nil }
    }

    /// Queues one small synthetic label on the fake relay. Does nothing against the real relay.
    func printSyntheticTestLabel() async {
        await fakeRelay?.enqueue(zpl: "^XA^FO40,40^A0N,48,48^FDFavor synthetic test^FS^XZ", label: "Synthetic test")
    }
    #endif

    // MARK: Scene phase

    /// Foreground-only: stop the loop on `.background`, resume on `.active`. `.inactive` (a system sheet, the app
    /// switcher) changes nothing. Call it for the current phase when the view appears, too.
    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .active: isForeground = true
        case .background: isForeground = false
        case .inactive: return
        @unknown default: return
        }
        schedule { await self.reconcile() }
    }

    /// Waits until every queued lifecycle change has been applied.
    func settled() async {
        await lifecycle?.value
    }

    /// Reads the printer and driver once for the host screen. The loop reports both every cycle while it runs, so this
    /// only matters when it does not (not enrolled, in the background): it keeps the screen from showing stale or no
    /// driver state.
    func refreshPrinter() async {
        let reading = await transport.status()
        guard !isLoopRunning else { return }
        status.driver = reading.driver
        status.printerAttached = reading.printerAttached
        status.printerReady = reading.driver == .running && reading.printerAttached == true
    }

    // MARK: Enrollment

    /// Redeems a one-time enrollment code for this iPad's attached printer. On success the relay id and token go to
    /// the host credential store, config is fetched, and the loop starts if the app is in the foreground. A failure
    /// leaves any earlier credential and the loop as they were.
    /// Returns nil on success, otherwise the reason (also in `error`).
    @discardableResult
    func enroll(code: String) async -> HostError? {
        await schedule { await self.performEnroll(code: code) }.value
    }

    /// Stops the loop and deletes the host credential, nothing else: not the check-in bearer and not the spool. A job
    /// still waiting in the spool is refused as stale by the cloud on its next enrollment and dropped.
    func unenroll() async {
        await schedule { await self.performUnenroll() }.value
    }

    /// Clears the auth error and lets the loop run again. The credential is tried once more.
    func retryAfterAuthError() {
        authBlocked = false
        if error == .authRejected { error = nil }
        schedule { await self.reconcile() }
    }

    private func performEnroll(code: String) async -> HostError? {
        guard case .real(let credentials, let makeRelay, let enroll) = backend else { return fail(.fakeRelayActive) }
        resolveRelayIfNeeded()
        error = nil
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return fail(.enrollment(.invalidCode)) }
        let reading = await transport.status()
        guard reading.driver == .running, let serial = reading.usbSerial, !serial.isEmpty else { return fail(.printerNotReady) }

        isEnrolling = true
        defer { isEnrolling = false }
        let issued: RelayCredentials
        do {
            issued = try await enroll(RelayEnrollRequest(code: trimmed, usbSerial: serial, appVersion: identity.appVersion, osVersion: identity.osVersion))
        } catch let failure as RelayEnrollFailure {
            return fail(.enrollment(failure))
        } catch RelayFailure.insecureBaseURL {
            return fail(.relayUnavailable)
        } catch {
            return fail(.enrollment(.network))
        }

        // Build the client before saving, so nothing is stored for a credential that cannot be used.
        let credential = HostCredential(relayId: issued.relayId, token: issued.token)
        let newRelay: any HostRelay
        do { newRelay = try makeRelay(credential) } catch { return fail(.relayUnavailable) }
        do { try credentials.save(credential) } catch { return fail(.credentialUnavailable) }

        await stopLoop()
        install(newRelay)
        authBlocked = false
        enrollment = .enrolled
        printerName = issued.printer?.name
        if let config = try? await newRelay.config(), let first = config.printers.first {
            printerName = first.name
        }
        await reconcile()
        return nil
    }

    private func performUnenroll() async {
        guard case .real(let credentials, _, _) = backend else { return }
        await stopLoop()
        do { try credentials.delete() } catch {
            // The credential is still there, so stay enrolled and let the loop carry on.
            self.error = .credentialUnavailable
            await reconcile()
            return
        }
        uninstall()
        authBlocked = false
        error = nil
        printerName = nil
        status = HostStatus()
        enrollment = .notEnrolled
    }

    private func fail(_ failure: HostError) -> HostError {
        error = failure
        return failure
    }

    // MARK: Lifecycle

    /// Queues lifecycle work to run one item at a time, in arrival order. The queue is updated before this returns.
    @discardableResult
    private func schedule<T: Sendable>(_ work: @escaping @MainActor () async -> T) -> Task<T, Never> {
        let previous = lifecycle
        let task = Task { () -> T in
            await previous?.value
            return await work()
        }
        lifecycle = Task { _ = await task.value }
        return task
    }

    /// Brings the loop in line with the current state: running only while the app is active, a relay exists and the
    /// cloud has not refused the credential.
    private func reconcile() async {
        resolveRelayIfNeeded()
        let shouldRun = isForeground && relay != nil && !authBlocked
        guard let loop else { return }
        if shouldRun {
            await loop.start()
            isLoopRunning = await loop.isRunning
        } else {
            await stopLoop()
        }
    }

    private func resolveRelayIfNeeded() {
        guard relay == nil, enrollment == .launching || enrollment == .notEnrolled else { return }
        switch backend {
        case .real(let credentials, let makeRelay, _):
            let credential: HostCredential?
            do { credential = try credentials.load() } catch {
                // A locked Keychain is not "not enrolled": keep waiting and report it.
                self.error = .credentialUnavailable
                return
            }
            if error == .credentialUnavailable { error = nil }
            guard let credential else {
                enrollment = .notEnrolled
                return
            }
            do {
                install(try makeRelay(credential))
                enrollment = .enrolled
            } catch {
                self.error = .relayUnavailable
            }
        #if DEBUG
        case .fake(let fake):
            install(fake)
            enrollment = .fakeRelay
        #endif
        }
    }

    private func install(_ newRelay: any HostRelay) {
        uninstall()
        let (stream, continuation) = AsyncStream.makeStream(of: HostStatus.self)
        relay = newRelay
        loop = HostLoop(
            relay: newRelay, transport: transport, spool: spool, identity: identity, timing: timing, now: now,
            onStatus: { continuation.yield($0) }
        )
        statusTask = Task { [weak self] in
            for await status in stream { self?.apply(status) }
        }
    }

    private func uninstall() {
        statusTask?.cancel()
        statusTask = nil
        loop = nil
        relay = nil
        isLoopRunning = false
    }

    private func stopLoop() async {
        await loop?.stop()
        isLoopRunning = false
    }

    private func apply(_ newStatus: HostStatus) {
        status = newStatus
        if newStatus.authRejected {
            authBlocked = true
            error = .authRejected
            isLoopRunning = false
        }
    }
}
