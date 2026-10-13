import CryptoKit
import Foundation
import Observation

/// One screen's load of a single value, with the failure kept for display.
@MainActor
@Observable
final class Loadable<Value: Sendable> {
    enum Phase {
        case idle
        case loading
        case loaded(Value)
        case failed(CheckinFailure)
    }

    private(set) var phase: Phase = .idle

    var value: Value? { if case .loaded(let value) = phase { value } else { nil } }
    var failure: CheckinFailure? { if case .failed(let failure) = phase { failure } else { nil } }
    var isLoading: Bool { if case .loading = phase { true } else { false } }

    func load(_ work: () async throws -> Value) async {
        if isLoading { return }
        phase = .loading
        do {
            phase = .loaded(try await work())
        } catch let failure as CheckinFailure {
            phase = .failed(failure)
        } catch {
            phase = .failed(.api(.transport))
        }
    }
}

/// What the volunteer is checking in to.
struct CheckinTarget: Sendable, Equatable {
    let definition: CheckinDefinition
    let occurrence: CheckinOccurrence
}

// MARK: - Contact search

@MainActor
@Observable
final class ContactSearchModel {
    var query = ""
    private(set) var results: [CheckinContact]?
    private(set) var failure: CheckinFailure?
    private(set) var isSearching = false

    private let service: CheckinService
    private let target: CheckinTarget
    /// Identifies the newest search, so an older answer that arrives late is dropped.
    private var latestSearch = 0

    init(service: CheckinService, target: CheckinTarget) {
        self.service = service
        self.target = target
    }

    var canSearch: Bool {
        DeviceAPIClient.contactQueryRange.contains(query.trimmingCharacters(in: .whitespacesAndNewlines).count)
    }

    func search() async {
        guard canSearch else { return }
        latestSearch += 1
        let mine = latestSearch
        isSearching = true
        failure = nil
        results = nil
        defer { if mine == latestSearch { isSearching = false } }
        let text = query
        let target = target
        do {
            let found = try await service.call { api, token, campusId in
                try await api.contacts(
                    token: token, campusId: campusId, definitionName: target.definition.definitionName,
                    eventId: target.occurrence.eventId, query: text
                )
            }
            guard mine == latestSearch else { return }
            results = found
        } catch let failure as CheckinFailure {
            guard mine == latestSearch else { return }
            self.failure = failure
        } catch {
            guard mine == latestSearch else { return }
            failure = .api(.transport)
        }
    }
}

// MARK: - Event check-in

@MainActor
@Observable
final class EventCheckinModel {
    enum Phase: Equatable {
        case ready
        case submitting
        case done(attendanceId: Int)
        /// The server answered and said no.
        case refused(String)
        /// The request failed; when `maybeRecorded` the check-in may have been written anyway.
        case failed(message: String, maybeRecorded: Bool)
    }

    private(set) var phase: Phase = .ready
    private let service: CheckinService
    let target: CheckinTarget
    let contact: CheckinContact

    init(service: CheckinService, target: CheckinTarget, contact: CheckinContact) {
        self.service = service
        self.target = target
        self.contact = contact
    }

    /// A failure that may have been recorded is not retried blindly: `confirmRetry()` is the explicit step.
    var canSubmit: Bool {
        switch phase {
        case .ready, .refused: service.isOnline
        case .failed(_, let maybeRecorded): service.isOnline && !maybeRecorded
        case .submitting, .done: false
        }
    }

    /// The volunteer checked and wants to send the check-in again after an unknown outcome.
    func confirmRetry() {
        if case .failed(_, true) = phase { phase = .ready }
    }

    func checkIn() async {
        guard canSubmit else { return }
        let keys = [CheckinService.checkInKey(eventId: target.occurrence.eventId, childId: contact.contactId)]
        guard service.claim(keys) else {
            phase = .refused("This check-in is already being sent. Wait a moment before trying again.")
            return
        }
        defer { service.release(keys) }
        phase = .submitting
        let target = target
        let contactId = contact.contactId
        do {
            let outcome = try await service.call { api, token, campusId in
                try await api.checkIn(
                    token: token,
                    CheckinRequest(campusId: campusId, definitionName: target.definition.definitionName,
                                   eventId: target.occurrence.eventId, contactId: contactId)
                )
            }
            switch outcome {
            case .checkedIn(let attendanceId): phase = .done(attendanceId: attendanceId)
            case .needsTeamChoice: phase = .refused("This check-in needs a team choice, which this iPad does not support.")
            case .failed(_, let message): phase = .refused(message)
            }
        } catch let failure as CheckinFailure {
            phase = .failed(message: failure.message, maybeRecorded: failure.outcomeUnknown)
        } catch {
            phase = .failed(message: CheckinFailure.api(.transport).message, maybeRecorded: true)
        }
    }
}

