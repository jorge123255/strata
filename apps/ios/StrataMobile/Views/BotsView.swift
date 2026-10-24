import SwiftUI

private enum BotRosterEntry: Identifiable {
    case bot(CompanionBot), team(BotTeam)
    var id: String { switch self { case .bot(let value): "bot-" + value.id; case .team(let value): "team-" + value.id } }
}

private struct BotWorkspaceObservation<Content: View>: View {
    @ObservedObject var workspace: BotWorkspaceStore
    let content: (BotWorkspaceStore) -> Content
    var body: some View { content(workspace) }
}

struct BotsView: View {
    @ObservedObject var store: CompanionStore
    let pair: () -> Void
    let openChat: () -> Void
    @State private var destination: BotWorkspaceDestination = .team
    @State private var workspace: BotWorkspaceStore?
    @State private var workspaceGeneration: UUID?
    @State private var rosterVisible = false
    @State private var creatingTeam = false
    @State private var creatingBot = false
    @State private var botQuery = ""
    @State private var rosterFilter: BotRosterFilter = .all
    @State private var openingTask: Task<Void, Never>?
    @State private var profileBotId: String?
    @FocusState private var searchFocused: Bool
    @Environment(\.scenePhase) private var scenePhase

    // Adapted from Cua Bots iOS PhoneViews.swift (FSL-1.1-MIT,
    // Copyright (c) 2026 Cua AI, Inc.). Uses Strata's existing paired store.
    var body: some View {
        Group {
            if let workspace { BotWorkspaceObservation(workspace: workspace) { _ in workspaceContent } }
            else { workspaceContent }
        }
        .task(id: store.pairingGeneration) {
            if workspaceGeneration != store.pairingGeneration || workspace == nil {
                creatingTeam = false; creatingBot = false; botQuery = ""; rosterFilter = .all
                workspace = store.isPaired ? store.botWorkspaceStore() : nil
                workspaceGeneration = store.pairingGeneration
            }
            if store.isPaired { await store.refreshBots(); await workspace?.refreshTeams() }
        }
        .onAppear { rosterVisible = true }
        .onDisappear { rosterVisible = false; openingTask?.cancel(); openingTask = nil; store.cancelOpeningBotConversation() }
        .task(id: rosterVisible && scenePhase == .active && store.isPaired && destination == .team) {
            guard rosterVisible, scenePhase == .active, store.isPaired, destination == .team else { return }
            while !Task.isCancelled && rosterVisible && scenePhase == .active && destination == .team {
                do { try await Task.sleep(for: .seconds(5)) } catch { break }
                guard !Task.isCancelled, rosterVisible, scenePhase == .active, destination == .team else { break }
                if workspace?.mutation == nil, workspace?.loading.contains("teams") != true { await workspace?.refreshTeams() }
            }
        }
    }

