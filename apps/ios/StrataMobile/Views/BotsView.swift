import SwiftUI

struct BotsView: View {
    @ObservedObject var store: CompanionStore
    let pair: () -> Void
    let openChat: () -> Void
    @State private var destination: BotWorkspaceDestination = .team
    @State private var workspace: BotWorkspaceStore?
    @State private var workspaceGeneration: UUID?
    @State private var creatingTeam = false
    @State private var creatingBot = false
    @State private var botQuery = ""
    @State private var rosterFilter: BotRosterFilter = .all
    @FocusState private var searchFocused: Bool

    // Adapted from Cua Bots iOS PhoneViews.swift (FSL-1.1-MIT,
    // Copyright (c) 2026 Cua AI, Inc.). Uses Strata's existing paired store.
    var body: some View {
        Group {
          if store.isPaired, let workspace, destination != .team {
            BotWorkspaceDestinationView(destination: destination, store: store, workspace: workspace, openChat: openChat).strataList()
          } else { List {
            if !store.isPaired {
                ConnectionNeededView(icon: "sparkles.rectangle.stack", title: "Meet your bots", message: "Pair your Mac to open your bots and their shared conversations.", pair: pair)
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            } else {
                if let message = store.botsMessage {
                    Section {
                        Label(message, systemImage: "info.circle").font(.subheadline).foregroundStyle(StrataTheme.secondaryInk)
                            .accessibilityIdentifier("botsUnavailable")
                        Button("Check again") { Task { await store.refreshBots() } }.disabled(store.isLoadingBots)
                    }.listRowBackground(StrataTheme.surface)
                }
                if store.isLoadingBots, store.botCatalog == nil { ProgressView("Checking your bots…") }
                if let catalog = store.botCatalog {
                    if botQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, rosterFilter == .all, let featured = featuredBot(catalog) {
                        NavigationLink { BotDetailView(store: store, botId: featured.id, openChat: openChat) } label: {
                            VStack(spacing: 8) {
                                ExpressiveBotAvatar(config: featured.face, size: 124, mood: store.botMood(featured), animated: true)
                                Text(featured.name).font(.subheadline.weight(.medium)).foregroundStyle(StrataTheme.secondaryInk)
                            }.frame(maxWidth: .infinity).padding(.vertical, 16)
                        }.listRowBackground(Color.clear).listRowSeparator(.hidden)
                            .accessibilityIdentifier("featuredBotButton")
                    }
                    Section {
                        if catalog.bots.isEmpty, catalog.reason == nil { emptyBots }
                        if !catalog.bots.isEmpty, filteredBots(catalog).isEmpty {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("No bots match this search or filter.").foregroundStyle(StrataTheme.secondaryInk).accessibilityIdentifier("botRosterFilteredEmpty")
                                Button("Clear filters") { botQuery = ""; rosterFilter = .all; searchFocused = false }
                                    .accessibilityIdentifier("clearBotRosterFiltersButton")
                            }.padding(.vertical, 18)
                        }
                        ForEach(filteredBots(catalog)) { bot in
                            NavigationLink { BotDetailView(store: store, botId: bot.id, openChat: openChat) } label: { botCard(bot, catalog: catalog) }
                                .accessibilityIdentifier("bot-\(bot.id)")
                        }
                    }.listRowBackground(Color.clear).listRowSeparator(.hidden)
                    if let workspace {
                        BotTeamsSection(store: store, workspace: workspace, openChat: openChat, createTeam: { creatingTeam = true })
                            .listRowBackground(StrataTheme.surface).listRowSeparator(.hidden)
                    }
                    if catalog.lifecycleSupported != true {
                        Text("Update Strata on your Mac to create and edit bots on your iPhone. Existing shared conversations are still available.")
                            .font(.caption).foregroundStyle(StrataTheme.secondaryInk).listRowBackground(Color.clear).listRowSeparator(.hidden)
                    }
                }
            }
          }.listStyle(.plain).scrollContentBackground(.hidden).background(StrataTheme.background)
              .listRowSpacing(4).listSectionSeparator(.hidden) }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if store.isPaired {
                Picker("Bots workspace", selection: $destination) {
                    ForEach(BotWorkspaceDestination.allCases) { item in Text(item.rawValue).tag(item) }
                }.pickerStyle(.segmented).padding(.horizontal, 16).padding(.vertical, 12)
                    .background(StrataTheme.background).accessibilityIdentifier("botsWorkspacePicker")
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if store.isPaired, destination == .team, store.botCatalog != nil { rosterControls }
        }
        .navigationTitle("Bots").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
        .refreshable { await store.refresh(silently: true); await store.refreshBots() }
        .sheet(isPresented: $creatingTeam) { if let workspace { BotTeamEditor(store: store, workspace: workspace) } }
        .sheet(isPresented: $creatingBot) { BotProfileEditor(store: store) }
        .toolbar {
            if store.isPaired, store.botCatalog?.lifecycleSupported == true {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { creatingBot = true } label: { Label("Create bot", systemImage: "plus") }
                        .disabled(store.savingBotProfile || store.status?.hostConnected != true).accessibilityIdentifier("createBotButton")
                }
            }
        }
        .task(id: store.pairingGeneration) {
            if workspaceGeneration != store.pairingGeneration || workspace == nil {
                creatingTeam = false
                creatingBot = false; botQuery = ""; rosterFilter = .all
                workspace = store.isPaired ? store.botWorkspaceStore() : nil
                workspaceGeneration = store.pairingGeneration
            }
            if store.isPaired { await store.refreshBots(); await workspace?.refreshTeams() }
        }
    }

    private var emptyBots: some View {
        VStack(alignment: .leading, spacing: 13) {
            Image(systemName: "sparkles.rectangle.stack").font(.system(size: 32, weight: .light)).foregroundStyle(StrataTheme.accentText)
            Text(store.botCatalog?.lifecycleSupported == true ? "Create your first bot" : "Your team starts on Mac").font(.title3.weight(.semibold)).foregroundStyle(StrataTheme.ink)
            Text("Create a coding bot, a computer-control bot, or one that can do both. Its conversations will appear here.")
                .font(.subheadline).foregroundStyle(StrataTheme.secondaryInk).lineSpacing(4)
        }.frame(maxWidth: .infinity, alignment: .leading).strataCard(padding: 24)
        .accessibilityIdentifier("botsEmptyState")
    }

    private var rosterControls: some View {
        VStack(spacing: 10) {
            Picker("Show bots", selection: $rosterFilter) {
                ForEach(BotRosterFilter.allCases) { Text($0.rawValue).tag($0) }
            }.pickerStyle(.segmented).accessibilityIdentifier("botRosterFilterPicker")
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(StrataTheme.secondaryInk)
                TextField("Search bots", text: $botQuery).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .focused($searchFocused).submitLabel(.search).onSubmit { searchFocused = false }
                    .accessibilityIdentifier("botRosterSearchInput")
                if !botQuery.isEmpty {
                    Button { botQuery = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(StrataTheme.secondaryInk) }
                        .buttonStyle(.plain).accessibilityLabel("Clear search").frame(width: 44, height: 44)
                }
            }.padding(.horizontal, 16).padding(.vertical, 9).frame(minHeight: 50)
                .background(StrataTheme.grouped, in: Capsule())
        }.padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 10).background(StrataTheme.background)
    }

    private func featuredBot(_ catalog: CompanionBots) -> CompanionBot? {
        if let id = store.currentConversation?.botId, let bot = catalog.bots.first(where: { $0.id == id }) { return bot }
        return catalog.bots.first(where: { store.botIsWorking($0) }) ?? catalog.bots.first
    }

    private func botCard(_ bot: CompanionBot, catalog: CompanionBots) -> some View {
        let conversations = store.botConversations(bot)
        let active = store.botIsWorking(bot)
        return HStack(spacing: 14) {
            KoalaAvatar(bot.face, mood: store.botMood(bot), animated: false).frame(width: 60, height: 60)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(bot.name).font(.body.weight(.semibold)).foregroundStyle(StrataTheme.ink).lineLimit(1)
                    Spacer(minLength: 0)
                    if bot.paused == true { Text("Paused").font(.caption).foregroundStyle(StrataTheme.secondaryInk) }
                    else if active { ProgressView().controlSize(.small) }
                }
                Text(conversations.first?.preview ?? bot.capabilityLabel)
                    .font(.subheadline).foregroundStyle(StrataTheme.secondaryInk).lineLimit(2)
            }
        }.padding(.vertical, 9)
    }

    private func filteredBots(_ catalog: CompanionBots) -> [CompanionBot] {
        let query = botQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        return catalog.bots.filter { bot in
            let matches = query.isEmpty || [bot.name, bot.provider, bot.model].contains { $0.localizedCaseInsensitiveContains(query) }
            let mood = store.botMood(bot)
            let attention = [.needsApproval, .paused, .error].contains(mood)
            return matches && (rosterFilter == .all || rosterFilter == .working && store.botIsWorking(bot) || rosterFilter == .attention && attention)
        }
    }

}

private struct BotDetailView: View {
    @ObservedObject var store: CompanionStore
    let botId: String
    let openChat: () -> Void
    @State private var showingSetup = false
    @State private var showingAvatar = false
    @State private var showingEditor = false
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
                Section("Computers") {
                    LabeledContent("Execution", value: bot.executionLabel)
                        .accessibilityElement(children: .combine).accessibilityIdentifier("botComputerDetail")
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
                                if store.currentConversation?.id == conversation.id { openChat() }
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
            if let bot { BotConversationSetupView(store: store, bot: bot, openChat: openChat) }
        }
        .sheet(isPresented: $showingAvatar) {
            if let bot { BotAvatarEditor(store: store, bot: bot) }
        }
        .sheet(isPresented: $showingEditor) { if let bot { BotProfileEditor(store: store, bot: bot) } }
    }

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

private struct BotConversationSetupView: View {
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
