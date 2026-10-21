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
    @State private var recipient = ""
    @State private var reply: BotTeamChannelMessage?
    @State private var confirmingStop: BotTeamRun?
    @State private var visible = false
    @State private var settingsExpanded = false
    @State private var tasksExpanded = false
    @State private var initiallyPositioned = false
    @State private var acknowledgedSequence = 0
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var taskFocused: Bool
    private var team: BotTeam? { workspace.teams?.teams.first { $0.id == teamId } }
    private var channel: BotTeamChannel? { workspace.channels[teamId] }
    private var channelKey: String { BotWorkspaceStore.channelKey(teamId) }
    private var entries: [BotTeamChannelMessage] { channel?.messages ?? [] }
    private var runs: [BotTeamRun] { (workspace.teams?.runs ?? []).filter { $0.teamId == teamId } }
    private var activeRuns: [BotTeamRun] { channel?.supported == true ? channel?.activeRuns ?? [] : runs.filter(\.isActive) }
    private var latestSequence: Int { entries.last?.sequence ?? 0 }

    var body: some View {
        ScrollViewReader { proxy in
            List {
                if let team {
                    Section {
                        HStack(spacing: 12) {
                            StrataTeamAvatars(bots: team.memberIds.compactMap { id in store.botCatalog?.bots.first { $0.id == id } }, size: 44)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(team.name).font(.headline)
                                Text("\(team.memberIds.count) teammates · \(team.enabled ? "Shared channel" : "Ready for review")").font(.caption).foregroundStyle(.secondary)
                            }
                        }.padding(.vertical, 4)
                        Button { settingsExpanded.toggle() } label: {
                            HStack { Text("Team settings"); Spacer(); Image(systemName: settingsExpanded ? "chevron.up" : "chevron.down") }.contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("botTeamSettingsDisclosure")
                        if settingsExpanded { teamSettings(team) }
                    }
                    if channel?.supported == true {
                        Section {
                            if channel?.hasMoreBefore == true {
                                Button("Load earlier messages") { Task { await workspace.refreshChannel(teamId, older: true) } }
                                    .disabled(workspace.loading.contains(channelKey) || workspace.mutation != nil)
                                    .accessibilityIdentifier("loadEarlierTeamMessagesButton")
                            }
                            if entries.isEmpty { Text("Say hello to everyone, ask who can help, or give the team a task. Conversations and handoffs appear here on Mac and iPhone.").foregroundStyle(.secondary).padding(.vertical, 12) }
                            ForEach(entries) { entry in
                                channelRow(entry, team: team).id(entry.id)
                            }
                            Color.clear.frame(height: 1).listRowSeparator(.hidden).id("team-channel-latest")
                        } header: { Text("Team channel") }
                    } else if let channel {
                        Section { Text(channel.reason ?? "Shared team channels require a newer Strata on your Mac.").font(.callout).foregroundStyle(.secondary) }
                    } else {
                        Section { ProgressView("Opening team channel…") }
                    }
                    if !activeRuns.isEmpty {
                        Section("Team work") {
                            ForEach(activeRuns) { run in runRow(run) }
                        }
                    }
                    Section {
                        Button { tasksExpanded.toggle() } label: {
                            HStack { Text("Previous tasks"); Spacer(); Image(systemName: tasksExpanded ? "chevron.up" : "chevron.down") }.contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("botTeamPreviousTasksDisclosure")
                        if tasksExpanded {
                            ForEach(runs.filter { !$0.isActive }) { run in runRow(run) }
                            if runs.allSatisfy(\.isActive) { Text("Completed team work will appear here.").font(.caption).foregroundStyle(.secondary) }
                        }
                    }

                } else { Text("This team is no longer available. Refresh Bots.").foregroundStyle(.secondary) }
            }
            .strataList()
            .scrollDismissesKeyboard(.interactively)
            .overlay(alignment: .bottomTrailing) {
                if latestSequence > acknowledgedSequence, initiallyPositioned {
                    Button {
                        proxy.scrollTo("team-channel-latest", anchor: .bottom)
                        acknowledgedSequence = latestSequence
                    } label: { Label("Latest", systemImage: "arrow.down").font(.caption.weight(.semibold)).padding(12).background(StrataTheme.surfaceSecondary, in: Capsule()) }
                        .padding(12).accessibilityIdentifier("latestTeamMessagesButton")
                }
            }
            .onAppear {
                if !entries.isEmpty, !initiallyPositioned {
                    initiallyPositioned = true; acknowledgedSequence = latestSequence
                    proxy.scrollTo("team-channel-latest", anchor: .bottom)
                }
            }
            .onChange(of: entries.isEmpty) { _, empty in
                if !empty, !initiallyPositioned {
                    initiallyPositioned = true; acknowledgedSequence = latestSequence
                    proxy.scrollTo("team-channel-latest", anchor: .bottom)
                }
            }
            .safeAreaInset(edge: .bottom) { if let team { composer(team) } }
        }
        .navigationTitle("Team channel").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if activeRuns.count == 1, let run = activeRuns.first {
                    Button("Stop team", systemImage: "stop.circle", role: .destructive) { confirmingStop = run }
                        .disabled(workspace.mutation != nil).accessibilityIdentifier("stopBotTeamRun-\(run.id)")
                } else if activeRuns.count > 1 {
                    Menu {
                        ForEach(activeRuns) { run in
                            Button("Stop \(run.stateLabel.lowercased()) task · \(run.consumedTurns) turns", role: .destructive) { confirmingStop = run }
                                .accessibilityIdentifier("stopBotTeamRun-\(run.id)")
                        }
                    } label: { Label("Team work", systemImage: "stop.circle") }.disabled(workspace.mutation != nil)
                }
            }
            ToolbarItemGroup(placement: .keyboard) { if taskFocused { Spacer(); Button("Done") { taskFocused = false }.accessibilityIdentifier("dismissBotTeamTaskKeyboardButton") } }
        }
        .refreshable { await workspace.refreshTeams(); await workspace.refreshChannel(teamId, reset: true) }
        .onAppear { visible = true }
        .onDisappear { visible = false; navigation = UUID() }
        .task(id: visible && scenePhase == .active) {
            guard visible, scenePhase == .active else { return }
            let generation = navigation
            repeat {
                if workspace.mutation == nil {
                    if !workspace.loading.contains("teams") { await workspace.refreshTeams() }
                    if !workspace.loading.contains(channelKey) { await workspace.refreshChannel(teamId) }
                }
                do { try await Task.sleep(for: .seconds(3)) } catch { break }
            } while !Task.isCancelled && visible && scenePhase == .active && navigation == generation
        }
        .onChange(of: message) { _, _ in requestId = UUID().uuidString }
        .onChange(of: recipient) { _, _ in requestId = UUID().uuidString }
        .onChange(of: reply?.id) { _, _ in requestId = UUID().uuidString }
        .confirmationDialog("Stop this team task and its delegated work?", isPresented: Binding(get: { confirmingStop != nil }, set: { if !$0 { confirmingStop = nil } })) {
            if let run = confirmingStop { Button("Stop all team work", role: .destructive) { confirmingStop = nil; Task { await workspace.stopRun(run); await workspace.refreshChannel(teamId) } } }
        }
    }

    @ViewBuilder private func teamSettings(_ team: BotTeam) -> some View {
        ForEach(team.memberIds, id: \.self) { id in
            let bot = store.botCatalog?.bots.first { $0.id == id }
            HStack { AvatarBadge(bot?.face ?? .default(for: "Bot"), size: 30); Text(bot?.name ?? "Unavailable bot"); Spacer(); if id == team.coordinatorId { Text("Coordinator").font(.caption).foregroundStyle(.secondary) } }
        }
        LabeledContent("Limits", value: "\(team.limits.maxParallel) parallel · \(team.limits.maxTurns) turns · \(team.limits.maxDurationMs / 60_000)m")
        Text("Everyone can join the conversation. The coordinator assigns work and brings results together. Each bot keeps its own model, computer and permissions.").font(.caption).foregroundStyle(.secondary)
        Button(team.enabled ? "Disable team" : "Enable reviewed team") { Task { await workspace.setTeamEnabled(team, enabled: !team.enabled) } }
            .disabled(workspace.mutation != nil || !activeRuns.isEmpty)
            .accessibilityIdentifier("toggleBotTeamEnabledButton")
    }

    private func channelRow(_ entry: BotTeamChannelMessage, team: BotTeam) -> some View {
        HStack(alignment: .top, spacing: 10) {
            if entry.author.type == "bot" {
                AvatarBadge(entry.author.avatarConfig ?? store.botCatalog?.bots.first { $0.id == entry.author.botId }?.face ?? .default(for: entry.author.name), size: 34)
            } else { Image(systemName: entry.author.type == "user" ? "person.crop.circle.fill" : "person.3.fill").font(.system(size: 22)).foregroundStyle(StrataTheme.secondaryInk).frame(width: 34, height: 34) }
            VStack(alignment: .leading, spacing: 7) {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 6) { authorLabel(entry, team: team); messageDate(entry) }
                } else {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline) { authorLabel(entry, team: team); Spacer(minLength: 8); messageDate(entry) }
                        VStack(alignment: .leading, spacing: 3) { authorLabel(entry, team: team); messageDate(entry) }
                    }
                }
                if let replyId = entry.replyToId {
                    let original = entries.first { $0.id == replyId }
                    Text("Replying to \(original?.author.name ?? "an earlier message")\(original.map { ": " + $0.content } ?? "")")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                if let recipients = entry.recipientIds, !recipients.isEmpty, Set(recipients) != Set(team.memberIds) {
                    Text("To " + recipients.map { id in store.botCatalog?.bots.first { $0.id == id }?.name ?? "Teammate" }.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
                }
                Text(.init(entry.content)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("teamMessageContent-\(entry.id)")
                if entry.kind != "message" { Text(entry.kind.replacingOccurrences(of: "_", with: " ").capitalized).font(.caption2.weight(.medium)).foregroundStyle(.secondary) }
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 12) { messageActions(entry) }.font(.caption).buttonStyle(.borderless)
                } else {
                    HStack(spacing: 16) { messageActions(entry) }.font(.caption).buttonStyle(.borderless)
                }
            }
        }.padding(.vertical, 10)
    }
    private func authorLabel(_ entry: BotTeamChannelMessage, team: BotTeam) -> some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.author.name).font(.subheadline.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                    if entry.author.botId == team.coordinatorId { Text("Coordinator").font(.caption2).foregroundStyle(.secondary) }
                }
            } else {
                HStack(spacing: 5) {
                    Text(entry.author.name).font(.subheadline.weight(.semibold))
                    if entry.author.botId == team.coordinatorId { Text("Coordinator").font(.caption2).foregroundStyle(.secondary) }
                }
            }
        }
    }
    @ViewBuilder private func messageActions(_ entry: BotTeamChannelMessage) -> some View {
        Button { reply = entry; requestId = UUID().uuidString; taskFocused = true } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }
            .accessibilityIdentifier("replyTeamMessage-\(entry.id)")
        if let chatId = entry.chatId, CompanionClient.isSafeIdentifier(chatId) {
            BotSharedConversationButton(store: store, chatId: chatId, title: "Thinking & tools", openChat: openChat)
        }
    }
    @ViewBuilder private func messageDate(_ entry: BotTeamChannelMessage) -> some View {
        if let date = entry.createdAt.date { Text(date, style: .time).font(.caption2).foregroundStyle(.secondary) }
    }
    private func runRow(_ run: BotTeamRun) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack { Text(run.stateLabel).font(.subheadline.weight(.semibold)); Spacer(); Text("\(run.consumedTurns) turns").font(.caption).foregroundStyle(.secondary) }
            if let detail = run.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
            BotSharedConversationButton(store: store, chatId: run.rootChatId, title: "Open task conversation", openChat: openChat)
            if run.isActive { Button("Stop team task", role: .destructive) { confirmingStop = run }.buttonStyle(.borderless).disabled(workspace.mutation != nil).accessibilityIdentifier("stopBotTeamRunDetails-\(run.id)") }
        }.padding(.vertical, 6)
    }
    private func composer(_ team: BotTeam) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            if let reply {
                HStack(alignment: .top) {
                    Text("Replying to \(reply.author.name): \(reply.content)").font(.caption).lineLimit(2).accessibilityIdentifier("teamReplyContext")
                    Spacer(); Button { self.reply = nil } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Cancel reply")
                }.foregroundStyle(.secondary)
            }
            if channel?.supported == true {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("To").font(.caption2).foregroundStyle(.secondary)
                        recipientPicker(team).font(.caption).frame(maxWidth: .infinity, alignment: .leading)
                        if !activeRuns.isEmpty { Text("Team working").font(.caption2).foregroundStyle(StrataTheme.accent) }
                    }
                } else {
                    HStack {
                        Text("To").font(.caption).foregroundStyle(.secondary)
                        recipientPicker(team)
                        Spacer()
                        if !activeRuns.isEmpty { Text("Team working").font(.caption).foregroundStyle(StrataTheme.accent) }
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField(channel?.supported == true ? "Message your team…" : "What should this team do?", text: $message, axis: .vertical).lineLimit(1...5)
                    .focused($taskFocused).padding(11).background(StrataTheme.grouped, in: RoundedRectangle(cornerRadius: 16))
                    .accessibilityIdentifier("botTeamTaskInput")
                Button { send(team) } label: { Image(systemName: "arrow.up").font(.system(size: 20, weight: .semibold)).frame(width: 44, height: 44).foregroundStyle(StrataTheme.primaryInk).background(StrataTheme.primaryFill, in: Circle()) }
                    .accessibilityLabel(channel?.supported == true ? "Send to team" : "Start task")
                    .disabled(channel == nil || !team.enabled || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || message.utf16.count > 16_000 || workspace.mutation != nil)
                    .accessibilityIdentifier("startBotTeamTaskButton")
            }
            if let error = workspace.messages[channelKey] ?? workspace.messages["teams"] {
                Text(error).font(.caption).foregroundStyle(StrataTheme.warning).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("teamChannelComposerError")
            }
            if !team.enabled { Text("Open Team settings to review and enable this team.").font(.caption).foregroundStyle(.secondary) }
        }.padding(.horizontal, 16).padding(.vertical, 10).background(StrataTheme.surfaceSecondary)
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
        let draft = BotTeamChannelPost(message: text, requestId: request, recipientIds: recipient.isEmpty ? nil : recipient == "everyone" ? team.memberIds : [recipient], replyToId: reply?.id)
        Task {
            let sent: Bool
            if channel?.supported == true { sent = await workspace.postTeamMessage(team, draft: draft) }
            else { sent = await workspace.startTeam(team, message: text, requestId: request) != nil }
            // Leave the room in place. Reading Thinking is a separate explicit action.
            if sent, navigation == generation, message == text, requestId == request { message = ""; reply = nil; requestId = UUID().uuidString }
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
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: item.icon).font(.subheadline).frame(width: 36, height: 36)
                                .background(StrataTheme.grouped, in: RoundedRectangle(cornerRadius: 12))
                            VStack(alignment: .leading, spacing: 5) {
                                Text(item.title).font(.body.weight(.semibold))
                                StrataStatusPill(title: item.state.replacingOccurrences(of: "_", with: " ").capitalized,
                                    tone: ["running", "working"].contains(item.state) ? .success : ["queued", "pending"].contains(item.state) ? .attention : .neutral)
                            }
                        }
                        if let from = item.fromBotId, let to = item.toBotId { Text(botName(from) + " → " + botName(to)).font(.subheadline) }
                        if let detail = item.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
                        if let chatId = item.chatId ?? workspace.teams?.runs.first(where: { $0.id == item.runId })?.rootChatId {
                            BotSharedConversationButton(store: store, chatId: chatId, title: "Open conversation", openChat: openChat)
                        }
                    }.padding(.vertical, 8).accessibilityIdentifier("botActivity-\(item.id)")
                }
                BotWorkspaceMessage(workspace: workspace, key: "activity")
            } header: { Text("Team activity") }
            Section("Shared work") {
                ForEach(store.conversations.filter { $0.active }) { conversation in
                    BotSharedConversationButton(store: store, chatId: conversation.id, title: conversation.title, openChat: openChat)
                }
                Text("Open a conversation to review its current approval requests or stop that exact task.").font(.caption).foregroundStyle(.secondary)
            }
        }.strataList()
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
                        HStack(spacing: 12) {
                            Image(systemName: connection.transport == "stdio" ? "terminal" : "network")
                                .font(.title3).frame(width: 42, height: 42).background(StrataTheme.grouped, in: RoundedRectangle(cornerRadius: 14))
                            VStack(alignment: .leading, spacing: 5) {
                                Text(connection.name).font(.body.weight(.semibold))
                                Text(connection.statusLabel + " · \(connection.tools.count) tools").font(.caption).foregroundStyle(StrataTheme.secondaryInk)
                            }
                        }.padding(.vertical, 4)
                    }.accessibilityIdentifier("botConnection-\(connection.id)")
                }
                BotWorkspaceMessage(workspace: workspace, key: "connections")
            }
        }.strataList()
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
        }.strataList().navigationTitle(connection?.name ?? "Connection").navigationBarTitleDisplayMode(.inline)
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
