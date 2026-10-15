import Foundation
import Observation
import SwiftUI
import UIKit

struct BackgroundExperimentJob: Codable, Sendable, Equatable {
    let at: Date
    let outcome: String
}

/// A keep-alive audio session event: "audio started", "audio stopped", "audio interrupted", "audio resumed", or a failure.
struct BackgroundExperimentAudioEvent: Codable, Sendable, Equatable {
    let at: Date
    let name: String
}

struct BackgroundExperimentState: Codable, Sendable, Equatable {
    var backgroundedAt: Date?
    var jobs: [BackgroundExperimentJob] = []
    var expiredAt: Date?
    var lastHeartbeatAt: Date?
    var returnedToForegroundAt: Date?
    var audioEvents: [BackgroundExperimentAudioEvent] = []

    static let defaultsKey = "FavorPrinter.BackgroundExperiment"

    func containsBackgroundEvent(at date: Date) -> Bool {
        guard let backgroundedAt, date >= backgroundedAt else { return false }
        return returnedToForegroundAt.map { date <= $0 } ?? true
    }
}

enum HostBackgroundExperiment {
    static let launchArgument = "-FavorHostBackgroundExperiment"

    static func enabled(arguments: [String]) -> Bool {
        #if DEBUG
        arguments.contains(launchArgument)
        #else
        false
        #endif
    }
}

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

/// Which printer transport the host drives. The real dext transport is the default in every mode, the fake relay
/// included, so the fake relay's synthetic label goes through the real driver and printer.
enum HostTransportMode: Sendable, Equatable {
    case driverKit
    /// DEBUG only: `FakeUsbTransport`, for simulator UI tests. Requested by its own launch argument, never implied.
    case fake

    static let fakeTransportArgument = "-FavorHostFakeTransport"

    static func resolve(arguments: [String]) -> HostTransportMode {
        #if DEBUG
        arguments.contains(fakeTransportArgument) ? .fake : .driverKit
        #else
        .driverKit
        #endif
    }

