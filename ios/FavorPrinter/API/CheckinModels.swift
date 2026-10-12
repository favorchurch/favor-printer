import Foundation

/// Wire types for the check-in endpoints in docs/native-api/v1.md. Fields not listed there are not decoded.

struct CheckinDefinition: Decodable, Sendable, Equatable, Identifiable {
    let definitionName: String
    let title: String
    let campusId: Int
    let source: String
    let sourceId: Int

    var id: String { definitionName }
}

struct CheckinOccurrence: Decodable, Sendable, Equatable, Identifiable {
    let eventId: String
    let definitionName: String
    let title: String
    let startDate: Date
    let endDate: Date?

    var id: String { eventId }
}

struct CheckinContact: Decodable, Sendable, Equatable, Identifiable {
    let contactId: String
    let personId: Int?
    let firstName: String
    let lastName: String
    let preferredName: String?
    let age: Int?
    let gender: String?
    let campusIds: [String]

    var id: String { contactId }

    var displayName: String {
        let first = (preferredName?.isEmpty == false ? preferredName : nil) ?? firstName
        return "\(first) \(lastName)"
    }
}

/// Every success body carries the contract version, and the client refuses any other.
protocol Versioned: Decodable, Sendable { var apiVersion: Int { get } }

struct ContactsResponse: Versioned, Sendable { let apiVersion: Int; let contacts: [CheckinContact] }
struct DefinitionsResponse: Versioned, Sendable { let apiVersion: Int; let definitions: [CheckinDefinition] }
struct OccurrencesResponse: Versioned, Sendable { let apiVersion: Int; let occurrences: [CheckinOccurrence] }
struct PrintersResponse: Versioned, Sendable { let apiVersion: Int; let printers: [PairablePrinter] }
struct ResultResponse<Result: Decodable & Sendable>: Versioned { let apiVersion: Int; let result: Result }

// MARK: - Event check-in

/// `ActionOutcome<CheckinResult>`: a failed domain outcome still arrives as HTTP 200.
enum CheckinOutcome: Decodable, Sendable, Equatable {
    case checkedIn(attendanceId: Int)
    /// A team-surface outcome. v1 supports only event and Kids surfaces, so this is a contract violation.
    case needsTeamChoice
    case failed(code: String, message: String)

    private enum Keys: String, CodingKey { case ok, data, code, message }
    private enum DataKeys: String, CodingKey { case outcome, attendanceId }

    init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: Keys.self)
        if try keys.decode(Bool.self, forKey: .ok) {
            let data = try keys.nestedContainer(keyedBy: DataKeys.self, forKey: .data)
            switch try data.decode(String.self, forKey: .outcome) {
            case "checked-in": self = .checkedIn(attendanceId: try data.decode(Int.self, forKey: .attendanceId))
            case "needs-team-choice": self = .needsTeamChoice
            default: throw DecodingError.dataCorruptedError(forKey: .outcome, in: data, debugDescription: "Unknown outcome")
            }
        } else {
            self = .failed(code: try keys.decode(String.self, forKey: .code), message: try keys.decode(String.self, forKey: .message))
        }
    }
}

struct CheckinRequest: Encodable, Sendable {
    let campusId: Int
    let definitionName: String
    let eventId: String
    let contactId: String
}

// MARK: - Kids family

enum KidsSibling: Decodable, Sendable, Equatable, Identifiable {
    case eligible(personAliasId: Int, displayName: String, age: Int?, checkedIn: Bool, isAdult: Bool)
    case ineligible(displayName: String, age: Int?, checkedIn: Bool)

    private enum Keys: String, CodingKey { case eligible, personAliasId, displayName, age, checkedIn, role }

    init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: Keys.self)
        let name = try keys.decode(String.self, forKey: .displayName)
        let age = try keys.decodeIfPresent(Int.self, forKey: .age)
        let checkedIn = try keys.decode(Bool.self, forKey: .checkedIn)
        if try keys.decode(Bool.self, forKey: .eligible) {
            self = .eligible(
                personAliasId: try keys.decode(Int.self, forKey: .personAliasId),
                displayName: name, age: age, checkedIn: checkedIn,
                isAdult: try keys.decodeIfPresent(String.self, forKey: .role) == "Adult"
            )
        } else {
            self = .ineligible(displayName: name, age: age, checkedIn: checkedIn)
        }
    }

    var id: String {
        switch self {
        case .eligible(let alias, _, _, _, _): "alias-\(alias)"
        case .ineligible(let name, let age, _): "other-\(name)-\(age.map(String.init) ?? "")"
        }
    }

    var displayName: String {
        switch self {
        case .eligible(_, let name, _, _, _), .ineligible(let name, _, _): name
        }
    }

    var checkedIn: Bool {
        switch self {
        case .eligible(_, _, _, let done, _), .ineligible(_, _, let done): done
        }
    }

    /// The PersonAlias id the family check-in sends, or nil when this member cannot be checked in.
    var selectableAliasId: Int? {
        if case .eligible(let alias, _, _, false, _) = self { alias } else { nil }
    }
}

struct PickupPhoneChoice: Decodable, Sendable, Equatable, Identifiable {
    let phoneNumberId: Int
    let adultPersonId: Int
    let label: String
    let maskedPhone: String

    var id: Int { phoneNumberId }
}

enum KidsFamilyResult: Decodable, Sendable, Equatable {
    case notFound
    case found(Family)

    struct Family: Decodable, Sendable, Equatable {
        let siblings: [KidsSibling]
        let choices: [PickupPhoneChoice]
        let selectedChoiceId: Int?
        let remember: Bool
        let remembered: String?
    }

    private enum Keys: String, CodingKey { case found }

