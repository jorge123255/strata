import SwiftUI

enum BotWorkspaceDestination: String, CaseIterable, Identifiable {
    case team = "Team", activity = "Activity", skills = "Skills", connections = "Connectors"
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
            case .skills: BotCapabilitiesLibraryView(store: store, workspace: workspace)
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
                        StrataTeamAvatars(bots: team.memberIds.compactMap { id in store.botCatalog?.bots.first(where: { $0.id == id }) })
                        VStack(alignment: .leading, spacing: 3) {
                            Text(team.name).font(.body.weight(.semibold))
                            Text("\(team.memberIds.count) bots · " + (team.enabled ? "Enabled" : "Ready for review")).font(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 8)
                }.accessibilityIdentifier("team-\(team.id)")
            }
            Button(action: createTeam) { Label("Create team", systemImage: "plus") }
                .disabled((store.botCatalog?.bots.count ?? 0) < 2 || workspace.teams == nil || workspace.teams?.reason != nil || workspace.mutation != nil)
                .accessibilityIdentifier("createBotTeamButton")
            BotWorkspaceMessage(workspace: workspace, key: "teams")
        } header: { Text("Teams") } footer: {
            Text(workspace.continuousTeams ? "The coordinator keeps the team working until finished or stopped. Creating a team starts no work." : "A coordinator can delegate to these bots within your limits. Creating a team starts no work.")
        }
    }
}

struct BotTeamEditor: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @State private var baseline: BotTeam?
    @State private var name: String
    @State private var selected: Set<String>
    @State private var coordinator: String
    @State private var limits: BotTeamLimits
    @State private var executionMode: String
    @State private var computerId: String
    @State private var folder: String
    @State private var briefing: BotTeamBriefing
    @State private var confirmingReload = false
    @FocusState private var focused: Field?
    private enum Field: Hashable { case name, folder, instructions, memberRole(String), memberInstructions(String) }

    init(store: CompanionStore, workspace: BotWorkspaceStore, team: BotTeam? = nil) {
        self.store = store; self.workspace = workspace
        _baseline = State(initialValue: team)
        _name = State(initialValue: team?.name ?? "")
        _selected = State(initialValue: Set(team?.memberIds ?? []))
        _coordinator = State(initialValue: team?.coordinatorId ?? "")
        _limits = State(initialValue: {
            let saved = team?.limits ?? BotTeamLimits()
            return saved == .continuous ? .continuous : saved.forHost(unrestrictedTeams: workspace.unrestrictedTeams, continuousTeams: false)
        }())
        _executionMode = State(initialValue: team?.execution?.mode ?? "individual")
        _computerId = State(initialValue: team?.execution?.computerId ?? "")
        _folder = State(initialValue: team?.execution?.workspace ?? "")
        _briefing = State(initialValue: team?.briefing ?? BotTeamBriefing())
    }
    private var supportsSettings: Bool { workspace.teams?.teamSettingsSupported == true }
    private var supportsInstructions: Bool { workspace.teams?.teamInstructionsSupported == true }
    private var unrestrictedTeams: Bool { workspace.unrestrictedTeams }
    private var continuousTeams: Bool { workspace.continuousTeams }
    private var current: BotTeam? { baseline.flatMap { old in workspace.teams?.teams.first { $0.id == old.id } } }
    private var hasActiveWork: Bool { baseline.map { old in workspace.teams?.runs.contains { $0.teamId == old.id && $0.isActive } == true } ?? false }
    private var changed: Bool { baseline != nil && (current == nil || current?.revision != baseline?.revision) }
    private var computers: [BotTeamComputer] { (workspace.teams?.teamComputers ?? []).filter { $0.memberId == nil || selected.contains($0.memberId!) } }
    private var chosenComputer: BotTeamComputer? { computers.first { $0.id == computerId } }
    private var draft: BotTeamDraft {
        BotTeamDraft(name: name.trimmingCharacters(in: .whitespacesAndNewlines), memberIds: selected.sorted(), coordinatorId: coordinator, limits: limits.forHost(unrestrictedTeams: unrestrictedTeams, continuousTeams: limits == .continuous),
                     execution: supportsSettings ? (executionMode == "shared" ? BotTeamExecution(mode: "shared", computerId: computerId, workspace: folder.trimmingCharacters(in: .whitespacesAndNewlines)) : .individual) : nil,
                     briefing: supportsInstructions ? BotTeamBriefing(instructions: briefing.instructions.trimmingCharacters(in: .whitespacesAndNewlines), members: briefing.members.filter { selected.contains($0.botId) }.map { BotTeamMemberBriefing(botId: $0.botId, role: $0.role.trimmingCharacters(in: .whitespacesAndNewlines), instructions: $0.instructions.trimmingCharacters(in: .whitespacesAndNewlines)) }.filter { !$0.role.isEmpty || !$0.instructions.isEmpty }.sorted { $0.botId < $1.botId }) : nil)
    }
    private var canSave: Bool {
        BotWorkspaceStore.validTeamDraft(draft, unrestrictedTeams: unrestrictedTeams, continuousTeams: limits == .continuous, availableMemberIds: Set(store.botCatalog?.bots.map(\.id) ?? [])) && workspace.mutation == nil && !hasActiveWork && !changed &&
        (baseline == nil || (supportsSettings && baseline?.revision != nil)) &&
        (executionMode != "shared" || (chosenComputer?.available == true && chosenComputer?.allowsFolder(folder.trimmingCharacters(in: .whitespacesAndNewlines)) == true))
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Team") {
                    TextField("Team name", text: $name).focused($focused, equals: .name).submitLabel(.done).onSubmit { focused = nil }.accessibilityIdentifier("botTeamNameInput")
                }
                if supportsInstructions {
                    Section {
                        TextField("What should this team work on?", text: $briefing.instructions, axis: .vertical)
                            .lineLimit(4...8).focused($focused, equals: .instructions).accessibilityIdentifier("botTeamInstructionsInput")
                    } header: { Text("Team instructions") } footer: {
                        Text("Shared with every teammate. Your coordinator can update this team’s instructions and roles. Private bot profiles, tools and permissions are managed separately.")
                    }
                }
                Section {
                    ForEach(store.botCatalog?.bots ?? []) { bot in
                        memberToggle(id: bot.id, name: bot.name, face: bot.face)
                    }
                    ForEach(selected.subtracting(Set(store.botCatalog?.bots.map(\.id) ?? [])).sorted(), id: \.self) { id in
                        memberToggle(id: id, name: "Unavailable bot", face: .default(for: "Bot"))
                    }
                    Picker("Coordinator", selection: $coordinator) {
                        if coordinator.isEmpty { Text("Choose a coordinator").tag("") }
                        ForEach((store.botCatalog?.bots ?? []).filter { selected.contains($0.id) }) { bot in Text(bot.name).tag(bot.id) }
                    }.accessibilityIdentifier("teamCoordinatorPicker")
                    Text("The coordinator assigns work and brings results together. Choose 2–12 teammates.").font(.caption).foregroundStyle(.secondary)
                } header: { Text("Team members") }
                if supportsInstructions {
                    Section {
                        ForEach(selected.sorted(), id: \.self) { id in
                            let bot = store.botCatalog?.bots.first { $0.id == id }
                            let role = briefing.members.first { $0.botId == id }?.role ?? ""
                            DisclosureGroup {
                                TextField("Role in this team", text: memberBriefingBinding(id, keyPath: \.role))
                                    .focused($focused, equals: .memberRole(id)).accessibilityIdentifier("teamMemberRole-\(id)")
                                TextField("Instructions for this teammate", text: memberBriefingBinding(id, keyPath: \.instructions), axis: .vertical)
                                    .lineLimit(3...6).focused($focused, equals: .memberInstructions(id)).accessibilityIdentifier("teamMemberInstructions-\(id)")
                            } label: {
                                HStack(spacing: 10) {
                                    AvatarBadge(bot?.face ?? .default(for: "Bot"), size: 30)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(bot?.name ?? "Unavailable bot")
                                        Text(role.isEmpty ? (id == coordinator ? "Coordinator" : "Add a role & instructions") : role).font(.caption).foregroundStyle(.secondary)
                                    }
                                }.accessibilityIdentifier("teamMemberBriefing-\(id)")
                            }
                        }
                    } header: { Text("Roles & instructions") } footer: {
                        Text("Give each teammate a clear responsibility within this team. These details are visible to all team members.")
                    }
                }
                if supportsSettings {
                    Section {
                        Picker("Execution", selection: $executionMode) {
                            Text("Each bot’s computer").tag("individual")
                            Text("Shared team computer").tag("shared")
                        }.accessibilityIdentifier("teamExecutionPicker")
                        if executionMode == "shared" {
                            Picker("Computer", selection: Binding(get: { computerId }, set: { id in
                                computerId = id
                                folder = computers.first { $0.id == id }?.workspace ?? ""
                            })) {
                                Text("Choose a configured computer").tag("")
                                if !computerId.isEmpty, chosenComputer == nil { Text("Saved computer unavailable").tag(computerId).disabled(true) }
                                ForEach(computers) { computer in
                                    Text(computer.name + (computer.available ? "" : " · Unavailable")).tag(computer.id).disabled(!computer.available)
                                }
                            }.accessibilityIdentifier("teamComputerPicker")
                            if let computer = chosenComputer {
                                Label(computer.label, systemImage: computer.isIsolated ? "rectangle.inset.filled.and.person.filled" : "desktopcomputer")
                                    .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("teamComputerContext")
                                if let detail = computer.detail, !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary) }
                            }
                            HStack(alignment: .top) {
                                TextField("Full folder path on this computer", text: $folder, axis: .vertical)
                                    .font(.body.monospaced()).autocorrectionDisabled().textInputAutocapitalization(.never)
                                    .focused($focused, equals: .folder).accessibilityIdentifier("teamWorkingFolderInput")
                                if !folder.isEmpty {
                                    Button { folder = ""; focused = .folder } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                                        .buttonStyle(.borderless).accessibilityLabel("Clear working folder").accessibilityIdentifier("clearTeamWorkingFolderButton")
                                }
                            }
                            Text(chosenComputer?.isIsolated == true ? "Use a folder inside this isolated computer’s /workspace. This does not select a folder on your iPhone or Mac." : "Enter or paste the full folder path on the selected computer. The team shares files there; your iPhone’s folders are separate.")
                                .font(.caption).foregroundStyle(.secondary)
                        } else {
                            Text("Each teammate keeps its saved computer and working folder.").font(.caption).foregroundStyle(.secondary)
                        }
                        Text("Models, approval policies and assigned tools remain specific to each bot. Saving starts no work.").font(.caption).foregroundStyle(.secondary)
                    } header: { Text("Computer & working folder") }
                }
                Section {
                    if continuousTeams {
                        Toggle("Until finished or stopped", isOn: Binding(get: { limits == .continuous }, set: { limits = $0 ? .continuous : BotTeamLimits().forHost(unrestrictedTeams: unrestrictedTeams, continuousTeams: false) }))
                            .accessibilityIdentifier("teamContinuousWorkLabel")
                        Text("Turn this on only when the team should keep working with no turn, time, depth or hop cutoff.").font(.caption).foregroundStyle(.secondary)
                    }
                    if limits != .continuous {
                    DisclosureGroup("Work limits") {
                        if unrestrictedTeams {
                            LabeledContent("Parallel work", value: "All available teammates").accessibilityIdentifier("teamParallelAvailableLabel")
                        } else {
                            Stepper("Parallel bots: \(limits.maxParallel)", value: $limits.maxParallel, in: 1...8).accessibilityIdentifier("teamParallelLimitStepper")
                        }
                        Stepper("Delegation depth: \(limits.maxDepth)", value: $limits.maxDepth, in: 1...4)
                        Stepper("Message hops: \(limits.maxHops)", value: $limits.maxHops, in: 1...32)
                        Stepper("\(unrestrictedTeams ? "Work turns" : "Conversation turns"): \(limits.maxTurns)", value: $limits.maxTurns, in: 1...100)
                        if unrestrictedTeams && selected.count > 24 && limits.maxTurns >= 24 {
                            Text("Large teams can answer the opening invitation once each; work and follow-up turns use this budget.").font(.caption).foregroundStyle(.secondary)
                        }
                        Stepper("Time limit: \(limits.maxDurationMs / 60_000) minutes", value: Binding(get: { limits.maxDurationMs / 60_000 }, set: { limits.maxDurationMs = $0 * 60_000 }), in: 1...60)
                    }
                    }
                    if baseline == nil { Text("Review and enable the saved team before sending its first task.").font(.caption).foregroundStyle(.secondary) }
                }
            }.disabled(workspace.mutation != nil)
                .safeAreaInset(edge: .bottom) {
                    VStack(alignment: .leading, spacing: 10) {
                        if hasActiveWork { Label("Team work is active. Finish or stop it before changing the team.", systemImage: "clock").font(.caption).accessibilityIdentifier("teamEditActiveWorkMessage") }
                        if changed {
                            Text("This team changed on another device. Reload its latest settings before saving.").font(.caption).accessibilityIdentifier("teamEditConflictMessage")
                            Button("Reload latest team") { confirmingReload = true }.font(.subheadline).accessibilityIdentifier("reloadBotTeamButton")
                        }
                        BotWorkspaceMessage(workspace: workspace, key: "teams")
                        Button(baseline == nil ? "Create team" : "Save changes") { save() }
                            .buttonStyle(.borderedProminent).frame(maxWidth: .infinity).disabled(!canSave)
                            .accessibilityIdentifier("confirmBotTeamButton")
                    }.padding(16).frame(maxWidth: .infinity).background(.regularMaterial)
                        .accessibilityElement(children: .contain).accessibilityIdentifier("teamEditorFooter")
                }
                .navigationTitle(baseline == nil ? "Create team" : "Edit team").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(workspace.mutation != nil) }
                    ToolbarItemGroup(placement: .keyboard) { if focused != nil { Spacer(); Button("Done") { focused = nil }.accessibilityIdentifier("dismissBotTeamNameKeyboardButton") } }
                }
                .interactiveDismissDisabled(workspace.mutation != nil)
                .confirmationDialog("Discard your changes and reload this team?", isPresented: $confirmingReload) {
                    Button("Reload latest team", role: .destructive) { if let current { reload(current) } }
                }
                .task { await store.refreshBots(); await workspace.refreshTeams() }
        }
    }
    private func memberToggle(id: String, name: String, face: AvatarConfig) -> some View {
        let anchor = executionMode == "shared" && chosenComputer?.memberId == id
        return Toggle(isOn: Binding(get: { selected.contains(id) }, set: { on in
            if on { selected.insert(id); if coordinator.isEmpty { coordinator = id } }
            else if !anchor { selected.remove(id); if coordinator == id { coordinator = "" } }
        })) {
            HStack {
                AvatarBadge(face, size: 32)
                VStack(alignment: .leading, spacing: 3) {
                    Text(name)
                    if anchor { Text("Hosts the shared computer. Choose another before removing.").font(.caption).foregroundStyle(.secondary) }
                }
            }
        }.disabled(anchor || selected.count >= 12 && !selected.contains(id)).accessibilityIdentifier("teamMember-\(id)")
    }
    private func reload(_ team: BotTeam) {
        baseline = team; name = team.name; selected = Set(team.memberIds); coordinator = team.coordinatorId; limits = team.limits == .continuous ? .continuous : team.limits.forHost(unrestrictedTeams: unrestrictedTeams, continuousTeams: false)
        executionMode = team.execution?.mode ?? "individual"; computerId = team.execution?.computerId ?? ""; folder = team.execution?.workspace ?? ""
        briefing = team.briefing ?? BotTeamBriefing()
    }
    private func memberBriefingBinding(_ botId: String, keyPath: WritableKeyPath<BotTeamMemberBriefing, String>) -> Binding<String> {
        Binding(get: { briefing.members.first { $0.botId == botId }?[keyPath: keyPath] ?? "" }, set: { text in
            if let index = briefing.members.firstIndex(where: { $0.botId == botId }) { briefing.members[index][keyPath: keyPath] = text }
            else { var member = BotTeamMemberBriefing(botId: botId); member[keyPath: keyPath] = text; briefing.members.append(member) }
        })
    }
    private func save() {
        guard canSave else { return }
        focused = nil
        let value = draft
        Task {
            let saved: Bool
            if let baseline { saved = await workspace.updateTeam(baseline, draft: value) }
            else { saved = await workspace.createTeam(value) }
            if saved { dismiss() }
        }
    }
}

