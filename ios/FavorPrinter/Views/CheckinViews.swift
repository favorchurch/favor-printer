import SwiftUI

// Screens for the check-in flow: definition, service, search, check-in, print and print status.
// Every interactive control carries an explicit accessibility label and identifier.

struct FailureText: View {
    let failure: CheckinFailure?

    var body: some View {
        if let failure {
            Text(failure.message).foregroundStyle(.red).accessibilityIdentifier("failure")
        }
    }
}

struct OfflineBanner: View {
    let service: CheckinService

    var body: some View {
        if !service.isOnline {
            Label(CheckinFailure.offlineMessage, systemImage: "wifi.slash")
                .foregroundStyle(.red)
                .accessibilityIdentifier("offline-banner")
        }
    }
}

// MARK: - Definitions

struct CheckinHomeView: View {
    let session: DeviceSession
    let service: CheckinService
    let grant: DeviceGrant
    @State private var definitions = Loadable<[CheckinDefinition]>()

    var body: some View {
        List {
            Section { OfflineBanner(service: service) }
            Section("Choose a check-in") {
                if let items = definitions.value {
                    if items.isEmpty {
                        Text("No check-ins are turned on for campus \(grant.campusId).")
                            .accessibilityIdentifier("definitions-empty")
                    }
                    ForEach(items) { definition in
                        NavigationLink(definition.title) { OccurrencesView(service: service, definition: definition) }
                            .accessibilityLabel(definition.title)
                            .accessibilityIdentifier("definition-\(definition.definitionName)")
                    }
                } else if definitions.isLoading {
                    ProgressView().accessibilityLabel("Loading check-ins")
                }
                FailureText(failure: definitions.failure)
            }
            Section("This iPad") {
                Text("\(grant.label), campus \(grant.campusId)")
                Button("Reload check-ins") { Task { await load() } }
                    .accessibilityLabel("Reload check-ins")
                    .accessibilityIdentifier("reload-definitions")
                Button("Refresh device status") { Task { await session.refresh() } }
                    .disabled(session.isBusy)
                    .accessibilityLabel("Refresh device status")
                    .accessibilityIdentifier("refresh-status")
                NoticeText(notice: session.notice)
            }
        }
        .navigationTitle("Check in")
        .task { await load() }
    }

    private func load() async {
        await definitions.load {
            try await service.call { api, token, campusId in try await api.definitions(token: token, campusId: campusId) }
        }
    }
}

// MARK: - Occurrences

struct OccurrencesView: View {
    let service: CheckinService
    let definition: CheckinDefinition
    @State private var occurrences = Loadable<[CheckinOccurrence]>()

    var body: some View {
        List {
            Section { OfflineBanner(service: service) }
            Section("Choose a service") {
                if let items = occurrences.value {
                    if items.isEmpty {
                        Text("No upcoming services for \(definition.title).").accessibilityIdentifier("occurrences-empty")
                    }
                    ForEach(items) { occurrence in
                        NavigationLink {
                            ContactSearchView(service: service, target: CheckinTarget(definition: definition, occurrence: occurrence))
                        } label: {
                            VStack(alignment: .leading) {
                                Text(occurrence.title)
                                Text(occurrence.startDate.formatted(date: .abbreviated, time: .shortened)).font(.caption)
                            }
                        }
                        .accessibilityLabel("\(occurrence.title), \(occurrence.startDate.formatted(date: .abbreviated, time: .shortened))")
                        .accessibilityIdentifier("occurrence-\(occurrence.eventId)")
                    }
                } else if occurrences.isLoading {
                    ProgressView().accessibilityLabel("Loading services")
                }
                FailureText(failure: occurrences.failure)
                if occurrences.failure != nil {
                    Button("Try again") { Task { await load() } }
                        .accessibilityLabel("Try loading services again")
                }
            }
        }
        .navigationTitle(definition.title)
        .task { await load() }
    }

    private func load() async {
        let name = definition.definitionName
        await occurrences.load {
            try await service.call { api, token, campusId in
                try await api.occurrences(token: token, campusId: campusId, definitionName: name)
            }
        }
    }
}

// MARK: - Search

struct ContactSearchView: View {
    let service: CheckinService
    let target: CheckinTarget
    @State private var model: ContactSearchModel

