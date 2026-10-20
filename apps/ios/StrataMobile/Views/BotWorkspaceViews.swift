import SwiftUI

enum BotWorkspaceDestination: String, CaseIterable, Identifiable {
    case team = "Team", activity = "Activity", skills = "Skills", connections = "Connections"
    var id: String { rawValue }
}

struct BotWorkspaceDestinationView: View {
    let destination: BotWorkspaceDestination
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let openChat: () -> Void
    var body: some View {
        Group {
            switch destination {
            case .team: EmptyView()
            case .activity: BotActivityView(store: store, workspace: workspace, openChat: openChat)
            case .skills: BotSkillsView(store: store, workspace: workspace)
            case .connections: BotConnectionsView(store: store, workspace: workspace)
            }
        }.id(destination)
    }
}

struct BotTeamsSection: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let openChat: () -> Void
    let createTeam: () -> Void
    var body: some View {
        Section {
            ForEach(workspace.teams?.teams ?? []) { team in
                NavigationLink {
                    BotTeamDetailView(store: store, workspace: workspace, teamId: team.id, openChat: openChat)
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "person.3.sequence.fill").font(.title3).foregroundStyle(StrataTheme.accentText).frame(width: 44)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(team.name).font(.headline)
                            Text("\(team.memberIds.count) bots · " + (team.enabled ? "Enabled" : "Ready for review")).font(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 5)
                }.accessibilityIdentifier("team-\(team.id)")
            }
            Button(action: createTeam) { Label("Create team", systemImage: "plus") }
                .disabled((store.botCatalog?.bots.count ?? 0) < 2 || workspace.teams == nil || workspace.teams?.reason != nil || workspace.mutation != nil)
                .accessibilityIdentifier("createBotTeamButton")
            BotWorkspaceMessage(workspace: workspace, key: "teams")
        } header: { Text("Teams") } footer: {
            Text("A coordinator can delegate to these bots within your limits. Creating a team starts no work.")
        }
    }
}

struct BotTeamEditor: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var selected: Set<String> = []
    @State private var coordinator = ""
    @State private var limits = BotTeamLimits()
    @FocusState private var nameFocused: Bool
    var body: some View {
        NavigationStack {
            Form {
                Section("Team") { TextField("Team name", text: $name).focused($nameFocused).submitLabel(.done).onSubmit { nameFocused = false }.accessibilityIdentifier("botTeamNameInput") }
                Section("Members") {
                    ForEach(store.botCatalog?.bots ?? []) { bot in
                        Toggle(isOn: Binding(get: { selected.contains(bot.id) }, set: { on in
                            if on { selected.insert(bot.id); if coordinator.isEmpty { coordinator = bot.id } }
                            else { selected.remove(bot.id); if coordinator == bot.id { coordinator = selected.sorted().first ?? "" } }
                        })) {
                            HStack { AvatarBadge(bot.face, size: 32); Text(bot.name) }
                        }.accessibilityIdentifier("teamMember-\(bot.id)")
                    }
                    Picker("Coordinator", selection: $coordinator) {
                        if coordinator.isEmpty { Text("Choose members first").tag("") }
                        ForEach((store.botCatalog?.bots ?? []).filter { selected.contains($0.id) }) { bot in Text(bot.name).tag(bot.id) }
                    }.accessibilityIdentifier("teamCoordinatorPicker")
                }
                Section {
                    DisclosureGroup("Work limits") {
                        Stepper("Parallel bots: \(limits.maxParallel)", value: $limits.maxParallel, in: 1...8)
                        Stepper("Delegation depth: \(limits.maxDepth)", value: $limits.maxDepth, in: 1...4)
                        Stepper("Message hops: \(limits.maxHops)", value: $limits.maxHops, in: 1...32)
                        Stepper("Conversation turns: \(limits.maxTurns)", value: $limits.maxTurns, in: 1...100)
                        Stepper("Time limit: \(limits.maxDurationMs / 60_000) minutes", value: Binding(get: { limits.maxDurationMs / 60_000 }, set: { limits.maxDurationMs = $0 * 60_000 }), in: 1...60)
                    }
                    Text("Review and enable the saved team before sending its first task. Each bot keeps its own provider, permissions and assigned tools.").font(.caption).foregroundStyle(.secondary)
                    BotWorkspaceMessage(workspace: workspace, key: "teams")
                }
            }.disabled(workspace.mutation != nil)
                .navigationTitle("Create team").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(workspace.mutation != nil) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Create") { Task {
                            if await workspace.createTeam(BotTeamDraft(name: name.trimmingCharacters(in: .whitespacesAndNewlines), memberIds: selected.sorted(), coordinatorId: coordinator, limits: limits)) { dismiss() }
                        } }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 80 || selected.count < 2 || selected.count > 12 || !selected.contains(coordinator) || workspace.mutation != nil)
                            .accessibilityIdentifier("confirmBotTeamButton")
                    }
                    ToolbarItemGroup(placement: .keyboard) { if nameFocused { Spacer(); Button("Done") { nameFocused = false }.accessibilityIdentifier("dismissBotTeamNameKeyboardButton") } }
                }
                .interactiveDismissDisabled(workspace.mutation != nil)
        }
    }
}