struct BotTeamDetailView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let teamId: String
    let openChat: () -> Void
    @State private var message = ""
    @State private var requestId = UUID().uuidString
    @State private var navigation = UUID()
    @State private var recipient = ""
    @State private var workMode: BotTeamMessageWorkMode = .chat
    @State private var reply: BotTeamChannelMessage?
    @State private var confirmingStop: BotTeamRun?
    @State private var visible = false
    @State private var showingDetails = false
    @State private var detailsVisible = false
    @State private var showingWorkflows = false
    @State private var editingTeam: BotTeam?
    @State private var settingsExpanded = false
    @State private var tasksExpanded = false
    @State private var workHistoryExpanded = false
    @State private var follow = BotTeamMessageFollowState()
    @State private var sentScrollRequest: String?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var taskFocused: Bool
    @State private var expandedMessages: Set<String> = []
    private var team: BotTeam? { workspace.teams?.teams.first { $0.id == teamId } }
    private var channel: BotTeamChannel? { workspace.channels[teamId] }
    private var channelKey: String { BotWorkspaceStore.channelKey(teamId) }
    private var supportsCoordinatorWork: Bool { workspace.teams?.teamCoordinatorWorkToolsSupported == true }
    private var entries: [BotTeamChannelMessage] { channel?.messages ?? [] }
    private var runs: [BotTeamRun] { (workspace.teams?.runs ?? []).filter { $0.teamId == teamId } }
    private var activeRuns: [BotTeamRun] { channel?.supported == true ? channel?.activeRuns ?? [] : runs.filter(\.isActive) }
    private var ordinaryTeamActivity: [BotWorkspaceActivity] {
        let planRuns = Set((workspace.workPlans[teamId]?.plans ?? []).map(\.parentRunId) + runs.filter { $0.planId != nil }.map(\.id))
        return workspace.activity.filter { $0.teamId == teamId && !planRuns.contains($0.runId) }
    }
    private var latestSequence: Int { entries.last?.sequence ?? 0 }
    private var workSurfaceVisible: Bool { visible && scenePhase == .active && !showingWorkflows && editingTeam == nil && (!showingDetails || detailsVisible) }
    private var workflowSnapshot: BotTeamWorkflowsSnapshot? { workspace.workflows[teamId] }
    private var workflowWork: BotTeamWorkflowWorkOverview {
        let rows = (workflowSnapshot?.workflows ?? []).map { workspace.workflow($0.id, teamId: teamId) ?? $0 }
        let sessions = workspace.messages["supervision"] == nil && workspace.supervision?.supported == true ? workspace.supervision?.sessions ?? [] : []
        return BotTeamWorkflowWorkOverview(rows, teamId: teamId, supervision: sessions)
    }
    private var workflowWorkSummary: String {
        let key = BotWorkspaceStore.workflowsKey(teamId)
        guard let snapshot = workflowSnapshot else { return workspace.messages[key] == nil ? "Checking workflows…" : "Workflows unavailable" }
        guard snapshot.isAvailable || !snapshot.workflows.isEmpty else { return "Workflows unavailable" }
        let prefix = workspace.messages[key] != nil || !snapshot.isAvailable ? "Last known: " : ""
        return prefix + (snapshot.hasMore ? "Latest workflows: " : "") + workflowWork.summary + (snapshot.hasMore ? " · more saved" : "")
    }
    private var planWorkSummary: String {
        let key = BotWorkspaceStore.workPlansKey(teamId)
        guard let snapshot = workspace.workPlans[teamId] else { return workspace.messages[key] == nil ? "Checking plans…" : "Plans unavailable" }
        guard snapshot.isAvailable || !snapshot.plans.isEmpty else { return "Plans unavailable" }
        let rows = snapshot.plans.map { workspace.workPlan($0.id, teamId: teamId) ?? $0 }
        let active = rows.filter { $0.phase.isActive }.count
        let attention = rows.filter { [.awaitingReview, .blocked, .interrupted].contains($0.phase) || $0.phase == .stopping && $0.blockedReason?.isEmpty == false }.count
        return (workspace.messages[key] != nil || !snapshot.isAvailable ? "Last known: " : "") + (snapshot.hasMore ? "At least " : "") + "\(active) in motion · \(attention) need you"
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    if let team {
                        if channel?.supported == true {
                            if channel?.hasMoreBefore == true {
                                Button("Load earlier messages") { Task { await workspace.refreshChannel(teamId, older: true) } }
                                    .font(.caption).frame(maxWidth: .infinity).padding(.vertical, 10)
                                    .disabled(workspace.loading.contains(channelKey) || workspace.mutation != nil)
                                    .accessibilityIdentifier("loadEarlierTeamMessagesButton")
                            }
                            if entries.isEmpty { emptyChannel(team) }
                            ForEach(entries) { entry in channelRow(entry, team: team).id(entry.id) }
                        } else if let channel {
                            Text(channel.reason ?? "Shared team channels require a newer Strata on your Mac.")
                                .font(.callout).foregroundStyle(.secondary).padding(.vertical, 24)
                        } else { ProgressView("Opening team channel…").frame(maxWidth: .infinity).padding(.vertical, 24) }
                    } else { Text("This team is no longer available. Refresh Bots.").foregroundStyle(.secondary) }
                    Color.clear.frame(height: 1).id("team-channel-latest")
                }.padding(.horizontal, 16).padding(.top, 22).padding(.bottom, 12)
                    .background { GeometryReader { geometry in Color.clear.preference(key: BotTeamLegacyScrollPreference.self, value: .init(contentFrame: geometry.frame(in: .named("team-channel-scroll-viewport")))) } }
            }
            .coordinateSpace(name: "team-channel-scroll-viewport")
            .background(StrataTheme.background).accessibilityIdentifier("teamChannelMessages")
            .modifier(BotTeamScrollObservation { nearBottom, userInitiated in follow.viewportChanged(nearBottom: nearBottom, userInitiated: userInitiated) })
            .scrollDismissesKeyboard(.interactively)
            .overlay(alignment: .bottomTrailing) {
                if !entries.isEmpty, follow.positioned, !follow.followingLatest || follow.unreadCount > 0 {
                    Button {
                        proxy.scrollTo("team-channel-latest", anchor: .bottom)
                        _ = follow.messagesChanged(to: latestSequence); follow.markLatestRead()
                    } label: {
                        HStack(spacing: 8) {
                            if follow.unreadCount > 0 { Text("\(follow.unreadCount) new updates").font(.caption.weight(.semibold)) }
                            Image(systemName: "arrow.down").font(.system(size: 18, weight: .semibold))
                        }.padding(.horizontal, follow.unreadCount > 0 ? 14 : 0).frame(minWidth: 46, minHeight: 46).strataChrome()
                    }
                        .accessibilityLabel(follow.unreadCount > 0 ? "\(follow.unreadCount) new team updates. Latest messages" : "Latest messages").padding(16).accessibilityIdentifier("latestTeamMessagesButton")
                }
            }
            .onAppear {
                if follow.messagesChanged(to: latestSequence) { proxy.scrollTo("team-channel-latest", anchor: .bottom) }
            }
            .onChange(of: latestSequence) { _, sequence in
                if follow.messagesChanged(to: sequence) { proxy.scrollTo("team-channel-latest", anchor: .bottom) }
            }
            .onChange(of: sentScrollRequest) { _, request in
                if request != nil {
                    _ = follow.messagesChanged(to: latestSequence); follow.markLatestRead()
                    proxy.scrollTo("team-channel-latest", anchor: .bottom)
                }
            }
            .onChange(of: store.pairingGeneration) { _, _ in follow = BotTeamMessageFollowState() }
            .safeAreaInset(edge: .top, spacing: 0) { if workspace.workReviewSupported || workspace.workflowsSupported || workspace.workPlansSupported { currentWorkButton } }
            .safeAreaInset(edge: .bottom, spacing: 0) { if let team { composer(team) } }
        }
        .navigationTitle("").navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                if let team {
                    Button { taskFocused = false; showingDetails = true } label: {
                        HStack(spacing: 7) {
                            StrataTeamAvatars(bots: members(team), size: 30, horizontal: true)
                            Text(team.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                        }.padding(.horizontal, 12).padding(.vertical, 7).background(StrataTheme.grouped, in: Capsule())
                    }.buttonStyle(.plain).accessibilityLabel(team.name + ", team details").accessibilityIdentifier("teamChannelHeaderButton")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Team details", systemImage: "person.3") { taskFocused = false; showingDetails = true }
                        .accessibilityIdentifier("showTeamDetailsButton")
                    Button(workspace.workReviewSupported ? "Tasks & results" : "Previous tasks", systemImage: "checklist") { taskFocused = false; tasksExpanded = !workspace.workReviewSupported; showingDetails = true }
                        .accessibilityIdentifier("showTeamPreviousTasksButton")
                    Button("Plan & verify", systemImage: "checkmark.seal") { taskFocused = false; showingWorkflows = true }
                        .accessibilityIdentifier("showTeamWorkflowsButton")
                    NotificationMuteButton(notifications: store.notifications, destination: CompanionNotificationDestination(type: "team", id: teamId))
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await workspace.refreshTeams(); if workspace.workReviewSupported { await workspace.refreshActivity() }; await workspace.refreshChannel(teamId, reset: true) } }
                } label: { Image(systemName: "ellipsis").font(.system(size: 20, weight: .medium)).frame(width: 38, height: 38) }
                    .accessibilityLabel("Team options").accessibilityIdentifier("teamOptionsButton")
            }
            ToolbarItem(placement: .topBarTrailing) {
                if activeRuns.count == 1, let run = activeRuns.first {
                    Button("Stop team", systemImage: "stop.circle", role: .destructive) { confirmingStop = run }
                        .disabled(workspace.mutation != nil).accessibilityIdentifier("stopBotTeamRun-\(run.id)")
                } else if activeRuns.count > 1 {
                    Menu {
                        ForEach(activeRuns) { run in
                            Button("Stop \(run.stateLabel.lowercased()) task · \(run.turnLabel(unrestrictedTeams: workspace.unrestrictedTeams, continuousTeams: workspace.continuousTeams))", role: .destructive) { confirmingStop = run }
                                .accessibilityIdentifier("stopBotTeamRun-\(run.id)")
                        }
                    } label: { Label("Team work", systemImage: "stop.circle") }.disabled(workspace.mutation != nil)
                }
            }
            ToolbarItemGroup(placement: .keyboard) { if taskFocused { Spacer(); Button("Done") { taskFocused = false }.accessibilityIdentifier("dismissBotTeamTaskKeyboardButton") } }
        }
        .sheet(isPresented: $showingDetails) { details }
        .sheet(isPresented: $showingWorkflows) {
            NavigationStack {
                BotTeamWorkflowsView(store: store, workspace: workspace, teamId: teamId, openChat: { showingWorkflows = false; openChat() })
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showingWorkflows = false }.accessibilityIdentifier("closeTeamWorkflowsButton") } }
            }
        }
        .refreshable { await workspace.refreshTeams(); if workspace.workReviewSupported { await workspace.refreshActivity() }; await workspace.refreshChannel(teamId, reset: true) }
        .onAppear { visible = true; store.notifications.focus(CompanionNotificationDestination(type: "team", id: teamId)) }
        .onDisappear { visible = false; navigation = UUID(); if store.notifications.focusedDestination == CompanionNotificationDestination(type: "team", id: teamId) { store.notifications.focus(nil) } }
        .task(id: workSurfaceVisible) {
            guard workSurfaceVisible else { return }
            let generation = navigation
            var lastWorkflowRefresh: Date?
            repeat {
                if workspace.mutation == nil {
                    if !workspace.loading.contains("teams") { await workspace.refreshTeams() }
                    guard !Task.isCancelled, workSurfaceVisible, navigation == generation else { return }
                    if workspace.workReviewSupported, !workspace.loading.contains("activity") { await workspace.refreshActivity() }
                    guard !Task.isCancelled, workSurfaceVisible, navigation == generation else { return }
                    if (workspace.workflowsSupported || workspace.workPlansSupported), lastWorkflowRefresh.map({ Date().timeIntervalSince($0) >= 10 }) ?? true {
                        if workspace.workPlansSupported { await workspace.refreshWorkPlans(teamId) }
                        guard !Task.isCancelled, workSurfaceVisible, navigation == generation else { return }
                        if workspace.workflowsSupported { await workspace.refreshWorkflows(teamId) }
                        guard !Task.isCancelled, workSurfaceVisible, navigation == generation else { return }
                        await workspace.refreshSupervision()
                        guard !Task.isCancelled, workSurfaceVisible, navigation == generation else { return }
                        lastWorkflowRefresh = Date()
                    }
                    if !showingDetails, !workspace.loading.contains(channelKey) { await workspace.refreshChannel(teamId) }
                }
                do { try await Task.sleep(for: .seconds(3)) } catch { break }
            } while !Task.isCancelled && workSurfaceVisible && navigation == generation
        }
        .onChange(of: supportsCoordinatorWork) { _, supported in if !supported { workMode = .chat; requestId = UUID().uuidString } }
        .onChange(of: message) { _, _ in requestId = UUID().uuidString }
        .onChange(of: recipient) { _, _ in requestId = UUID().uuidString }
        .onChange(of: reply?.id) { _, _ in requestId = UUID().uuidString }
        .confirmationDialog("Stop this team task and its delegated work?", isPresented: Binding(get: { !showingDetails && confirmingStop != nil }, set: { if !$0 && !showingDetails { confirmingStop = nil } })) {
            if let run = confirmingStop { Button("Stop all team work", role: .destructive) { confirmingStop = nil; Task { await workspace.stopRun(run); await workspace.refreshChannel(teamId) } } }
        }
    }
    private var currentWorkButton: some View {
        let overview = BotTeamWorkOverview(ordinaryTeamActivity)
        let stale = workspace.messages["activity"] != nil
        let value = workspace.activityLoaded ? (stale ? "Last known: " : "") + "\(overview.attentionCount) need you, \(overview.workingCount) working" : stale ? "Unavailable" : "Checking current work"
        let taskLabel = workspace.workReviewSupported ? "Tasks: " + value : ""
        let workflowLabel = workspace.workflowsSupported ? "Workflows: " + workflowWorkSummary : ""
        let planLabel = workspace.workPlansSupported ? "Plans: " + planWorkSummary : ""
        let accessibilitySummary = [taskLabel, workflowLabel, planLabel].filter { !$0.isEmpty }.joined(separator: ". ")
        return HStack(spacing: 10) {
            Button {
            taskFocused = false; tasksExpanded = false; showingDetails = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "checklist").foregroundStyle(StrataTheme.accentText)
                currentWorkLabels(task: taskLabel, workflow: workflowLabel, plan: planLabel)
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }.padding(.vertical, 10)
        }.buttonStyle(.plain).accessibilityLabel("Team work").accessibilityValue(accessibilitySummary).accessibilityIdentifier("teamCurrentWorkButton")
            if workspace.workflowsSupported {
                Button { taskFocused = false; showingWorkflows = true } label: { Image(systemName: "checkmark.seal").font(.system(size: 20)).frame(width: 44, height: 44).strataChrome() }
                    .accessibilityLabel("Open Plan & verify workflows").accessibilityIdentifier("teamCurrentWorkflowsButton")
            }
        }.padding(.horizontal, 16).background(StrataTheme.background)
    }
    private func currentWorkLabels(task: String, workflow: String, plan: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Team work").font(.caption.weight(.semibold))
            if !task.isEmpty { Text(task).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            if !workflow.isEmpty { Text(workflow).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("teamWorkflowWorkSummary") }
            if !plan.isEmpty { Text(plan).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("teamPlanWorkSummary") }
        }
    }
    private func members(_ team: BotTeam) -> [CompanionBot] { team.memberIds.compactMap { id in store.botCatalog?.bots.first { $0.id == id } } }
    private func emptyChannel(_ team: BotTeam) -> some View {
        VStack(spacing: 14) {
            StrataTeamAvatars(bots: members(team), size: 76)
            Text(team.name).font(.title3.weight(.semibold))
            Text("Say hello to everyone, ask who can help, or give your team a task.")
                .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity).padding(.horizontal, 24).padding(.vertical, 42).accessibilityIdentifier("teamChannelEmptyState")
    }
    private var details: some View {
        NavigationStack {
            List {
                if let team {
                    Section {
                        VStack(spacing: 10) {
                            StrataTeamAvatars(bots: members(team), size: 90)
                            Text(team.name).font(.title2.weight(.semibold))
                            Text("\(team.memberIds.count) teammates · \(team.enabled ? "Shared channel" : "Ready for review")").font(.subheadline).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity).padding(.vertical, 16)
                    }.listRowBackground(Color.clear)
                    if workspace.workPlansSupported {
                        BotTeamPlansSection(store: store, workspace: workspace, teamId: teamId, openChat: { showingDetails = false; openChat() })
                    }
                    Section {
                        NavigationLink {
                            BotTeamWorkflowsView(store: store, workspace: workspace, teamId: teamId, openChat: { showingDetails = false; openChat() })
                        } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Label("Plan & verify", systemImage: "checkmark.seal")
                                if workspace.workflowsSupported { Text(workflowWorkSummary).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("teamDetailsWorkflowWorkSummary") }
                            }
                        }
                            .accessibilityIdentifier("teamWorkflowsLink")
                        ForEach(workflowWork.attention + workflowWork.working) { value in
                            NavigationLink {
                                BotTeamWorkflowDetailView(store: store, workspace: workspace, teamId: teamId, workflowId: value.id, openChat: { showingDetails = false; openChat() })
                            } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(value.goal).font(.subheadline.weight(.semibold)).lineLimit(2)
                                    Text((workspace.messages[BotWorkspaceStore.workflowsKey(teamId)] != nil || workflowSnapshot?.isAvailable != true ? "Last known: " : "") + workflowWork.statusLabel(value)).font(.caption).foregroundStyle(.secondary)
                                }
                            }.accessibilityIdentifier("teamCurrentWorkflow-" + value.id)
                        }
                    } footer: { Text("Give work a plan, an independent evaluator and clear success criteria.") }
                    Section {
                        Button { settingsExpanded.toggle() } label: {
                            HStack { Text("Team settings"); Spacer(); Image(systemName: settingsExpanded ? "chevron.up" : "chevron.down") }.contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("botTeamSettingsDisclosure")
                        if settingsExpanded { teamSettings(team) }
                    }
                    if workspace.workReviewSupported {
                        let overview = BotTeamWorkOverview(ordinaryTeamActivity)
                        Section {
                            if workspace.activityLoaded { BotTeamWorkSummary(overview: overview, stale: workspace.messages["activity"] != nil) }
                            else if workspace.messages["activity"] == nil { ProgressView("Checking current work…") }
                            else { Text("Current work is unavailable. Refresh to check your team.").font(.callout).foregroundStyle(.secondary).accessibilityIdentifier("teamCurrentWorkUnavailable") }
                            ForEach(overview.current) { item in taskLink(item) }
                            if workspace.activityLoaded, overview.current.isEmpty {
                                BotTeamEarlierWorkNotice(overview: overview, stale: workspace.messages["activity"] != nil) { workHistoryExpanded = true }
                            }
                            BotWorkspaceMessage(workspace: workspace, key: "activity")
                        } header: { Text("Current work") } footer: { Text("Review submitted evidence or prepare recovery for one unfinished task.") }
                        if !overview.history.isEmpty {
                            Section {
                                Button { workHistoryExpanded.toggle() } label: {
                                    HStack { Label("History", systemImage: "clock"); Spacer(); Text("\(overview.history.count)").foregroundStyle(.secondary); Image(systemName: workHistoryExpanded ? "chevron.up" : "chevron.down") }
                                        .contentShape(Rectangle())
                                }.buttonStyle(.plain).accessibilityValue(workHistoryExpanded ? "Expanded" : "Collapsed").accessibilityIdentifier("teamWorkHistoryDisclosure")
                                if workHistoryExpanded { ForEach(overview.history) { item in taskLink(item) } }
                            }
                        }
                    }
                    if !activeRuns.isEmpty { Section("Team work") { ForEach(activeRuns) { run in runRow(run) } } }
                    Section {
                        Button { tasksExpanded.toggle() } label: {
                            HStack { Text(workspace.workReviewSupported ? "Earlier team requests" : "Previous tasks"); Spacer(); Image(systemName: tasksExpanded ? "chevron.up" : "chevron.down") }.contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("botTeamPreviousTasksDisclosure")
                        if tasksExpanded {
                            ForEach(runs.filter { !$0.isActive }) { run in runRow(run) }
                            if runs.allSatisfy(\.isActive) { Text(workspace.workReviewSupported ? "Earlier team requests will appear here. A finished turn is separate from a verified task result." : "Completed team work will appear here.").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    BotWorkspaceMessage(workspace: workspace, key: "teams")
                }
            }.strataList().navigationTitle("Team details").navigationBarTitleDisplayMode(.inline)
                .onAppear { detailsVisible = true }.onDisappear { detailsVisible = false }
                .task { await workspace.refreshActivity() }
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showingDetails = false }.accessibilityIdentifier("closeTeamDetailsButton") } }
                .sheet(item: $editingTeam) { team in BotTeamEditor(store: store, workspace: workspace, team: team) }
                .confirmationDialog("Stop this team task and its delegated work?", isPresented: Binding(get: { confirmingStop != nil }, set: { if !$0 { confirmingStop = nil } })) {
                    if let run = confirmingStop { Button("Stop all team work", role: .destructive) { confirmingStop = nil; Task { await workspace.stopRun(run); await workspace.refreshChannel(teamId) } } }
                }
        }
    }
    private func taskLink(_ item: BotWorkspaceActivity) -> some View {
        NavigationLink {
            BotTeamTaskReviewView(store: store, workspace: workspace, item: item, openChat: { showingDetails = false; openChat() })
        } label: {
            BotTeamTaskLabel(item: item, stale: workspace.messages["activity"] != nil, ownerName: item.botId.map { id in store.botCatalog?.bots.first { $0.id == id }?.name ?? "Unavailable teammate" })
        }.accessibilityIdentifier("teamWork-" + item.id)
    }
    @ViewBuilder private func teamSettings(_ team: BotTeam) -> some View {
        NavigationLink {
            BotConnectionsView(store: store, workspace: workspace, teamId: team.id)
        } label: { Label("Team connectors", systemImage: "link") }
            .accessibilityIdentifier("teamConnectorsButton")
        Button("Edit team members & settings", systemImage: "person.2.badge.gearshape") { editingTeam = team }
            .disabled(workspace.teams?.teamSettingsSupported != true || team.revision == nil || workspace.mutation != nil || !activeRuns.isEmpty)
            .accessibilityIdentifier("editBotTeamButton")
        if !activeRuns.isEmpty { Text("Team work is active. Finish or stop it before changing the team.").font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("teamSettingsActiveWorkMessage") }
        if workspace.teams?.teamSettingsSupported != true { Text("Update Strata on your Mac to edit this team and choose a shared computer.").font(.caption).foregroundStyle(.secondary) }
        ForEach(team.memberIds, id: \.self) { id in
            let bot = store.botCatalog?.bots.first { $0.id == id }
            let member = team.briefing?.members.first { $0.botId == id }
            HStack(alignment: .top, spacing: 10) {
                AvatarBadge(bot?.face ?? .default(for: "Bot"), size: 30)
                VStack(alignment: .leading, spacing: 4) {
                    Text(bot?.name ?? "Unavailable bot")
                    if let role = member?.role, !role.isEmpty { Text(role).font(.caption).foregroundStyle(.secondary) }
                    if let instructions = member?.instructions, !instructions.isEmpty { Text(instructions).font(.caption).foregroundStyle(.secondary).lineLimit(4) }
                }
                Spacer()
                if id == team.coordinatorId { Text("Coordinator").font(.caption).foregroundStyle(.secondary) }
            }
        }
        if let instructions = team.briefing?.instructions, !instructions.isEmpty {
            VStack(alignment: .leading, spacing: 6) { Text("Team instructions").font(.subheadline.weight(.semibold)); Text(instructions).font(.subheadline).textSelection(.enabled) }
                .accessibilityIdentifier("teamSavedInstructions")
        }
        if let execution = team.execution, execution.isShared {
            let computer = workspace.teams?.teamComputers?.first { $0.id == execution.computerId }
            LabeledContent("Shared computer", value: computer?.name ?? "Saved computer unavailable")
            if let folder = execution.workspace { LabeledContent("Working folder", value: folder).font(.subheadline).accessibilityIdentifier("teamSavedWorkingFolder") }
            if computer?.isIsolated == true, let anchor = computer?.memberId {
                NavigationLink {
                    BotComputerView(store: store, botId: anchor, name: computer?.name ?? team.name)
                } label: { Label("Open team computer", systemImage: "desktopcomputer") }
                    .accessibilityIdentifier("openTeamComputerButton")
            }
        } else { LabeledContent("Execution", value: "Each bot’s computer") }
        if team.limits == .continuous {
            LabeledContent("Team work", value: "Until finished or stopped").accessibilityIdentifier("teamContinuousDetailLabel")
        } else {
            LabeledContent("Limits", value: "\(team.limits.parallelLabel(unrestrictedTeams: workspace.unrestrictedTeams)) · \(team.limits.maxTurns) turns · depth \(team.limits.maxDepth) · \(team.limits.maxHops) hops · \(team.limits.maxDurationMs / 60_000)m")
        }
        Text("Everyone can join the conversation. The coordinator assigns work and brings results together. Each bot keeps its own model and permissions.").font(.caption).foregroundStyle(.secondary)
        Button(team.enabled ? "Disable team" : "Enable reviewed team") { Task { await workspace.setTeamEnabled(team, enabled: !team.enabled) } }
            .disabled(workspace.mutation != nil || !activeRuns.isEmpty)
            .accessibilityIdentifier("toggleBotTeamEnabledButton")
    }

    private func channelRow(_ entry: BotTeamChannelMessage, team: BotTeam) -> some View {
        let human = entry.author.type == "user"
        return HStack(alignment: .bottom, spacing: 8) {
            if human { Spacer(minLength: dynamicTypeSize.isAccessibilitySize ? 12 : 42) }
            else if entry.author.type == "bot" {
                AvatarBadge(entry.author.avatarConfig ?? store.botCatalog?.bots.first { $0.id == entry.author.botId }?.face ?? .default(for: entry.author.name), size: 26)
            } else {
                Image(systemName: "person.3.fill").font(.system(size: 17)).foregroundStyle(StrataTheme.secondaryInk).frame(width: 26, height: 26)
            }
            VStack(alignment: human ? .trailing : .leading, spacing: 5) {
                if !human { Text(entry.author.name).font(.caption).foregroundStyle(StrataTheme.secondaryInk).padding(.horizontal, 10).fixedSize(horizontal: false, vertical: true) }
                VStack(alignment: .leading, spacing: 8) {
                    if let replyId = entry.replyToId, !isImplicitRootReply(entry) {
                        let original = entries.first { $0.id == replyId }
                        Text("Replying to \(original?.author.name ?? "an earlier message")")
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            .accessibilityIdentifier("teamMessageReply-\(entry.id)")
                    }
                    if entry.kind != "assignment", let recipients = entry.recipientIds, !recipients.isEmpty, Set(recipients) != Set(team.memberIds) {
                        Text("To " + recipients.map { id in store.botCatalog?.bots.first { $0.id == id }?.name ?? "Teammate" }.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
                    }
                    if human, entry.workMode == .work { Label("Work request", systemImage: "hammer").font(.caption.weight(.medium)).foregroundStyle(.secondary).accessibilityIdentifier("teamMessageWorkRequest-" + entry.id) }
                    messageContent(entry)
                    if entry.kind != "message" { Text(entry.kind.replacingOccurrences(of: "_", with: " ").capitalized).font(.caption2.weight(.medium)).foregroundStyle(.secondary) }
                }.padding(.horizontal, 15).padding(.vertical, 12)
                    .background(human ? StrataTheme.grouped : StrataTheme.surface, in: RoundedRectangle(cornerRadius: 23))
                HStack(spacing: 8) {
                    if let date = entry.createdAt.date { Text(date, style: .time).font(.caption2).foregroundStyle(.secondary) }
                    Menu { messageActions(entry) } label: { Image(systemName: "ellipsis").font(.system(size: 13)).frame(width: 32, height: 28).contentShape(Rectangle()) }
                        .accessibilityLabel("Message actions from " + entry.author.name).accessibilityIdentifier("teamMessageOptions-\(entry.id)")
                }.padding(.horizontal, 8)
            }
            if !human { Spacer(minLength: dynamicTypeSize.isAccessibilitySize ? 4 : 22) }
        }.accessibilityElement(children: .contain).accessibilityIdentifier("teamMessage-\(entry.id)")
    }
    @ViewBuilder private func messageContent(_ entry: BotTeamChannelMessage) -> some View {
        if entry.usesCompactCard {
            VStack(alignment: .leading, spacing: 10) {
                Button {
                    if !expandedMessages.insert(entry.id).inserted { expandedMessages.remove(entry.id) }
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(entry.kind == "assignment" ? assignmentTitle(entry) : "Read full report").font(.subheadline.weight(.semibold)).lineLimit(2)
                            Text(entry.compactPreview).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: expandedMessages.contains(entry.id) ? "chevron.up" : "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityIdentifier("teamMessageDisclosure-\(entry.id)")
                    .accessibilityValue(expandedMessages.contains(entry.id) ? "Expanded" : "Collapsed")
                    .accessibilityHint(expandedMessages.contains(entry.id) ? "Hide full text" : "Show full text")
                if expandedMessages.contains(entry.id) {
                    Text(.init(entry.content)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("teamMessageContent-\(entry.id)")
                }
            }
        } else {
            Text(.init(entry.content)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("teamMessageContent-\(entry.id)")
        }
    }
    private func assignmentTitle(_ entry: BotTeamChannelMessage) -> String {
        guard let recipients = entry.recipientIds, !recipients.isEmpty else { return "View assignment" }
        return "Assigned to " + recipients.map { id in store.botCatalog?.bots.first { $0.id == id }?.name ?? "Teammate" }.joined(separator: ", ")
    }
    private func isImplicitRootReply(_ entry: BotTeamChannelMessage) -> Bool {
        guard let replyId = entry.replyToId, let runId = entry.runId,
              let original = entries.first(where: { $0.id == replyId }) else { return false }
        return original.author.type == "user" && original.runId == runId
    }
    @ViewBuilder private func messageActions(_ entry: BotTeamChannelMessage) -> some View {
        Button { reply = entry; requestId = UUID().uuidString; taskFocused = true } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }
            .accessibilityIdentifier("replyTeamMessage-\(entry.id)")
        if let chatId = entry.chatId, CompanionClient.isSafeIdentifier(chatId) {
            Button { openConversation(chatId) } label: { Label("Thinking & tools", systemImage: "bubble.left.and.bubble.right") }
                .disabled(store.isSubmittingMessage || store.isSending || store.isSelectingConversation)
        }
    }
    private func openConversation(_ chatId: String) {
        let generation = navigation, pairing = store.pairingGeneration
        Task {
            await store.refresh(silently: true)
            guard navigation == generation, store.pairingGeneration == pairing, let summary = store.conversations.first(where: { $0.id == chatId }) else { return }
            await store.selectConversation(summary)
            if navigation == generation, store.pairingGeneration == pairing, store.currentConversation?.id == chatId { showingDetails = false; openChat() }
        }
    }
    private func runRow(_ run: BotTeamRun) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack { Text(run.requestStateLabel(workReviewSupported: workspace.workReviewSupported)).font(.subheadline.weight(.semibold)); Spacer(); Text(run.turnLabel(unrestrictedTeams: workspace.unrestrictedTeams, continuousTeams: workspace.continuousTeams)).font(.caption).foregroundStyle(.secondary) }
            if let detail = run.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
            BotSharedConversationButton(store: store, chatId: run.rootChatId, title: "Open task conversation", openChat: { showingDetails = false; openChat() })
            if run.isActive { Button("Stop team task", role: .destructive) { confirmingStop = run }.buttonStyle(.borderless).disabled(workspace.mutation != nil).accessibilityIdentifier("stopBotTeamRunDetails-\(run.id)") }
        }.padding(.vertical, 6)
    }
    private func composer(_ team: BotTeam) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let reply {
                HStack(alignment: .top) {
                    Text("Replying to \(reply.author.name)").font(.caption).lineLimit(1).accessibilityIdentifier("teamReplyContext")
                    Spacer(); Button { self.reply = nil } label: { Image(systemName: "xmark.circle.fill").frame(width: 32, height: 28) }.accessibilityLabel("Cancel reply")
                }.foregroundStyle(.secondary)
            }
            if !recipient.isEmpty || !activeRuns.isEmpty || channel?.presence?.contains(where: { $0.state == "working" }) == true {
                HStack {
                    if !recipient.isEmpty { Text("To " + (recipient == "everyone" ? "Everyone" : store.botCatalog?.bots.first { $0.id == recipient }?.name ?? "Teammate")).lineLimit(2) }
                    Spacer(minLength: 0)
                    if let names = channel?.presence?.filter({ $0.state == "working" }).map({ row in store.botCatalog?.bots.first { $0.id == row.botId }?.name ?? "A teammate" }), !names.isEmpty {
                        Text(names.joined(separator: ", ") + (names.count == 1 ? " is working…" : " are working…")).lineLimit(2)
                    } else if !activeRuns.isEmpty { Label("Team working", systemImage: "circle.fill").labelStyle(.titleOnly).foregroundStyle(StrataTheme.accentText) }
                }.font(.caption).foregroundStyle(.secondary).padding(.horizontal, 8)
            }
            if supportsCoordinatorWork, channel?.supported == true {
                VStack(alignment: .leading, spacing: 6) {
                    Picker("Team message mode", selection: $workMode) {
                        Text("Chat").tag(BotTeamMessageWorkMode.chat)
                        Text("Work").tag(BotTeamMessageWorkMode.work)
                    }.pickerStyle(.segmented).disabled(workspace.mutation != nil).accessibilityIdentifier("teamMessageWorkModePicker")
                    Text(workMode == .work ? (workspace.workPlansSupported ? "Your coordinator saves a team plan with task owners, dependencies and review. Saved tools, approvals and the team computer/folder stay in force." : "Coordinator and teammates can use their saved tools, approvals and selected team computer/folder.") : "Talk with the team. Your coordinator can bring in teammates.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("teamMessageWorkModeExplanation")
                }.onChange(of: workMode) { _, _ in requestId = UUID().uuidString }
            }
            HStack(alignment: .bottom, spacing: 10) {
                Menu {
                    if channel?.supported == true {
                        recipientPicker(team)
                        Button("Draft a greeting to everyone", systemImage: "hand.wave") { workMode = .chat; message = "Hi everyone!"; recipient = "everyone"; reply = nil; requestId = UUID().uuidString; taskFocused = true }
                            .disabled(workspace.mutation != nil).accessibilityIdentifier("draftTeamGreetingButton")
                    }
                    Button("Team details", systemImage: "person.3") { taskFocused = false; showingDetails = true }
                    Button(workspace.workReviewSupported ? "Tasks & results" : "Previous tasks", systemImage: "checklist") { taskFocused = false; tasksExpanded = !workspace.workReviewSupported; showingDetails = true }
                    if reply != nil { Button("Cancel reply", systemImage: "xmark") { reply = nil } }
                } label: { Image(systemName: "plus").font(.system(size: 24, weight: .medium)).frame(width: 48, height: 48).strataChrome() }
                    .accessibilityLabel("Team message options").accessibilityIdentifier("teamComposerMenuButton")
                HStack(alignment: .bottom, spacing: 4) {
                    TextField(channel?.supported == true ? "Message…" : "What should this team do?", text: $message, axis: .vertical).lineLimit(1...5)
                        .focused($taskFocused).padding(.leading, 17).padding(.vertical, 14).accessibilityIdentifier("botTeamTaskInput")
                    Button { send(team) } label: { Image(systemName: "arrow.up").font(.system(size: 19, weight: .semibold)).frame(width: 40, height: 40).foregroundStyle(StrataTheme.primaryInk).background(StrataTheme.primaryFill, in: Circle()) }
                        .padding(4).accessibilityLabel(channel?.supported == true ? "Send to team" : "Start task")
                        .disabled(channel == nil || !team.enabled || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || message.utf16.count > 16_000 || workspace.mutation != nil)
                        .accessibilityIdentifier("startBotTeamTaskButton")
                }.background(StrataTheme.grouped, in: RoundedRectangle(cornerRadius: 27))
            }
            if let error = workspace.messages[channelKey] ?? workspace.messages["teams"] {
                Text(error).font(.caption).foregroundStyle(StrataTheme.warning).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("teamChannelComposerError")
            }
            if !team.enabled { Button("Review and enable your team") { settingsExpanded = true; showingDetails = true }.font(.caption).accessibilityIdentifier("reviewTeamForChatButton") }
        }.padding(.horizontal, 16).padding(.vertical, 10).background(StrataTheme.background)
            .background { GeometryReader { geometry in Color.clear.preference(key: BotTeamLegacyScrollPreference.self, value: .init(bottomInset: geometry.size.height)) } }
    }
    private func recipientPicker(_ team: BotTeam) -> some View {
        Picker("Recipients", selection: $recipient) {
            Text("Team").tag("")
            Text("Everyone").tag("everyone")
            ForEach(team.memberIds, id: \.self) { id in Text(store.botCatalog?.bots.first { $0.id == id }?.name ?? "Unavailable bot").tag(id) }
        }.pickerStyle(.menu).labelsHidden().accessibilityLabel("Message recipients")
            .accessibilityHint("The coordinator routes your message naturally.").accessibilityIdentifier("teamChannelRecipientPicker")
    }
    private func send(_ team: BotTeam) {
        taskFocused = false
        let generation = navigation, text = message, request = requestId
        let draft = BotTeamChannelPost(message: text, requestId: request, recipientIds: recipient.isEmpty ? nil : recipient == "everyone" ? team.memberIds : [recipient], replyToId: reply?.id, workMode: supportsCoordinatorWork ? workMode : nil, durablePlan: supportsCoordinatorWork && workspace.workPlansSupported && workMode == .work ? true : nil, everyone: recipient == "everyone" ? true : nil)
        Task {
            let sent: Bool
            if channel?.supported == true { sent = await workspace.postTeamMessage(team, draft: draft) }
            else { sent = await workspace.startTeam(team, message: text, requestId: request) != nil }
            // Leave the room in place. Reading Thinking is a separate explicit action.
            if sent, navigation == generation {
                sentScrollRequest = request
                if message == text, requestId == request { message = ""; workMode = .chat; reply = nil; requestId = UUID().uuidString }
            }
        }
    }
}