    private var workspaceContent: some View {
        Group {
            if store.isPaired, let workspace, destination != .team {
                BotWorkspaceDestinationView(destination: destination, store: store, workspace: workspace, openChat: openChat).strataList()
            } else { roster }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { if store.isPaired { rosterControls } }
        .navigationTitle(destination == .team ? "Bots" : destination.rawValue)
        .navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
        .refreshable { await store.refresh(silently: true); await store.refreshBots(); await workspace?.refreshTeams() }
        .sheet(isPresented: $creatingTeam) { if let workspace { BotTeamEditor(store: store, workspace: workspace) } }
        .sheet(isPresented: $creatingBot) { BotProfileEditor(store: store) }
        .navigationDestination(isPresented: Binding(get: { profileBotId != nil }, set: { if !$0 { profileBotId = nil } })) {
            if let profileBotId { BotDetailView(store: store, botId: profileBotId, openChat: openChat) }
        }
        .toolbar {
            if store.isPaired {
                ToolbarItem(placement: .topBarLeading) {
                    Button { destination = .activity; searchFocused = false } label: {
                        Image(systemName: "waveform.path").frame(width: 44, height: 44)
                    }.accessibilityLabel("Bot activity").accessibilityIdentifier("botsActivityButton")
                }
                ToolbarItem(placement: .topBarTrailing) { NotificationInboxButton(notifications: store.notifications) }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { creatingBot = true } label: { Label("Create bot", systemImage: "sparkles") }
                            .disabled(store.botCatalog?.lifecycleSupported != true || store.savingBotProfile || store.status?.hostConnected != true)
                            .accessibilityIdentifier("createBotButton")
                        Button { creatingTeam = true } label: { Label("Create team", systemImage: "person.3") }
                            .disabled(!canCreateTeam).accessibilityIdentifier("createBotTeamButton")
                    } label: { Image(systemName: "plus").font(.system(size: 23, weight: .medium)).frame(width: 44, height: 44) }
                        .accessibilityLabel("Create bot or team").accessibilityIdentifier("createBotMenuButton")
                }
            }
        }
    }

    private var roster: some View {
        List {
            if !store.isPaired {
                ConnectionNeededView(icon: "sparkles.rectangle.stack", title: "Meet your bots", message: "Pair your Mac to open your bots and their shared conversations.", pair: pair)
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            } else {
                if let message = store.botsMessage {
                    Section {
                        Label(message, systemImage: "info.circle").foregroundStyle(StrataTheme.secondaryInk).accessibilityIdentifier("botsUnavailable")
                        Button("Check again") { Task { await store.refreshBots() } }.disabled(store.isLoadingBots)
                    }.listRowBackground(Color.clear)
                }
                if store.isLoadingBots, store.botCatalog == nil { ProgressView("Checking your bots…") }
                if let catalog = store.botCatalog {
                    if botQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, rosterFilter == .all, let featured = featuredBot(catalog) {
                        HStack(alignment: .top, spacing: 8) {
                            Spacer(minLength: 32)
                            Button { openBot(featured) } label: {
                            VStack(spacing: 8) {
                                StrataCompanionStage(size: 124, tint: featured.face.color.accent) {
                                    ExpressiveBotAvatar(config: featured.face, size: 124, mood: store.botMood(featured), animated: true)
                                }
                                Text(featured.name).font(.subheadline.weight(.medium)).foregroundStyle(StrataTheme.secondaryInk)
                                Text(companionGreeting(store.botMood(featured))).font(.caption)
                                    .foregroundStyle(StrataTheme.secondaryInk).multilineTextAlignment(.center)
                                    .fixedSize(horizontal: false, vertical: true)
                                if store.openingBotConversationId == featured.id { ProgressView("Opening conversation…").font(.caption) }
                            }.frame(maxWidth: .infinity).padding(.vertical, 19)
                            }.buttonStyle(.plain).disabled(!canOpenBot).accessibilityLabel("Chat with " + featured.name).accessibilityValue(store.botMood(featured).label).accessibilityIdentifier("featuredBotButton")
                            botProfileLink(featured, identifier: "featuredBotProfileButton")
                        }.listRowBackground(Color.clear).listRowSeparator(.hidden)
                    }
                    Section {
                        let entries = rosterEntries(catalog)
                        if catalog.bots.isEmpty, catalog.reason == nil { emptyBots }
                        if !catalog.bots.isEmpty, entries.isEmpty {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("No bots or teams match this search or filter.").foregroundStyle(StrataTheme.secondaryInk).accessibilityIdentifier("botRosterFilteredEmpty")
                                Button("Clear filters") { botQuery = ""; rosterFilter = .all; searchFocused = false }.accessibilityIdentifier("clearBotRosterFiltersButton")
                            }.padding(.vertical, 18)
                        }
                        ForEach(entries) { entry in
                            switch entry {
                            case .bot(let bot):
                                HStack(spacing: 8) {
                                    Button { openBot(bot) } label: { botCard(bot) }.buttonStyle(.plain)
                                        .disabled(!canOpenBot).accessibilityIdentifier("bot-\(bot.id)")
                                    botProfileLink(bot, identifier: "botProfile-" + bot.id)
                                }
                            case .team(let team):
                                if let workspace {
                                    NavigationLink { BotTeamDetailView(store: store, workspace: workspace, teamId: team.id, openChat: openChat) } label: { teamCard(team, catalog: catalog) }.accessibilityIdentifier("team-\(team.id)")
                                }
                            }
                        }
                    }.listRowBackground(Color.clear).listRowSeparator(.hidden)
                    if let message = workspace?.messages["teams"] { Text(message).font(.caption).foregroundStyle(StrataTheme.warning).listRowBackground(Color.clear) }
                    if catalog.lifecycleSupported != true {
                        Text("Update Strata on your Mac to create and edit bots on your iPhone. Existing shared conversations are still available.").font(.caption).foregroundStyle(StrataTheme.secondaryInk).listRowBackground(Color.clear)
                    }
                }
            }
        }.listStyle(.plain).scrollContentBackground(.hidden).background(StrataTheme.background)
            .listRowSpacing(4).listSectionSeparator(.hidden).accessibilityIdentifier("botAndTeamRoster")
    }
    private var canCreateTeam: Bool {
        (store.botCatalog?.bots.count ?? 0) >= 2 && workspace?.teams != nil && workspace?.teams?.reason == nil && workspace?.mutation == nil
    }
    private func companionGreeting(_ mood: BotMood) -> String {
        switch mood {
        case .idle: return "Your next idea starts here."
        case .thinking: return "Mulling it over…"
        case .working: return "On the case."
        case .needsApproval: return "A little help, please."
        case .done: return "Something to show you."
        case .paused: return "Taking a breather."
        case .error: return "Let’s take another look."
        }
    }
    private var canOpenBot: Bool {
        store.openingBotConversationId == nil && store.creatingBotConversationId == nil && !store.isSending && !store.isSubmittingMessage && !store.savingBotProfile
    }
    private func botProfileLink(_ bot: CompanionBot, identifier: String) -> some View {
        Button { profileBotId = bot.id } label: {
            Image(systemName: "info.circle").font(.system(size: 19)).foregroundStyle(StrataTheme.secondaryInk).frame(minWidth: 44, minHeight: 44)
        }.buttonStyle(.plain).accessibilityLabel(bot.name + " profile and settings").accessibilityIdentifier(identifier)
    }
    private func openBot(_ bot: CompanionBot) {
        guard openingTask == nil, canOpenBot else { return }
        searchFocused = false
        let generation = store.pairingGeneration
        openingTask = Task {
            let opened = await store.openBotConversation(bot.id)
            guard !Task.isCancelled, rosterVisible, generation == store.pairingGeneration else { openingTask = nil; return }
            openingTask = nil
            if opened { openChat() }
        }
    }
    private var emptyBots: some View {
        VStack(alignment: .leading, spacing: 13) {
            Image(systemName: "sparkles.rectangle.stack").font(.system(size: 28, weight: .regular)).foregroundStyle(StrataTheme.ink)
                .frame(width: 64, height: 64).background(StrataTheme.surfaceSecondary, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            Text(store.botCatalog?.lifecycleSupported == true ? "Create your first bot" : "Your team starts on Mac").font(.title3.weight(.semibold)).foregroundStyle(StrataTheme.ink)
            Text("Create a coding bot, a computer-control bot, or one that can do both. Its conversations will appear here.").font(.subheadline).foregroundStyle(StrataTheme.secondaryInk)
        }.frame(maxWidth: .infinity, alignment: .leading).strataCard(padding: 24).accessibilityIdentifier("botsEmptyState")
    }
    private var rosterControls: some View {
        HStack(spacing: 10) {
            Menu {
                Section("Workspace") {
                    ForEach(BotWorkspaceDestination.allCases) { item in
                        Button { destination = item; searchFocused = false } label: { Label(item == .team ? "Bots & teams" : item.rawValue, systemImage: item == .team ? "person.2" : item == .activity ? "waveform.path" : item == .skills ? "sparkles" : "puzzlepiece.extension") }
                            .accessibilityIdentifier("botsWorkspaceDestination-\(item.rawValue)")
                    }
                }
                Section("Show") {
                    ForEach(BotRosterFilter.allCases) { filter in
                        Button { rosterFilter = filter; destination = .team } label: { if rosterFilter == filter { Label(filter.rawValue, systemImage: "checkmark") } else { Text(filter.rawValue) } }
                            .accessibilityIdentifier("botRosterFilter-\(filter.rawValue)")
                    }
                }
            } label: { Image(systemName: "square.grid.2x2").font(.system(size: 21)).frame(width: 48, height: 48).strataChrome() }
                .accessibilityLabel("Bots workspace and filters").accessibilityIdentifier("botsWorkspaceMenuButton")
            if destination == .team {
                HStack(spacing: 9) {
                    Image(systemName: "magnifyingglass").foregroundStyle(StrataTheme.secondaryInk)
                    TextField("Search", text: $botQuery).textInputAutocapitalization(.never).autocorrectionDisabled().focused($searchFocused).submitLabel(.search).onSubmit { searchFocused = false }.accessibilityIdentifier("botRosterSearchInput")
                    if !botQuery.isEmpty { Button { botQuery = "" } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).accessibilityLabel("Clear search").frame(width: 36, height: 36) }
                }.padding(.horizontal, 16).frame(minHeight: 48).background(StrataTheme.grouped, in: Capsule())
            } else { Text(destination.rawValue).font(.subheadline).foregroundStyle(StrataTheme.secondaryInk); Spacer() }
        }.padding(.horizontal, 16).padding(.vertical, 10).background(StrataTheme.background)
    }
    private func featuredBot(_ catalog: CompanionBots) -> CompanionBot? {
        if let id = store.currentConversation?.botId, let bot = catalog.bots.first(where: { $0.id == id }) { return bot }
        return catalog.bots.first(where: { store.botIsWorking($0) }) ?? catalog.bots.first
    }
    private func botCard(_ bot: CompanionBot) -> some View {
        let latest = store.botRosterConversations(bot).first
        return HStack(spacing: 14) {
            ZStack(alignment: .bottomTrailing) {
                KoalaAvatar(bot.face, mood: store.botMood(bot), animated: false).frame(width: 58, height: 58)
                BreathingStatusDot(kind: coucouKind(mood: store.botMood(bot), paused: bot.paused == true)).offset(x: 2, y: 2)
            }
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(bot.name).font(.body.weight(.semibold)).foregroundStyle(StrataTheme.ink).lineLimit(1)
                    Spacer(minLength: 0)
                    rosterDate(latest?.updatedAt.flatMap(rosterTimestamp))
                }
                if store.botIsWorking(bot) && bot.paused != true {
                    ShimmerText(text: latest?.preview.flatMap { $0.isEmpty ? nil : $0 } ?? bot.capabilityLabel).font(.subheadline).lineLimit(2)
                } else {
                    Text(latest?.preview.flatMap { $0.isEmpty ? nil : $0 } ?? bot.capabilityLabel).font(.subheadline).foregroundStyle(StrataTheme.secondaryInk).lineLimit(2)
                }
            }
            if store.openingBotConversationId == bot.id { ProgressView().accessibilityLabel("Opening conversation") }
            else if bot.paused == true { Image(systemName: "pause.circle").foregroundStyle(.secondary) }
        }.padding(.vertical, 10)
    }
    private func teamCard(_ team: BotTeam, catalog: CompanionBots) -> some View {
        let preview = previewForTeam(team)
        let working = workspace?.teams?.runs.contains(where: { $0.teamId == team.id && $0.isActive }) == true
        return HStack(spacing: 14) {
            ZStack(alignment: .bottomTrailing) {
                StrataTeamAvatars(bots: team.memberIds.compactMap { id in catalog.bots.first { $0.id == id } }, size: 58)
                if working { BreathingStatusDot(kind: .working).offset(x: 2, y: 2) }
            }
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(team.name).font(.body.weight(.semibold)).foregroundStyle(StrataTheme.ink).lineLimit(1)
                    Spacer(minLength: 0); rosterDate(preview?.createdAt.date ?? team.createdAt?.date)
                }
                if working {
                    ShimmerText(text: preview?.line ?? (team.enabled ? "Start a conversation with your team" : "Review and enable this team")).font(.subheadline).lineLimit(2).accessibilityIdentifier("teamRosterPreview-\(team.id)")
                } else {
                    Text(preview?.line ?? (team.enabled ? "Start a conversation with your team" : "Review and enable this team"))
                        .font(.subheadline).foregroundStyle(StrataTheme.secondaryInk).lineLimit(2).accessibilityIdentifier("teamRosterPreview-\(team.id)")
                }
            }
        }.padding(.vertical, 10)
    }
    private func previewForTeam(_ team: BotTeam) -> BotTeamChannelPreview? {
        if let row = workspace?.channels[team.id]?.messages.last, row.sequence > (team.channelPreview?.sequence ?? 0) {
            return BotTeamChannelPreview(id: row.id, sequence: row.sequence, kind: row.kind, author: row.author, content: row.content, createdAt: row.createdAt)
        }
        return team.channelPreview
    }
    @ViewBuilder private func rosterDate(_ date: Date?) -> some View { if let date { Text(date, style: .time).font(.caption).foregroundStyle(StrataTheme.secondaryInk).lineLimit(1) } }
    private func rosterTimestamp(_ raw: String) -> Date? {
        if let value = Double(raw), value > 0 { return Date(timeIntervalSince1970: value > 100_000_000_000 ? value / 1_000 : value) }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
    }
    private func rosterEntries(_ catalog: CompanionBots) -> [BotRosterEntry] {
        let query = botQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let bots = catalog.bots.filter { bot in
            let matches = query.isEmpty || [bot.name, bot.provider, bot.model].contains { $0.localizedCaseInsensitiveContains(query) }
            let attention = [.needsApproval, .paused, .error].contains(store.botMood(bot))
            return matches && (rosterFilter == .all || rosterFilter == .working && store.botIsWorking(bot) || rosterFilter == .attention && attention)
        }.map(BotRosterEntry.bot)
        let teams = (workspace?.teams?.teams ?? []).filter { team in
            let matches = query.isEmpty || team.name.localizedCaseInsensitiveContains(query) || team.memberIds.contains { id in catalog.bots.first { $0.id == id }?.name.localizedCaseInsensitiveContains(query) == true }
            let active = workspace?.teams?.runs.contains { $0.teamId == team.id && $0.isActive } == true
            return matches && (rosterFilter == .all || rosterFilter == .working && active || rosterFilter == .attention && !team.enabled)
        }.map(BotRosterEntry.team)
        return (teams + bots).sorted { a, b in
            @MainActor func date(_ entry: BotRosterEntry) -> Date {
                switch entry {
                case .bot(let value): return store.botRosterConversations(value).first?.updatedAt.flatMap(rosterTimestamp) ?? .distantPast
                case .team(let value): return previewForTeam(value)?.createdAt.date ?? value.createdAt?.date ?? .distantPast
                }
            }
            let left = date(a), right = date(b)
            return left == right ? a.id < b.id : left > right
        }
    }
}