    func makeTransport() -> any UsbPrinterTransport {
        #if DEBUG
        if self == .fake { return FakeUsbTransport() }
        #endif
        return DriverKitUsbTransport()
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
        case .hostActive:
            "This printer is active on another host. Ask an RSVP admin to confirm a handover, then use the new code."
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
    /// Set by an enrollment that moved the printer off another host. Cleared on unenroll.
    private(set) var handedOverFrom: RelayHandedOverFrom?

    @ObservationIgnored private let backend: Backend
    @ObservationIgnored let transport: any UsbPrinterTransport
    @ObservationIgnored private let spool: HostSpool
    @ObservationIgnored private let identity: HostIdentity
    @ObservationIgnored private let timing: HostLoop.Timing
    @ObservationIgnored private let now: @Sendable () -> Date
    private let backgroundExperimentEnabled: Bool
    private let experimentDefaults: UserDefaults
    private let beginBackgroundTask: (@escaping @MainActor () -> Void) -> Int
    private let endBackgroundTask: (Int) -> Void
    private let keepAliveAudio: (any KeepAliveAudioSession)?
    @ObservationIgnored private var isKeepAliveAudioActive = false
    private(set) var backgroundExperiment: BackgroundExperimentState
    @ObservationIgnored private var backgroundTaskId: Int?
    /// Background tasks begun for a "paused" beat and not yet ended. Each begin has exactly one end.
    @ObservationIgnored private var pausedBeatTaskIds: Set<Int> = []
    @ObservationIgnored private var backgroundEnqueueTask: Task<Void, Never>?
    @ObservationIgnored private var lastExperimentJobAt: Date?

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
        now: @escaping @Sendable () -> Date = { Date() },
        backgroundExperimentEnabled: Bool = false,
        experimentDefaults: UserDefaults = .standard,
        beginBackgroundTask: @escaping (@escaping @MainActor () -> Void) -> Int = { expiration in
            let identifier = UIApplication.shared.beginBackgroundTask(withName: "FavorPrinter host", expirationHandler: expiration)
            return identifier == .invalid ? -1 : identifier.rawValue
        },
        endBackgroundTask: @escaping (Int) -> Void = { UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: $0)) },
        keepAliveAudio: (any KeepAliveAudioSession)? = nil
    ) {
        self.backend = backend
        self.transport = transport
        self.spool = spool
        self.identity = identity
        self.timing = timing
        self.now = now
        self.backgroundExperimentEnabled = backgroundExperimentEnabled
        self.experimentDefaults = experimentDefaults
        self.beginBackgroundTask = beginBackgroundTask
        self.endBackgroundTask = endBackgroundTask
        self.keepAliveAudio = backgroundExperimentEnabled ? keepAliveAudio : nil
        self.backgroundExperiment = ((experimentDefaults.object(forKey: BackgroundExperimentState.defaultsKey) as? Data)
            .flatMap { try? JSONDecoder().decode(BackgroundExperimentState.self, from: $0) }) ?? BackgroundExperimentState()
        #if DEBUG
        self.keepAliveAudio?.onInterruption = { [weak self] event in self?.keepAliveAudioInterrupted(event) }
        #endif
    }

    /// Builds the controller for this launch. The relay is chosen by `arguments` alone: `-FavorHostFakeRelay` (DEBUG
    /// builds) selects `FakeRelay` without reading the host credential or building an HTTP client; otherwise a stored
    /// credential selects the cloud relay at `baseURL`, and none means not enrolled. The transport is the real
    /// DriverKit one unless `transport` is passed or a DEBUG build is launched with `-FavorHostFakeTransport`; the
    /// relay choice never changes it.
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
                transport: transport ?? HostTransportMode.resolve(arguments: arguments).makeTransport(),
                spool: spool, identity: identity, timing: timing,
                backgroundExperimentEnabled: HostBackgroundExperiment.enabled(arguments: arguments) || HostKeepAliveAudio.enabled(arguments: arguments),
                keepAliveAudio: Self.makeKeepAliveAudio(arguments: arguments)
            )
        case .fake:
            #if DEBUG
            // Fake jobs live apart from real ones: a real claimed job must never be printed or reported by the fake.
            let directory = try spoolDirectory ?? HostSpool.defaultDirectory().deletingLastPathComponent()
                .appending(path: "HostSpoolFake", directoryHint: .isDirectory)
            return HostController(
                backend: .fake(FakeRelay.demo()),
                transport: transport ?? HostTransportMode.resolve(arguments: arguments).makeTransport(),
                spool: try HostSpool(directory: directory), identity: identity, timing: timing,
                backgroundExperimentEnabled: HostBackgroundExperiment.enabled(arguments: arguments) || HostKeepAliveAudio.enabled(arguments: arguments),
                keepAliveAudio: Self.makeKeepAliveAudio(arguments: arguments)
            )
            #else
            preconditionFailure("the fake relay is not compiled into this build")
            #endif
        }
    }

    private static func makeKeepAliveAudio(arguments: [String]) -> (any KeepAliveAudioSession)? {
        #if DEBUG
        HostKeepAliveAudio.enabled(arguments: arguments) ? SilentLoopAudioSession() : nil
        #else
        nil
        #endif
    }

    #if DEBUG
    private(set) var isReadingPrinterStatus = false
    var backgroundExperimentEnabledForDisplay: Bool { backgroundExperimentEnabled }

    /// DEBUG only. Sends `~HS` and reads the answer, to see what the printer says over bulk IN. The loop is paused for
    /// the read and resumed after, so the probe never shares the wire with a job: pausing waits for a send already
    /// writing, and no new one starts until the probe is done. It runs in the lifecycle queue with enrollment and scene
    /// changes. A second request while one is running is refused.
    func readPrinterStatus() async -> PrinterStatusReading {
        guard !isReadingPrinterStatus else { return .busy }
        isReadingPrinterStatus = true
        defer { isReadingPrinterStatus = false }
        return await schedule { await self.performReadPrinterStatus() }.value
    }

    private func performReadPrinterStatus() async -> PrinterStatusReading {
        await stopLoop()
        let reading = await PrinterStatusReading.read(from: transport)
        await reconcile()
        return reading
    }

    var fakeRelay: FakeRelay? {
        if case .fake(let relay) = backend { relay } else { nil }
    }

    /// Queues one small synthetic label on the fake relay. Does nothing against the real relay.
    func printSyntheticTestLabel() async {
        await fakeRelay?.enqueue(zpl: "^XA^FO40,40^A0N,48,48^FDFavor synthetic test^FS^XZ", label: "Synthetic test")
    }

    /// Queues the large synthetic label on the fake relay: the normal job path, but a payload that needs several send
    /// calls, for unplugging the printer mid-send. Does nothing against the real relay.
    func printLargeSyntheticTestLabel() async {
        await fakeRelay?.enqueue(zpl: Self.largeSyntheticLabelZPL, label: "Large synthetic test")
    }

    /// An 800 x 1000 dot `^GFA` graphic: a frame with a stripe every 50 rows, about 200 KB of ZPL (100,000 graphic
    /// bytes as hex). Uncompressed on purpose, so the payload is as large as it looks.
    nonisolated static let largeSyntheticLabelZPL: String = {
        let rowBytes = 100, rows = 1000
        let solid = String(repeating: "FF", count: rowBytes)
        let stripe = String(repeating: "AA", count: rowBytes)
        let edges = "80" + String(repeating: "00", count: rowBytes - 2) + "01"
        var graphic = ""
        graphic.reserveCapacity(rowBytes * rows * 2)
        for row in 0..<rows {
            graphic += row == 0 || row == rows - 1 ? solid : (row % 50 == 0 ? stripe : edges)
        }
        return "^XA^FO0,0^GFA,\(rowBytes * rows),\(rowBytes * rows),\(rowBytes),\(graphic)^FS^XZ"
    }()
    #endif

    // MARK: Scene phase

    /// The DEBUG experiment keeps the loop alive under an iOS background task. Normal launches stay foreground-only.
    /// `.inactive` (a system sheet, the app switcher) changes nothing. Call it for the current phase when the view appears.
    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .active:
            isForeground = true
