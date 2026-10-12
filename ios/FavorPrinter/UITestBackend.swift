#if DEBUG
import Foundation

/// An in-process stand-in for Favor RSVP, used only by the XCUITest target (Debug builds, launched
/// with `-FavorUITestMock`). It never touches the network, the Keychain or UserDefaults.
enum UITestHarness {
    static let flag = "-FavorUITestMock"
    static let offlineFlag = "-FavorUITestOffline"
    static let approvedFlag = "-FavorUITestApproved"

    static var isActive: Bool { ProcessInfo.processInfo.arguments.contains(flag) }

    @MainActor static func makeSession() -> (DeviceSession, CheckinService) {
        let arguments = ProcessInfo.processInfo.arguments
        let backend = MockBackend()
        let approved = arguments.contains(approvedFlag)
        let secrets = MockSecretStore(approved ? MockBackend.token : nil)
        let records = MockRecordStore(approved ? DeviceRecord(grant: MockBackend.grant(.approved), revoked: false) : nil)
        let session = DeviceSession(api: backend, secrets: secrets, records: records)
        let connectivity = FixedConnectivity(isOnline: !arguments.contains(offlineFlag))
        return (session, CheckinService(session: session, api: backend, connectivity: connectivity))
    }
}

@MainActor
final class FixedConnectivity: Connectivity {
    let isOnline: Bool
    init(isOnline: Bool) { self.isOnline = isOnline }
}

final class MockSecretStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    init(_ value: String?) { self.value = value }
    func read() throws -> String? { lock.withLock { value } }
    func write(_ secret: String) throws { lock.withLock { value = secret } }
    func delete() throws { lock.withLock { value = nil } }
}

final class MockRecordStore: DeviceRecordStore, @unchecked Sendable {
    private let lock = NSLock()
    private var record: DeviceRecord?
    init(_ record: DeviceRecord?) { self.record = record }
    func load() -> DeviceRecord? { lock.withLock { record } }
    func save(_ record: DeviceRecord) { lock.withLock { self.record = record } }
    func clear() { lock.withLock { record = nil } }
}

final class MockBackend: DeviceAPI, CheckinAPI, @unchecked Sendable {
    static let token = "checkin_device_" + String(repeating: "a", count: 43)
    private static let start = Date(timeIntervalSince1970: 1_792_285_200)
    private static let printerId = "8b57de32-e4ef-4608-9e80-5c5e21b8d063"

    static func grant(_ status: DeviceStatus, campusId: Int = 1, label: String = "UI test iPad") -> DeviceGrant {
        DeviceGrant(
            id: "3c026625-4597-4787-a36c-871f1d052ab6", campusId: campusId, label: label, status: status,
            createdAt: start, approvedAt: status == .pending ? nil : start, revokedAt: nil
        )
    }

    private let lock = NSLock()
    private var registered: DeviceGrant?
    private var checkedIn: Set<String> = []

    // MARK: Device

    func register(campusId: Int, label: String) async throws -> DeviceRegistration {
        let grant = Self.grant(.pending, campusId: campusId, label: label)
        lock.withLock { registered = grant }
        return DeviceRegistration(grant: grant, token: Self.token)
    }

    /// The first status check after registering is the mocked admin approval.
    func status(token: String) async throws -> DeviceGrant {
        lock.withLock {
            let grant = registered ?? Self.grant(.approved)
            let approved = Self.grant(.approved, campusId: grant.campusId, label: grant.label)
            registered = approved
            return approved
        }
    }

    // MARK: Check-in

    func definitions(token: String, campusId: Int) async throws -> [CheckinDefinition] {
        [CheckinDefinition(definitionName: "grp-71", title: "Kids", campusId: campusId, source: "group", sourceId: 71)]
    }

    func occurrences(token: String, campusId: Int, definitionName: String) async throws -> [CheckinOccurrence] {
        [CheckinOccurrence(eventId: "34886", definitionName: definitionName, title: "Kids 10am", startDate: Self.start, endDate: nil)]
    }

    func contacts(token: String, campusId: Int, definitionName: String, eventId: String, query: String) async throws -> [CheckinContact] {
        guard query.lowercased().contains("mar") else { return [] }
        return [CheckinContact(
            contactId: "12310", personId: 12309, firstName: "Maria", lastName: "Santos", preferredName: nil,
            age: 9, gender: "Female", campusIds: [String(campusId)]
        )]
    }

    func family(token: String, campusId: Int, definitionName: String, eventId: String, anchorAliasId: Int) async throws -> KidsFamilyResult {
        let done = lock.withLock { checkedIn }
        return .found(.init(
            siblings: [
                .eligible(personAliasId: 12310, displayName: "Maria S.", age: 9, checkedIn: done.contains("12310"), isAdult: false),
                .eligible(personAliasId: 12311, displayName: "Jose S.", age: 6, checkedIn: done.contains("12311"), isAdult: false),
            ],
            choices: [PickupPhoneChoice(phoneNumberId: 501, adultPersonId: 900, label: "Ana Santos", maskedPhone: "•••••1234")],
            selectedChoiceId: nil, remember: false, remembered: nil
        ))
    }

    func checkIn(token: String, _ request: CheckinRequest) async throws -> CheckinOutcome {
        lock.withLock { _ = checkedIn.insert(request.contactId) }
        return .checkedIn(attendanceId: 48191)
    }

    func familyCheckIn(token: String, _ request: FamilyCheckinRequest) async throws -> FamilyCheckinResult {
        lock.withLock { checkedIn.formUnion(request.childAliasIds.map(String.init)) }
        return FamilyCheckinResult(
            children: request.childAliasIds.map { alias in
                FamilyChildOutcome(
                    childAliasId: alias, status: .checkedIn, attendanceId: 48000 + alias % 1000,
                    targets: [FamilyTargetOutcome(eventId: request.eventId, ok: true, message: nil, alreadyCheckedIn: nil)]
                )
            },
            printAttendanceIds: request.childAliasIds.map { 48000 + $0 % 1000 },
            pickup: .init(saved: request.pickup != nil),
            print: request.print == nil ? .skipped : .queued(jobIds: ["c1cf3bdb-59b8-4457-9724-7cdabcc9bf2f"])
        )
    }

    func printers(token: String, campusId: Int, definitionName: String, eventId: String) async throws -> [PairablePrinter] {
        [PairablePrinter(id: Self.printerId, name: "Kids desk", laptopLabel: "Kids Mac", campusId: campusId, campusLabel: "MNL", health: .online)]
    }

    func enqueuePrint(token: String, _ request: PrintEnqueueRequest) async throws -> PrintEnqueueOutcome {
        .queued(created: true, jobIds: ["c1cf3bdb-59b8-4457-9724-7cdabcc9bf2f"], refused: [])
    }

    func printStatus(token: String, campusId: Int, definitionName: String, eventId: String, printerId: String, attendanceIds: [Int]) async throws -> PrintStatus {
        .enrolled(
            chip: PrintChip(tone: "ok", text: "Ready"), printerName: "Kids desk",
            jobs: [PrintJob(id: "job-1", status: "sent", reviewReason: nil, kind: "child", lastError: nil, canReprint: true)]
        )
    }
}
#endif