private struct BotTeamDetailView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let teamId: String
    let openChat: () -> Void
    @State private var message = ""
    @State private var requestId = UUID().uuidString
    @State private var navigation = UUID()
    @State private var confirmingStop: BotTeamRun?
    @State private var visible = false
    @Environment(\.scenePhase) private var scenePhase
    @FocusState private var taskFocused: Bool
    private var team: BotTeam? { workspace.teams?.teams.first { $0.id == teamId } }
    var body: some View {
        List {
            if let team {
                Section {
                    Label(team.name, systemImage: "person.3.sequence.fill").font(.title3.weight(.semibold))
                    ForEach(team.memberIds, id: \.self) { id in
                        let bot = store.botCatalog?.bots.first { $0.id == id }
                        HStack { AvatarBadge(bot?.face ?? .default(for: "Bot"), size: 34); Text(bot?.name ?? "Unavailable bot"); Spacer(); if id == team.coordinatorId { Text("Coordinator").font(.caption).foregroundStyle(.secondary) } }
                    }
                    LabeledContent("Limits", value: "\(team.limits.maxParallel) parallel · \(team.limits.maxTurns) turns · \(team.limits.maxDurationMs / 60_000)m")
                    Button(team.enabled ? "Disable team" : "Enable reviewed team") { Task { await workspace.setTeamEnabled(team, enabled: !team.enabled) } }
                        .disabled(workspace.mutation != nil || (workspace.teams?.runs.contains { $0.teamId == team.id && $0.isActive } ?? false))
                        .accessibilityIdentifier("toggleBotTeamEnabledButton")
                }
                Section {
                    TextField("What should this team do?", text: $message, axis: .vertical).lineLimit(3...8)
                        .focused($taskFocused)
                        .disabled(workspace.mutation != nil)
                        .accessibilityIdentifier("botTeamTaskInput")
                    Button {
                        taskFocused = false
                        let generation = navigation
                        let taskMessage = message, taskRequestId = requestId
                        Task {
                            guard let run = await workspace.startTeam(team, message: taskMessage, requestId: taskRequestId) else { return }
                            if navigation == generation { message = ""; requestId = UUID().uuidString }
                            await store.refresh(silently: true)
                            guard navigation == generation, let chat = store.conversations.first(where: { $0.id == run.rootChatId }) else { return }
                            await store.selectConversation(chat)
                            if navigation == generation, store.currentConversation?.id == chat.id { openChat() }
                        }
                    } label: { Label("Start task", systemImage: "paperplane.fill") }
                        .disabled(!team.enabled || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || message.utf16.count > 16_000 || workspace.mutation != nil || store.isSending || store.isSubmittingMessage)
                        .accessibilityIdentifier("startBotTeamTaskButton")
                    Text("This sends the task to the coordinator. Its conversation, Thinking, approvals and delegated work are shared with your Mac.").font(.caption).foregroundStyle(.secondary)
                    BotWorkspaceMessage(workspace: workspace, key: "teams")
                } header: { Text("New task") }
                Section("Tasks") {
                    ForEach((workspace.teams?.runs ?? []).filter { $0.teamId == team.id }) { run in
                        VStack(alignment: .leading, spacing: 10) {
                            HStack { Text(run.stateLabel).font(.headline); Spacer(); Text("\(run.consumedTurns) turns").font(.caption).foregroundStyle(.secondary) }
                            if let detail = run.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
                            BotSharedConversationButton(store: store, chatId: run.rootChatId, title: "Open shared conversation", openChat: openChat)
                            if run.isActive { Button("Stop team task", role: .destructive) { confirmingStop = run }.buttonStyle(.borderless).disabled(workspace.mutation != nil).accessibilityIdentifier("stopBotTeamRun-\(run.id)") }
                        }.padding(.vertical, 5)
                    }
                }
            } else { Text("This team is no longer available. Refresh Bots.").foregroundStyle(.secondary) }
        }.navigationTitle(team?.name ?? "Team").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItemGroup(placement: .keyboard) { if taskFocused { Spacer(); Button("Done") { taskFocused = false }.accessibilityIdentifier("dismissBotTeamTaskKeyboardButton") } } }
            .refreshable { await workspace.refreshTeams() }
            .onAppear { visible = true }
            .onDisappear { visible = false; navigation = UUID() }
            .task(id: visible && scenePhase == .active) {
                guard visible, scenePhase == .active else { return }
                let generation = navigation
                repeat {
                    if workspace.mutation == nil, !workspace.loading.contains("teams") { await workspace.refreshTeams() }
                    do { try await Task.sleep(for: .seconds(3)) } catch { break }
                } while !Task.isCancelled && visible && scenePhase == .active && navigation == generation
            }
            .onChange(of: message) { _, _ in requestId = UUID().uuidString }
            .confirmationDialog("Stop this team task and its delegated work?", isPresented: Binding(get: { confirmingStop != nil }, set: { if !$0 { confirmingStop = nil } })) {
                if let run = confirmingStop { Button("Stop all team work", role: .destructive) { confirmingStop = nil; Task { await workspace.stopRun(run) } } }
            }
    }
}