#if DEBUG
            if backgroundExperimentEnabled, backgroundExperiment.backgroundedAt != nil,
               backgroundExperiment.returnedToForegroundAt == nil {
                backgroundExperiment.returnedToForegroundAt = now()
                persistBackgroundExperiment()
                endExperimentBackgroundTask()
                stopKeepAliveAudio()
                backgroundEnqueueTask?.cancel()
                backgroundEnqueueTask = nil
            }
#endif
        case .background:
            isForeground = false
            var keepsRunning = false
#if DEBUG
            keepsRunning = backgroundExperimentEnabled
#endif
            if !keepsRunning {
                // The beat is prepared in the lifecycle queue ahead of the stop, so a stop cannot win the race.
                let taskId = beginPausedBeatTask()
                schedule { await self.pausedBeatThenReconcile(taskId) }
                return
            }
#if DEBUG
            if backgroundExperimentEnabled {
                backgroundExperiment.backgroundedAt = now()
                backgroundExperiment.expiredAt = nil
                backgroundExperiment.returnedToForegroundAt = nil
                lastExperimentJobAt = status.lastJobAt
                persistBackgroundExperiment()
                startKeepAliveAudio()
                beginExperimentBackgroundTask()
                enqueueSyntheticLabelsWhileBackgrounded()
                schedule { await self.reconcile() }
                return
            }
#endif
        case .inactive: return
        @unknown default: return
        }
        schedule { await self.reconcile() }
    }

    /// Begins the short background task a "paused" beat runs under. Nil when the system refused one.
    private func beginPausedBeatTask() -> Int? {
        var begun: Int?
        let id = beginBackgroundTask { [weak self] in
            // Expiry ends this task now; the beat is abandoned with it.
            if let begun = begun { self?.endPausedBeatTask(begun) }
        }
        guard id >= 0 else { return nil }
        begun = id
        pausedBeatTaskIds.insert(id)
        return id
    }

    /// Ends the task once. A second call for the same id (expiry after completion, or the reverse) does nothing.
    private func endPausedBeatTask(_ id: Int) {
        guard pausedBeatTaskIds.remove(id) != nil else { return }
        endBackgroundTask(id)
    }

    /// Starts one best-effort "paused" heartbeat (under the background task), then applies the stop. The beat runs
    /// beside the queue, so it never delays the stop or a send in flight, and a failure is ignored.
    private func pausedBeatThenReconcile(_ taskId: Int?) async {
        if let loop, let beat = await loop.startPausedHeartbeat() {
            Task { [weak self] in
                await beat.value
                if let taskId { self?.endPausedBeatTask(taskId) }
            }
        } else if let taskId {
            endPausedBeatTask(taskId)
        }
        // Back in the foreground before the stop ran: the loop stays up, so it must report "active" again.
        if isForeground, let loop { await loop.resumeAfterPausedHeartbeat() }
        await reconcile()
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
#if DEBUG
        status.driverDiagnostic = reading.debugDiagnostic
#endif
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

    /// Stops the loop and deletes the host credential, nothing else: not the spool. A job
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
        handedOverFrom = issued.handedOverFrom
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
        handedOverFrom = nil
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
        let shouldRun = (isForeground || isBackgroundExperimentRunning) && relay != nil && !authBlocked
        guard let loop else { return }
        if shouldRun {
            await loop.start()
            isLoopRunning = await loop.isRunning
        } else {
            await stopLoop()
        }
    }

    private var isBackgroundExperimentRunning: Bool {
#if DEBUG
        backgroundExperimentEnabled && backgroundExperiment.backgroundedAt != nil
            && (isKeepAliveAudioActive || (backgroundTaskId != nil && backgroundExperiment.expiredAt == nil))
#else
        false
#endif
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
#if DEBUG
        if backgroundExperimentEnabled {
            if let at = newStatus.lastJobAt,
               backgroundExperiment.containsBackgroundEvent(at: at),
               at != lastExperimentJobAt,
               let outcome = newStatus.lastJobOutcome {
                backgroundExperiment.jobs.append(BackgroundExperimentJob(at: at, outcome: outcome.rawValue))
                lastExperimentJobAt = at
                persistBackgroundExperiment()
            }
            if let heartbeat = newStatus.lastHeartbeatAt,
               backgroundExperiment.containsBackgroundEvent(at: heartbeat),
               heartbeat != backgroundExperiment.lastHeartbeatAt {
                backgroundExperiment.lastHeartbeatAt = heartbeat
                persistBackgroundExperiment()
            }
        }
#endif
        if newStatus.authRejected {
            authBlocked = true
            error = .authRejected
            isLoopRunning = false
        }
    }

