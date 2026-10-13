import Foundation
import Testing
@testable import FavorPrinter

@MainActor
final class SwitchableConnectivity: Connectivity {
    var isOnline = true
}

/// Records calls and returns canned answers, so flows can be checked without a network.
actor FakeCheckinAPI: CheckinAPI {
    var contactsResult: Result<[CheckinContact], APIError> = .success([])
    var checkInResult: Result<CheckinOutcome, APIError> = .success(.checkedIn(attendanceId: 7))
    var familyResult: Result<KidsFamilyResult, APIError> = .success(.notFound)
    var familyCheckInResult: Result<FamilyCheckinResult, APIError> = .failure(.transport)
    var printersResult: Result<[PairablePrinter], APIError> = .success([])
    var enqueueResult: Result<PrintEnqueueOutcome, APIError> = .failure(.transport)
    var statusResults: [Result<PrintStatus, APIError>] = []
    /// Runs inside `contacts` before it answers, to hold a request in flight.
    var contactsGate: (@Sendable () async -> Void)?
    private(set) var calls: [String] = []
    private(set) var tokens: [String] = []
    private(set) var familyRequests: [FamilyCheckinRequest] = []
    private(set) var enqueueRequests: [PrintEnqueueRequest] = []

    func set(contacts: Result<[CheckinContact], APIError>) { contactsResult = contacts }
    func set(contactsGate gate: (@Sendable () async -> Void)?) { contactsGate = gate }
    func set(checkIn: Result<CheckinOutcome, APIError>) { checkInResult = checkIn }
    func set(family: Result<KidsFamilyResult, APIError>) { familyResult = family }
    func set(familyCheckIn: Result<FamilyCheckinResult, APIError>) { familyCheckInResult = familyCheckIn }
    func set(printers: Result<[PairablePrinter], APIError>) { printersResult = printers }
    func set(enqueue: Result<PrintEnqueueOutcome, APIError>) { enqueueResult = enqueue }
    func set(statuses: [Result<PrintStatus, APIError>]) { statusResults = statuses }

    private func record(_ name: String, _ token: String) { calls.append(name); tokens.append(token) }

    func definitions(token: String, campusId: Int) async throws -> [CheckinDefinition] { record("definitions", token); return [] }
    func occurrences(token: String, campusId: Int, definitionName: String) async throws -> [CheckinOccurrence] { record("occurrences", token); return [] }
    func contacts(token: String, campusId: Int, definitionName: String, eventId: String, query: String) async throws -> [CheckinContact] {
        record("contacts", token)
        if let contactsGate { await contactsGate() }
        return try contactsResult.get()
    }
    func family(token: String, campusId: Int, definitionName: String, eventId: String, anchorAliasId: Int) async throws -> KidsFamilyResult {
        record("family", token); return try familyResult.get()
    }
    func checkIn(token: String, _ request: CheckinRequest) async throws -> CheckinOutcome { record("checkIn", token); return try checkInResult.get() }
    func familyCheckIn(token: String, _ request: FamilyCheckinRequest) async throws -> FamilyCheckinResult {
        record("familyCheckIn", token); familyRequests.append(request); return try familyCheckInResult.get()
    }
    func printers(token: String, campusId: Int, definitionName: String, eventId: String) async throws -> [PairablePrinter] {
        record("printers", token); return try printersResult.get()
    }
    func enqueuePrint(token: String, _ request: PrintEnqueueRequest) async throws -> PrintEnqueueOutcome {
        record("enqueue", token); enqueueRequests.append(request); return try enqueueResult.get()
    }
    func printStatus(token: String, campusId: Int, definitionName: String, eventId: String, printerId: String, attendanceIds: [Int]) async throws -> PrintStatus {
        record("status", token)
        if statusResults.count > 1 { return try statusResults.removeFirst().get() }
        return try (statusResults.first ?? .failure(.transport)).get()
    }
}