private struct BotTeamScrollMetrics: Equatable {
    var offset: CGFloat; var contentHeight: CGFloat; var viewportHeight: CGFloat; var bottomInset: CGFloat
    var nearBottom: Bool { offset + viewportHeight >= contentHeight + bottomInset - 44 }
    func movedWithoutContentGrowth(from old: Self) -> Bool {
        abs(offset - old.offset) > 0.5 && abs(contentHeight - old.contentHeight) < 0.5 && abs(viewportHeight - old.viewportHeight) < 0.5 && abs(bottomInset - old.bottomInset) < 0.5
    }
}
private struct BotTeamLegacyScrollValue: Equatable {
    var contentFrame: CGRect?; var viewportHeight: CGFloat?; var bottomInset: CGFloat?
    var metrics: BotTeamScrollMetrics? {
        guard let contentFrame, let viewportHeight else { return nil }
        return .init(offset: -contentFrame.minY, contentHeight: contentFrame.height, viewportHeight: viewportHeight, bottomInset: bottomInset ?? 0)
    }
}
private struct BotTeamLegacyScrollPreference: PreferenceKey {
    static let defaultValue = BotTeamLegacyScrollValue()
    static func reduce(value: inout BotTeamLegacyScrollValue, nextValue: () -> BotTeamLegacyScrollValue) {
        let next = nextValue()
        value.contentFrame = next.contentFrame ?? value.contentFrame
        value.viewportHeight = next.viewportHeight ?? value.viewportHeight
        value.bottomInset = next.bottomInset ?? value.bottomInset
    }
}
private struct BotTeamScrollObservation: ViewModifier {
    let changed: (Bool, Bool) -> Void
    @State private var previousLegacy: BotTeamScrollMetrics?
    @State private var userScrolling = false
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: BotTeamScrollMetrics.self) { geometry in
                .init(offset: geometry.visibleRect.minY, contentHeight: geometry.contentSize.height, viewportHeight: geometry.visibleRect.height, bottomInset: 0)
            } action: { old, new in changed(new.nearBottom, userScrolling && new.movedWithoutContentGrowth(from: old)) }
                .onScrollPhaseChange { _, phase in userScrolling = phase == .tracking || phase == .interacting || phase == .decelerating }
        } else {
            content.background { GeometryReader { geometry in Color.clear.preference(key: BotTeamLegacyScrollPreference.self, value: .init(viewportHeight: geometry.size.height)) } }
                .onPreferenceChange(BotTeamLegacyScrollPreference.self) { value in
                    guard let next = value.metrics else { return }
                    let moved = userScrolling && (previousLegacy.map { next.movedWithoutContentGrowth(from: $0) } ?? false)
                    previousLegacy = next; changed(next.nearBottom, moved)
                }
                .simultaneousGesture(DragGesture(minimumDistance: 1).onChanged { _ in userScrolling = true }.onEnded { _ in userScrolling = false })
        }
    }
}