    init(service: CheckinService, target: CheckinTarget) {
        self.service = service
        self.target = target
        _model = State(initialValue: ContactSearchModel(service: service, target: target))
    }

    var body: some View {
        List {
            Section { OfflineBanner(service: service) }
            Section("Find a person") {
                TextField("Name", text: $model.query)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .onSubmit { Task { await model.search() } }
                    .accessibilityLabel("Name to search")
                    .accessibilityIdentifier("search-field")
                Button("Search") { Task { await model.search() } }
                    .disabled(!model.canSearch || !service.isOnline)
                    .accessibilityLabel("Search")
                    .accessibilityIdentifier("search-button")
                FailureText(failure: model.failure)
            }
            if let results = model.results {
                Section("Results") {
                    if results.isEmpty { Text("No one matches that search.").accessibilityIdentifier("no-results") }
                    ForEach(results) { contact in
                        NavigationLink {
                            ContactView(service: service, target: target, contact: contact)
                        } label: {
                            VStack(alignment: .leading) {
                                Text(contact.displayName)
                                if let age = contact.age { Text("Age \(age)").font(.caption) }
                            }
                        }
                        .accessibilityLabel(contact.displayName + (contact.age.map { ", age \($0)" } ?? ""))
                        .accessibilityIdentifier("contact-\(contact.contactId)")
                    }
                }
            }
        }
        .navigationTitle(target.occurrence.title)
    }
}

// MARK: - Event check-in

struct ContactView: View {
    let service: CheckinService
    let target: CheckinTarget
    let contact: CheckinContact
    @State private var model: EventCheckinModel

    init(service: CheckinService, target: CheckinTarget, contact: CheckinContact) {
        self.service = service
        self.target = target
        self.contact = contact
        _model = State(initialValue: EventCheckinModel(service: service, target: target, contact: contact))
    }

    var body: some View {
        List {
            Section { OfflineBanner(service: service) }
            Section {
                Text(contact.displayName).font(.title2)
                Text("\(target.definition.title), \(target.occurrence.startDate.formatted(date: .abbreviated, time: .shortened))")
            }
            Section {
                Button("Check in") { Task { await model.checkIn() } }
                    .disabled(!model.canSubmit)
                    .accessibilityLabel("Check in \(contact.displayName)")
                    .accessibilityIdentifier("check-in-button")
                phaseView
                NavigationLink("Check in with family") {
                    FamilyCheckinView(service: service, target: target, contact: contact)
                }
                .accessibilityLabel("Check in \(contact.displayName) with family")
                .accessibilityIdentifier("family-link")
            }
        }
        .navigationTitle(contact.firstName)
    }

    @ViewBuilder private var phaseView: some View {
        switch model.phase {
        case .ready: EmptyView()
        case .submitting: ProgressView().accessibilityLabel("Checking in")
        case .done(let attendanceId):
            Label("Checked in", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green).accessibilityIdentifier("checked-in")
            NavigationLink("Print label") {
                PrintView(service: service, target: target, attendanceIds: [attendanceId])
            }
            .accessibilityLabel("Print label for \(contact.displayName)")
            .accessibilityIdentifier("print-link")
        case .refused(let message):
            Text(message).foregroundStyle(.red).accessibilityIdentifier("failure")
        case .failed(let message, let maybeRecorded):
            Text(message).foregroundStyle(.red).accessibilityIdentifier("failure")
            if maybeRecorded {
                Text("This check-in may have been recorded. Search for \(contact.firstName) again to confirm before trying again.")
                    .accessibilityIdentifier("maybe-recorded")
            }
        }
    }
}

// MARK: - Kids family check-in

struct FamilyCheckinView: View {
    let service: CheckinService
    let target: CheckinTarget
    @State private var model: FamilyCheckinModel

    init(service: CheckinService, target: CheckinTarget, contact: CheckinContact) {
        self.service = service
        self.target = target
        _model = State(initialValue: FamilyCheckinModel(service: service, target: target, contact: contact))
    }

