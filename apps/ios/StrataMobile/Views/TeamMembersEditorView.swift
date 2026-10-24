import SwiftUI

/// The paired phone edits one saved team's members: add or remove bots and pick
/// the coordinator. Reads and saves go through the companion members route, and
/// every save is checked against the exact revision this screen loaded.
struct TeamMembersEditorView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let teamId: String
    @Environment(\.dismiss) private var dismiss
    @State private var members: [String] = []
    @State private var coordinator = ""
    @State private var adoptedRevision = 0
    @State private var pendingRemoval: String?
    @State private var savedConfirmation = false

    private var key: String { BotWorkspaceStore.teamMembersKey(teamId) }
    private var snapshot: BotTeamMembersSnapshot? { workspace.teamMembers[teamId] }
    private var busy: Bool { workspace.loading.contains(key) || workspace.mutation == key }
    private var message: String? { workspace.messages[key] }
    private var changed: Bool {
        guard let snapshot else { return false }
        return members != snapshot.team.memberIds || coordinator != snapshot.team.coordinatorId
    }
    private var canSave: Bool {
        guard let snapshot, !busy, message == nil, changed,
              (2...12).contains(members.count), members.contains(coordinator) else { return false }
        return true
    }
    /// The draft roster in saved order, joined with the Mac's member details.
    private var draftMembers: [BotTeamMembersSnapshot.Member] {
        guard let snapshot else { return [] }
        let known = snapshot.members + snapshot.roster
            .filter { bot in snapshot.members.first(where: { $0.id == bot.id }) == nil }
            .map { BotTeamMembersSnapshot.Member(id: $0.id, name: $0.name, role: nil, paused: $0.paused, available: $0.paused != true) }
        return members.compactMap { id in known.first { $0.id == id } }
    }
    private var addableBots: [BotTeamMembersSnapshot.RosterBot] {
        guard let snapshot else { return [] }
        let chosen = Set(members)
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
                    if members.count <= 2 { Text("Keep at least two bots in the team.").font(.caption).foregroundStyle(.secondary) }
                }
                if !addableBots.isEmpty {
                    Section {
                        ForEach(addableBots) { bot in addRow(bot) }
                    } header: { Text("Add teammates") } footer: { Text("Paused bots keep their saved work but cannot start new team turns.") }
                }
                Section {
                    Picker("Coordinator", selection: $coordinator) {
                        ForEach(draftMembers) { member in Text(member.name).tag(member.id) }
                    }.accessibilityIdentifier("teamMembersCoordinatorPicker")
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
                    if savedConfirmation {
                        Label("Members saved", systemImage: "checkmark").font(.caption).foregroundStyle(StrataTheme.success)
                            .accessibilityIdentifier("teamMembersSavedMessage")
                    }
                }.padding(16).frame(maxWidth: .infinity).background(.regularMaterial)
                    .accessibilityElement(children: .contain).accessibilityIdentifier("teamMembersFooter")
            }
        }
        .task { await load() }
        .onChange(of: snapshot?.team.revision) { _, _ in sync() }
        .accessibilityIdentifier("teamMembersScreen")
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
            if member.id == coordinator { Text("Coordinator").font(.caption).foregroundStyle(.secondary) }
            else if let status = member.statusLabel { StrataStatusPill(title: status, tone: .attention) }
            Button {
                pendingRemoval = member.id
            } label: { Image(systemName: "minus.circle") }
                .buttonStyle(.borderless)
                .tint(StrataTheme.destructive)
                .disabled(members.count <= 2)
                .accessibilityLabel("Remove \(member.name)")
                .accessibilityIdentifier("removeTeamMember-" + member.id)
        }
        .confirmationDialog("Remove \(member.name) from this team?",
                            isPresented: Binding(get: { pendingRemoval == member.id }, set: { if !$0 && pendingRemoval == member.id { pendingRemoval = nil } }),
                            titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                guard let pending = pendingRemoval else { return }
                pendingRemoval = nil
                members.removeAll { $0 == pending }
                if coordinator == pending, let next = members.first { coordinator = next }
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
            Button("Add") { members.append(bot.id) }
                .buttonStyle(.borderless).disabled(members.count >= 12)
                .accessibilityIdentifier("addTeamMember-" + bot.id)
        }
    }

    private func load() async {
        savedConfirmation = false
        await workspace.refreshTeamMembers(teamId)
        sync(force: true)
    }
    private func reload() async {
        await workspace.refreshTeamMembers(teamId)
        sync(force: true)
    }
    /// A newly loaded roster becomes the draft only when the draft holds no
    /// edits that a conflict message is preserving, or when forced by a save.
    private func sync(force: Bool = false) {
        guard let snapshot, force || !changed || adoptedRevision == 0 else { return }
        members = snapshot.team.memberIds
        coordinator = snapshot.team.coordinatorId
        adoptedRevision = snapshot.team.revision
    }
    private func save() async {
        guard let revision = snapshot?.team.revision, canSave else { return }
        let saved = await workspace.saveTeamMembers(teamId, memberIds: members, coordinatorId: coordinator, expectedRevision: revision)
        guard !Task.isCancelled else { return }
        if saved { savedConfirmation = true; sync(force: true) }
    }
}