private struct BotActivityView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    @State private var reviewingWork: BotWorkspaceActivity?
    @State private var workHistoryExpanded = false
    @State private var activityHistoryExpanded = false
    let openChat: () -> Void
    @State private var visible = false
    @State private var supervisionFilter: BotSupervisionFilter = .all
    @State private var supervisionLimit = 12
    @State private var harnessDetails: Set<String> = []
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        List {
            if let snapshot = workspace.supervision, snapshot.supported {
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(workspace.messages["supervision"] == nil ? "YOUR BOTS, AT A GLANCE" : "LAST KNOWN ACTIVITY")
                            .font(.caption2.weight(.semibold)).tracking(1).foregroundStyle(StrataTheme.accentText)
                        Text(snapshot.headline).font(.title2.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                        Text("Approvals first. Follow the exact conversation to review tools, thinking and results.")
                            .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 124), spacing: 10)], spacing: 10) {
                            ForEach(BotSupervisionFilter.allCases) { filter in
                                Button { supervisionFilter = filter; supervisionLimit = 12 } label: {
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text("\(filter.count(snapshot.counts))").font(.title3.weight(.semibold))
                                        Text(filter.rawValue).font(.caption.weight(.medium)).fixedSize(horizontal: false, vertical: true)
                                    }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
                                        .background(supervisionFilter == filter ? StrataTheme.accentTint : StrataTheme.grouped, in: RoundedRectangle(cornerRadius: 14))
                                        .foregroundStyle(supervisionFilter == filter ? StrataTheme.accentText : StrataTheme.ink)
                                }.buttonStyle(.plain).accessibilityAddTraits(supervisionFilter == filter ? [.isSelected] : [])
                                    .accessibilityIdentifier("botSupervisionFilter-" + filter.id)
                            }
                        }
                    }.padding(.vertical, 8).accessibilityIdentifier("botSupervisionSummary")
                }.listRowBackground(Color.clear)
                Section {
                    let sessions = snapshot.sessions.filter(supervisionFilter.includes)
                    ForEach(Array(sessions.prefix(supervisionLimit))) { session in
                        supervisionRow(session)
                    }
                    if sessions.isEmpty {
                        Label(supervisionFilter == .attention ? "Nothing waiting on you" : "No conversations in this view", systemImage: "checkmark.circle")
                            .foregroundStyle(.secondary).padding(.vertical, 12).accessibilityIdentifier("botSupervisionEmpty")
                    }
                    if sessions.count > supervisionLimit { Button("Show more conversations") { supervisionLimit += 12 } }
                    if snapshot.hasMore { Text("Showing the 200 most urgent or recent conversations. Open a bot to browse its full history.").font(.caption).foregroundStyle(.secondary) }
                } header: { Text("Live conversations") } footer: { Text("Finished and failed conversations stay here for 24 hours. Your complete history stays with each bot.") }
            }
            if workspace.loading.contains("supervision"), workspace.supervision == nil {
                Section { ProgressView("Checking your bots…") }
            }
            if workspace.messages["supervision"] != nil {
                Section { BotWorkspaceMessage(workspace: workspace, key: "supervision") }
            }
            BotHarnessRecoverySection(store: store, workspace: workspace, openChat: openChat)
            if workspace.workReviewSupported {
                let overview = BotTeamWorkOverview(workspace.activity)
                Section {
                    if workspace.activityLoaded { BotTeamWorkSummary(overview: overview, stale: workspace.messages["activity"] != nil) }
                    else if workspace.messages["activity"] == nil { ProgressView("Checking current work…") }
                    else { Text("Current work is unavailable. Refresh to check your team.").font(.callout).foregroundStyle(.secondary).accessibilityIdentifier("teamCurrentWorkUnavailable") }
                    ForEach(overview.current) { item in taskActivityRow(item) }
                    if workspace.activityLoaded, overview.current.isEmpty { BotTeamEarlierWorkNotice(overview: overview, stale: workspace.messages["activity"] != nil) { workHistoryExpanded = true } }
                    BotWorkspaceMessage(workspace: workspace, key: "activity")
                } header: { Text("Current work") }
                if !overview.history.isEmpty {
                    Section {
                        Button { workHistoryExpanded.toggle() } label: {
                            HStack { Label("Task history", systemImage: "clock"); Spacer(); Text("\(overview.history.count)").foregroundStyle(.secondary); Image(systemName: workHistoryExpanded ? "chevron.up" : "chevron.down") }.contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityValue(workHistoryExpanded ? "Expanded" : "Collapsed").accessibilityIdentifier("teamWorkHistoryDisclosure")
                        if workHistoryExpanded { ForEach(overview.history) { item in taskActivityRow(item) } }
                    }
                }
                let otherActivity = workspace.activity.filter { $0.work == nil }
                let live = otherActivity.filter(\.isExecutionActive)
                if !live.isEmpty { Section("Team conversations in motion") { ForEach(live) { item in taskActivityRow(item) } } }
                let earlier = otherActivity.filter { !$0.isExecutionActive }
                if !earlier.isEmpty {
                    Section {
                        Button { activityHistoryExpanded.toggle() } label: {
                            HStack { Text("Earlier team activity"); Spacer(); Text("\(earlier.count)").foregroundStyle(.secondary); Image(systemName: activityHistoryExpanded ? "chevron.up" : "chevron.down") }.contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityValue(activityHistoryExpanded ? "Expanded" : "Collapsed").accessibilityIdentifier("earlierTeamActivityDisclosure")
                        if activityHistoryExpanded { ForEach(earlier) { item in taskActivityRow(item) } }
                    }
                }
            } else {
                Section {
                    if workspace.activity.isEmpty, !workspace.loading.contains("activity"), workspace.messages["activity"] == nil { Text("Team tasks, bot messages and subagents will appear here.").foregroundStyle(.secondary) }
                    ForEach(workspace.activity) { item in taskActivityRow(item) }
                    BotWorkspaceMessage(workspace: workspace, key: "activity")
                } header: { Text("Team activity") }
            }
            Section("Shared work") {
                ForEach(store.conversations.filter { $0.active }) { conversation in
                    BotSharedConversationButton(store: store, chatId: conversation.id, title: conversation.title, openChat: openChat)
                }
                Text("Open a conversation to review its current approval requests or stop that exact task.").font(.caption).foregroundStyle(.secondary)
            }
        }.strataList()
            .sheet(item: $reviewingWork) { item in NavigationStack {
                BotTeamTaskReviewView(store: store, workspace: workspace, item: item, openChat: { reviewingWork = nil; openChat() })
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { reviewingWork = nil }.accessibilityIdentifier("closeTeamWorkReviewButton") } }
            } }
            .refreshable { await workspace.refreshSupervision(); await workspace.refreshHarnessActions(force: true); await workspace.refreshActivity(); await workspace.refreshTeams(); await store.refresh(silently: true) }
            .onAppear { visible = true }
            .onDisappear { visible = false }
            .task(id: visible && scenePhase == .active) {
                guard visible, scenePhase == .active else { return }
                repeat {
                    if workspace.mutation == nil {
                        if !workspace.loading.contains("supervision") { await workspace.refreshSupervision() }
                        if !workspace.loading.contains("harnessActions") { await workspace.refreshHarnessActions() }
                        if !workspace.loading.contains("activity") { await workspace.refreshActivity() }
                        if !workspace.loading.contains("teams") { await workspace.refreshTeams() }
                    }
                    do { try await Task.sleep(for: .seconds(3)) } catch { break }
                } while !Task.isCancelled && visible && scenePhase == .active
            }
    }
    private func taskActivityRow(_ item: BotWorkspaceActivity) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            if workspace.workReviewSupported, item.work != nil {
                BotTeamTaskLabel(item: item, stale: workspace.messages["activity"] != nil, ownerName: item.botId.map(botName))
                Button("Results & recovery", systemImage: "checklist") { reviewingWork = item }
                    .buttonStyle(.borderless).accessibilityIdentifier("openTeamWork-" + item.id)
            } else {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: item.icon).font(.subheadline).frame(width: 36, height: 36).background(StrataTheme.grouped, in: RoundedRectangle(cornerRadius: 12))
                    VStack(alignment: .leading, spacing: 5) {
                        Text(item.title).font(.body.weight(.semibold))
                        StrataStatusPill(title: workspace.workReviewSupported && item.state == "completed" ? "Turn finished" : item.state.replacingOccurrences(of: "_", with: " ").capitalized,
                            tone: item.isExecutionActive ? .accent : .neutral)
                    }
                }
                if let from = item.fromBotId, let to = item.toBotId { Text(botName(from) + " → " + botName(to)).font(.subheadline) }
                if let detail = item.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
            }
            if let chatId = item.chatId ?? workspace.teams?.runs.first(where: { $0.id == item.runId })?.rootChatId {
                BotSharedConversationButton(store: store, chatId: chatId, title: "Open conversation", openChat: openChat)
            }
        }.padding(.vertical, 8).accessibilityElement(children: .contain).accessibilityIdentifier("botActivity-\(item.id)")
    }
    private func supervisionRow(_ session: BotSupervisionSession) -> some View {
        let bot = store.botCatalog?.bots.first { $0.id == session.botId }
        let stale = workspace.messages["supervision"] != nil
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                ExpressiveBotAvatar(config: bot?.face ?? .default(for: session.name), size: 44,
                    mood: stale ? .idle : session.state == .approval ? .needsApproval : session.state == .error ? .error : session.isWorking ? .working : .idle, animated: !stale)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.name).font(.headline)
                    Text(session.context).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            Text(session.title).font(.body.weight(.medium)).fixedSize(horizontal: false, vertical: true)
            StrataStatusPill(title: (stale ? "Last known: " : "") + session.statusLabel,
                tone: stale ? .neutral : session.needsAttention ? .attention : session.isWorking ? .accent : .success)
            if session.state == .working, let tool = session.toolName {
                Text(tool.replacingOccurrences(of: "_", with: " ")).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let value = session.harness, value.isValid {
                let expanded = harnessDetails.contains(session.id)
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        if expanded { harnessDetails.remove(session.id) } else { harnessDetails.insert(session.id) }
                    }
                } label: {
                    HStack {
                        Text(value.label + " · " + BotHarnessDiagnostics.seconds(value.elapsedMs))
                        Spacer()
                        Image(systemName: expanded ? "chevron.down" : "chevron.right").accessibilityHidden(true)
                    }.font(.caption).frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.borderless).accessibilityIdentifier("botHarnessDetails-" + session.id)
                    .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                    .accessibilityHint("Shows provider, approval and tool timing.")
                if expanded {
                    VStack(alignment: .leading, spacing: 6) {
                        if let first = value.firstOutputMs { LabeledContent("First response", value: BotHarnessDiagnostics.seconds(first)) }
                        LabeledContent("Preparation", value: BotHarnessDiagnostics.seconds(value.timings.startingMs))
                        LabeledContent("Provider wait", value: BotHarnessDiagnostics.seconds(value.timings.modelMs))
                        LabeledContent("Approval wait", value: BotHarnessDiagnostics.seconds(value.timings.approvalMs))
                        LabeledContent("Tools", value: BotHarnessDiagnostics.seconds(value.timings.toolMs))
                        LabeledContent("Cleanup", value: BotHarnessDiagnostics.seconds(value.timings.cleanupMs))
                        LabeledContent("Tool calls / errors", value: "\(value.toolCalls) / \(value.toolErrors)")
                        LabeledContent("Context compactions", value: "\(value.contextCompactions)")
                        Text("Observed for this host session. Provider wait includes connection and startup time. Timings do not verify the task’s result.").foregroundStyle(.secondary)
                    }.font(.caption).padding(.top, 6)
                }
            }
            BotSharedConversationButton(store: store, chatId: session.id,
                title: session.state == .approval ? "Review approval" : "Open conversation", openChat: openChat)
        }.padding(.vertical, 10).accessibilityElement(children: .contain).accessibilityIdentifier("botSupervision-" + session.id)
    }
    private func botName(_ id: String) -> String { store.botCatalog?.bots.first { $0.id == id }?.name ?? "Bot" }
}