// MARK: - Kids family check-in

@MainActor
@Observable
final class FamilyCheckinModel {
    enum Phase: Equatable {
        case loading
        case notFound
        case ready
        case submitting
        case done(FamilyCheckinResult)
        case failed(message: String, maybeRecorded: Bool)
    }

    /// The server accepts at most this many children in one batch.
    static let maxChildren = 16

    private(set) var phase: Phase = .loading
    private(set) var loadFailure: CheckinFailure?
    private(set) var family: KidsFamilyResult.Family?
    private(set) var printers: [PairablePrinter] = []
    private(set) var printersFailure: CheckinFailure?
    var selectedAliasIds: Set<Int> = []
    var pickupChoiceId: Int?
    var rememberPickup = false
    var printLabels = false {
        didSet { if printLabels, printers.isEmpty, !isLoadingPrinters { Task { await loadPrinters() } } }
    }
    var printerId: String?

    private let service: CheckinService
    let target: CheckinTarget
    let contact: CheckinContact
    private let sessionId = UUID().uuidString.lowercased()
    private var isLoadingFamily = false
    private var isLoadingPrinters = false

    init(service: CheckinService, target: CheckinTarget, contact: CheckinContact) {
        self.service = service
        self.target = target
        self.contact = contact
    }

    var anchorAliasId: Int? { Int(contact.contactId) }

    func load() async {
        guard let anchorAliasId, !isLoadingFamily, phase == .loading || loadFailure != nil else { return }
        isLoadingFamily = true
        defer { isLoadingFamily = false }
        loadFailure = nil
        phase = .loading
        let target = target
        do {
            let result = try await service.call { api, token, campusId in
                try await api.family(
                    token: token, campusId: campusId, definitionName: target.definition.definitionName,
                    eventId: target.occurrence.eventId, anchorAliasId: anchorAliasId
                )
            }
            switch result {
            case .notFound: phase = .notFound
            case .found(let family): apply(family)
            }
        } catch let failure as CheckinFailure {
            loadFailure = failure
        } catch {
            loadFailure = .api(.transport)
        }
    }

    private func apply(_ family: KidsFamilyResult.Family) {
        self.family = family
        selectedAliasIds = Set(family.siblings.compactMap(\.selectableAliasId).prefix(Self.maxChildren))
        pickupChoiceId = family.selectedChoiceId
        rememberPickup = family.remember
        phase = .ready
    }

    func loadPrinters() async {
        guard !isLoadingPrinters else { return }
        isLoadingPrinters = true
        defer { isLoadingPrinters = false }
        let target = target
        printersFailure = nil
        do {
            printers = try await service.call { api, token, campusId in
                try await api.printers(
                    token: token, campusId: campusId, definitionName: target.definition.definitionName,
                    eventId: target.occurrence.eventId
                )
            }
            if printerId == nil, printers.count == 1 { printerId = printers[0].id }
        } catch let failure as CheckinFailure {
            printersFailure = failure
        } catch {
            printersFailure = .api(.transport)
        }
    }

    /// Why the primary action is unavailable, or nil when it is available.
    var submitBlock: String? {
        guard let family else { return "Loading the family." }
        if phase == .loading { return "Loading the family." }
        if !service.isOnline { return CheckinFailure.offlineMessage }
        if phase == .submitting { return "Checking in." }
        if selectedAliasIds.isEmpty { return "Select at least one child." }
        if selectedAliasIds.count > Self.maxChildren { return "Select \(Self.maxChildren) children or fewer." }
        if printLabels, printerId == nil { return "Choose a printer or turn labels off." }
        if printLabels, !family.choices.isEmpty, pickupChoiceId == nil { return "Choose who picks up before printing labels." }
        return nil
    }