struct BotDetailView: View {
    @ObservedObject var store: CompanionStore
    let botId: String
    let openChat: () -> Void
    @State private var showingSetup = false
    @State private var showingAvatar = false
    @State private var showingEditor = false
    @Environment(\.dismiss) private var dismiss
    private var bot: CompanionBot? { store.botCatalog?.bots.first { $0.id == botId } }

    // Profile sections follow the actual Cua Bots PhoneProfile layout while
    // every action uses the existing Strata companion catalog and history.
    var body: some View {
        List {
            if let bot {
                Section {
                    VStack(spacing: 6) {
                        Button { showingAvatar = true } label: { AvatarBadge(bot.face, mood: store.botMood(bot), size: 152, editable: true, animated: true, flourishToken: BotAvatarState.flourish(conversation: store.currentConversation?.botId == bot.id ? store.currentConversation : nil)) }
                            .buttonStyle(.plain).accessibilityLabel("Customize avatar").accessibilityIdentifier("customizeBotAvatarButton")
                        Text(bot.name).font(.title2.weight(.semibold))
                        Text(bot.capabilityLabel).font(.subheadline).foregroundStyle(.secondary)
                        if bot.paused == true { Label("Paused", systemImage: "pause.circle").font(.subheadline).foregroundStyle(.secondary) }
                    }.frame(maxWidth: .infinity).listRowBackground(Color.clear)
                }
                Section {
                    Button { showingSetup = true } label: {
                        profileAction("New conversation", detail: "Give \(bot.name) something to work on", icon: "square.and.pencil")
                    }.disabled(bot.paused == true || store.creatingBotConversationId != nil || store.isSending || store.isSubmittingMessage || store.status?.hostConnected != true)
                        .accessibilityIdentifier("newBotConversationButton")
                    if bot.computerMode == "cua" {
                        NavigationLink { BotComputerView(store: store, botId: bot.id, name: bot.name) } label: {
                            profileAction("Open computer", detail: "View and control its isolated desktop", icon: "desktopcomputer")
                        }.accessibilityIdentifier("botComputerViewButton")
                    }
                    if store.botCatalog?.lifecycleSupported == true {
                        Button { showingEditor = true } label: {
                            profileAction("Bot settings", detail: "Model, effort, computer and approvals", icon: "slider.horizontal.3")
                        }.disabled(bot.updatedAt == nil || store.botIsWorking(bot)).accessibilityIdentifier("botSettingsCard")
                    }
                }.listRowBackground(StrataTheme.surface)
                Section {
                    NavigationLink {
                        BotConnectorsForBotView(store: store, botId: bot.id)
                    } label: { profileAction("Connectors", detail: "Service accounts and tools", icon: "link") }
                        .accessibilityIdentifier("botConnectorsButton")
                }
                Section("Computers") {
                    LabeledContent("Execution", value: bot.executionLabel)
                        .accessibilityElement(children: .combine).accessibilityIdentifier("botComputerDetail")
                    if bot.computerMode == "cua", store.botCatalog?.hostFolderSupported == true {
                        NavigationLink { BotHostFolderView(store: store, bot: bot) } label: {
                            profileAction("Shared host folder", detail: bot.hostFolder?.path ?? "No host folder shared", icon: "folder.badge.gearshape")
                        }.accessibilityIdentifier("botHostFolderButton")
                    }
                }
                Section("Provider") { botDetails(bot) }
                Section("Conversations") {
                    let conversations = store.botConversations(bot)
                    if conversations.isEmpty {
                        Text("Start a conversation to give this bot work. Opening this screen doesn’t start a task.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    ForEach(conversations) { conversation in
                        Button {
                            Task {
                                await store.selectConversation(conversation)
                                if store.currentConversation?.id == conversation.id { openSelectedChat() }
                            }
                        } label: {
                            HStack(alignment: .top, spacing: 12) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(conversation.title).font(.subheadline.weight(.semibold)).foregroundStyle(StrataTheme.ink)
                                    if let preview = conversation.preview, !preview.isEmpty {
                                        Text(preview).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                }
                                Spacer(minLength: 0)
                                Image(systemName: conversation.active ? "circle.fill" : "chevron.right")
                                    .font(.caption2).foregroundStyle(conversation.active ? StrataTheme.accentText : StrataTheme.secondaryInk)
                            }
                        }
                        .disabled(store.isSubmittingMessage || store.isSending || store.creatingBotConversationId != nil)
                        .accessibilityIdentifier("botConversation-\(conversation.id)")
                    }
                }
            } else {
                Text("This bot is no longer available. Check Strata on your Mac.").foregroundStyle(.secondary)
            }
        }
        .strataList()
        .navigationTitle(bot?.name ?? "Bot").navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbar {
            if let bot, store.botCatalog?.lifecycleSupported == true {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") { showingEditor = true }
                        .disabled(bot.updatedAt == nil || store.botIsWorking(bot))
                        .accessibilityIdentifier("editBotProfileButton")
                }
            }
        }
        .refreshable { await store.refresh(silently: true); await store.refreshBots() }
        .sheet(isPresented: $showingSetup) {
            if let bot { BotConversationSetupView(store: store, bot: bot, openChat: openSelectedChat) }
        }
        .sheet(isPresented: $showingAvatar) {
            if let bot { BotAvatarEditor(store: store, bot: bot) }
        }
        .sheet(isPresented: $showingEditor) { if let bot { BotProfileEditor(store: store, bot: bot) } }
    }

    private func openSelectedChat() { dismiss(); openChat() }

    private func profileAction(_ title: String, detail: String, icon: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: icon).font(.system(size: 22, weight: .medium)).foregroundStyle(StrataTheme.accentText).frame(width: 30)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.body.weight(.medium)).foregroundStyle(StrataTheme.ink)
                Text(detail).font(.caption).foregroundStyle(StrataTheme.secondaryInk)
            }
            Spacer(minLength: 0)
        }.padding(.vertical, 9)
    }

    private func botDetails(_ bot: CompanionBot) -> some View {
        let provider = store.botCatalog?.providers.first { $0.id == bot.provider }
        return VStack(alignment: .leading, spacing: 15) {
            LabeledContent("Provider", value: provider?.name ?? bot.provider.capitalized)
                .accessibilityElement(children: .combine).accessibilityIdentifier("botProviderDetail")
            LabeledContent("Model", value: bot.model.isEmpty ? "Provider default" : bot.model)
            LabeledContent("Effort", value: bot.effort?.isEmpty == false ? bot.effort!.capitalized : "Provider default")
            LabeledContent("Permissions", value: bot.policyLabel)
                .accessibilityElement(children: .combine).accessibilityIdentifier("botPermissionsDetail")
            if let provider, !provider.detail.isEmpty {
                Label(provider.detail, systemImage: provider.available ? "checkmark.circle" : "exclamationmark.circle")
                    .font(.caption).foregroundStyle(provider.available ? StrataTheme.secondaryInk : StrataTheme.warning)
            }
        }
        .font(.subheadline).foregroundStyle(StrataTheme.secondaryInk)
    }
}