private struct BotCapabilitiesLibraryView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    @State private var library = "skills"
    var body: some View {
        VStack(spacing: 0) {
            Picker("Library", selection: $library) {
                Text("Skills").tag("skills")
                Text("Tools").tag("tools")
            }.pickerStyle(.segmented).padding(.horizontal).padding(.vertical, 8).accessibilityIdentifier("botCapabilitiesLibraryPicker")
            if library == "tools" { BotCreatedToolsView(store: store, workspace: workspace) }
            else { BotSkillsView(store: store, workspace: workspace) }
        }
    }
}

private struct BotCreatedToolsView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    @State private var creating = false
    private var available: Bool { workspace.createdTools?.isAvailable == true && workspace.messages["createdTools"] == nil }
    var body: some View {
        List {
            Section {
                Label("Build a tool once. Let your bots reuse it.", systemImage: "wrench.and.screwdriver").font(.headline)
                Text("Ask a bot to create a reusable tool when it needs a new capability. Its draft appears here for you to review, enable and share.").font(.subheadline).foregroundStyle(.secondary)
                Button { creating = true } label: { Label("Create draft tool", systemImage: "plus") }
                    .disabled(!available || workspace.mutation != nil).accessibilityIdentifier("createBotToolButton")
            }
            Section("Reusable tools") {
                ForEach(workspace.createdTools?.tools ?? []) { tool in
                    NavigationLink {
                        BotCreatedToolDetailView(store: store, workspace: workspace, toolId: tool.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack { Text(tool.name).font(.headline); Spacer(); Text(tool.status.capitalized).font(.caption).foregroundStyle(tool.isEnabled ? StrataTheme.accentText : StrataTheme.secondaryInk) }
                            Text(tool.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            if let botId = tool.provenance?.botId {
                                Text("Created by " + (store.botCatalog?.bots.first { $0.id == botId }?.name ?? "a bot")).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }.accessibilityIdentifier("botTool-\(tool.id)")
                }
                if available && workspace.createdTools?.tools.isEmpty == true {
                    Text("No tools yet. Ask a bot what it needs, or create a draft above.").font(.subheadline).foregroundStyle(.secondary)
                }
                BotWorkspaceMessage(workspace: workspace, key: "createdTools")
            }
        }.strataList()
            .task(id: ObjectIdentifier(workspace)) { await workspace.refreshCreatedTools() }
            .refreshable { await workspace.refreshCreatedTools() }
            .sheet(isPresented: $creating) { BotCreatedToolEditor(workspace: workspace) }
    }
}

private struct BotCreatedToolDetailView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let toolId: String
    @State private var editing = false
    @State private var reviewedRevision: Int?
    @State private var reviewedDigest: String?
    @State private var deleting = false
    @State private var deletionTarget: BotCreatedTool?
    @Environment(\.dismiss) private var dismiss
    private var tool: BotCreatedTool? { workspace.createdTools?.tools.first { $0.id == toolId } }
    private var reviewed: Bool { tool?.hasValidReview == true && reviewedRevision == tool?.revision && reviewedDigest == tool?.digest }
    private var available: Bool { workspace.createdTools?.isAvailable == true && workspace.messages["createdTools"] == nil }
    private var busy: Bool { workspace.mutation != nil || workspace.isPreparingAssignment }
    private func assignment(tool: BotCreatedTool, id: String, team: Bool) -> Binding<Bool> {
        Binding(get: { team ? self.tool?.teamIds.contains(id) == true : self.tool?.botIds.contains(id) == true }, set: { value in
            Task { _ = await workspace.assignCreatedTool(tool, botId: team ? nil : id, teamId: team ? id : nil, assigned: value) }
        })
    }
    private func assignmentDisabled(tool: BotCreatedTool, assigned: Bool) -> Bool { !available || !reviewed || busy || (!tool.isEnabled && !assigned) }
    var body: some View {
        List {
            if let tool {
                Section("Definition to review") {
                    Text(tool.description).font(.subheadline)
                    LabeledContent("Type", value: "Command")
                    LabeledContent("Timeout", value: "\(tool.timeoutSeconds) seconds")
                    LabeledContent("Revision", value: String(tool.revision))
                    Text(tool.command).font(.system(.caption, design: .monospaced)).textSelection(.enabled).accessibilityIdentifier("botToolReviewedCommand")
                }
                Section("Inputs") {
                    Text(tool.inputSchema.formatted).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    if let requirements = tool.requirements {
                        LabeledContent("Platforms", value: requirements.platforms.isEmpty ? "Any supported platform" : requirements.platforms.joined(separator: ", "))
                        LabeledContent("Programs", value: requirements.executables.isEmpty ? "None declared" : requirements.executables.joined(separator: ", "))
                        LabeledContent("Workspace files", value: requirements.workspaceFiles.isEmpty ? "None declared" : requirements.workspaceFiles.joined(separator: ", "))
                    }
                    Text("Ask the bot to check this exact tool on its selected computer. Checks use its normal command permission and install nothing. Declared requirements are checked again before execution.").font(.caption).foregroundStyle(.secondary)
                    Text("The command reads inputs from STRATA_TOOL_INPUT as JSON. It runs on the bot’s selected computer, inside that bot’s workspace and tool permissions.").font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    if !reviewed {
                        Button("I reviewed this version") { reviewedRevision = tool.revision; reviewedDigest = tool.digest }
                            .disabled(!available || busy || !tool.hasValidReview).accessibilityIdentifier("reviewBotToolButton")
                    } else { Label("Version reviewed", systemImage: "checkmark.circle").foregroundStyle(StrataTheme.accentText) }
                    Button("Edit draft") { editing = true }.disabled(!available || !reviewed || busy).accessibilityIdentifier("editBotToolButton")
                    Button(tool.isEnabled ? "Return to draft" : "Enable reviewed tool") {
                        Task { await workspace.setCreatedToolEnabled(tool, enabled: !tool.isEnabled) }
                    }.disabled(!available || !reviewed || busy).accessibilityIdentifier("enableBotToolButton")
                } footer: {
                    Text("Enabling and sharing do not run a command. The author can test its draft through normal bot work. Other bots can use an enabled tool through their normal approval policy. Editing its definition returns it to draft.")
                }
                Section("Bots with access") {
                    ForEach(store.botCatalog?.bots ?? []) { bot in
                        Toggle(bot.name, isOn: assignment(tool: tool, id: bot.id, team: false))
                            .disabled(assignmentDisabled(tool: tool, assigned: tool.botIds.contains(bot.id))).accessibilityIdentifier("toolBotAssignment-\(bot.id)")
                    }
                }
                Section {
                    ForEach(workspace.teams?.teams ?? []) { team in
                        Toggle(team.name, isOn: assignment(tool: tool, id: team.id, team: true))
                            .disabled(assignmentDisabled(tool: tool, assigned: tool.teamIds.contains(team.id))).accessibilityIdentifier("toolTeamAssignment-\(team.id)")
                    }
                    BotWorkspaceMessage(workspace: workspace, key: "teams")
                } header: { Text("Teams with access") } footer: { Text("Team access applies to the team’s work. It does not grant access to those bots’ private conversations.") }
                Section {
                    Button("Delete tool", role: .destructive) { deletionTarget = tool; deleting = true }
                        .disabled(!available || !reviewed || busy).accessibilityIdentifier("deleteBotToolButton")
                } footer: { Text("Removing this tool prevents future use. It does not stop a command that is already running.") }
            } else if workspace.loading.contains("createdTools") { ProgressView("Loading tool…") }
            else { Text("This tool is no longer available.").foregroundStyle(.secondary) }
            Section {
                BotWorkspaceMessage(workspace: workspace, key: "createdTools")
                Button("Refresh tools") { Task { await workspace.refreshCreatedTools() } }.disabled(busy)
            }
        }.strataList().navigationTitle(tool?.name ?? "Tool").navigationBarTitleDisplayMode(.inline)
            .task { await workspace.refreshCreatedTools(); await workspace.refreshTeams() }
            .sheet(isPresented: $editing) { if let tool { BotCreatedToolEditor(workspace: workspace, tool: tool) } }
            .confirmationDialog("Delete this reviewed tool?", isPresented: $deleting, titleVisibility: .visible, presenting: deletionTarget) { target in
                Button("Delete tool", role: .destructive) { Task { if await workspace.deleteCreatedTool(target) { dismiss() } } }
            }
    }
}

private struct BotCreatedToolEditor: View {
    @ObservedObject var workspace: BotWorkspaceStore
    let tool: BotCreatedTool?
    @State private var draft: BotCreatedToolDraft
    @State private var requirementPlatforms: [String] = []
    @State private var requirementPrograms = ""
    @State private var requirementFiles = ""
    @State private var schemaText: String
    @State private var reviewedTool: BotCreatedTool?
    @State private var ready: Bool
    @Environment(\.dismiss) private var dismiss
    init(workspace: BotWorkspaceStore, tool: BotCreatedTool? = nil) {
        self.workspace = workspace; self.tool = tool
        let value = tool.map(BotCreatedToolDraft.init(tool:)) ?? BotCreatedToolDraft()
        _draft = State(initialValue: value); _schemaText = State(initialValue: value.inputSchema.formatted)
        _requirementPlatforms = State(initialValue: value.requirements?.platforms ?? [])
        _requirementPrograms = State(initialValue: value.requirements?.executables.joined(separator: "\n") ?? "")
        _requirementFiles = State(initialValue: value.requirements?.workspaceFiles.joined(separator: "\n") ?? "")
        _ready = State(initialValue: tool == nil)
    }
    private var parsedDraft: BotCreatedToolDraft? {
        guard schemaText.utf8.count <= 16_000, let data = schemaText.data(using: .utf8), let schema = try? JSONDecoder().decode(BotToolJSON.self, from: data) else { return nil }
        var value = draft; value.inputSchema = schema
        if workspace.createdTools?.createdToolReadinessSupported == true {
            func lines(_ text: String) -> [String] { text.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
            value.requirements = BotToolRequirements(platforms: requirementPlatforms, executables: lines(requirementPrograms), workspaceFiles: lines(requirementFiles))
        }
        return value.isValid ? value : nil
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Reusable tool") {
                    TextField("Name", text: $draft.name).accessibilityIdentifier("botToolNameInput")
                    TextField("Description", text: $draft.description, axis: .vertical).accessibilityIdentifier("botToolDescriptionInput")
                    Stepper("Timeout: \(draft.timeoutSeconds) seconds", value: $draft.timeoutSeconds, in: 1...120)
                }
                Section("Command") {
                    TextEditor(text: $draft.command).frame(minHeight: 140).font(.system(.body, design: .monospaced)).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("botToolCommandInput")
                    Text("Use STRATA_TOOL_INPUT for JSON inputs. Saving a draft never runs it.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Input schema") {
                    TextEditor(text: $schemaText).frame(minHeight: 160).font(.system(.caption, design: .monospaced)).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("botToolSchemaInput")
                    Text("Use an object with up to 32 string, number, integer or boolean properties, a required array and additionalProperties: false.").font(.caption).foregroundStyle(.secondary)
                    if parsedDraft == nil { Text("Enter a name, command and supported JSON input schema to save.").font(.caption).foregroundStyle(StrataTheme.warning) }
                }
                if workspace.createdTools?.createdToolReadinessSupported == true {
                    Section("Computer requirements · optional") {
                        ForEach(["darwin", "linux", "win32"], id: \.self) { platform in
                            Toggle(platform == "darwin" ? "macOS" : platform == "win32" ? "Windows" : "Linux", isOn: Binding(get: { requirementPlatforms.contains(platform) }, set: { enabled in
                                requirementPlatforms.removeAll { $0 == platform }; if enabled { requirementPlatforms.append(platform) }
                            })).accessibilityIdentifier("botToolPlatform-" + platform)
                        }
                        TextField("Required programs · one per line", text: $requirementPrograms, axis: .vertical).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("botToolProgramsInput")
                        TextField("Workspace files · one relative path per line", text: $requirementFiles, axis: .vertical).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("botToolFilesInput")
                        if !requirementPlatforms.isEmpty || !requirementPrograms.isEmpty || !requirementFiles.isEmpty {
                            Button("Clear requirements") { requirementPlatforms = []; requirementPrograms = ""; requirementFiles = "" }.accessibilityIdentifier("clearBotToolRequirementsButton")
                        }
                        Text("Leave platforms off to allow any supported platform. Up to 16 programs and 16 files. Saving installs and executes nothing.").font(.caption).foregroundStyle(.secondary)
                        if parsedDraft == nil { Text("Use up to 16 unique program names without arguments and 16 relative file paths without traversal.").font(.caption).foregroundStyle(StrataTheme.warning) }
                    }
                } else {
                    Section { Text("Update Strata on your Mac to declare computer requirements.").font(.caption).foregroundStyle(.secondary) }
                }
                Section { BotWorkspaceMessage(workspace: workspace, key: "createdTools") }
            }.disabled(!ready || workspace.mutation != nil)
                .navigationTitle(tool == nil ? "Draft tool" : "Edit tool").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(workspace.mutation != nil) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save draft") { Task { if let value = parsedDraft, await workspace.saveCreatedTool(value, reviewing: reviewedTool) { dismiss() } } }
                            .disabled(!ready || parsedDraft == nil || workspace.mutation != nil).accessibilityIdentifier("saveBotToolButton")
                    }
                }
                .task {
                    if let tool {
                        await workspace.refreshCreatedTools()
                        if workspace.messages["createdTools"] == nil, let fresh = workspace.createdTools?.tools.first(where: { $0.id == tool.id }), fresh.matchesReview(tool) {
                            draft = BotCreatedToolDraft(tool: fresh); schemaText = fresh.inputSchema.formatted; reviewedTool = fresh; ready = true
                            requirementPlatforms = fresh.requirements?.platforms ?? []; requirementPrograms = fresh.requirements?.executables.joined(separator: "\n") ?? ""; requirementFiles = fresh.requirements?.workspaceFiles.joined(separator: "\n") ?? ""
                        }
                    }
                }
                .interactiveDismissDisabled(workspace.mutation != nil)
        }
    }
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
        }.strataList()
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
        }.strataList().navigationTitle(skill?.name ?? "Skill").navigationBarTitleDisplayMode(.inline)
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

private struct BotSharedConversationButton: View {
    @ObservedObject var store: CompanionStore
    let chatId: String
    let title: String
    let openChat: () -> Void
    @State private var navigation = UUID()
    var body: some View {
        Button {
            let generation = navigation, pairing = store.pairingGeneration
            Task {
                await store.refresh(silently: true)
                guard navigation == generation, store.pairingGeneration == pairing, let summary = store.conversations.first(where: { $0.id == chatId }) else { return }
                await store.selectConversation(summary)
                if navigation == generation, store.pairingGeneration == pairing, store.currentConversation?.id == chatId { openChat() }
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


private struct BotTeamEarlierWorkNotice: View {
    let overview: BotTeamWorkOverview
    let stale: Bool
    let reviewEarlierWork: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(stale ? "At the last check, no current tasks were tracked." : "No current tasks are tracked.")
                .font(.callout).foregroundStyle(.secondary).accessibilityIdentifier("teamCurrentWorkEmpty")
            if overview.earlierUnverifiedCount > 0 {
                Text(overview.earlierUnverifiedSummary).font(.callout).foregroundStyle(.secondary)
                    .accessibilityIdentifier("teamEarlierUnverifiedSummary")
                Button("Review earlier work", systemImage: "clock.arrow.circlepath", action: reviewEarlierWork)
                    .buttonStyle(.borderless).accessibilityIdentifier("reviewEarlierTeamWorkButton")
            }
        }.fixedSize(horizontal: false, vertical: true)
    }
}

private struct BotTeamWorkSummary: View {
    let overview: BotTeamWorkOverview
    var stale = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(stale ? "Last known work" : "What needs attention").font(.headline)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { counts }
                VStack(alignment: .leading, spacing: 8) { counts }
            }
            if stale { Text("Refresh to check the current status.").font(.caption).foregroundStyle(.secondary) }
        }.padding(.vertical, 6).accessibilityElement(children: .contain).accessibilityIdentifier("teamCurrentWorkSummary")
    }
    @ViewBuilder private var counts: some View {
        Label("\(overview.attentionCount) need you", systemImage: "hand.raised").foregroundStyle(overview.attentionCount > 0 ? StrataTheme.warning : .secondary)
        Label("\(overview.workingCount) working", systemImage: "bolt").foregroundStyle(overview.workingCount > 0 ? StrataTheme.accentText : .secondary)
    }
}

