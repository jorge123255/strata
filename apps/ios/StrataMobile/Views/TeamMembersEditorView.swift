import SwiftUI

/// The editor's draft: the roster choice plus the exact revision it was
/// adopted from. A newer shared snapshot never silently rebases a dirty
/// draft — the draft keeps saving against its adopted revision so the Mac
/// can return a conflict instead of overwriting the newer choice.
struct TeamMembersDraftState: Equatable {
    private(set) var members: [String] = []
    private(set) var coordinator = ""
    private(set) var adoptedRevision = 0
    private(set) var savedConfirmation = false

    /// An explicit load or reload always adopts the loaded roster.
    mutating func rebase(on snapshot: BotTeamMembersSnapshot) {
        members = snapshot.team.memberIds
        coordinator = snapshot.team.coordinatorId
        adoptedRevision = snapshot.team.revision
        savedConfirmation = false
    }

    /// A newer snapshot arrives while the screen is open. A dirty draft keeps
    /// its edits and its adopted revision; only an idle draft follows the
    /// newer roster.
    mutating func sync(with snapshot: BotTeamMembersSnapshot) {
        guard adoptedRevision == 0 || !changed(asOf: snapshot) else { return }
        rebase(on: snapshot)
    }

    func changed(asOf snapshot: BotTeamMembersSnapshot) -> Bool {
        members != snapshot.team.memberIds || coordinator != snapshot.team.coordinatorId
    }

    /// The revision this draft was adopted from. A save sends exactly this
    /// revision, never a newer one the draft did not adopt.
    var saveRevision: Int { adoptedRevision }

    mutating func add(_ id: String) { members.append(id) }
    mutating func remove(_ id: String) {
        members.removeAll { $0 == id }
        if coordinator == id, let next = members.first { coordinator = next }
    }
    mutating func pickCoordinator(_ id: String) { coordinator = id }

    /// The PATCH was confirmed. Adopt the confirmed team so the editor shows
    /// exactly what the Mac saved; when the follow-up read failed this keeps
    /// the confirmed roster visible without adopting the older cache, and
    /// Save stays blocked until an explicit reload adopts a fresh snapshot.
    mutating func confirm(_ team: BotTeamMembersSnapshot.Team) {
        members = team.memberIds
        coordinator = team.coordinatorId
        adoptedRevision = team.revision
        savedConfirmation = true
    }

    /// Edits made while a save is in flight stay in the draft. The save
    /// confirms only the roster it actually submitted; a draft that differs
    /// from the submitted one stays dirty and is never clobbered.
    mutating func mergeConfirmation(_ team: BotTeamMembersSnapshot.Team, into submitted: TeamMembersDraftState) {
        guard self == submitted else { return }
        confirm(team)
    }
}