#if DEBUG
    private func persistBackgroundExperiment() {
        guard let data = try? JSONEncoder().encode(backgroundExperiment) else { return }
        experimentDefaults.set(data, forKey: BackgroundExperimentState.defaultsKey)
    }

    private func beginExperimentBackgroundTask() {
        guard backgroundTaskId == nil else { return }
        let id = beginBackgroundTask { [weak self] in
            guard let self else { return }
            self.backgroundTaskExpired()
        }
        guard id >= 0 else {
            schedule { await self.stopLoop() }
            return
        }
        backgroundTaskId = id
    }

    private func endExperimentBackgroundTask() {
        guard let id = backgroundTaskId else { return }
        backgroundTaskId = nil
        endBackgroundTask(id)
    }

    private func backgroundTaskExpired() {
        guard !isForeground, backgroundExperimentEnabled else { return }
        backgroundExperiment.expiredAt = now()
        persistBackgroundExperiment()
        if isKeepAliveAudioActive {
            // The audio session keeps the app running: the loop and the synthetic queue continue.
            schedule { self.endExperimentBackgroundTask() }
            return
        }
        backgroundEnqueueTask?.cancel()
        backgroundEnqueueTask = nil
        schedule {
            await self.stopLoop()
            self.endExperimentBackgroundTask()
        }
    }

    private func recordAudioEvent(_ name: String) {
        backgroundExperiment.audioEvents.append(BackgroundExperimentAudioEvent(at: now(), name: name))
        persistBackgroundExperiment()
    }

    private func startKeepAliveAudio() {
        guard let keepAliveAudio, !isKeepAliveAudioActive else { return }
        do {
            try keepAliveAudio.start()
            isKeepAliveAudioActive = true
            recordAudioEvent("audio started")
        } catch {
            recordAudioEvent("audio start failed")
        }
    }

    private func stopKeepAliveAudio() {
        guard let keepAliveAudio, isKeepAliveAudioActive else { return }
        isKeepAliveAudioActive = false
        keepAliveAudio.stop()
        recordAudioEvent("audio stopped")
    }

    private func keepAliveAudioInterrupted(_ event: KeepAliveAudioInterruption) {
        guard let keepAliveAudio, isKeepAliveAudioActive else { return }
        switch event {
        case .began:
            recordAudioEvent("audio interrupted")
        case .ended:
            do {
                try keepAliveAudio.resume()
                recordAudioEvent("audio resumed")
            } catch {
                recordAudioEvent("audio resume failed")
            }
        }
    }

    private func enqueueSyntheticLabelsWhileBackgrounded() {
        guard backgroundEnqueueTask == nil, let relay = fakeRelay else { return }
        backgroundEnqueueTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                guard !Task.isCancelled, let self, !self.isForeground else { return }
                await relay.enqueue(zpl: "^XA^FO40,40^A0N,48,48^FDFavor background experiment^FS^XZ", label: "Background experiment")
            }
        }
    }
#endif
}