private struct BotTeamTaskLabel: View {
    let item: BotWorkspaceActivity
    var showSummary = true
    var stale = false
    var ownerName: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(item.title).font(.body.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
            StrataStatusPill(title: (stale ? "Last known: " : "") + item.workStatusLabel, tone: item.work?.status == .verified ? .success : item.isWorkingNow ? .accent : item.needsOwnerAttention ? .attention : .neutral)
            if let ownerName { Label(ownerName, systemImage: "person.crop.circle").font(.caption).foregroundStyle(.secondary) }
            if let date = item.latestWorkDate {
                Text("Updated " + date.formatted(date: .abbreviated, time: .shortened)).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let work = item.work {
                Label(item.isClosedLegacyWork ? "Earlier activity · no saved task result" : work.evidenceSummary, systemImage: item.isClosedLegacyWork ? "clock" : "paperclip").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("teamWorkEvidenceCount-" + item.id)
                if let changes = work.latestRequestedChanges {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Requested changes").font(.caption.weight(.semibold))
                        Text(changes).font(.caption).lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    }.foregroundStyle(StrataTheme.warning).accessibilityIdentifier("teamWorkRequestedChanges-" + item.id)
                }
            }
            if showSummary, let summary = item.work?.summary, !summary.isEmpty { Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
        }.padding(.vertical, 5)
    }
}

/// Every mutation in this view follows a deliberate owner tap. Opening results
/// and inspecting a recovery plan only read the Mac's saved task state.
private struct BotTeamTaskReviewView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let item: BotWorkspaceActivity
    let openChat: () -> Void
    @State private var note = ""
    @State private var confirmingReview: String?
    @State private var reviewTarget: BotWorkspaceActivity?
    @State private var resumeTarget: BotWorkspaceActivity?
    @State private var resumePlan: BotTeamRecoveryPlan?
    @State private var confirmingResume = false
    @State private var idempotencyKey = UUID().uuidString
    @State private var showEarlierResults = false
    @Environment(\.scenePhase) private var scenePhase
    private var current: BotWorkspaceActivity? { workspace.activity.first { $0.id == item.id && $0.teamId == item.teamId } }
    private var work: BotTeamWork? { store.isPaired && workspace.workReviewSupported ? current?.work : nil }
    private var key: String { BotWorkspaceStore.workKey(item.id) }
    private var plan: BotTeamRecoveryPlan? { workspace.recoveryPlans[item.id] }
    private var busy: Bool { workspace.mutation != nil || workspace.loading.contains(key) }

    var body: some View {
        List {
            if let current, let work {
                Section {
                    BotTeamTaskLabel(item: current, showSummary: false, stale: workspace.messages["activity"] != nil)
                    if let summary = work.summary, !summary.isEmpty { Text(summary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("teamWorkSummary") }
                    if work.status == .readyForReview {
                        Text("The bot submitted these results. Review the evidence before marking the task verified.").font(.callout).foregroundStyle(.secondary)
                    } else if work.status == .verified {
                        Text("You marked this submitted result verified. That decision does not grant new tool permissions.").font(.caption).foregroundStyle(.secondary)
                    } else if let detail = current.detail, !detail.isEmpty { Text(detail).font(.callout).textSelection(.enabled) }
                    if let chatId = current.chatId { BotSharedConversationButton(store: store, chatId: chatId, title: "Open task conversation", openChat: openChat) }
                }
                if !work.evidence.isEmpty {
                    Section("Submitted evidence") { evidenceRows(work.evidence) }
                }
                if work.canReview {
                    Section {
                        if current.isExecutionActive { Text("The result was submitted, and the bot is still finishing its work. Review will be available after it stops.").font(.callout).foregroundStyle(.secondary) }
                        TextField("Review note (optional)", text: $note, axis: .vertical).lineLimit(3...7).accessibilityIdentifier("teamWorkReviewNote")
                        if note.utf16.count > 2_500 { Text("Keep your note under 2,500 characters.").font(.caption).foregroundStyle(StrataTheme.warning) }
                        Button("Mark verified", systemImage: "checkmark.seal") { reviewTarget = current; confirmingReview = "accept" }
                            .disabled(busy || current.isExecutionActive || note.utf16.count > 2_500).accessibilityIdentifier("verifyTeamWorkButton")
                        Button("Request changes", systemImage: "arrow.uturn.backward") { reviewTarget = current; confirmingReview = "reject" }
                            .disabled(busy || current.isExecutionActive || note.utf16.count > 2_500).accessibilityIdentifier("requestTeamWorkChangesButton")
                    } header: { Text("Your review") } footer: { Text("Requesting changes records your feedback. It does not restart the task.") }
                }
                if work.canPlanRecovery {
                    Section {
                        Button("Prepare recovery", systemImage: "arrow.clockwise") { Task { await workspace.refreshRecovery(current) } }
                            .disabled(busy).accessibilityIdentifier("prepareTeamRecoveryButton")
                        Text("Review the saved context and exact working computer before you resume this one unfinished task.").font(.caption).foregroundStyle(.secondary)
                    } header: { Text("Recovery") }
                } else if work.recoveryJobId != nil {
                    Section("Recovery") { Text("A continuation was already created for this task. Its results appear in the team's task list.").font(.callout).accessibilityIdentifier("teamWorkAlreadyRecovered") }
                }
                if let plan { recoverySection(plan, current: current) }
                if !work.reviewHistory.isEmpty {
                    Section("Owner review history") {
                        ForEach(Array(work.reviewHistory.enumerated()), id: \.offset) { _, review in
                            VStack(alignment: .leading, spacing: 6) {
                                Label(review.decision == "accept" ? "Marked verified" : "Changes requested", systemImage: review.decision == "accept" ? "checkmark.seal" : "arrow.uturn.backward").font(.subheadline.weight(.medium))
                                if let note = review.note, !note.isEmpty { Text(note).font(.callout).textSelection(.enabled) }
                            }.padding(.vertical, 4)
                        }
                    }
                }
                if work.resultHistory.count > 1 {
                    Section {
                        DisclosureGroup("Earlier submitted results", isExpanded: $showEarlierResults) {
                            ForEach(work.resultHistory.dropLast()) { result in
                                VStack(alignment: .leading, spacing: 10) { Text(result.summary).textSelection(.enabled); evidenceRows(result.evidence) }.padding(.vertical, 8)
                            }
                        }
                    }
                }
            } else {
                Section { Text("This task is no longer available, or the Mac no longer supports result review. Refresh before continuing.").foregroundStyle(.secondary) }
            }
            if busy { Section { ProgressView("Updating task…") } }
            if let message = workspace.messages[key] { Section { Text(message).foregroundStyle(StrataTheme.warning).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("teamWorkError") } }
        }.strataList().navigationTitle("Task results").navigationBarTitleDisplayMode(.inline)
            .accessibilityIdentifier("teamWorkReviewView")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Refresh", systemImage: "arrow.clockwise") { Task { await workspace.refreshTeams(); await workspace.refreshActivity() } }.disabled(busy).accessibilityIdentifier("refreshTeamWorkButton") } }
            .task { await workspace.refreshActivity() }
            .onChange(of: plan?.id) { _, _ in idempotencyKey = UUID().uuidString }
            .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await workspace.refreshTeams(); await workspace.refreshActivity() } } }
            .confirmationDialog(confirmingReview == "accept" ? "Mark this submitted result verified?" : "Request changes to this submitted result?", isPresented: Binding(get: { confirmingReview != nil }, set: { if !$0 { confirmingReview = nil } })) {
                if let decision = confirmingReview, let target = reviewTarget {
                    Button(decision == "accept" ? "Mark verified" : "Request changes") {
                        confirmingReview = nil
                        Task { _ = await workspace.reviewWork(target, decision: decision, note: note) }
                    }.accessibilityIdentifier("confirmTeamWorkReviewButton")
                }
            } message: { Text("Your review applies only to the result revision currently shown.") }
            .confirmationDialog("Resume this unfinished task?", isPresented: $confirmingResume) {
                if let target = resumeTarget, let plan = resumePlan {
                    Button("Resume this task") { Task { _ = await workspace.resumeWork(target, plan: plan, idempotencyKey: idempotencyKey) } }.accessibilityIdentifier("confirmTeamWorkResumeButton")
                }
            } message: { Text("This queues only the task shown above, using its saved context. It does not replay already completed teammate assignments.") }
    }
    private func evidenceRows(_ evidence: [BotTeamEvidence]) -> some View {
        ForEach(Array(evidence.enumerated()), id: \.offset) { _, evidence in
            VStack(alignment: .leading, spacing: 6) {
                Label(evidence.label, systemImage: evidence.icon).font(.subheadline.weight(.semibold))
                Text(evidence.detail).font(.callout).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }.padding(.vertical, 5)
        }
    }
    private func recoverySection(_ plan: BotTeamRecoveryPlan, current: BotWorkspaceActivity) -> some View {
        Section {
            Text(plan.summary).textSelection(.enabled).accessibilityIdentifier("teamRecoverySummary")
            if let review = work?.reviewHistory.last, review.decision == "reject", let note = review.note, !note.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Requested changes", systemImage: "arrow.uturn.backward").font(.subheadline.weight(.semibold))
                    Text(note).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }.accessibilityIdentifier("teamRecoveryRequestedChanges")
            }
            LabeledContent("Bot", value: plan.botName)
            LabeledContent("Provider", value: plan.provider)
            LabeledContent("Model", value: plan.model.isEmpty ? "Provider default" : plan.model)
            LabeledContent("Computer", value: plan.computerLabel)
            VStack(alignment: .leading, spacing: 5) { Text("Working folder").font(.caption).foregroundStyle(.secondary); Text(plan.workspace).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                .accessibilityIdentifier("teamRecoveryWorkspace")
            ForEach(Array(plan.steps.enumerated()), id: \.offset) { index, step in Text("\(index + 1). \(step)").font(.callout).fixedSize(horizontal: false, vertical: true) }
            ForEach(Array(plan.completedReports.enumerated()), id: \.offset) { _, report in
                VStack(alignment: .leading, spacing: 7) {
                    Label("Saved teammate result", systemImage: "doc.text").font(.subheadline.weight(.medium))
                    Text(report.summary).font(.callout).textSelection(.enabled)
                    BotSharedConversationButton(store: store, chatId: report.chatId, title: "Open saved result", openChat: openChat)
                }
            }
            if let reason = plan.blockedReason, !reason.isEmpty { Text(reason).font(.callout).foregroundStyle(StrataTheme.warning).accessibilityIdentifier("teamRecoveryBlockedReason") }
            TimelineView(.periodic(from: .now, by: 1)) { clock in
                let expired = plan.isExpired(at: clock.date)
                if expired { Text("This recovery plan expired. Prepare a fresh plan before resuming.").font(.caption).foregroundStyle(StrataTheme.warning) }
                Button("Resume this task", systemImage: "play.fill") { resumeTarget = current; resumePlan = plan; confirmingResume = true }
                    .disabled(busy || !plan.canResume || expired || work?.canPlanRecovery != true || work?.revision != plan.expectedRevision)
                    .accessibilityIdentifier("resumeTeamWorkButton")
            }
        } header: { Text("Recovery plan") } footer: { Text("Resume is explicit. Tool approvals and computer permissions still apply.") }
    }
}

private struct BotHarnessRecoverySection: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let openChat: () -> Void
    @State private var reviewing: BotHarnessAction?
    @State private var expanded = false
    var body: some View {
        if let snapshot = workspace.harnessActions {
            Section {
                if !snapshot.available {
                    Text(snapshot.reason ?? "Some action receipts could not be read. Available receipts remain below for inspection; recording review is unavailable.").font(.callout).foregroundStyle(StrataTheme.warning).accessibilityIdentifier("harnessRecoveryUnavailable")
                }
                let actions = snapshot.actions.filter(\.needsReview)
                ForEach(Array(actions.prefix(expanded ? 200 : 6))) { action in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(action.toolName.replacingOccurrences(of: "_", with: " ")).font(.headline)
                        Text((action.state == "uncertain" ? "Outcome unconfirmed" : "Interrupted") + (action.origin == "ssh-worker" ? " · SSH computer" : " · Host broker")).font(.caption).foregroundStyle(.secondary)
                        BotSharedConversationButton(store: store, chatId: action.chatId, title: "Inspect conversation", openChat: openChat)
                        if action.canReview {
                            Button("Record review…") { reviewing = action }.buttonStyle(.borderless).disabled(!snapshot.available || workspace.mutation != nil || workspace.messages["harnessActions"] != nil).accessibilityIdentifier("reviewHarnessAction-" + action.id)
                        } else {
                            Text("Remote receipt is read-only here. Review the selected computer before continuing. Cleanup holds remain in force.").font(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 6).accessibilityElement(children: .contain).accessibilityIdentifier("harnessAction-" + action.id)
                }
                if actions.isEmpty, snapshot.available { Text("No interrupted actions need review in the retained journal.").font(.callout).foregroundStyle(.secondary) }
                if actions.count > 6, !expanded { Button("Show more receipts") { expanded = true } }
                if snapshot.hasMore { Text("Showing up to 200 receipts, with interrupted actions first.").font(.caption).foregroundStyle(.secondary) }
                BotWorkspaceMessage(workspace: workspace, key: "harnessActions")
            } header: { Text("Action recovery") } footer: { Text("Inspect the conversation and any changes before continuing. Recording review does not verify success, retry a command or resume a task.") }
                .confirmationDialog("Have you inspected this action’s conversation and any changes it made?", isPresented: Binding(get: { reviewing != nil }, set: { if !$0 { reviewing = nil } }), titleVisibility: .visible, presenting: reviewing) { action in
                    Button("I reviewed the conversation") { Task { _ = await workspace.reviewHarnessAction(action); reviewing = nil } }
                    Button("Cancel", role: .cancel) { reviewing = nil }
                }
        } else if workspace.messages["harnessActions"] != nil {
            Section {
                Text("Action recovery is unavailable. Refresh to inspect the current receipts before continuing.").font(.callout).foregroundStyle(StrataTheme.warning).accessibilityIdentifier("harnessRecoveryInitialUnavailable")
                BotWorkspaceMessage(workspace: workspace, key: "harnessActions")
                Button("Refresh action receipts") { Task { await workspace.refreshHarnessActions(force: true) } }
                    .disabled(workspace.loading.contains("harnessActions") || workspace.mutation != nil).accessibilityIdentifier("refreshHarnessActionsButton")
            } header: { Text("Action recovery") }
        }
    }
}

/// A plan belongs to the team Work surface. Opening it only reads saved state.
private struct BotTeamPlansSection: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let teamId: String
    let openChat: () -> Void
    private var key: String { BotWorkspaceStore.workPlansKey(teamId) }
    private var snapshot: BotTeamWorkPlansSnapshot? { workspace.workPlans[teamId] }
    var body: some View {
        Section {
            ForEach(snapshot?.plans ?? []) { listed in
                let plan = workspace.workPlan(listed.id, teamId: teamId) ?? listed
                NavigationLink {
                    BotTeamWorkPlanDetailView(store: store, workspace: workspace, teamId: teamId, planId: plan.id, openChat: openChat)
                } label: {
                    VStack(alignment: .leading, spacing: 7) {
                        HStack(alignment: .top, spacing: 9) {
                            AvatarBadge(store.botCatalog?.bots.first { $0.id == plan.coordinatorId }?.face ?? .default(for: "Bot"), size: 30)
                            Text(plan.goal).font(.headline).lineLimit(3)
                        }
                        Text((workspace.messages[key] != nil || snapshot?.isAvailable != true ? "Last known: " : "") + plan.phase.label).font(.caption.weight(.semibold)).foregroundStyle(StrataTheme.accentText)
                        Text(plan.counts.summary).font(.caption).foregroundStyle(.secondary)
                        if let reason = plan.blockedReason, !reason.isEmpty { Label(reason, systemImage: "exclamationmark.bubble").font(.caption).foregroundStyle(StrataTheme.warning).lineLimit(3) }
                    }.padding(.vertical, 5)
                }.accessibilityIdentifier("teamPlan-" + plan.id)
            }
            if snapshot == nil, workspace.messages[key] == nil { ProgressView("Reading saved team plans…") }
            if snapshot?.isAvailable == true, snapshot?.plans.isEmpty == true, workspace.messages[key] == nil {
                Text("Choose Work in the team channel to save a plan with owners, prerequisites and review.").font(.callout).foregroundStyle(.secondary).accessibilityIdentifier("teamPlansEmpty")
            }
            if snapshot?.hasMore == true {
                Text("More plans remain saved. Counts in this view cover the loaded plans.").font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("teamPlansPartial")
                if let cursor = snapshot?.nextBeforePlanId {
                    Button("Earlier plans", systemImage: "clock.arrow.circlepath") { Task { await workspace.refreshWorkPlans(teamId, beforePlanId: cursor) } }
                        .disabled(!store.isPaired || snapshot?.isAvailable != true || workspace.messages[key] != nil || workspace.loading.contains(key) || workspace.mutation != nil).accessibilityIdentifier("loadEarlierTeamPlansButton")
                }
            }
            BotWorkspaceMessage(workspace: workspace, key: key)
            Button("Refresh team plans", systemImage: "arrow.clockwise") { Task { await workspace.refreshWorkPlans(teamId) } }
                .disabled(!store.isPaired || workspace.mutation != nil || workspace.loading.contains(key)).accessibilityIdentifier("refreshTeamPlansButton")
        } header: { Text("Team plans") } footer: { Text("Each plan keeps real task owners and conversations. Reported results remain separate from your acceptance.") }
    }
}