    init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: Keys.self)
        self = try keys.decode(Bool.self, forKey: .found) ? .found(try Family(from: decoder)) : .notFound
    }
}

struct FamilyCheckinRequest: Encodable, Sendable, Equatable {
    struct Pickup: Encodable, Sendable, Equatable { let choiceId: Int; let remember: Bool }
    struct Print: Encodable, Sendable, Equatable { let actionId: String; let printerId: String? }

    let campusId: Int
    let definitionName: String
    let eventId: String
    let anchorAliasId: Int
    let targetEventIds: [String]
    let childAliasIds: [Int]
    var pickup: Pickup?
    var print: Print?
}

struct FamilyTargetOutcome: Decodable, Sendable, Equatable {
    let eventId: String
    let ok: Bool
    let message: String?
    let alreadyCheckedIn: Bool?
}

struct FamilyChildOutcome: Decodable, Sendable, Equatable {
    enum Status: String, Decodable, Sendable { case checkedIn = "checked-in", partial, failed }
    let childAliasId: Int
    let status: Status
    let attendanceId: Int?
    let targets: [FamilyTargetOutcome]
}

enum FamilyPrintOutcome: Decodable, Sendable, Equatable {
    case skipped
    case queued(jobIds: [String])
    case notQueued(code: String, retry: Bool, message: String)

    private enum Keys: String, CodingKey { case status, jobIds, code, retry, message }

    init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: Keys.self)
        switch try keys.decode(String.self, forKey: .status) {
        case "skipped": self = .skipped
        case "queued": self = .queued(jobIds: try keys.decode([String].self, forKey: .jobIds))
        case "not-queued":
            self = .notQueued(
                code: try keys.decode(String.self, forKey: .code),
                retry: try keys.decode(Bool.self, forKey: .retry),
                message: try keys.decode(String.self, forKey: .message)
            )
        default: throw DecodingError.dataCorruptedError(forKey: .status, in: keys, debugDescription: "Unknown print status")
        }
    }
}

struct FamilyCheckinResult: Decodable, Sendable, Equatable {
    struct Pickup: Decodable, Sendable, Equatable { let saved: Bool }
    let children: [FamilyChildOutcome]
    let printAttendanceIds: [Int]
    let pickup: Pickup
    let print: FamilyPrintOutcome
}

// MARK: - Printing

enum PrinterHealth: String, Decodable, Sendable, Equatable {
    case online
    case statusUnknown = "status_unknown"
    case unreachable
    case relayOffline = "relay_offline"
    case unknown
}

struct PairablePrinter: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let name: String
    let laptopLabel: String?
    let campusId: Int?
    let campusLabel: String
    let health: PrinterHealth
}

struct PrintEnqueueRequest: Encodable, Sendable, Equatable {
    let campusId: Int
    let definitionName: String
    let eventId: String
    let actionId: String
    let attendanceIds: [Int]
    let printerId: String?
    var alsoEventIds: [String]?
    var wholeFamily: Bool?
}

struct PrintRefusal: Decodable, Sendable, Equatable {
    let attendanceId: Int
    let code: String
}

enum PrintEnqueueOutcome: Decodable, Sendable, Equatable {
    case queued(created: Bool, jobIds: [String], refused: [PrintRefusal])
    case failed(code: String, retry: Bool, message: String, refused: [PrintRefusal])

    private enum Keys: String, CodingKey { case ok, created, jobIds, refused, code, retry, message }

    init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: Keys.self)
        let refused = try keys.decodeIfPresent([PrintRefusal].self, forKey: .refused) ?? []
        if try keys.decode(Bool.self, forKey: .ok) {
            self = .queued(created: try keys.decode(Bool.self, forKey: .created), jobIds: try keys.decode([String].self, forKey: .jobIds), refused: refused)
        } else {
            self = .failed(
                code: try keys.decode(String.self, forKey: .code),
                retry: try keys.decode(Bool.self, forKey: .retry),
                message: try keys.decode(String.self, forKey: .message),
                refused: refused
            )
        }
    }
}

struct PrintChip: Decodable, Sendable, Equatable {
    let tone: String
    let text: String
}

struct PrintJob: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let status: String
    let reviewReason: String?
    let kind: String
    let lastError: String?
    let canReprint: Bool

    /// Jobs in these states will not change on their own.
    var isFinished: Bool { ["sent", "failed", "cancelled", "review"].contains(status) }
}

enum PrintStatus: Decodable, Sendable, Equatable {
    case off
    case unenrolled(chip: PrintChip)
    case enrolled(chip: PrintChip, printerName: String, jobs: [PrintJob])

    private enum Keys: String, CodingKey { case state, chip, printer, printerName, jobs }
    private struct PrinterRef: Decodable { let name: String }

    init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: Keys.self)
        switch try keys.decode(String.self, forKey: .state) {
        case "off": self = .off
        case "unenrolled": self = .unenrolled(chip: try keys.decode(PrintChip.self, forKey: .chip))
        case "enrolled":
            let printer = try keys.decode(PrinterRef.self, forKey: .printer)
            self = .enrolled(
                chip: try keys.decode(PrintChip.self, forKey: .chip),
                printerName: try keys.decodeIfPresent(String.self, forKey: .printerName) ?? printer.name,
                jobs: try keys.decode([PrintJob].self, forKey: .jobs)
            )
        default: throw DecodingError.dataCorruptedError(forKey: .state, in: keys, debugDescription: "Unknown print state")
        }
    }

    /// True while a job may still change, so the screen keeps polling.
    var isSettled: Bool {
        guard case .enrolled(_, _, let jobs) = self else { return true }
        return !jobs.isEmpty && jobs.allSatisfy(\.isFinished)
    }
}