private struct BotAvatarEditor: View {
    @ObservedObject var store: CompanionStore
    let bot: CompanionBot
    @State private var avatar: AvatarConfig
    @Environment(\.dismiss) private var dismiss
    init(store: CompanionStore, bot: CompanionBot) { self.store = store; self.bot = bot; _avatar = State(initialValue: bot.face) }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    ExpressiveBotAvatar(config: avatar, size: 120, animated: true, interactive: true, flourishToken: String(describing: avatar))
                    AvatarPicker(avatar: $avatar, name: bot.name, supportedShapes: store.botCatalog?.avatarShapes ?? [])
                    if let error = store.error { Text(error).font(.subheadline).foregroundStyle(StrataTheme.warning) }
                }.padding(24)
            }
            .navigationTitle("Customize avatar").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(store.savingBotAvatarId != nil) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { if await store.saveBotAvatar(botId: bot.id, avatar: avatar) { dismiss() } } }
                        .disabled(store.savingBotAvatarId != nil).accessibilityIdentifier("saveBotAvatarButton")
                }
            }
        }
    }
}

struct BotAvatarView: View {
    let avatar: String
    var size: CGFloat = 40
    var config: AvatarConfig? = nil
    var name: String = "Bot"
    var mood: BotMood = .idle
    var animated = false
    var interactive = false
    var flourishToken = ""
    var body: some View {
        ExpressiveBotAvatar(config: config ?? .default(for: name), size: size, mood: mood, animated: animated, interactive: interactive, flourishToken: flourishToken)
            .accessibilityLabel(interactive ? "Animate bot avatar" : "Bot avatar").accessibilityValue(mood.label)
            .accessibilityIdentifier(interactive ? "animateBotAvatarButton" : "botAvatar")
    }
}

