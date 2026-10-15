import Foundation
import Testing
@testable import FavorPrinter

#if DEBUG
@MainActor
private final class FakeKeepAliveAudio: KeepAliveAudioSession {
    var onInterruption: (@MainActor (KeepAliveAudioInterruption) -> Void)?
    private(set) var calls: [String] = []
    var failResume = false
    var failStart = false

    func start() throws {
        calls.append("start")
        if failStart { throw URLError(.unknown) }
    }
    func resume() throws {
        calls.append("resume")
        if failResume { throw URLError(.unknown) }
    }
    func stop() { calls.append("stop") }
    func interrupt(_ event: KeepAliveAudioInterruption) { onInterruption?(event) }
}

@MainActor
private final class AudioTaskHarness {
    private(set) var expiration: (@MainActor () -> Void)?
    func begin(_ expiration: @escaping @MainActor () -> Void) -> Int {
        self.expiration = expiration
        return 1
    }
}

@MainActor
struct KeepAliveAudioTests {
    private func makeController(
        audio: FakeKeepAliveAudio?, experiment: Bool, harness: AudioTaskHarness, defaults: UserDefaults, relay: FakeRelay = FakeRelay()
    ) throws -> HostController {
        HostController(
            backend: .real(
                credentials: SecretHostCredentialStore(secrets: storedCredential()),
                makeRelay: { _ in relay },
                enroll: { _ in throw RelayEnrollFailure.network }
            ),
            transport: FakeUsbTransport(), spool: try HostSpool(directory: TempDirectory().url),
            identity: testIdentity, timing: fastTiming, backgroundExperimentEnabled: experiment,
            experimentDefaults: defaults,
            beginBackgroundTask: { harness.begin($0) },
            endBackgroundTask: { _ in },
            keepAliveAudio: audio
        )
    }

    @Test func launchArgumentIsRecognised() {
        #expect(HostKeepAliveAudio.enabled(arguments: ["-FavorHostKeepAliveAudio"]))
        #expect(!HostKeepAliveAudio.enabled(arguments: ["-FavorHostBackgroundExperiment"]))
        #expect(!HostKeepAliveAudio.enabled(arguments: []))
    }

    @Test func flagAbsentNeverStartsAudio() async throws {
        let suiteName = "keepalive-absent-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        let audio = FakeKeepAliveAudio()
        // The experiment is off, so the controller must discard the audio session entirely.
        let off = try makeController(audio: audio, experiment: false, harness: AudioTaskHarness(), defaults: defaults)
        off.scenePhaseChanged(.active)
        await off.settled()
        off.scenePhaseChanged(.background)
        await off.settled()
        off.scenePhaseChanged(.active)
        await off.settled()
        #expect(audio.calls.isEmpty)
        #expect(audio.onInterruption == nil)
        #expect(off.backgroundExperiment.audioEvents.isEmpty)

        // The background experiment without the audio flag has no session either.
        let plain = try makeController(audio: nil, experiment: true, harness: AudioTaskHarness(), defaults: defaults)
        plain.scenePhaseChanged(.background)
        await plain.settled()
        #expect(plain.backgroundExperiment.audioEvents.isEmpty)
        plain.scenePhaseChanged(.active)
        await plain.settled()
        defaults.removePersistentDomain(forName: suiteName)
    }

    @Test func audioStartsOnBackgroundAndStopsOnActive() async throws {
        let suiteName = "keepalive-sequence-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        let audio = FakeKeepAliveAudio()
        let controller = try makeController(audio: audio, experiment: true, harness: AudioTaskHarness(), defaults: defaults)

        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(audio.calls.isEmpty, "audio must not start while foregrounded")

        controller.scenePhaseChanged(.inactive)
        await controller.settled()
        #expect(audio.calls.isEmpty)

        controller.scenePhaseChanged(.background)
        await controller.settled()
        controller.scenePhaseChanged(.background)
        await controller.settled()
        #expect(audio.calls == ["start"], "a repeated background must not restart audio")

        controller.scenePhaseChanged(.active)
        await controller.settled()
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(audio.calls == ["start", "stop"])
        #expect(controller.backgroundExperiment.audioEvents.map(\.name) == ["audio started", "audio stopped"])

        let restored = try makeController(audio: nil, experiment: true, harness: AudioTaskHarness(), defaults: defaults)
        #expect(restored.backgroundExperiment.audioEvents == controller.backgroundExperiment.audioEvents)
        defaults.removePersistentDomain(forName: suiteName)
    }