    var body: some View {
        List {
            Section { OfflineBanner(service: service) }
            switch model.phase {
            case .loading:
                if let failure = model.loadFailure {
                    FailureText(failure: failure)
                    Button("Try again") { Task { await model.load() } }.accessibilityLabel("Try loading the family again")
                } else {
                    ProgressView().accessibilityLabel("Loading family")
                }
            case .notFound:
                Text("No eligible family was found for \(model.contact.displayName).").accessibilityIdentifier("family-not-found")
            case .ready, .submitting:
                formSections
            case .done(let result):
                resultSections(result)
            case .failed(let message, let maybeRecorded):
                Text(message).foregroundStyle(.red).accessibilityIdentifier("failure")
                if maybeRecorded {
                    Text("These check-ins may have been recorded. Reload the family to see who is checked in before trying again.")
                        .accessibilityIdentifier("maybe-recorded")
                }
                Button("Reload family") { Task { await model.retryAfterFailure() } }.accessibilityLabel("Reload family")
            }
        }
        .navigationTitle("Family")
        .task { await model.load() }
    }

    @ViewBuilder private var formSections: some View {
        if let family = model.family {
            Section("Children") {
                ForEach(family.siblings) { sibling in
                    if let alias = sibling.selectableAliasId {
                        Toggle(sibling.displayName, isOn: Binding(
                            get: { model.selectedAliasIds.contains(alias) },
                            set: { _ in model.toggle(alias) }
                        ))
                        .accessibilityLabel(sibling.displayName)
                        .accessibilityIdentifier("child-\(alias)")
                    } else {
                        Text(sibling.displayName + (sibling.checkedIn ? ", already checked in" : ", not eligible"))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            if !family.choices.isEmpty {
                Section("Who picks up") {
                    Picker("Pickup phone", selection: $model.pickupChoiceId) {
                        Text("Not chosen").tag(Int?.none)
                        ForEach(family.choices) { choice in
                            Text("\(choice.label) \(choice.maskedPhone)").tag(Int?.some(choice.phoneNumberId))
                        }
                    }
                    .accessibilityLabel("Pickup phone")
                    .accessibilityIdentifier("pickup-picker")
                    Toggle("Remember for next time", isOn: $model.rememberPickup)
                        .accessibilityLabel("Remember this pickup phone")
                }
            }
            Section("Labels") {
                Toggle("Print labels", isOn: $model.printLabels)
                    .accessibilityLabel("Print labels")
                    .accessibilityIdentifier("print-toggle")
                if model.printLabels {
                    Picker("Printer", selection: $model.printerId) {
                        Text("Choose a printer").tag(String?.none)
                        ForEach(model.printers) { printer in Text(printer.name).tag(String?.some(printer.id)) }
                    }
                    .accessibilityLabel("Printer")
                    .accessibilityIdentifier("printer-picker")
                    FailureText(failure: model.printersFailure)
                }
            }
            Section {
                Button(model.buttonTitle) { Task { await model.submit() } }
                    .disabled(model.submitBlock != nil)
                    .accessibilityLabel(model.buttonTitle)
                    .accessibilityIdentifier("family-submit")
                if let block = model.submitBlock, model.phase == .ready {
                    Text(block).font(.caption).accessibilityIdentifier("submit-block")
                }
            }
        }
    }

    @ViewBuilder private func resultSections(_ result: FamilyCheckinResult) -> some View {
        Section("Result") {
            ForEach(result.children, id: \.childAliasId) { child in
                let name = model.family?.siblings.first { $0.selectableAliasId == child.childAliasId }?.displayName ?? "Child"
                switch child.status {
                case .checkedIn: Label("\(name) checked in", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                case .partial: Label("\(name) checked in to some services only", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                case .failed:
                    Label("\(name) was not checked in\(child.targets.first?.message.map { ": \($0)" } ?? "")", systemImage: "xmark.circle")
                        .foregroundStyle(.red)
                }
            }
            if !result.pickup.saved, model.pickupChoiceId != nil {
                Text("The pickup phone was not saved.").foregroundStyle(.orange)
            }
        }
        Section("Labels") {
            switch result.print {
            case .skipped:
                if !result.printAttendanceIds.isEmpty {
                    NavigationLink("Print labels") {
                        PrintView(service: service, target: target, attendanceIds: result.printAttendanceIds, wholeFamily: true)
                    }
                    .accessibilityLabel("Print labels for this family")
                    .accessibilityIdentifier("print-link")
                }
            case .queued:
                if let printerId = model.printerId {
                    NavigationLink("View print status") {
                        PrintView(service: service, target: target, attendanceIds: result.printAttendanceIds, wholeFamily: true, alreadyQueuedOn: printerId)
                    }
                    .accessibilityLabel("View print status")
                    .accessibilityIdentifier("print-status-link")
                }
            case .notQueued(_, let retry, let message):
                Text("Labels were not queued: \(message)").foregroundStyle(.red).accessibilityIdentifier("print-not-queued")
                if retry, !result.printAttendanceIds.isEmpty {
                    NavigationLink("Try printing again") {
                        PrintView(service: service, target: target, attendanceIds: result.printAttendanceIds, wholeFamily: true)
                    }
                    .accessibilityLabel("Try printing labels again")
                    .accessibilityIdentifier("print-link")
                }
            }
        }
    }
}

// MARK: - Print and status

struct PrintView: View {
    let service: CheckinService
    @State private var model: PrintModel

    init(
        service: CheckinService, target: CheckinTarget, attendanceIds: [Int],
        wholeFamily: Bool = false, alreadyQueuedOn printerId: String? = nil
    ) {
        self.service = service
        _model = State(initialValue: PrintModel(
            service: service, target: target, attendanceIds: attendanceIds, wholeFamily: wholeFamily, alreadyQueuedOn: printerId
        ))
    }

    var body: some View {
        List {
            Section { OfflineBanner(service: service) }
            if model.phase == .tracking {
                statusSections
            } else {
                chooseSections
            }
        }
        .navigationTitle("Print")
        .task {
            if model.phase == .tracking { await model.trackUntilSettled() } else { await model.loadPrinters() }
        }
    }

    @ViewBuilder private var chooseSections: some View {
        Section("Printer") {
            ForEach(model.printers) { printer in
                Button {
                    model.printerId = printer.id
                } label: {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(printer.name)
                            Text(printer.health.description).font(.caption)
                        }
                        Spacer()
                        if model.printerId == printer.id { Image(systemName: "checkmark") }
                    }
                }
                .accessibilityLabel("\(printer.name), \(printer.health.description)\(model.printerId == printer.id ? ", selected" : "")")
                .accessibilityIdentifier("printer-\(printer.id)")
            }
            if model.printers.isEmpty, model.printersFailure == nil {
                Text("No printers are available for this campus.").accessibilityIdentifier("printers-empty")
            }
            FailureText(failure: model.printersFailure)
        }
        Section {
            Button("Print") { Task { await model.enqueue(); await model.trackUntilSettled() } }
                .disabled(!model.canEnqueue)
                .accessibilityLabel("Print")
                .accessibilityIdentifier("print-button")
            if model.phase == .enqueuing { ProgressView().accessibilityLabel("Sending to printer") }
            if let message = model.enqueueMessage {
                Text(message).foregroundStyle(.red).accessibilityIdentifier("failure")
            }
        }
    }

    @ViewBuilder private var statusSections: some View {
        Section("Print status") {
            switch model.status {
            case .none:
                if model.statusFailure == nil { ProgressView().accessibilityLabel("Loading print status") }
            case .off?:
                Text("Printing is turned off for this check-in.").accessibilityIdentifier("print-off")
            case .unenrolled(let chip)?:
                Text(chip.text).accessibilityIdentifier("print-chip")
            case .enrolled(let chip, let printerName, let jobs)?:
                Text("\(printerName): \(chip.text)").accessibilityIdentifier("print-chip")
                if jobs.isEmpty { Text("Waiting for the label to be queued.") }
                ForEach(jobs) { job in
                    Text("\(job.kind.capitalized) label: \(job.status)\(job.lastError.map { ", \($0)" } ?? "")")
                        .accessibilityIdentifier("job-\(job.id)")
                }
            }
            FailureText(failure: model.statusFailure)
            if let message = model.enqueueMessage { Text(message).accessibilityIdentifier("enqueue-note") }
            Button("Refresh status") { Task { await model.trackUntilSettled() } }
                .disabled(model.isRefreshing || !service.isOnline)
                .accessibilityLabel("Refresh print status")
                .accessibilityIdentifier("refresh-print-status")
        }
    }
}

extension PrinterHealth: CustomStringConvertible {
    var description: String {
        switch self {
        case .online: "online"
        case .statusUnknown: "online, paper status unknown"
        case .unreachable: "cannot reach printer"
        case .relayOffline: "relay offline"
        case .unknown: "status unknown"
        }
    }
}
