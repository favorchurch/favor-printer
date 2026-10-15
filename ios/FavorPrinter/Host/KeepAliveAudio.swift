import AVFoundation
import Foundation

/// What the audio session reports while the keep-alive experiment holds it.
enum KeepAliveAudioInterruption: Sendable, Equatable {
    case began
    case ended
}

/// The DEBUG keep-alive audio experiment's seam. `HostController` drives it from scene phase changes; the real one
/// plays a looping silent buffer, tests use a fake.
@MainActor
protocol KeepAliveAudioSession: AnyObject {
    var onInterruption: (@MainActor (KeepAliveAudioInterruption) -> Void)? { get set }
    func start() throws
    /// Re-activates the session and playback after an interruption ended.
    func resume() throws
    func stop()
}

enum HostKeepAliveAudio {
    static let launchArgument = "-FavorHostKeepAliveAudio"

    /// DEBUG only. Release builds ignore the flag (and carry no `audio` background mode).
    static func enabled(arguments: [String]) -> Bool {
        #if DEBUG
        arguments.contains(launchArgument)
        #else
        false
        #endif
    }
}

#if DEBUG
/// Plays a silent looping buffer through a `.playback` + `.mixWithOthers` session. Unsupported experiment: App Store
/// review (guideline 2.5.4) rejects silent-audio keep-alive.
@MainActor
final class SilentLoopAudioSession: KeepAliveAudioSession {
    var onInterruption: (@MainActor (KeepAliveAudioInterruption) -> Void)?
    private var player: AVAudioPlayer?
    private var observer: (any NSObjectProtocol)?

    init() {}

    enum KeepAliveAudioError: Error { case playbackFailed }

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try session.setActive(true)
        if player == nil {
            let player = try AVAudioPlayer(data: Self.silentWAV(seconds: 1))
            player.numberOfLoops = -1
            player.prepareToPlay()
            self.player = player
        }
        guard player?.play() == true else { throw KeepAliveAudioError.playbackFailed }
        if observer == nil {
            observer = NotificationCenter.default.addObserver(
                forName: AVAudioSession.interruptionNotification, object: AVAudioSession.sharedInstance(), queue: .main
            ) { [weak self] notification in
                let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
                MainActor.assumeIsolated {
                    guard let self, let raw, let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
                    switch type {
                    case .began: self.onInterruption?(.began)
                    case .ended: self.onInterruption?(.ended)
                    @unknown default: break
                    }
                }
            }
        }
    }

    func resume() throws {
        try AVAudioSession.sharedInstance().setActive(true)
        guard player?.play() == true else { throw KeepAliveAudioError.playbackFailed }
    }

    func stop() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        player?.stop()
        player = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// A mono 8 kHz 16-bit PCM WAV of digital silence.
    static func silentWAV(seconds: Int) -> Data {
        let sampleRate = 8000
        let dataSize = sampleRate * seconds * 2
        var data = Data()
        func append32(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        func append16(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        data.append(contentsOf: Array("RIFF".utf8)); append32(UInt32(36 + dataSize))
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); append32(16); append16(1); append16(1)
        append32(UInt32(sampleRate)); append32(UInt32(sampleRate * 2)); append16(2); append16(16)
        data.append(contentsOf: Array("data".utf8)); append32(UInt32(dataSize))
        data.append(Data(count: dataSize))
        return data
    }
}
#endif