private struct BotTeamWorkPlanDetailView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let teamId: String
    let planId: String
    let openChat: () -> Void
    @State private var note = ""
    @State private var inspected = false
    @State private var visible = false
    @State private var resumeRequestId = UUID().uuidString
    @State private var confirming: Confirmation?
    @Environment(\.scenePhase) private var scenePhase
    private struct Confirmation: Identifiable {
        var value: BotTeamWorkPlan; var action: String; var decision: String?; var note: String; var requestId: String?
        var id: String { action + (decision ?? "") + value.proof }
    }
    private var key: String { BotWorkspaceStore.workPlanKey(planId) }
    private var listKey: String { BotWorkspaceStore.workPlansKey(teamId) }
    private var value: BotTeamWorkPlan? { workspace.workPlan(planId, teamId: teamId) }
    private var tasks: [BotTeamWorkPlan.Task] { workspace.workPlanTasks(planId, teamId: teamId) }
    private var stale: Bool { workspace.messages[key] != nil || workspace.messages[listKey] != nil || workspace.workPlans[teamId]?.isAvailable != true }
    private var busy: Bool { !store.isPaired || !workspace.workPlansSupported || workspace.mutation != nil || stale }
    private var enabled: Bool { workspace.teams?.teams.first { $0.id == teamId }?.enabled == true }
    var body: some View {
        List {
            if let value {
                Section {
                    Text(value.goal).font(.title3.weight(.semibold)).textSelection(.enabled).accessibilityIdentifier("teamPlanGoal")
                    Label((stale ? "Last known: " : "") + value.phase.label, systemImage: value.phase == .completed ? "checkmark.seal" : "point.3.connected.trianglepath.dotted").font(.headline).foregroundStyle(StrataTheme.accentText).accessibilityIdentifier("teamPlanPhase")
                    Text(value.counts.summary).font(.callout).foregroundStyle(.secondary).accessibilityIdentifier("teamPlanProgress")
                    member(value.coordinatorId, role: "Coordinator")
                    if let summary = value.summary, !summary.isEmpty {
                        Text([.awaitingReview, .completed].contains(value.phase) ? "Team report" : "Last saved report").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        Text(summary).font(.callout).textSelection(.enabled).accessibilityIdentifier("teamPlanSummary")
                    }
                    if let reason = value.blockedReason, !reason.isEmpty { Label(reason, systemImage: "exclamationmark.bubble").font(.callout).foregroundStyle(StrataTheme.warning).accessibilityIdentifier("teamPlanBlocker") }
                } header: { Text("Saved team plan") }
                if !value.participation.isEmpty {
                    Section("Your team") {
                        ForEach(value.participation) { participant in
                            VStack(alignment: .leading, spacing: 7) {
                                member(participant.botId, role: participant.role)
                                Text(participant.reason).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            }.accessibilityIdentifier("teamPlanParticipant-" + participant.botId)
                        }
                    }
                }
                Section {
                    ForEach(tasks) { task in taskRow(task, plan: value) }
                    if tasks.isEmpty { Text(value.phase == .planning ? "The coordinator is preparing concrete tasks and owners." : "No task page is loaded. Refresh to read the saved work.").font(.callout).foregroundStyle(.secondary) }
                    if let offset = workspace.nextWorkPlanTaskOffset(planId, teamId: teamId) {
                        Button("Load more tasks", systemImage: "arrow.down") { Task { await workspace.refreshWorkPlan(planId, teamId: teamId, taskOffset: offset) } }
                            .disabled(busy || workspace.loading.contains(key)).accessibilityIdentifier("loadMoreTeamPlanTasksButton")
                    }
                    if tasks.count < value.totalTasks { Text("Showing \(tasks.count) of \(value.totalTasks) tasks. Counts above include the entire plan.").font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("teamPlanTasksPartial") }
                } header: { Text("Tasks & prerequisites") } footer: { Text("Prerequisites name saved tasks. A reported result does not imply owner acceptance, and a shared workspace key grants no new folder access.") }
                Section {
                    ForEach(value.attempts.filter { $0.kind != .task }) { attempt in
                        VStack(alignment: .leading, spacing: 7) {
                            member(attempt.botId, role: attempt.kind == .planning ? "Planning" : "Team report")
                            Text(attempt.state.rawValue.capitalized).font(.caption).foregroundStyle(.secondary)
                            if let chatId = attempt.chatId { BotSharedConversationButton(store: store, chatId: chatId, title: "Thinking, tools & approvals", openChat: openChat) }
                        }
                    }
                    if value.attemptsTruncated { Text("Showing the latest \(value.attempts.count) of \(value.totalAttempts) attempts. Earlier conversations remain saved on the Mac.").font(.caption).foregroundStyle(.secondary) }
                } header: { Text("Coordination") }
                actions(value)
            } else if workspace.loading.contains(key) { Section { ProgressView("Reading team plan…") } }
            else { Section { Text("This team plan is unavailable. Refresh to inspect its saved state.").foregroundStyle(.secondary) } }
            Section {
                BotWorkspaceMessage(workspace: workspace, key: key)
                BotWorkspaceMessage(workspace: workspace, key: listKey)
                if !workspace.workPlansSupported { Label("Update Strata on your Mac to use saved team plans.", systemImage: "info.circle").font(.callout) }
            }
        }.strataList().navigationTitle("Team plan").navigationBarTitleDisplayMode(.inline).accessibilityIdentifier("teamPlanDetailView")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }.disabled(workspace.mutation != nil || workspace.loading.contains(key)).accessibilityIdentifier("refreshTeamPlanButton") } }
            .refreshable { await refresh() }
            .onAppear { visible = true }.onDisappear { visible = false; confirming = nil }
            .onChange(of: value?.proof) { _, _ in inspected = false; confirming = nil; resumeRequestId = UUID().uuidString }
            .task(id: visible && scenePhase == .active) {
                guard visible, scenePhase == .active else { return }
                await refresh()
                while !Task.isCancelled, visible, scenePhase == .active {
                    do { try await Task.sleep(for: .seconds(10)) } catch { return }
                    guard !Task.isCancelled, visible, scenePhase == .active, store.isPaired else { return }
                    if workspace.mutation == nil, !workspace.loading.contains(key) { await workspace.refreshWorkPlan(planId, teamId: teamId) }
                }
            }
            .confirmationDialog("Apply this action to the inspected team plan?", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })) {
                if let target = confirming {
                    Button(target.action == "stop" ? "Stop team plan" : target.action == "resume" ? "Resume inspected plan" : target.decision == "accept" ? "Accept this result" : "Request changes", role: target.action == "stop" ? .destructive : nil) {
                        confirming = nil
                        Task { _ = await workspace.changeWorkPlan(target.value, action: target.action, requestId: target.requestId, decision: target.decision, note: target.note, inspected: inspected) }
                    }.accessibilityIdentifier("confirmTeamPlanActionButton")
                }
            } message: { Text("Only this saved revision is targeted. This does not approve tools, change access, or replay an uncertain action.") }
    }
    private func member(_ id: String, role: String) -> some View {
        let bot = store.botCatalog?.bots.first { $0.id == id }
        return HStack(spacing: 9) {
            AvatarBadge(bot?.face ?? .default(for: "Bot"), size: 30)
            VStack(alignment: .leading, spacing: 2) { Text(bot?.name ?? "Saved teammate").font(.subheadline.weight(.semibold)); Text(role).font(.caption).foregroundStyle(.secondary) }
        }
    }
    private func taskRow(_ task: BotTeamWorkPlan.Task, plan: BotTeamWorkPlan) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) { Text(task.title).font(.headline); Spacer(); Text(task.kind == .review ? "Independent review" : "Work").font(.caption).foregroundStyle(.secondary) }
            member(task.ownerId, role: task.state.label)
            Text(task.instructions).font(.callout).textSelection(.enabled)
            if task.instructionsTruncated == true { Text("Instructions shown in part. The bot receives the exact saved instructions.").font(.caption).foregroundStyle(.secondary) }
            if !task.dependsOn.isEmpty { Label("After: " + task.dependsOn.joined(separator: ", "), systemImage: "arrow.triangle.branch").font(.caption).foregroundStyle(.secondary) }
            if !task.collaboratorIds.isEmpty { Text("Contributors: " + task.collaboratorIds.map { id in store.botCatalog?.bots.first { $0.id == id }?.name ?? "Saved teammate" }.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary) }
            if let workspace = task.workspaceKey { Label("Workspace group: " + workspace, systemImage: "folder").font(.caption).foregroundStyle(.secondary) }
            if let summary = task.summary, !summary.isEmpty { Text("Reported progress").font(.caption.weight(.semibold)).foregroundStyle(.secondary); Text(summary).font(.callout).textSelection(.enabled) }
            if let next = task.nextStep, !next.isEmpty { Label(next, systemImage: "arrow.right.circle").font(.callout).foregroundStyle(task.state == .blocked ? StrataTheme.warning : .secondary) }
            ForEach(task.criteria) { criterion in
                let check = task.checks?.first { $0.criterionId == criterion.id }
                VStack(alignment: .leading, spacing: 4) {
                    Label(criterion.text, systemImage: check?.passed == true && task.state == .readyForReview ? "checkmark.circle" : "circle.dashed").font(.subheadline)
                    if let check { Text((task.state != .readyForReview ? "Previous finding · recheck pending: " : check.passed ? "Evaluator reports pass: " : "Changes needed: ") + check.detail).font(.caption).foregroundStyle(.secondary) }
                }
            }
            ForEach(Array((task.evidence ?? []).enumerated()), id: \.offset) { _, evidence in
                VStack(alignment: .leading, spacing: 4) { Label(evidence.label, systemImage: evidence.icon).font(.subheadline); Text(evidence.detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
            }
            if let chat = task.chatId ?? plan.attempts.first(where: { $0.id == task.attemptId && $0.taskId == task.id && $0.botId == task.ownerId })?.chatId {
                BotSharedConversationButton(store: store, chatId: chat, title: "Thinking, tools & approvals", openChat: openChat).accessibilityIdentifier("teamPlanTaskChat-" + task.id)
            } else if task.attemptId != nil { Text("This task’s conversation is outside the latest attempt preview. Earlier history remains saved on the Mac.").font(.caption).foregroundStyle(.secondary) }
        }.padding(.vertical, 7).accessibilityElement(children: .contain).accessibilityIdentifier("teamPlanTask-" + task.id)
    }
    @ViewBuilder private func actions(_ plan: BotTeamWorkPlan) -> some View {
        if plan.canContinue || plan.canReview {
            Section {
                NavigationLink { List { BotHarnessRecoverySection(store: store, workspace: workspace, openChat: openChat) }.strataList().navigationTitle("Action receipts").task { await workspace.refreshHarnessActions(force: true) } } label: { Label("Inspect action receipts", systemImage: "doc.text.magnifyingglass") }
                Toggle("I inspected the tasks, evidence and action receipts", isOn: $inspected).accessibilityIdentifier("teamPlanInspectedToggle")
                if plan.canReview {
                    Text("The team has reported all results. Inspect the deliverables and any independent checks before accepting.").font(.callout).accessibilityIdentifier("teamPlanAwaitingReview")
                    TextField("Feedback for the team (optional)", text: $note, axis: .vertical).lineLimit(2...6).accessibilityIdentifier("teamPlanReviewNote")
                    Button("Accept result", systemImage: "checkmark.seal") { confirming = Confirmation(value: plan, action: "review", decision: "accept", note: note) }.disabled(busy || !inspected || !BotTeamWorkPlan.text(note, 4_000)).accessibilityIdentifier("acceptTeamPlanButton")
                    Button("Request changes", systemImage: "arrow.triangle.2.circlepath") { confirming = Confirmation(value: plan, action: "review", decision: "changes_requested", note: note) }.disabled(busy || !inspected || !enabled || !BotTeamWorkPlan.text(note, 4_000) || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityIdentifier("repairTeamPlanButton")
                } else {
                    Button(plan.phase == .running ? "Resume unfinished tasks" : "Resume plan", systemImage: "play") { confirming = Confirmation(value: plan, action: "resume", note: "", requestId: resumeRequestId) }.disabled(busy || !inspected || !enabled).accessibilityIdentifier("resumeTeamPlanButton")
                }
            } header: { Text(plan.canReview ? "Your review" : "Continue deliberately") } footer: { Text("Uncertain actions and computer cleanup retain their own review. A new attempt inspects saved progress instead of replaying old commands.") }
        } else if plan.phase == .completed { Section("Your review") { Label("You accepted this team result.", systemImage: "person.crop.circle.badge.checkmark").accessibilityIdentifier("teamPlanOwnerAccepted") } }
        if plan.canStop { Section { Button(plan.phase == .stopping ? "Retry Stop" : "Stop team plan", systemImage: "stop.circle", role: .destructive) { confirming = Confirmation(value: plan, action: "stop", note: "") }.disabled(busy).accessibilityIdentifier("stopTeamPlanButton") } }
    }
    private func refresh() async {
        await workspace.refreshTeams()
        guard !Task.isCancelled, store.isPaired else { return }
        await workspace.refreshWorkPlans(teamId)
        guard !Task.isCancelled, store.isPaired else { return }
        await workspace.refreshWorkPlan(planId, teamId: teamId)
    }
}

struct BotTeamWorkflowsView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let teamId: String
    let openChat: () -> Void
    @State private var creating = false
    @State private var createdID: String?
    @State private var visible = false
    @Environment(\.scenePhase) private var scenePhase
    private var key: String { BotWorkspaceStore.workflowsKey(teamId) }
    private var snapshot: BotTeamWorkflowsSnapshot? { workspace.workflows[teamId] }
    private var team: BotTeam? { workspace.teams?.teams.first { $0.id == teamId } }
    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Image(systemName: "checkmark.seal.fill").font(.system(size: 30)).foregroundStyle(StrataTheme.accentText)
                    Text("Work with a clear finish.").font(.title2.weight(.semibold))
                    Text("Plan the work, build it, then let a separate teammate evaluate the result. Repairs stay in the same workflow until it is ready for your review.")
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }.padding(.vertical, 8)
                Button("New workflow", systemImage: "plus") { creating = true }
                    .disabled(!store.isPaired || !workspace.workflowsSupported || snapshot?.isAvailable != true || team?.enabled != true || workspace.messages[key] != nil || workspace.mutation != nil)
                    .accessibilityIdentifier("newTeamWorkflowButton")
            }
            if !workspace.workflowsSupported {
                Section { Label("Update Strata on your Mac to use Plan & verify. Your existing team conversations remain available.", systemImage: "info.circle").font(.callout).accessibilityIdentifier("teamWorkflowsUnsupported") }
            } else {
                Section("Saved workflows") {
                    ForEach(snapshot?.workflows ?? []) { listed in
                        let value = workspace.workflow(listed.id, teamId: teamId) ?? listed
                        NavigationLink {
                            BotTeamWorkflowDetailView(store: store, workspace: workspace, teamId: teamId, workflowId: value.id, openChat: openChat)
                        } label: {
                            VStack(alignment: .leading, spacing: 7) {
                                Text(value.goal).font(.headline).lineLimit(2)
                                HStack { Label(value.phase.label, systemImage: value.phase == .completed ? "checkmark.seal" : value.phase == .awaitingReview ? "person.crop.circle.badge.checkmark" : "arrow.triangle.branch"); Spacer(); Text("\(value.criteria.count) criteria") }
                                    .font(.caption).foregroundStyle(.secondary)
                                if let summary = value.summary, !summary.isEmpty { Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                            }.padding(.vertical, 4)
                        }.accessibilityIdentifier("workflow-" + value.id)
                    }
                    if snapshot?.isAvailable == true, snapshot?.workflows.isEmpty == true, workspace.messages[key] == nil {
                        Text("Start with a goal and success criteria. Each stage keeps its own conversation and evidence.").font(.callout).foregroundStyle(.secondary).accessibilityIdentifier("teamWorkflowsEmpty")
                    }
                    if snapshot?.hasMore == true { Text("Showing the latest workflows. Earlier work remains saved on your Mac.").font(.caption).foregroundStyle(.secondary) }
                    BotWorkspaceMessage(workspace: workspace, key: key)
                }
            }
        }.strataList().navigationTitle("Plan & verify").navigationBarTitleDisplayMode(.inline).accessibilityIdentifier("teamWorkflowsView")
            .sheet(isPresented: $creating) { BotTeamWorkflowEditor(store: store, workspace: workspace, teamId: teamId) { id in creating = false; createdID = id } }
            .navigationDestination(item: $createdID) { id in BotTeamWorkflowDetailView(store: store, workspace: workspace, teamId: teamId, workflowId: id, openChat: openChat) }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }.disabled(workspace.mutation != nil || workspace.loading.contains(key)).accessibilityIdentifier("refreshTeamWorkflowsButton") } }
            .refreshable { await refresh() }
            .onAppear { visible = true }.onDisappear { visible = false }
            .task(id: visible && scenePhase == .active) {
                guard visible, scenePhase == .active else { return }
                await refresh()
                while !Task.isCancelled, visible, scenePhase == .active {
                    do { try await Task.sleep(for: .seconds(10)) } catch { return }
                    guard !Task.isCancelled, visible, scenePhase == .active, store.isPaired else { return }
                    if workspace.mutation == nil, !workspace.loading.contains(key) { await workspace.refreshWorkflows(teamId) }
                }
            }
    }
    private func refresh() async {
        await workspace.refreshTeams()
        guard !Task.isCancelled, store.isPaired else { return }
        await workspace.refreshWorkflows(teamId)
    }
}