@MainActor
struct CheckinFlowTests {
    let api = FakeCheckinAPI()
    let deviceAPI = FakeDeviceAPI()
    let secrets = InMemorySecretStore(Fixture.token)
    let records = InMemoryRecordStore(DeviceRecord(grant: Fixture.deviceGrant(.approved), revoked: false))
    let connectivity = SwitchableConnectivity()
    let session: DeviceSession
    let service: CheckinService

    let definition = CheckinDefinition(definitionName: "grp-71", title: "Kids", campusId: 1, source: "group", sourceId: 71)
    var target: CheckinTarget {
        CheckinTarget(definition: definition, occurrence: CheckinOccurrence(
            eventId: "34886", definitionName: "grp-71", title: "Kids", startDate: Date(timeIntervalSince1970: 1_792_285_200), endDate: nil
        ))
    }
    let contact = CheckinContact(
        contactId: "12310", personId: 1, firstName: "Maria", lastName: "Santos", preferredName: nil, age: 9, gender: nil, campusIds: ["1"]
    )

    init() async {
        session = DeviceSession(api: deviceAPI, secrets: secrets, records: records)
        service = CheckinService(session: session, api: api, connectivity: connectivity)
        await session.start()
        await deviceAPI.setStatus(.success(Fixture.deviceGrant(.approved)))
    }

    // MARK: online-only

    @Test func offlineBlocksEveryCallAndQueuesNothing() async {
        await session.refresh()
        connectivity.isOnline = false
        let event = EventCheckinModel(service: service, target: target, contact: contact)
        #expect(!event.canSubmit)
        await event.checkIn()
        #expect(event.phase == .ready)

        let search = ContactSearchModel(service: service, target: target)
        search.query = "Maria"
        await search.search()
        #expect(search.failure == .offline)
        #expect(CheckinFailure.offline.message.contains("No network"))
        #expect(CheckinFailure.offline.message.contains("nothing is saved"))

        let family = FamilyCheckinModel(service: service, target: target, contact: contact)
        await family.load()
        #expect(family.loadFailure == .offline)
        let print = PrintModel(service: service, target: target, attendanceIds: [1])
        print.printerId = "p"
        #expect(!print.canEnqueue)

        #expect(await api.calls.isEmpty)
    }

    @Test func comingBackOnlineDoesNotReplayAnything() async {
        connectivity.isOnline = false
        let event = EventCheckinModel(service: service, target: target, contact: contact)
        await event.checkIn()
        connectivity.isOnline = true
        try? await Task.sleep(for: .milliseconds(50))
        #expect(await api.calls.isEmpty)
        #expect(event.phase == .ready)
    }

    // MARK: credential rules