private struct BotActivityView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let openChat: () -> Void
    @State private var visible = false
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        List {
            Section {
                if workspace.activity.isEmpty, !workspace.loading.contains("activity"), workspace.messages["activity"] == nil { Text("Team tasks, bot messages and subagents will appear here.").foregroundStyle(.secondary) }
                ForEach(workspace.activity) { item in
                    VStack(alignment: .leading, spacing: 8) {
                        Label(item.title, systemImage: item.icon).font(.headline)
                        Text(item.state.replacingOccurrences(of: "_", with: " ").capitalized).font(.caption).foregroundStyle(.secondary)
                        if let from = item.fromBotId, let to = item.toBotId { Text(botName(from) + " → " + botName(to)).font(.subheadline) }
                        if let detail = item.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
                        if let chatId = item.chatId ?? workspace.teams?.runs.first(where: { $0.id == item.runId })?.rootChatId {
                            BotSharedConversationButton(store: store, chatId: chatId, title: "Open conversation", openChat: openChat)
                        }
                    }.padding(.vertical, 5).accessibilityIdentifier("botActivity-\(item.id)")
                }
                BotWorkspaceMessage(workspace: workspace, key: "activity")
            } header: { Text("Team activity") }
            Section("Shared work") {
                ForEach(store.conversations.filter { $0.active }) { conversation in
                    BotSharedConversationButton(store: store, chatId: conversation.id, title: conversation.title, openChat: openChat)
                }
                Text("Open a conversation to review its current approval requests or stop that exact task.").font(.caption).foregroundStyle(.secondary)
            }
        }.scrollContentBackground(.hidden).background(StrataTheme.background)
            .refreshable { await workspace.refreshActivity(); await workspace.refreshTeams(); await store.refresh(silently: true) }
            .onAppear { visible = true }
            .onDisappear { visible = false }
            .task(id: visible && scenePhase == .active) {
                guard visible, scenePhase == .active else { return }
                repeat {
                    if workspace.mutation == nil {
                        if !workspace.loading.contains("activity") { await workspace.refreshActivity() }
                        if !workspace.loading.contains("teams") { await workspace.refreshTeams() }
                    }
                    do { try await Task.sleep(for: .seconds(3)) } catch { break }
                } while !Task.isCancelled && visible && scenePhase == .active
            }
    }
    private func botName(_ id: String) -> String { store.botCatalog?.bots.first { $0.id == id }?.name ?? "Bot" }
}