private struct BotTeamWorkflowEditor: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let teamId: String
    let saved: (String) -> Void
    @State private var goal = ""
    @State private var criteria = ""
    @State private var planner = ""
    @State private var builder = ""
    @State private var evaluator = ""
    @State private var requestId = UUID().uuidString
    @State private var navigation = UUID()
    private enum Field: Hashable { case goal, criteria }
    @FocusState private var focused: Field?
    @Environment(\.dismiss) private var dismiss
    private var team: BotTeam? { workspace.teams?.teams.first { $0.id == teamId } }
    private var members: [CompanionBot] { (team?.memberIds ?? []).compactMap { id in store.botCatalog?.bots.first { $0.id == id } } }
    private var key: String { BotWorkspaceStore.workflowsKey(teamId) }
    private var draft: BotTeamWorkflowDraft {
        BotTeamWorkflowDraft(requestId: requestId, goal: goal.trimmingCharacters(in: .whitespacesAndNewlines), plannerId: planner, builderId: builder, evaluatorId: evaluator, criteria: BotTeamWorkflowDraft.criteria(from: criteria))
    }
    private var readinessNotices: [String] { draft.roleReadinessNotices(in: members) }
    private var canSave: Bool { store.isPaired && workspace.workflowsSupported && workspace.workflows[teamId]?.isAvailable == true && team?.enabled == true && draft.isValid(memberIds: members.map(\.id)) && readinessNotices.isEmpty && workspace.messages[key] == nil && workspace.mutation == nil }
    var body: some View {
        NavigationStack {
            Form {
                Section("Goal") {
                    TextField("What should the team accomplish?", text: $goal, axis: .vertical).lineLimit(4...8).focused($focused, equals: .goal).accessibilityIdentifier("workflowGoalInput")
                }
                Section {
                    TextField("One success criterion per line", text: $criteria, axis: .vertical).lineLimit(5...10).focused($focused, equals: .criteria).accessibilityIdentifier("workflowCriteriaInput")
                    Text("\(draft.criteria.count) of 16 criteria").font(.caption).foregroundStyle(.secondary)
                } header: { Text("What does success look like?") } footer: { Text("Use observable results the evaluator can check. Each criterion can contain up to 1,000 characters.") }
                Section {
                    rolePicker("Planner", selection: $planner, identifier: "workflowPlannerPicker")
                    rolePicker("Builder", selection: $builder, identifier: "workflowBuilderPicker")
                    rolePicker("Independent evaluator", selection: $evaluator, identifier: "workflowEvaluatorPicker")
                    if builder == evaluator, !builder.isEmpty { Label("Choose a different evaluator from the builder.", systemImage: "person.2.slash").font(.caption).foregroundStyle(StrataTheme.warning).accessibilityIdentifier("workflowEvaluatorConflict") }
                    ForEach(readinessNotices, id: \.self) { notice in Label(notice, systemImage: "info.circle").font(.caption).foregroundStyle(StrataTheme.warning) }
                    if !readinessNotices.isEmpty {
                        Button("Refresh saved bots", systemImage: "arrow.clockwise") { refreshSavedRoles() }
                            .disabled(workspace.mutation != nil || store.isLoadingBots).accessibilityIdentifier("refreshWorkflowRoleBotsButton")
                    }
                } header: { Text("Saved teammates") } footer: { Text("The planner can also build. The evaluator must be a different teammate. Each bot keeps its configured model, computer, tools and approval policy.") }
                Section {
                    Text("The team plans, builds, evaluates and repairs as needed. You can stop it at any time. A passing evaluation still needs your acceptance.").font(.callout).foregroundStyle(.secondary)
                    if team?.enabled != true { Label("Enable the reviewed team before starting work.", systemImage: "info.circle").font(.caption) }
                    if !workspace.workflowsSupported { Text("Update Strata on your Mac to start workflows.").font(.caption) }
                    BotWorkspaceMessage(workspace: workspace, key: key)
                    if workspace.messages[key] != nil {
                        Button("Refresh saved workflows", systemImage: "arrow.clockwise") { Task { await workspace.refreshWorkflows(teamId) } }
                            .disabled(workspace.mutation != nil).accessibilityIdentifier("refreshWorkflowDraftStateButton")
                    }
                    Button("Start workflow", systemImage: "play.fill") { submit() }.disabled(!canSave).accessibilityIdentifier("startTeamWorkflowButton")
                }
            }.strataList().navigationTitle("New workflow").navigationBarTitleDisplayMode(.inline).accessibilityIdentifier("teamWorkflowEditor")
                .disabled(workspace.mutation != nil)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(workspace.mutation != nil) }
                    ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { focused = nil } }
                }
                .onAppear {
                    if planner.isEmpty { planner = team?.coordinatorId ?? members.first?.id ?? "" }
                    if builder.isEmpty { builder = planner }
                    if evaluator.isEmpty { evaluator = members.first { $0.id != builder }?.id ?? "" }
                }
                .onChange(of: [goal, criteria, planner, builder, evaluator]) { _, _ in requestId = UUID().uuidString }
                .onDisappear { navigation = UUID() }
                .interactiveDismissDisabled(workspace.mutation != nil)
        }
    }
    private func rolePicker(_ title: String, selection: Binding<String>, identifier: String) -> some View {
        Picker(title, selection: selection) {
            Text("Choose teammate").tag("")
            ForEach(members) { member in Text(member.name).tag(member.id) }
        }.accessibilityIdentifier(identifier)
    }
    private func submit() {
        guard canSave else { return }
        let value = draft, generation = navigation, pairing = store.pairingGeneration
        focused = nil
        Task {
            let result = await workspace.createWorkflow(teamId: teamId, draft: value)
            guard !Task.isCancelled, navigation == generation, store.pairingGeneration == pairing, let result else { return }
            saved(result.id)
        }
    }
    private func refreshSavedRoles() {
        let generation = navigation, pairing = store.pairingGeneration
        Task {
            await store.refreshBots()
            guard !Task.isCancelled, navigation == generation, store.pairingGeneration == pairing else { return }
            await workspace.refreshTeams()
            guard !Task.isCancelled, navigation == generation, store.pairingGeneration == pairing else { return }
            await workspace.refreshWorkflows(teamId)
        }
    }
}

private struct BotTeamWorkflowDetailView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let teamId: String
    let workflowId: String
    let openChat: () -> Void
    @State private var note = ""
    @State private var inspected = false
    @State private var confirming: WorkflowConfirmation?
    @State private var resumeRequestId = UUID().uuidString
    @State private var visible = false
    @Environment(\.scenePhase) private var scenePhase
    private struct WorkflowConfirmation: Identifiable {
        var action: String; var workflow: BotTeamWorkflow; var decision: String?; var note: String; var requestId: String?
        var id: String { action + (decision ?? "") + workflow.proof }
    }
    private var value: BotTeamWorkflow? { workspace.workflow(workflowId, teamId: teamId) }
    private var key: String { BotWorkspaceStore.workflowKey(workflowId) }
    private var stale: Bool { workspace.messages[key] != nil || workspace.messages[BotWorkspaceStore.workflowsKey(teamId)] != nil }
    private var busy: Bool { !store.isPaired || !workspace.workflowsSupported || workspace.workflows[teamId]?.isAvailable != true || workspace.mutation != nil || stale }
    var body: some View {
        List {
            if let value {
                overview(value)
                if let plan = value.plan { planSection(plan) }
                criteriaSection(value)
                stepsSection(value)
                actions(value)
            } else if workspace.loading.contains(key) { Section { ProgressView("Reading workflow…") } }
            else { Section { Text("This workflow is unavailable. Refresh to inspect its saved state.").foregroundStyle(.secondary) } }
            Section {
                BotWorkspaceMessage(workspace: workspace, key: key)
                BotWorkspaceMessage(workspace: workspace, key: BotWorkspaceStore.workflowsKey(teamId))
                if !workspace.workflowsSupported { Label("Update Strata on your Mac before changing this workflow.", systemImage: "info.circle").font(.caption) }
            }
        }.strataList().navigationTitle("Workflow").navigationBarTitleDisplayMode(.inline).accessibilityIdentifier("teamWorkflowDetailView")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }.disabled(workspace.mutation != nil || workspace.loading.contains(key)).accessibilityIdentifier("refreshTeamWorkflowButton") } }
            .refreshable { await refresh() }
            .onAppear { visible = true }.onDisappear { visible = false; confirming = nil }
            .onChange(of: value?.proof) { _, _ in inspected = false; confirming = nil; resumeRequestId = UUID().uuidString }
            .task(id: visible && scenePhase == .active) {
                guard visible, scenePhase == .active else { return }
                await refresh()
                while !Task.isCancelled, visible, scenePhase == .active {
                    do { try await Task.sleep(for: .seconds(10)) } catch { return }
                    guard !Task.isCancelled, visible, scenePhase == .active, store.isPaired else { return }
                    if workspace.mutation == nil, !workspace.loading.contains(key) { await workspace.refreshWorkflow(workflowId, teamId: teamId) }
                }
            }
            .confirmationDialog(confirmationTitle, isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })) {
                if let target = confirming {
                    Button(target.action == "stop" ? "Stop workflow" : target.action == "resume" ? "Resume inspected workflow" : target.decision == "accept" ? "Accept this result" : "Request repairs", role: target.action == "stop" ? .destructive : nil) {
                        confirming = nil
                        Task { _ = await workspace.changeWorkflow(target.workflow, action: target.action, requestId: target.requestId, decision: target.decision, note: target.note, inspected: target.action == "resume") }
                    }.accessibilityIdentifier("confirmTeamWorkflowActionButton")
                }
            } message: { Text("This applies only to the saved workflow revision you reviewed. It does not change permissions or replay an earlier action.") }
    }
    private var confirmationTitle: String {
        guard let target = confirming else { return "Review workflow action" }
        return target.action == "stop" ? "Stop this workflow?" : target.action == "resume" ? "Resume after inspecting its prior work?" : target.decision == "accept" ? "Accept this workflow result?" : "Send your feedback for repairs?"
    }
    private func botName(_ id: String) -> String { store.botCatalog?.bots.first { $0.id == id }?.name ?? "Saved teammate" }
    private func overview(_ value: BotTeamWorkflow) -> some View {
        Section {
            Text(value.goal).font(.title3.weight(.semibold)).textSelection(.enabled).accessibilityIdentifier("workflowGoal")
            Label((stale ? "Last known: " : "") + value.phase.label, systemImage: value.phase == .completed ? "checkmark.seal.fill" : "arrow.triangle.branch").font(.headline).foregroundStyle(StrataTheme.accentText).accessibilityIdentifier("workflowPhase")
            if let summary = value.summary, !summary.isEmpty {
                if !value.showsCurrentEvaluation { Text("Last saved report").font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
                Text(summary).font(.callout).textSelection(.enabled).accessibilityIdentifier("workflowSummary")
            }
            LabeledContent("Planner", value: botName(value.plannerId))
            LabeledContent("Builder", value: botName(value.builderId))
            LabeledContent("Independent evaluator", value: botName(value.evaluatorId)).accessibilityIdentifier("workflowIndependentEvaluator")
            if value.round > 0 { LabeledContent("Evaluation round", value: String(value.round)) }
            if let reason = value.blockedReason, !reason.isEmpty { Label(reason, systemImage: "exclamationmark.bubble").font(.callout).foregroundStyle(StrataTheme.warning).accessibilityIdentifier("workflowBlockedReason") }
        } header: { Text("Saved workflow") }
    }
    private func planSection(_ plan: BotTeamWorkflow.Plan) -> some View {
        Section("Plan") {
            Text(plan.summary).font(.callout).textSelection(.enabled)
            ForEach(Array(plan.items.enumerated()), id: \.offset) { index, item in Text("\(index + 1). \(item)").font(.callout).textSelection(.enabled) }
        }.accessibilityIdentifier("workflowPlan")
    }
    private func criteriaSection(_ value: BotTeamWorkflow) -> some View {
        Section {
            ForEach(value.criteria) { criterion in
                let check = value.checks.first { $0.criterionId == criterion.id }
                VStack(alignment: .leading, spacing: 7) {
                    Label(criterion.text, systemImage: check.map { value.showsCurrentEvaluation ? ($0.passed ? "checkmark.circle" : "exclamationmark.circle") : "clock.arrow.circlepath" } ?? "circle.dashed").font(.subheadline.weight(.medium))
                    Text(check.map { value.showsCurrentEvaluation ? ($0.passed ? "Evaluator: passed" : "Evaluator: changes needed") : ($0.passed ? "Previously passed · recheck pending" : "Previous changes requested · recheck pending") } ?? "Awaiting evaluation").font(.caption).foregroundStyle(.secondary)
                    if let detail = check?.detail, !detail.isEmpty { Text(detail).font(.callout).foregroundStyle(.secondary).textSelection(.enabled) }
                }.padding(.vertical, 4).accessibilityElement(children: .contain).accessibilityIdentifier("workflowCriterion-" + criterion.id)
            }
        } header: { Text("Success criteria") } footer: { Text(!value.checks.isEmpty && !value.showsCurrentEvaluation ? "These are the last saved evaluation findings. The current work needs a new evaluation before your review." : "These are the independent evaluator’s findings. Your acceptance is recorded separately.") }
    }
    private func stepsSection(_ value: BotTeamWorkflow) -> some View {
        Section {
            ForEach(value.steps) { step in
                VStack(alignment: .leading, spacing: 9) {
                    HStack { Text(step.phase.label).font(.headline); Spacer(); Text(step.state.rawValue.capitalized).font(.caption).foregroundStyle(.secondary) }
                    Text(botName(step.botId)).font(.caption).foregroundStyle(.secondary)
                    if let summary = step.summary, !summary.isEmpty { Text(summary).font(.callout).textSelection(.enabled) }
                    ForEach(Array((step.evidence ?? []).enumerated()), id: \.offset) { _, evidence in
                        VStack(alignment: .leading, spacing: 5) { Label(evidence.label, systemImage: evidence.icon).font(.subheadline.weight(.medium)); Text(evidence.detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                    }
                    if let chatId = step.chatId {
                        BotSharedConversationButton(store: store, chatId: chatId, title: "Thinking, tools & approvals", openChat: openChat).accessibilityIdentifier("workflowStepChat-" + step.id)
                    }
                }.padding(.vertical, 6).accessibilityElement(children: .contain).accessibilityIdentifier("workflowStep-" + step.id)
            }
            if value.steps.isEmpty { Text("The next stage will appear here when it starts.").font(.callout).foregroundStyle(.secondary) }
            if value.stepsTruncated { Text("Showing the latest \(value.steps.count) of \(value.totalSteps) steps. Earlier conversations and evidence remain saved on the Mac.").font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("workflowStepsTruncated") }
        } header: { Text("Work & evidence") }
    }
    @ViewBuilder private func actions(_ value: BotTeamWorkflow) -> some View {
        if value.canReview {
            Section {
                Text("The evaluator recommends this result. Inspect the work and evidence before accepting it.").font(.callout).accessibilityIdentifier("workflowAwaitingOwnerReview")
                TextField("Feedback for the team (optional)", text: $note, axis: .vertical).lineLimit(3...7).accessibilityIdentifier("workflowOwnerReviewNote")
                Button("Accept result", systemImage: "checkmark.seal") { confirming = WorkflowConfirmation(action: "review", workflow: value, decision: "accept", note: note) }.disabled(busy || !BotTeamWorkflow.validText(note, maximum: 2_500)).accessibilityIdentifier("acceptTeamWorkflowButton")
                Button("Request changes", systemImage: "arrow.triangle.2.circlepath") { confirming = WorkflowConfirmation(action: "review", workflow: value, decision: "changes_requested", note: note) }.disabled(busy || !BotTeamWorkflow.validText(note, maximum: 2_500) || workspace.teams?.teams.first(where: { $0.id == teamId })?.enabled != true).accessibilityIdentifier("repairTeamWorkflowButton")
            } header: { Text("Your review") }
        } else if value.phase == .completed {
            Section("Your review") { Label("You accepted this result.", systemImage: "person.crop.circle.badge.checkmark").accessibilityIdentifier("workflowOwnerAccepted") }
        }
        if value.canContinue {
            Section {
                NavigationLink {
                    List { BotHarnessRecoverySection(store: store, workspace: workspace, openChat: openChat) }.strataList().navigationTitle("Action receipts").task { await workspace.refreshHarnessActions(force: true) }
                } label: { Label("Inspect action receipts", systemImage: "doc.text.magnifyingglass") }.accessibilityIdentifier("inspectWorkflowActionReceiptsButton")
                Toggle("I inspected the prior steps and action receipts", isOn: $inspected).accessibilityIdentifier("workflowInspectedToggle")
                Button("Resume workflow", systemImage: "play") { confirming = WorkflowConfirmation(action: "resume", workflow: value, note: "", requestId: resumeRequestId) }.disabled(busy || !inspected || workspace.teams?.teams.first(where: { $0.id == teamId })?.enabled != true).accessibilityIdentifier("resumeTeamWorkflowButton")
            } header: { Text("Continue deliberately") } footer: { Text("Resume starts the next needed stage. Uncertain tool actions and computer cleanup require their own review; this does not retry or approve them.") }
        }
        if value.canStop {
            Section { Button(value.phase == .stopping ? "Retry Stop" : "Stop workflow", systemImage: "stop.circle", role: .destructive) { confirming = WorkflowConfirmation(action: "stop", workflow: value, note: "") }.disabled(busy).accessibilityIdentifier("stopTeamWorkflowButton") }
        }
    }
    private func refresh() async {
        await workspace.refreshTeams()
        guard !Task.isCancelled, store.isPaired else { return }
        await workspace.refreshWorkflows(teamId)
        guard !Task.isCancelled, store.isPaired else { return }
        await workspace.refreshWorkflow(workflowId, teamId: teamId)
    }
}