    @Test func interruptionIsRecordedAndSessionReactivatedWhenItEnds() async throws {
        let suiteName = "keepalive-interruption-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        let audio = FakeKeepAliveAudio()
        let controller = try makeController(audio: audio, experiment: true, harness: AudioTaskHarness(), defaults: defaults)

        audio.interrupt(.began)
        #expect(audio.calls.isEmpty, "an interruption before audio started is ignored")

        controller.scenePhaseChanged(.background)
        await controller.settled()
        audio.interrupt(.began)
        #expect(audio.calls == ["start"], "an interruption beginning needs no action")
        audio.interrupt(.ended)
        #expect(audio.calls == ["start", "resume"])
        audio.failResume = true
        audio.interrupt(.began)
        audio.interrupt(.ended)
        #expect(controller.backgroundExperiment.audioEvents.map(\.name) == [
            "audio started", "audio interrupted", "audio resumed", "audio interrupted", "audio resume failed",
        ])

        controller.scenePhaseChanged(.active)
        await controller.settled()
        audio.interrupt(.ended)
        #expect(audio.calls.last == "stop", "no resume once audio was stopped")
        defaults.removePersistentDomain(forName: suiteName)
    }

    @Test func audioKeepsTheLoopRunningPastBackgroundTaskExpiration() async throws {
        let suiteName = "keepalive-expiry-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        let audio = FakeKeepAliveAudio()
        let harness = AudioTaskHarness()
        let controller = try makeController(audio: audio, experiment: true, harness: harness, defaults: defaults)

        controller.scenePhaseChanged(.active)
        await controller.settled()
        controller.scenePhaseChanged(.background)
        await controller.settled()
        harness.expiration?()
        await controller.settled()
        #expect(controller.backgroundExperiment.expiredAt != nil)
        #expect(controller.isLoopRunning, "the audio session should keep the loop alive after the task expires")

        controller.scenePhaseChanged(.active)
        await controller.settled()
        defaults.removePersistentDomain(forName: suiteName)
    }

    @Test func silentWAVHasAValidHeader() {
        let data = SilentLoopAudioSession.silentWAV(seconds: 1)
        #expect(data.count == 44 + 16000)
        #expect(String(decoding: data.prefix(4), as: UTF8.self) == "RIFF")
        #expect(data.dropFirst(44).allSatisfy { $0 == 0 })
    }
}

@MainActor
struct KeepAliveToggleTests {
    private func makeController(
        audio: FakeKeepAliveAudio, preference: KeepAlivePreference, harness: AudioTaskHarness = AudioTaskHarness(),
        relay: FakeRelay = FakeRelay()
    ) throws -> HostController {
        // Experiment off: this is the supported (Internal build) path, with no DEBUG experiment involved.
        HostController(
            backend: .real(
                credentials: SecretHostCredentialStore(secrets: storedCredential()),
                makeRelay: { _ in relay },
                enroll: { _ in throw RelayEnrollFailure.network }
            ),
            transport: FakeUsbTransport(), spool: try HostSpool(directory: TempDirectory().url),
            identity: testIdentity, timing: fastTiming,
            beginBackgroundTask: { harness.begin($0) }, endBackgroundTask: { _ in },
            keepAliveAudio: audio, keepAlivePreference: preference
        )
    }