    var buttonTitle: String {
        let count = selectedAliasIds.count
        return "Check in \(count) \(count == 1 ? "kid" : "kids")"
    }

    func toggle(_ aliasId: Int) {
        if selectedAliasIds.contains(aliasId) { selectedAliasIds.remove(aliasId) } else { selectedAliasIds.insert(aliasId) }
    }

    func submit() async {
        guard phase == .ready, submitBlock == nil, let anchorAliasId else { return }
        let children = selectedAliasIds.sorted()
        let keys = children.map { CheckinService.checkInKey(eventId: target.occurrence.eventId, childId: String($0)) }
        guard service.claim(keys) else {
            phase = .failed(message: "A child here is already being checked in. Reload the family to see the result.", maybeRecorded: true)
            return
        }
        defer { service.release(keys) }
        phase = .submitting
        let target = target
        let pickup = pickupChoiceId.map { FamilyCheckinRequest.Pickup(choiceId: $0, remember: rememberPickup) }
        let print = printLabels
            ? FamilyCheckinRequest.Print(
                actionId: PrintActionID.make(prefix: "family", session: sessionId, attendanceKey: children.map(String.init), eventIds: [target.occurrence.eventId]),
                printerId: printerId)
            : nil
        do {
            let result = try await service.call { api, token, campusId in
                try await api.familyCheckIn(token: token, FamilyCheckinRequest(
                    campusId: campusId, definitionName: target.definition.definitionName, eventId: target.occurrence.eventId,
                    anchorAliasId: anchorAliasId, targetEventIds: [target.occurrence.eventId], childAliasIds: children,
                    pickup: pickup, print: print
                ))
            }
            phase = .done(result)
        } catch let failure as CheckinFailure {
            phase = .failed(message: failure.message, maybeRecorded: failure.outcomeUnknown)
        } catch {
            phase = .failed(message: CheckinFailure.api(.transport).message, maybeRecorded: true)
        }
    }

    /// Back to the form after a failure. Reloads the family so check-in state shown is current.
    func retryAfterFailure() async {
        phase = .loading
        await load()
    }
}

// MARK: - Printing