    @Test func pendingOrUnregisteredDeviceMakesNoRequest() async throws {
        let pending = DeviceSession(
            api: FakeDeviceAPI(), secrets: InMemorySecretStore(Fixture.token),
            records: InMemoryRecordStore(DeviceRecord(grant: Fixture.deviceGrant(.pending), revoked: false))
        )
        await pending.start()
        let blocked = CheckinService(session: pending, api: api, connectivity: connectivity)
        await #expect(throws: CheckinFailure.notApproved) {
            _ = try await blocked.call { api, token, campus in try await api.definitions(token: token, campusId: campus) }
        }
        #expect(await api.calls.isEmpty)
    }

    @Test func requestUsesTheKeychainSecretAndTheGrantCampus() async throws {
        await session.refresh()
        _ = try await service.call { api, token, campus in
            #expect(campus == 1)
            return try await api.definitions(token: token, campusId: campus)
        }
        #expect(await api.tokens == [Fixture.token])
    }

    @Test(arguments: [
        APIError.server(status: 403, code: .deviceRevoked),
        .server(status: 401, code: .unknownDevice),
    ])
    func revokedOrUnknownDeviceWipesSecretAndShowsRevokedState(error: APIError) async {
        await session.refresh()
        await api.set(contacts: .failure(error))
        let search = ContactSearchModel(service: service, target: target)
        search.query = "Maria"
        await search.search()

        #expect(search.failure == .api(error))
        #expect(secrets.current == nil)
        guard case .revoked = session.state else { Issue.record("expected revoked, got \(session.state)"); return }
    }

    @Test func crossCampusAndDisabledDefinitionKeepTheCredentialAndShowTheirOwnMessage() async {
        await session.refresh()
        for (code, fragment) in [(APIErrorCode.wrongCampus, "own campus"), (.definitionForbidden, "turned off")] {
            await api.set(contacts: .failure(.server(status: 403, code: code)))
            let search = ContactSearchModel(service: service, target: target)
            search.query = "Maria"
            await search.search()
            #expect(search.failure?.message.contains(fragment) == true)
            #expect(secrets.current == Fixture.token)
            #expect(session.state == .approved(Fixture.deviceGrant(.approved)))
        }
    }

    @Test func answerArrivingAfterTheDeviceWasWipedIsDropped() async {
        await session.refresh()
        await api.set(contacts: .success([contact]))
        let (entered, release) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        await api.set(contactsGate: { release.yield(); try? await Task.sleep(for: .milliseconds(200)) })
        let search = ContactSearchModel(service: service, target: target)
        search.query = "Maria"
        let call = Task { await search.search() }
        // Wait until the request is in flight, then wipe the credential under it.
        for await _ in entered { break }
        session.registerAgain()
        await call.value

        #expect(search.results == nil)
        // The call was answered before the wipe, so its outcome is unknown, not a plain failure.
        #expect(search.failure?.outcomeUnknown == true)
        #expect(session.state == .unregistered)
    }

    // MARK: event check-in

    @Test func checkInShowsDoneAndRefusalAndUnknownOutcome() async {
        await session.refresh()
        let model = EventCheckinModel(service: service, target: target, contact: contact)
        await model.checkIn()
        #expect(model.phase == .done(attendanceId: 7))
        #expect(!model.canSubmit)

        let refused = EventCheckinModel(service: service, target: target, contact: contact)
        await api.set(checkIn: .success(.failed(code: "business", message: "Already checked in.")))
        await refused.checkIn()
        #expect(refused.phase == .refused("Already checked in."))

        let lost = EventCheckinModel(service: service, target: target, contact: contact)
        await api.set(checkIn: .failure(.transport))
        await lost.checkIn()
        guard case .failed(_, let maybeRecorded) = lost.phase else { Issue.record("expected failure"); return }
        #expect(maybeRecorded)
        let rejected = EventCheckinModel(service: service, target: target, contact: contact)
        await api.set(checkIn: .failure(.server(status: 403, code: .occurrenceForbidden)))
        await rejected.checkIn()
        guard case .failed(let message, let maybe) = rejected.phase else { Issue.record("expected failure"); return }
        #expect(!maybe)
        #expect(message.contains("not open"))
    }

    // MARK: family

    func family(selectedChoice: Int? = nil, choices: Bool = true) -> KidsFamilyResult {
        .found(.init(
            siblings: [
                .eligible(personAliasId: 1, displayName: "A", age: 9, checkedIn: false, isAdult: false),
                .eligible(personAliasId: 2, displayName: "B", age: 7, checkedIn: true, isAdult: false),
                .ineligible(displayName: "C", age: 3, checkedIn: false),
            ],
            choices: choices ? [PickupPhoneChoice(phoneNumberId: 5, adultPersonId: 9, label: "Ana", maskedPhone: "•••1")] : [],
            selectedChoiceId: selectedChoice, remember: false, remembered: nil
        ))
    }

    @Test func familyPreselectsOnlyEligibleUncheckedChildrenAndNeverTheOthers() async {
        await session.refresh()
        await api.set(family: .success(family()))
        let model = FamilyCheckinModel(service: service, target: target, contact: contact)
        await model.load()
        #expect(model.selectedAliasIds == [1])
        #expect(model.buttonTitle == "Check in 1 kid")
    }

    @Test func familyHoldsLabelsUntilPickupAndPrinterAreChosen() async {
        await session.refresh()
        await api.set(family: .success(family()))
        await api.set(printers: .success([PairablePrinter(id: "p1", name: "Kids desk", laptopLabel: nil, campusId: 1, campusLabel: "MNL", health: .online)]))
        let model = FamilyCheckinModel(service: service, target: target, contact: contact)
        await model.load()
        #expect(model.submitBlock == nil)

        model.printLabels = true
        #expect(model.submitBlock == "Choose a printer or turn labels off.")
        await model.loadPrinters()
        #expect(model.printerId == "p1")
        #expect(model.submitBlock == "Choose who picks up before printing labels.")
        model.pickupChoiceId = 5
        #expect(model.submitBlock == nil)
        model.selectedAliasIds = []
        #expect(model.submitBlock == "Select at least one child.")
    }

    @Test func familySubmitSendsGrantCampusSelectedChildrenAndStablePrintAction() async throws {
        await session.refresh()
        await api.set(family: .success(family()))
        await api.set(familyCheckIn: .success(FamilyCheckinResult(
            children: [FamilyChildOutcome(childAliasId: 1, status: .checkedIn, attendanceId: 9, targets: [])],
            printAttendanceIds: [9], pickup: .init(saved: true), print: .queued(jobIds: ["j"])
        )))
        let model = FamilyCheckinModel(service: service, target: target, contact: contact)
        await model.load()
        model.pickupChoiceId = 5
        model.printLabels = true
        model.printerId = "p1"
        await model.submit()
        let first = try #require(await api.familyRequests.first)

        #expect(first.campusId == 1)
        #expect(first.childAliasIds == [1])
        #expect(first.targetEventIds == ["34886"])
        #expect(first.anchorAliasId == 12310)
        #expect(first.pickup == .init(choiceId: 5, remember: false))
        #expect(first.print?.printerId == "p1")
        #expect((first.print?.actionId.count ?? 999) <= 200)
        guard case .done = model.phase else { Issue.record("expected done"); return }

        let sameSheet = PrintActionID.make(prefix: "family", session: "s", attendanceKey: ["2", "1"], eventIds: ["b", "a"])
        #expect(sameSheet == PrintActionID.make(prefix: "family", session: "s", attendanceKey: ["1", "2"], eventIds: ["a", "b"]))
        #expect(sameSheet != PrintActionID.make(prefix: "family", session: "s", attendanceKey: ["1"], eventIds: ["a", "b"]))
    }

    @Test func familyNotFoundAndLostSubmitAreExplained() async {
        await session.refresh()
        let model = FamilyCheckinModel(service: service, target: target, contact: contact)
        await model.load()
        #expect(model.phase == .notFound)

        await api.set(family: .success(family()))
        let lost = FamilyCheckinModel(service: service, target: target, contact: contact)
        await lost.load()
        await api.set(familyCheckIn: .failure(.transport))
        await lost.submit()
        guard case .failed(_, let maybeRecorded) = lost.phase else { Issue.record("expected failure"); return }
        #expect(maybeRecorded)
    }

    // MARK: printing

    @Test func enqueueSendsOnlyIdsAndTheChosenPrinter() async throws {
        await session.refresh()
        await api.set(enqueue: .success(.queued(created: true, jobIds: ["j"], refused: [])))
        await api.set(statuses: [.success(.enrolled(chip: .init(tone: "ok", text: "Ready"), printerName: "P", jobs: [
            PrintJob(id: "j", status: "sent", reviewReason: nil, kind: "child", lastError: nil, canReprint: true),
        ]))])
        let model = PrintModel(service: service, target: target, attendanceIds: [9, 10], wholeFamily: true)
        #expect(!model.canEnqueue)
        model.printerId = "p1"
        await model.enqueue()

        let request = try #require(await api.enqueueRequests.first)
        #expect(request.attendanceIds == [9, 10])
        #expect(request.printerId == "p1")
        #expect(request.wholeFamily == true)
        #expect(request.campusId == 1)
        #expect(model.phase == .tracking)
        #expect(model.status?.isSettled == true)
    }

    @Test func enqueueRefusalReturnsToChoosingWithTheServerMessage() async {
        await session.refresh()
        await api.set(enqueue: .success(.failed(code: "not_enrolled", retry: false, message: "No printer is set up.", refused: [])))
        let model = PrintModel(service: service, target: target, attendanceIds: [9])
        model.printerId = "p1"
        await model.enqueue()
        #expect(model.phase == .choosing)
        #expect(model.enqueueMessage == "No printer is set up.")

        await api.set(enqueue: .failure(.server(status: 403, code: .printerForbidden)))
        await model.enqueue()
        #expect(model.phase == .choosing)
        #expect(model.enqueueMessage?.contains("printer is not available") == true)
    }

    @Test func partialRefusalIsReported() async {
        await session.refresh()
        await api.set(enqueue: .success(.queued(created: true, jobIds: ["j"], refused: [PrintRefusal(attendanceId: 10, code: "not_attended")])))
        await api.set(statuses: [.failure(.transport)])
        let model = PrintModel(service: service, target: target, attendanceIds: [9, 10])
        model.printerId = "p1"
        await model.enqueue()
        #expect(model.enqueueMessage?.contains("1 label was not printed") == true)
        #expect(model.statusFailure == .api(.transport))
    }

    @Test func statusTrackingPollsUntilSettledThenStops() async {
        await session.refresh()
        let working = PrintJob(id: "j", status: "sending", reviewReason: nil, kind: "child", lastError: nil, canReprint: false)
        let done = PrintJob(id: "j", status: "sent", reviewReason: nil, kind: "child", lastError: nil, canReprint: true)
        func status(_ job: PrintJob) -> Result<PrintStatus, APIError> {
            .success(.enrolled(chip: .init(tone: "ok", text: "x"), printerName: "P", jobs: [job]))
        }
        await api.set(statuses: [status(working), status(working), status(done)])
        let model = PrintModel(service: service, target: target, attendanceIds: [9], alreadyQueuedOn: "p1", pollInterval: .milliseconds(1))
        await model.trackUntilSettled()

        #expect(model.status?.isSettled == true)
        #expect(await api.calls.filter { $0 == "status" }.count == 3)
    }

    @Test func statusTrackingStopsAtThePollBudget() async {
        await session.refresh()
        let working = PrintJob(id: "j", status: "queued", reviewReason: nil, kind: "child", lastError: nil, canReprint: false)
        await api.set(statuses: [.success(.enrolled(chip: .init(tone: "info", text: "x"), printerName: "P", jobs: [working]))])
        let model = PrintModel(service: service, target: target, attendanceIds: [9], alreadyQueuedOn: "p1", pollInterval: .milliseconds(1), maxPolls: 4)
        await model.trackUntilSettled()
        #expect(await api.calls.filter { $0 == "status" }.count == 4)
    }

    @Test func statusFailureStopsPollingAndRevocationWipes() async {
        await session.refresh()
        await api.set(statuses: [.failure(.server(status: 403, code: .deviceRevoked))])
        let model = PrintModel(service: service, target: target, attendanceIds: [9], alreadyQueuedOn: "p1", pollInterval: .milliseconds(1))
        await model.trackUntilSettled()
        #expect(await api.calls.filter { $0 == "status" }.count == 1)
        #expect(secrets.current == nil)
    }

    @Test func searchRequiresTwoCharactersAndShowsResults() async {
        await session.refresh()
        await api.set(contacts: .success([contact]))
        let model = ContactSearchModel(service: service, target: target)
        model.query = " a "
        #expect(!model.canSearch)
        await model.search()
        #expect(await api.calls.isEmpty)
        model.query = "Ma"
        await model.search()
        #expect(model.results == [contact])
    }
}