/// The paired phone edits one saved team's members: add or remove bots and pick
/// the coordinator. Reads and saves go through the companion members route, and
/// every save is checked against the exact revision this screen loaded.
struct TeamMembersEditorView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let teamId: String
    @Environment(\.dismiss) private var dismiss
    @State private var draft = TeamMembersDraftState()
    @State private var pendingRemoval: String?

    private var key: String { BotWorkspaceStore.teamMembersKey(teamId) }
    private var snapshot: BotTeamMembersSnapshot? { workspace.teamMembers[teamId] }
    private var busy: Bool { workspace.loading.contains(key) || workspace.mutation == key }
    private var message: String? { workspace.messages[key] }
    private var changed: Bool { snapshot.map { draft.changed(asOf: $0) } ?? false }
    private var canSave: Bool {
        guard let snapshot, !busy, message == nil, changed,
              (2...12).contains(draft.members.count), draft.members.contains(draft.coordinator) else { return false }
        return true
    }
    /// The draft roster in saved order, joined with the Mac's member details.
    private var draftMembers: [BotTeamMembersSnapshot.Member] {
        guard let snapshot else { return [] }
        let known = snapshot.members + snapshot.roster
            .filter { bot in snapshot.members.first(where: { $0.id == bot.id }) == nil }
            .map { BotTeamMembersSnapshot.Member(id: $0.id, name: $0.name, role: nil, paused: $0.paused, available: $0.paused != true) }
        return draft.members.compactMap { id in known.first { $0.id == id } }
    }
    private var addableBots: [BotTeamMembersSnapshot.RosterBot] {
        guard let snapshot else { return [] }
        let chosen = Set(draft.members)
        return snapshot.roster.filter { !chosen.contains($0.id) }
    }

    var body: some View {
        Form {
            if let snapshot {
                Section {
                    LabeledContent("Team", value: snapshot.team.name)
                    LabeledContent("Saved version", value: "\(snapshot.team.revision)")
                } header: { Text("Team") } footer: { Text("Pick 2 to 12 bots and choose which one coordinates.") }
                Section("Members") {
                    ForEach(draftMembers) { row in memberRow(row) }
                    if draft.members.count <= 2 { Text("Keep at least two bots in the team.").font(.caption).foregroundStyle(.secondary) }
                }
                if !addableBots.isEmpty {
                    Section {
                        ForEach(addableBots) { bot in addRow(bot) }
                    } header: { Text("Add teammates") } footer: { Text("Paused bots keep their saved work but cannot start new team turns.") }
                }
                Section {
                    Picker("Coordinator", selection: coordinatorBinding) {
                        ForEach(draftMembers) { member in Text(member.name).tag(member.id) }
                    }
                    .disabled(busy)
                    .accessibilityIdentifier("teamMembersCoordinatorPicker")
                } header: { Text("Coordinator") } footer: { Text("The coordinator assigns work and brings results together.") }
            } else if busy {
                ProgressView("Loading team members…").frame(maxWidth: .infinity).padding(.vertical, 24)
            } else {
                Section {
                    Text("This team's members are unavailable. Reload to check again.").foregroundStyle(.secondary)
                        .accessibilityIdentifier("teamMembersUnavailable")
                    Button("Reload") { Task { await load() } }.accessibilityIdentifier("reloadTeamMembersButton")
                }
            }
        }
        .strataList()
        .navigationTitle("Edit members").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("closeTeamMembersButton") } }
        // The exact roster choice and its conflict recovery stay in a
        // persistent action area, so a long roster never hides the save.
        .safeAreaInset(edge: .bottom) {
            if snapshot != nil {
                VStack(alignment: .leading, spacing: 10) {
                    if let message {
                        Text(message).font(.caption).foregroundStyle(StrataTheme.warning).accessibilityIdentifier("teamMembersMessage")
                        Button("Reload latest members") { Task { await reload() } }.accessibilityIdentifier("reloadTeamMembersButton")
                    }
                    Button { Task { await save() } } label: { Text("Save changes") }
                        .buttonStyle(.borderedProminent).frame(maxWidth: .infinity)
                        .disabled(!canSave).accessibilityIdentifier("saveTeamMembersButton")
                    if draft.savedConfirmation {
                        Label("Members saved", systemImage: "checkmark").font(.caption).foregroundStyle(StrataTheme.success)
                            .accessibilityIdentifier("teamMembersSavedMessage")
                    }
                }.padding(16).frame(maxWidth: .infinity).background(.regularMaterial)
                    .accessibilityElement(children: .contain).accessibilityIdentifier("teamMembersFooter")
            }
        }
        .task { await load() }
        .onChange(of: snapshot?.team.revision) { _, _ in
            guard let snapshot else { return }
            draft.sync(with: snapshot)
        }
        .accessibilityIdentifier("teamMembersScreen")
    }

    private var coordinatorBinding: Binding<String> {
        Binding(
            get: { draft.coordinator },
            set: { newValue in
                var updated = draft
                updated.pickCoordinator(newValue)
                draft = updated
            })
    }

    private func memberRow(_ member: BotTeamMembersSnapshot.Member) -> some View {
        HStack(alignment: .top, spacing: 10) {
            AvatarBadge(AvatarConfig.default(for: member.name), size: 30)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(member.name)
                if let role = member.role, !role.isEmpty { Text(role).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            if member.id == draft.coordinator { Text("Coordinator").font(.caption).foregroundStyle(.secondary) }
            else if let status = member.statusLabel { StrataStatusPill(title: status, tone: .attention) }
            Button {
                pendingRemoval = member.id
            } label: { Image(systemName: "minus.circle") }
                .buttonStyle(.borderless)
                .tint(StrataTheme.destructive)
                .disabled(busy || draft.members.count <= 2)
                .accessibilityLabel("Remove \(member.name)")
                .accessibilityIdentifier("removeTeamMember-" + member.id)
        }
        .confirmationDialog("Remove \(member.name) from this team?",
                            isPresented: Binding(get: { pendingRemoval == member.id }, set: { if !$0 && pendingRemoval == member.id { pendingRemoval = nil } }),
                            titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                guard let pending = pendingRemoval else { return }
                pendingRemoval = nil
                var updated = draft
                updated.remove(pending)
                draft = updated
            }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        } message: { Text("The bot keeps its saved work. You can add it back any time.") }
    }

    private func addRow(_ bot: BotTeamMembersSnapshot.RosterBot) -> some View {
        HStack(spacing: 10) {
            AvatarBadge(AvatarConfig.default(for: bot.name), size: 30).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(bot.name)
                if bot.paused == true { Text("Paused").font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            Button("Add") {
                var updated = draft
                updated.add(bot.id)
                draft = updated
            }
                .buttonStyle(.borderless).disabled(busy || draft.members.count >= 12)
                .accessibilityIdentifier("addTeamMember-" + bot.id)
        }
    }

    private func load() async {
        await workspace.refreshTeamMembers(teamId)
        if let snapshot { draft.rebase(on: snapshot) }
    }
    /// The explicit Reload adopts the freshest loaded roster, even when the
    /// draft held edits or a stale confirmed write.
    private func reload() async {
        await workspace.refreshTeamMembers(teamId)
        if let snapshot { draft.rebase(on: snapshot) }
    }
    private func save() async {
        guard canSave else { return }
        let submitted = draft
        let outcome = await workspace.saveTeamMembers(teamId, memberIds: submitted.members,
                                                      coordinatorId: submitted.coordinator,
                                                      expectedRevision: submitted.saveRevision)
        guard !Task.isCancelled else { return }
        switch outcome {
        case .refused:
            break // The store surfaced the conflict; the draft is preserved as-is.
        case .confirmed(let team, _):
            draft.mergeConfirmation(team, into: submitted)
        }
    }
}