private struct BotSkillsView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    @State private var scope = ""
    @State private var creating = false
    var body: some View {
        List {
            Section {
                Picker("Scope", selection: $scope) {
                    Text("All bots").tag("")
                    ForEach(store.botCatalog?.bots ?? []) { bot in Text(bot.name).tag(bot.id) }
                }.accessibilityIdentifier("botSkillsScopePicker")
                Button { creating = true } label: { Label("Create draft skill", systemImage: "plus") }
                    .disabled(workspace.skills == nil || workspace.skills?.reason != nil || workspace.mutation != nil).accessibilityIdentifier("createBotSkillButton")
                Text("A draft adds no instructions to your bots until you review, enable and assign it.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Skills") {
                ForEach((workspace.skills?.skills ?? []).filter { scope.isEmpty || $0.botIds.contains(scope) }) { skill in
                    NavigationLink {
                        BotSkillDetailView(store: store, workspace: workspace, skillId: skill.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(skill.name).font(.headline)
                            Text(skill.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            Text(skill.isLibrary ? "Library · " + skill.status.capitalized : skill.status.capitalized).font(.caption2).foregroundStyle(StrataTheme.accentText)
                        }
                    }.accessibilityIdentifier("botSkill-\(skill.id)")
                }
                BotWorkspaceMessage(workspace: workspace, key: "skills")
            }
        }.scrollContentBackground(.hidden).background(StrataTheme.background)
            .task(id: ObjectIdentifier(workspace)) { await workspace.refreshSkills() }
            .refreshable { await workspace.refreshSkills() }
            .sheet(isPresented: $creating) { BotSkillEditor(workspace: workspace) }
    }
}

private struct BotSkillDetailView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let skillId: String
    @State private var editing = false
    @State private var reviewedDigest: String?
    private var skill: BotSkill? { workspace.skills?.skills.first { $0.id == skillId } }
    private var reviewed: Bool { reviewedDigest != nil && reviewedDigest == skill?.digest }
    var body: some View {
        List {
            if let skill {
                Section {
                    if !skill.description.isEmpty { Text(skill.description).font(.subheadline) }
                    Text(skill.body).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    if !skill.triggers.isEmpty { LabeledContent("Triggers", value: skill.triggers.joined(separator: ", ")) }
                    Text("Revision \(skill.revision)").font(.caption).foregroundStyle(.secondary)
                }
                if !skill.isLibrary {
                    Section {
                        if !reviewed { Button("Review current version") { reviewedDigest = skill.digest } }
                        Button("Edit draft") { editing = true }.disabled(!reviewed || workspace.mutation != nil)
                        Button(skill.isEnabled ? "Return to draft" : "Enable reviewed skill") { Task { await workspace.setSkillEnabled(skill, enabled: !skill.isEnabled) } }
                            .disabled(!reviewed || workspace.mutation != nil).accessibilityIdentifier("enableBotSkillButton")
                    } footer: { Text("Enabling a skill lets you assign its instructions. It does not send a prompt.") }
                }
                Section("Assigned bots") {
                    ForEach(store.botCatalog?.bots ?? []) { bot in
                        Toggle(bot.name, isOn: Binding(get: { workspace.skills?.skills.first(where: { $0.id == skill.id })?.botIds.contains(bot.id) == true }, set: { value in Task { await workspace.assignSkill(skill, botId: bot.id, assigned: value) } }))
                            .disabled((!skill.isEnabled || !reviewed) && !skill.botIds.contains(bot.id) || workspace.mutation != nil || workspace.isPreparingAssignment)
                            .accessibilityIdentifier("skillAssignment-\(bot.id)")
                    }
                }
            } else if workspace.loading.contains("skills") { ProgressView("Loading skill…") }
            else { Text("This skill is no longer available.").foregroundStyle(.secondary) }
            BotWorkspaceMessage(workspace: workspace, key: "skills")
        }.navigationTitle(skill?.name ?? "Skill").navigationBarTitleDisplayMode(.inline)
            .task { await workspace.refreshSkills(); if workspace.messages["skills"] == nil { reviewedDigest = skill?.digest } }
            .sheet(isPresented: $editing) { if let skill { BotSkillEditor(workspace: workspace, skill: skill) } }
    }
}

