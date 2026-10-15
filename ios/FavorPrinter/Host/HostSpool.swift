import Darwin
import Foundation

/// One claimed job as it moves through the host loop. Only a `claimed` entry carries the label and ZPL;
/// the transitions below drop them, and the initializer is private so no other stage can hold them.
///
///   claimed  claimed from the cloud, nothing written to the printer
///   sending  marked durably before the first byte goes out; bytes may have reached the printer
///   report   the outcome is known and still has to reach the cloud
struct SpoolEntry: Codable, Sendable, Equatable {
    enum Stage: String, Codable, Sendable { case claimed, sending, report }

    let id: String
    let printerId: String
    let copy: Int
    let attempt: Int
    let claimToken: String
    let leaseExpiresAt: String
    let claimedAt: Date
    let stage: Stage
    let label: String?
    let zpl: String?
    private let outcomeRaw: String?
    let error: String?

    var outcome: RelayReportOutcome? { outcomeRaw.flatMap(RelayReportOutcome.init(rawValue:)) }

    private init(
        id: String, printerId: String, copy: Int, attempt: Int, claimToken: String, leaseExpiresAt: String,
        claimedAt: Date, stage: Stage, label: String?, zpl: String?, outcomeRaw: String?, error: String?
    ) {
        self.id = id
        self.printerId = printerId
        self.copy = copy
        self.attempt = attempt
        self.claimToken = claimToken
        self.leaseExpiresAt = leaseExpiresAt
        self.claimedAt = claimedAt
        self.stage = stage
        self.label = stage == .claimed ? label : nil
        self.zpl = stage == .claimed ? zpl : nil
        self.outcomeRaw = outcomeRaw
        self.error = error
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        self.init(
            id: try container.decode(String.self, forKey: .id),
            printerId: try container.decode(String.self, forKey: .printerId),
            copy: try container.decode(Int.self, forKey: .copy),
            attempt: try container.decode(Int.self, forKey: .attempt),
            claimToken: try container.decode(String.self, forKey: .claimToken),
            leaseExpiresAt: try container.decode(String.self, forKey: .leaseExpiresAt),
            claimedAt: try container.decode(Date.self, forKey: .claimedAt),
            stage: try container.decode(Stage.self, forKey: .stage),
            label: try container.decodeIfPresent(String.self, forKey: .label),
            zpl: try container.decodeIfPresent(String.self, forKey: .zpl),
            outcomeRaw: try container.decodeIfPresent(String.self, forKey: .outcomeRaw),
            error: try container.decodeIfPresent(String.self, forKey: .error)
        )
    }

    private enum Keys: String, CodingKey {
        case id, printerId, copy, attempt, claimToken, leaseExpiresAt, claimedAt, stage, label, zpl, outcomeRaw, error
    }

    static func claimed(_ job: RelayJob, at date: Date) -> SpoolEntry {
        SpoolEntry(
            id: job.id, printerId: job.printerId, copy: job.copy, attempt: job.attempt, claimToken: job.claimToken,
            leaseExpiresAt: job.leaseExpiresAt, claimedAt: date, stage: .claimed, label: job.label, zpl: job.zpl,
            outcomeRaw: nil, error: nil
        )
    }

    func markedSending() -> SpoolEntry { moved(to: .sending, outcome: nil, error: nil) }

    func reported(_ outcome: RelayReportOutcome, error: String?) -> SpoolEntry {
        moved(to: .report, outcome: outcome.rawValue, error: error)
    }

    private func moved(to stage: Stage, outcome: String?, error: String?) -> SpoolEntry {
        SpoolEntry(
            id: id, printerId: printerId, copy: copy, attempt: attempt, claimToken: claimToken,
            leaseExpiresAt: leaseExpiresAt, claimedAt: claimedAt, stage: stage, label: nil, zpl: nil,
            outcomeRaw: outcome, error: error
        )
    }
}

/// One JSON file per unreported job in the app container. Each write goes to a temp file that is synced and renamed
/// into place, so a crash leaves the old entry or the new one, never a torn file.
actor HostSpool {
    /// Longest job id kept: the id becomes a file name.
    static let maxIdLength = 80

    nonisolated let directory: URL
    private let fileManager = FileManager.default

    init(directory: URL) throws {
        self.directory = directory
        let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: protection)
        try? fileManager.setAttributes(protection, ofItemAtPath: directory.path)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var excluded = directory
        try? excluded.setResourceValues(values)
        // A temp file left by a crash before its rename was never an entry.
        for url in try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) where url.pathExtension == "tmp" {
            try? fileManager.removeItem(at: url)
        }
    }

    static func defaultDirectory() throws -> URL {
        try FileManager.default
            .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appending(path: "FavorPrinter/HostSpool", directoryHint: .isDirectory)
    }

    /// Entries in claim order. A file that cannot be decoded is skipped and left in place.
    func list() -> [SpoolEntry] {
        let urls = (try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        let decoder = Self.decoder
        return urls
            .filter { $0.pathExtension == "json" }
            .compactMap { try? decoder.decode(SpoolEntry.self, from: Data(contentsOf: $0)) }
            .sorted { ($0.claimedAt, $0.id) < ($1.claimedAt, $1.id) }
    }

    /// Entries on disk, readable or not: what the heartbeat calls the spool depth.
    var count: Int {
        ((try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []).filter { $0.pathExtension == "json" }.count
    }

    func contains(_ id: String) -> Bool {
        fileManager.fileExists(atPath: url(for: id).path)
    }

    /// Stores a freshly claimed job. False when this id is already held (a later stage is never overwritten with a
    /// claim) or the id cannot be a file name.
    func addClaimed(_ job: RelayJob, at date: Date) throws -> Bool {
        guard Self.isStorable(job.id), !contains(job.id) else { return false }
        try write(.claimed(job, at: date))
        return true
    }

    func write(_ entry: SpoolEntry) throws {
        guard Self.isStorable(entry.id) else { throw CocoaError(.fileWriteInvalidFileName) }
        let data = try Self.encoder.encode(entry)
        let final = url(for: entry.id)
        let temp = directory.appending(path: "\(UUID().uuidString).tmp")
        let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        var failure: Int32 = 0
        data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count, failure == 0 {
                let written = Darwin.write(fd, buffer.baseAddress! + offset, buffer.count - offset)
                if written < 0 { failure = errno } else { offset += written }
            }
        }
        if failure == 0, fsync(fd) != 0 { failure = errno }
        close(fd)
        if failure == 0, Darwin.rename(temp.path, final.path) != 0 { failure = errno }
        if failure != 0 {
            try? fileManager.removeItem(at: temp)
            throw POSIXError(POSIXErrorCode(rawValue: failure) ?? .EIO)
        }
    }

    func remove(_ id: String) {
        try? fileManager.removeItem(at: url(for: id))
    }

    func removeAll() {
        for url in (try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] {
            try? fileManager.removeItem(at: url)
        }
    }

    private func url(for id: String) -> URL {
        directory.appending(path: Self.fileName(for: id))
    }

    static func isStorable(_ id: String) -> Bool {
        !id.isEmpty && id.count <= maxIdLength
    }

    /// Percent-encoded outside `[A-Za-z0-9_-]`, so an id can never name a path or a dotfile.
    static func fileName(for id: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        return (id.addingPercentEncoding(withAllowedCharacters: allowed) ?? "invalid") + ".json"
    }

    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        return encoder
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return decoder
    }
}