struct BotConversationSetupView: View {
    @ObservedObject var store: CompanionStore
    let initialBot: CompanionBot
    let openChat: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var computerId = ""
    @State private var modelId = ""
    @State private var workspace: String
    @State private var message: String?
    @State private var supportedEfforts: [String] = []
    @State private var effortSelection = "__profile"
    @State private var policy: BotApprovalPolicy
    @State private var confirmingBypass = false
    @FocusState private var workspaceFocused: Bool

    init(store: CompanionStore, bot: CompanionBot, openChat: @escaping () -> Void) {
        self.store = store; self.initialBot = bot; self.openChat = openChat
        _workspace = State(initialValue: bot.computerMode == "cua" ? "/workspace" : bot.workspace ?? "")
        _modelId = State(initialValue: bot.modelId ?? "")
        _policy = State(initialValue: BotApprovalPolicy(rawValue: bot.policy) ?? .manual)
    }

    private var bot: CompanionBot { store.botCatalog?.bots.first { $0.id == initialBot.id } ?? initialBot }
    private var supportsSelection: Bool { store.botCatalog?.selectionSupported == true }
    private var supportsPolicy: Bool { store.botCatalog?.lifecycleSupported == true }
    private var chosenComputer: BotComputer? { store.botCatalog?.computers.first { $0.id == computerId } }
    private var chosenModel: BotConfiguredModel? { store.botCatalog?.models?.first { $0.id == modelId } }
    private var isBusy: Bool { store.creatingBotConversationId != nil }
    private var remoteEffort: Bool { chosenComputer?.kind == "ssh" || (computerId.isEmpty && bot.execution.kind == "ssh") }
    private var effortOverride: String? {
        if !modelId.isEmpty { return bot.effort?.isEmpty == false ? "" : nil }
        return effortSelection == "__profile" ? nil : effortSelection
    }
    private var canCreate: Bool {
        !isBusy && store.status?.hostConnected == true &&
        (computerId.isEmpty || chosenComputer?.available == true) && (modelId.isEmpty || chosenModel?.available == true) &&
        (!supportsSelection || workspace.hasPrefix("/"))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 12) {
                        AvatarBadge(bot.face, size: 72)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(bot.name).font(.body.weight(.semibold))
                            Text(bot.capabilityLabel).font(.caption).foregroundStyle(StrataTheme.secondaryInk)
                        }
                    }
                }
                if supportsSelection {
                    Section {
                        Picker("Computer", selection: $computerId) {
                            Text("Bot default · " + bot.executionLabel).tag("")
                            if !computerId.isEmpty, chosenComputer == nil { Text("Computer no longer available").tag(computerId).disabled(true) }
                            ForEach(store.botCatalog?.computers ?? []) { computer in
                                Text(computer.name + (computer.available ? "" : " · Set up on Mac"))
                                    .tag(computer.id).disabled(!computer.available)
                            }
                        }.pickerStyle(.menu).accessibilityIdentifier("botComputerPicker")
                        if let computer = chosenComputer {
                            Text(computer.detail).font(.caption).foregroundStyle(StrataTheme.secondaryInk)
                        }
                        HStack {
                            TextField("Workspace folder", text: $workspace)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .focused($workspaceFocused).submitLabel(.done).onSubmit { workspaceFocused = false }
                                .accessibilityIdentifier("botWorkspaceInput")
                                .disabled(bot.computerMode == "cua")
                            if !workspace.isEmpty, bot.computerMode != "cua" {
                                Button { workspace = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(StrataTheme.secondaryInk) }
                                    .buttonStyle(.borderless).accessibilityLabel("Clear workspace folder").accessibilityIdentifier("clearBotWorkspaceButton")
                            }
                        }
                    } header: { Text("Where it works") } footer: {
                        Text(bot.computerMode == "cua" ? "This isolated computer uses /workspace. Set up additional computers in Strata on your Mac." : "Enter the folder path on that computer. Set up additional computers in Strata on your Mac.")
                    }
                    Section {
                        Picker("Model", selection: $modelId) {
                            Text("Bot default · " + (bot.model.isEmpty ? "Provider default" : bot.model)).tag("")
                            if !modelId.isEmpty, chosenModel == nil { Text("Model no longer available").tag(modelId).disabled(true) }
                            ForEach(store.botCatalog?.models ?? []) { model in
                                Text(model.label + (model.available ? "" : " · Unavailable"))
                                    .tag(model.id).disabled(!model.available)
                            }
                        }.pickerStyle(.menu).accessibilityIdentifier("botModelPicker")
                        if let model = chosenModel, let detail = model.detail, !detail.isEmpty {
                            Text(detail).font(.caption).foregroundStyle(StrataTheme.secondaryInk)
                        }
                        if modelId.isEmpty, !supportedEfforts.isEmpty || bot.effort?.isEmpty == false || remoteEffort {
                            Picker("Effort", selection: $effortSelection) {
                                Text(remoteEffort && bot.effort?.isEmpty == false ? "Saved · " + bot.effort! : "Bot default").tag("__profile")
                                Text("Provider default").tag("")
                                if !remoteEffort { ForEach(supportedEfforts, id: \.self) { level in Text(level.capitalized).tag(level) } }
                            }.accessibilityIdentifier("botEffortPicker")
                        }
                    } header: { Text("What powers it") } footer: {
                        Text("A configured model applies to this conversation. Existing model-serving selections stay unchanged.")
                    }
                } else {
                    Section {
                        LabeledContent("Computer", value: bot.executionLabel)
                        LabeledContent("Model", value: bot.model.isEmpty ? "Provider default" : bot.model)
                        Text("Update Strata on your Mac to choose another computer or model here.")
                            .font(.caption).foregroundStyle(StrataTheme.secondaryInk)
                    }
                }
                Section {
                    if supportsPolicy {
                        Picker("Approvals", selection: $policy) {
                            ForEach(BotApprovalPolicy.allCases) { value in Text(value.label).tag(value) }
                        }.accessibilityIdentifier("botConversationPolicyPicker")
                        Text(policy.detail).font(.caption).foregroundStyle(policy == .bypass ? StrataTheme.warning : StrataTheme.secondaryInk)
                    } else {
                        LabeledContent("Permissions", value: bot.policyLabel)
                        Text("Update Strata on your Mac to choose a different approval mode for a new conversation.").font(.caption).foregroundStyle(StrataTheme.secondaryInk)
                    }
                    Text("Existing conversations keep their original settings. Work starts when you send a message.")
                        .font(.caption).foregroundStyle(StrataTheme.secondaryInk)
                    if let message {
                        Label(message, systemImage: "exclamationmark.circle").font(.subheadline).foregroundStyle(StrataTheme.warning)
                            .accessibilityIdentifier("botConversationSetupError")
                    }
                    Button {
                        workspaceFocused = false
                        if supportsPolicy, policy == .bypass { confirmingBypass = true }
                        else { createConversation() }
                    } label: {
                        HStack {
                            if isBusy { ProgressView() }
                            Text("Create conversation").fontWeight(.semibold)
                        }.frame(maxWidth: .infinity)
                    }
                    .disabled(!canCreate).accessibilityIdentifier("confirmBotConversationButton")
                }
            }
            .disabled(isBusy)
            .strataList()
            .navigationTitle("New conversation").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(isBusy) }
                ToolbarItemGroup(placement: .keyboard) {
                    if workspaceFocused {
                        Spacer()
                        Button("Done") { workspaceFocused = false }.accessibilityIdentifier("dismissBotSetupKeyboardButton")
                    }
                }
            }
            .confirmationDialog("Start with Bypass approvals?", isPresented: $confirmingBypass, titleVisibility: .visible) {
                Button("Create with Bypass approvals", role: .destructive) { createConversation() }
            } message: { Text("This new conversation can run actions without approval prompts. Existing conversations and queued approvals keep their settings.") }
            .interactiveDismissDisabled(isBusy)
        }
        .tint(StrataTheme.accentText)
        .onChange(of: computerId) { _, _ in effortSelection = "" }
        .task(id: bot.provider + ":" + bot.model) { supportedEfforts = await store.supportedBotEfforts(bot) }
    }

    private func createConversation() {
        Task {
            message = nil
            let folder = bot.computerMode == "cua" ? "/workspace" : (supportsSelection && workspace != bot.workspace ? workspace : nil)
            if await store.newBotConversation(bot, computerId: computerId.isEmpty ? nil : computerId,
                                              modelId: modelId.isEmpty ? nil : modelId, workspace: folder,
                                              effort: effortOverride, policy: supportsPolicy ? policy : nil) {
                dismiss(); openChat()
            } else { message = store.error ?? "This conversation could not be created. Refresh Bots and try again."; store.error = nil }
        }
    }
}