private struct BotSkillEditor: View {
    @ObservedObject var workspace: BotWorkspaceStore
    let skill: BotSkill?
    @State private var draft: BotSkillDraft
    @State private var triggers: String
    @State private var ready: Bool
    @State private var reviewedSkill: BotSkill?
    @Environment(\.dismiss) private var dismiss
    init(workspace: BotWorkspaceStore, skill: BotSkill? = nil) {
        self.workspace = workspace; self.skill = skill
        _draft = State(initialValue: skill.map(BotSkillDraft.init(skill:)) ?? BotSkillDraft())
        _triggers = State(initialValue: skill?.triggers.joined(separator: ", ") ?? "")
        _ready = State(initialValue: skill == nil)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Skill") {
                    TextField("Name", text: $draft.name).accessibilityIdentifier("botSkillNameInput")
                    TextField("Description", text: $draft.description, axis: .vertical)
                    TextField("Triggers, separated by commas", text: $triggers)
                }
                Section("Instructions to review") { TextEditor(text: $draft.body).frame(minHeight: 220).font(.system(.body, design: .monospaced)).accessibilityIdentifier("botSkillBodyInput") }
                Section { Text("New and edited instructions must be reviewed before use. Enabling and assigning are separate actions.").font(.caption).foregroundStyle(.secondary); BotWorkspaceMessage(workspace: workspace, key: "skills") }
            }.disabled(!ready || workspace.mutation != nil)
                .navigationTitle(skill == nil ? "Draft skill" : "Edit skill").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(workspace.mutation != nil) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save draft") { Task {
                            draft.triggers = triggers.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
                            if await workspace.saveSkill(draft, reviewing: reviewedSkill) { dismiss() }
                        } }.disabled(!ready || draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.name.count > 120 || draft.description.count > 500 || draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.body.utf16.count > 64_000 || workspace.mutation != nil)
                            .accessibilityIdentifier("saveBotSkillButton")
                    }
                }
                .task {
                    if let skill {
                        await workspace.refreshSkills()
                        if workspace.messages["skills"] == nil, let fresh = workspace.skills?.skills.first(where: { $0.id == skill.id }), !fresh.isLibrary {
                            draft = BotSkillDraft(skill: fresh); triggers = fresh.triggers.joined(separator: ", "); reviewedSkill = fresh; ready = true
                        }
                    }
                }
                .interactiveDismissDisabled(workspace.mutation != nil)
        }
    }
}

private struct BotConnectionsView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    var body: some View {
        List {
            Section {
                Label("Programs run on your Mac", systemImage: "desktopcomputer")
                Text("Add MCP programs, URLs and credentials in Strata on Mac. Here you can check saved connections and choose which bots and tools have access.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Saved MCP connections") {
                ForEach(workspace.connections?.connections ?? []) { connection in
                    NavigationLink {
                        BotConnectionDetailView(store: store, workspace: workspace, connectionId: connection.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(connection.name).font(.headline)
                            Text(connection.statusLabel + " · \(connection.tools.count) tools").font(.caption).foregroundStyle(.secondary)
                        }
                    }.accessibilityIdentifier("botConnection-\(connection.id)")
                }
                BotWorkspaceMessage(workspace: workspace, key: "connections")
            }
        }.scrollContentBackground(.hidden).background(StrataTheme.background)
            .task(id: ObjectIdentifier(workspace)) { await workspace.refreshConnections() }
            .refreshable { await workspace.refreshConnections() }
    }
}