    private func makeDefaults() throws -> (UserDefaults, String) {
        let name = "keepalive-toggle-\(UUID().uuidString)"
        return (try #require(UserDefaults(suiteName: name)), name)
    }

    @Test func toggleDefaultsOnAndPersists() throws {
        let (defaults, name) = try makeDefaults()
        let preference = KeepAlivePreference(defaults: defaults)
        #expect(preference.isEnabled)
        preference.isEnabled = false
        #expect(!KeepAlivePreference(defaults: defaults).isEnabled)
        preference.isEnabled = true
        #expect(KeepAlivePreference(defaults: defaults).isEnabled)
        defaults.removePersistentDomain(forName: name)
    }

    @Test func toggleOffNeverStartsAudioAndStopsTheLoopInTheBackground() async throws {
        let (defaults, name) = try makeDefaults()
        let preference = KeepAlivePreference(defaults: defaults)
        preference.isEnabled = false
        let audio = FakeKeepAliveAudio()
        let controller = try makeController(audio: audio, preference: preference)
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(controller.isLoopRunning)
        controller.scenePhaseChanged(.background)
        await controller.settled()
        #expect(!controller.isLoopRunning, "toggle off is the foreground-only loop")
        #expect(!controller.isKeepAliveAudioActive)
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(audio.calls.isEmpty)
        defaults.removePersistentDomain(forName: name)
    }

    @Test func toggleOnStartsOnBackgroundAndStopsOnActive() async throws {
        let (defaults, name) = try makeDefaults()
        let audio = FakeKeepAliveAudio()
        let controller = try makeController(audio: audio, preference: KeepAlivePreference(defaults: defaults))
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(audio.calls.isEmpty)
        controller.scenePhaseChanged(.background)
        await controller.settled()
        controller.scenePhaseChanged(.background)
        await controller.settled()
        #expect(audio.calls == ["start"])
        #expect(controller.isKeepAliveAudioActive)
        audio.interrupt(.ended)
        #expect(audio.calls == ["start", "resume"])
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(audio.calls == ["start", "resume", "stop"])
        #expect(!controller.isKeepAliveAudioActive)
        defaults.removePersistentDomain(forName: name)
    }

    @Test func loopContinuesInTheBackgroundWhileKeepAliveIsActive() async throws {
        let (defaults, name) = try makeDefaults()
        let audio = FakeKeepAliveAudio()
        let controller = try makeController(audio: audio, preference: KeepAlivePreference(defaults: defaults))
        controller.scenePhaseChanged(.active)
        await controller.settled()
        controller.scenePhaseChanged(.background)
        await controller.settled()
        #expect(controller.isLoopRunning)
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(controller.isLoopRunning)
        defaults.removePersistentDomain(forName: name)
    }

    @Test func keepAliveOnBackgroundedSendsNoPausedBeatAndActiveBeatsContinue() async throws {
        let (defaults, name) = try makeDefaults()
        let relay = FakeRelay()
        let audio = FakeKeepAliveAudio()
        let controller = try makeController(audio: audio, preference: KeepAlivePreference(defaults: defaults), relay: relay)
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(await eventually { await relay.heartbeats.count >= 1 })
        controller.scenePhaseChanged(.background)
        await controller.settled()
        let before = await relay.heartbeats.count
        #expect(await eventually { await relay.heartbeats.count > before + 1 })
        #expect(await relay.heartbeats.allSatisfy { $0.lifecycle == .active })
        #expect(controller.isLoopRunning)
        controller.scenePhaseChanged(.active)
        await controller.settled()
        defaults.removePersistentDomain(forName: name)
    }

    @Test func keepAliveOffBackgroundedSendsThePausedBeat() async throws {
        let (defaults, name) = try makeDefaults()
        let preference = KeepAlivePreference(defaults: defaults)
        preference.isEnabled = false
        let relay = FakeRelay()
        let controller = try makeController(audio: FakeKeepAliveAudio(), preference: preference, relay: relay)
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(await eventually { await relay.heartbeats.count >= 1 })
        controller.scenePhaseChanged(.background)
        await controller.settled()
        #expect(await eventually { await relay.heartbeats.last?.lifecycle == .paused })
        #expect(!controller.isLoopRunning)
        defaults.removePersistentDomain(forName: name)
    }

    @Test func audioStartFailureSendsThePausedBeat() async throws {
        let (defaults, name) = try makeDefaults()
        let relay = FakeRelay()
        let audio = FakeKeepAliveAudio()
        audio.failStart = true
        let controller = try makeController(audio: audio, preference: KeepAlivePreference(defaults: defaults), relay: relay)
        controller.scenePhaseChanged(.active)
        await controller.settled()
        #expect(await eventually { await relay.heartbeats.count >= 1 })
        controller.scenePhaseChanged(.background)
        await controller.settled()
        #expect(await eventually { await relay.heartbeats.last?.lifecycle == .paused })
        #expect(!controller.isKeepAliveAudioActive)
        #expect(!controller.isLoopRunning)
        defaults.removePersistentDomain(forName: name)
    }
}
#endif