enum PrintActionID {
    /// Stable for the same open screen and selection, so a retry after a lost response queues once.
    /// The digest keeps the length fixed under the server's 200 character limit.
    static func make(prefix: String, session: String, attendanceKey: [String], eventIds: [String]) -> String {
        let selection = attendanceKey.sorted().joined(separator: ".") + "|" + eventIds.sorted().joined(separator: ".")
        let digest = SHA256.hash(data: Data(selection.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        return "\(prefix)-\(session)-\(digest)"
    }
}

@MainActor
@Observable
final class PrintModel {
    enum Phase: Equatable {
        case choosing
        case enqueuing
        /// Jobs exist (or were already queued); the screen shows status for these attendances.
        case tracking
    }

    private(set) var phase: Phase
    private(set) var printers: [PairablePrinter] = []
    private(set) var printersFailure: CheckinFailure?
    private(set) var enqueueMessage: String?
    private(set) var status: PrintStatus?
    private(set) var statusFailure: CheckinFailure?
    private(set) var isRefreshing = false
    private var isTracking = false
    /// False once the screen has gone away, so nothing starts polling for a screen nobody sees.
    private var isVisible = true
    private var tracker: Task<Void, Never>?
    var printerId: String?

    private let service: CheckinService
    let target: CheckinTarget
    let attendanceIds: [Int]
    let alsoEventIds: [String]?
    let wholeFamily: Bool
    private let actionId: String
    private let pollInterval: Duration
    private let maxPolls: Int

    init(
        service: CheckinService, target: CheckinTarget, attendanceIds: [Int], alsoEventIds: [String]? = nil,
        wholeFamily: Bool = false, alreadyQueuedOn printerId: String? = nil,
        pollInterval: Duration = .seconds(3), maxPolls: Int = 20
    ) {
        self.service = service
        self.target = target
        self.attendanceIds = attendanceIds
        self.alsoEventIds = alsoEventIds
        self.wholeFamily = wholeFamily
        self.printerId = printerId
        self.phase = printerId == nil ? .choosing : .tracking
        self.pollInterval = pollInterval
        self.maxPolls = maxPolls
        self.actionId = PrintActionID.make(
            prefix: "print", session: UUID().uuidString.lowercased(), attendanceKey: attendanceIds.map(String.init),
            eventIds: [target.occurrence.eventId] + (alsoEventIds ?? [])
        )
    }

    var canEnqueue: Bool { phase == .choosing && printerId != nil && service.isOnline }

    func loadPrinters() async {
        let target = target
        printersFailure = nil
        do {
            printers = try await service.call { api, token, campusId in
                try await api.printers(
                    token: token, campusId: campusId, definitionName: target.definition.definitionName,
                    eventId: target.occurrence.eventId
                )
            }
            if printerId == nil, printers.count == 1 { printerId = printers[0].id }
        } catch let failure as CheckinFailure {
            printersFailure = failure
        } catch {
            printersFailure = .api(.transport)
        }
    }

    func enqueue() async {
        guard canEnqueue, let printerId else { return }
        phase = .enqueuing
        enqueueMessage = nil
        let target = target
        let request = (attendanceIds, alsoEventIds, wholeFamily, actionId)
        do {
            let outcome = try await service.call { api, token, campusId in
                try await api.enqueuePrint(token: token, PrintEnqueueRequest(
                    campusId: campusId, definitionName: target.definition.definitionName, eventId: target.occurrence.eventId,
                    actionId: request.3, attendanceIds: request.0, printerId: printerId,
                    alsoEventIds: request.1, wholeFamily: request.2 ? true : nil
                ))
            }
            switch outcome {
            case .queued(_, _, let refused):
                enqueueMessage = refused.isEmpty ? nil : "\(refused.count) \(refused.count == 1 ? "label was" : "labels were") not printed because the person is not checked in here."
                phase = .tracking
                await refreshStatus()
            case .failed(_, _, let message, _):
                enqueueMessage = message
                phase = .choosing
            }
        } catch let failure as CheckinFailure {
            enqueueMessage = failure.outcomeUnknown
                ? "Could not confirm the print request. Tap Print to send it again. The same request is reused, so the label is not queued twice."
                : failure.message
            phase = .choosing
        } catch {
            enqueueMessage = CheckinFailure.api(.transport).message
            phase = .choosing
        }
    }

    /// The screen appeared: follow the print status again if a request was accepted, else load the printers.
    func start() async {
        isVisible = true
        if phase == .tracking { startTracking() } else { await loadPrinters() }
    }

    /// The screen went away: stop polling. A print request already sent is left to finish.
    func stop() {
        isVisible = false
        tracker?.cancel()
        tracker = nil
    }

    /// Print button: send the request, then follow its status while the screen is showing.
    func enqueueAndTrack() async {
        await enqueue()
        startTracking()
    }

    /// Refresh button: fetch now even when the last status looks settled, then keep following it.
    func refresh() async {
        await refreshStatus()
        startTracking()
    }

    /// Runs the poll in a task the model can cancel from `stop()`. Replaces any poll already running,
    /// after that one has wound down, because only one poll may run at a time.
    private func startTracking() {
        guard isVisible else { return }
        let previous = tracker
        previous?.cancel()
        tracker = Task {
            await previous?.value
            await trackUntilSettled()
        }
    }

    func refreshStatus() async {
        guard let printerId, !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        let target = target
        let ids = attendanceIds
        do {
            status = try await service.call { api, token, campusId in
                try await api.printStatus(
                    token: token, campusId: campusId, definitionName: target.definition.definitionName,
                    eventId: target.occurrence.eventId, printerId: printerId, attendanceIds: ids
                )
            }
            statusFailure = nil
        } catch let failure as CheckinFailure {
            if !Task.isCancelled { statusFailure = failure }
        } catch {
            if !Task.isCancelled { statusFailure = .api(.transport) }
        }
    }

    /// Refreshes until every job is finished, a request fails, or the poll budget runs out.
    /// Does nothing before a request was accepted, so a refused or failed print is never followed by polling.
    func trackUntilSettled() async {
        guard phase == .tracking, !isTracking else { return }
        isTracking = true
        defer { isTracking = false }
        for attempt in 0..<maxPolls {
            if Task.isCancelled { return }
            if attempt > 0 || status == nil { await refreshStatus() }
            if statusFailure != nil || status?.isSettled == true { return }
            try? await Task.sleep(for: pollInterval)
        }
    }
}