private struct BotConnectionDetailView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let connectionId: String
    @State private var botIds: Set<String> = []
    @State private var toolIds: Set<String> = []
    @State private var loaded = false
    @State private var reviewedConnection: BotMCPConnection?
    @State private var saved = false
    @State private var confirmingCheck = false
    private var connection: BotMCPConnection? { workspace.connections?.connections.first { $0.id == connectionId } }
    private var ready: Bool { loaded && reviewedConnection?.inventoryDigest.count == 64 && reviewedConnection?.inventoryDigest == connection?.inventoryDigest }
    var body: some View {
        List {
            if let connection {
                Section {
                    LabeledContent("Status", value: connection.statusLabel)
                    LabeledContent("Transport", value: connection.transport == "stdio" ? "Program on Mac" : "HTTP from Mac")
                    if let checked = connection.checkedAt?.date { LabeledContent("Last checked", value: checked.formatted(date: .abbreviated, time: .shortened)) }
                    if !connection.detail.isEmpty { Text(connection.detail).font(.caption).foregroundStyle(.secondary) }
                    Button("Check connection") { confirmingCheck = true }.disabled(workspace.mutation != nil)
                        .accessibilityIdentifier("checkBotConnectionButton")
                } footer: { Text("Checking a program connection launches its configured program on your Mac. It lists tools; it does not call them.") }
                Section("Bot access") {
                    ForEach(store.botCatalog?.bots ?? []) { bot in Toggle(bot.name, isOn: selection(bot.id, in: $botIds)).accessibilityIdentifier("connectionBotAccess-\(bot.id)") }
                }.disabled(!ready || workspace.mutation != nil)
                Section("Tool access") {
                    ForEach(connection.tools) { tool in
                        Toggle(isOn: selection(tool.id, in: $toolIds)) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(tool.name).font(.subheadline.weight(.semibold))
                                Text(tool.description).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                                if tool.readOnly { Label("Reviewed read-only on Mac", systemImage: "checkmark.shield").font(.caption2).foregroundStyle(.secondary) }
                            }
                        }.accessibilityIdentifier("connectionToolAccess-\(tool.id)")
                    }
                }.disabled(!ready || workspace.mutation != nil)
                Section {
                    if !ready, loaded { Button("Reload and review tools") { Task { await reload() } } }
                    Button("Save access") { if let reviewedConnection { Task { saved = await workspace.saveConnection(reviewedConnection, botIds: botIds.sorted(), toolIds: toolIds.sorted()) } } }
                        .disabled(!ready || workspace.mutation != nil).accessibilityIdentifier("saveBotConnectionAccessButton")
                    if saved { Label("Access saved", systemImage: "checkmark.circle").font(.caption).foregroundStyle(StrataTheme.accentText) }
                    Text("Read-only classifications are reviewed on Mac. Other tools keep the bot’s approval policy. Connection credentials are kept on Mac.").font(.caption).foregroundStyle(.secondary)
                }
            } else { Text("This connection is no longer available.").foregroundStyle(.secondary) }
            BotWorkspaceMessage(workspace: workspace, key: "connections")
        }.navigationTitle(connection?.name ?? "Connection").navigationBarTitleDisplayMode(.inline)
            .task { await reload() }
            .confirmationDialog("Check this saved connection on your Mac?", isPresented: $confirmingCheck) {
                if let connection { Button("Check saved connection") { Task { await workspace.checkConnection(connection); await reload() } } }
            }
    }
    private func reload() async {
        loaded = false; await workspace.refreshConnections()
        if workspace.messages["connections"] == nil, let connection {
            botIds = Set(connection.botIds); toolIds = Set(connection.enabledToolIds); reviewedConnection = connection; loaded = true
        }
    }
    private func selection(_ id: String, in set: Binding<Set<String>>) -> Binding<Bool> {
        Binding(get: { set.wrappedValue.contains(id) }, set: { value in if value { set.wrappedValue.insert(id) } else { set.wrappedValue.remove(id) }; saved = false })
    }
}

private struct BotSharedConversationButton: View {
    @ObservedObject var store: CompanionStore
    let chatId: String
    let title: String
    let openChat: () -> Void
    @State private var navigation = UUID()
    var body: some View {
        Button {
            let generation = navigation
            Task {
                await store.refresh(silently: true)
                guard navigation == generation, let summary = store.conversations.first(where: { $0.id == chatId }) else { return }
                await store.selectConversation(summary)
                if navigation == generation, store.currentConversation?.id == chatId { openChat() }
            }
        } label: { Label(title, systemImage: "bubble.left.and.bubble.right") }
            .buttonStyle(.borderless)
            .disabled(store.isSubmittingMessage || store.isSending || store.isSelectingConversation)
            .onDisappear { navigation = UUID() }
    }
}

private struct BotWorkspaceMessage: View {
    @ObservedObject var workspace: BotWorkspaceStore
    let key: String
    var body: some View {
        if let message = workspace.messages[key] { Label(message, systemImage: "info.circle").font(.caption).foregroundStyle(StrataTheme.warning).accessibilityIdentifier("botWorkspaceMessage-\(key)") }
        if workspace.loading.contains(key) { ProgressView().controlSize(.small) }
    }
}