private enum BotRosterFilter: String, CaseIterable, Identifiable {
    case all = "All", working = "Working", attention = "Needs attention"
    var id: String { rawValue }
}

private struct BotHostFolderView: View {
    @ObservedObject var store: CompanionStore
    let bot: CompanionBot
    @Environment(\.dismiss) private var dismiss
    @State private var enabled: Bool
    @State private var path: String
    @State private var access: String
    @State private var saved = false
    init(store: CompanionStore, bot: CompanionBot) {
        self.store = store; self.bot = bot
        _enabled = State(initialValue: bot.hostFolder != nil)
        _path = State(initialValue: bot.hostFolder?.path ?? "")
        _access = State(initialValue: bot.hostFolder?.access ?? "read")
    }
    var body: some View {
        Form {
            Section {
                Toggle("Share a host folder", isOn: $enabled).accessibilityIdentifier("hostFolderEnabled")
                if enabled {
                    TextField("Full path on the execution computer", text: $path)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("hostFolderPath")
                    Picker("Access", selection: $access) {
                        Text("Read only").tag("read"); Text("Read and write").tag("read-write")
                    }.accessibilityIdentifier("hostFolderAccess")
                }
            } footer: {
                Text("Choose one folder on the bot’s execution computer. Dedicated tools read text files and, when allowed, write them. Commands and browser tools stay isolated. This does not share an iPhone folder.")
            }
            Section {
                Text("Teams using this bot’s isolated computer inherit the share. Changes apply to new chats and runs; removing or changing access revokes it from older chats too.")
                    .font(.footnote).foregroundStyle(.secondary)
                if access == "read-write", enabled { Text("The bot’s approval mode still applies to file changes.").font(.footnote).foregroundStyle(.secondary) }
                Button(enabled ? "Save folder access" : "Remove folder access") {
                    let generation = store.pairingGeneration
                    let folder = enabled ? BotHostFolder(path: path.trimmingCharacters(in: .whitespacesAndNewlines), access: access) : nil
                    Task { if await store.saveBotHostFolder(bot, folder: folder, expectedPairingGeneration: generation) { saved = true; dismiss() } }
                }.disabled(store.savingBotProfile || enabled && !path.hasPrefix("/"))
                    .accessibilityIdentifier("saveHostFolderButton")
                if store.savingBotProfile { ProgressView("Saving…") }
                if let error = store.botProfileError { Text(error).foregroundStyle(StrataTheme.warning).accessibilityIdentifier("hostFolderError") }
            } footer: { Text("Saving starts no computer or model. Finish active work before changing access.") }
        }.strataList().navigationTitle("Shared host folder")
            .onAppear { store.clearBotProfileError() }
    }
}
