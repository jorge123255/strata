import SwiftUI

struct BotsView: View {
    @ObservedObject var store: CompanionStore
    let pair: () -> Void
    let openChat: () -> Void
    @State private var destination: BotWorkspaceDestination = .team
    @State private var workspace: BotWorkspaceStore?
    @State private var workspaceGeneration: UUID?
    @State private var creatingTeam = false

    // Adapted from Cua Bots iOS PhoneViews.swift (FSL-1.1-MIT,
    // Copyright (c) 2026 Cua AI, Inc.). Uses Strata's existing paired store.
    var body: some View {
        Group {
          if store.isPaired, let workspace, destination != .team {
            BotWorkspaceDestinationView(destination: destination, store: store, workspace: workspace, openChat: openChat)
          } else { List {
            if !store.isPaired {
                ConnectionNeededView(icon: "sparkles.rectangle.stack", title: "Meet your bots", message: "Pair your Mac to open your bots and their shared conversations.", pair: pair)
            } else {
                if let message = store.botsMessage {
                    Section {
                        Label(message, systemImage: "info.circle").font(.subheadline).foregroundStyle(StrataTheme.secondaryInk)
                            .accessibilityIdentifier("botsUnavailable")
                        Button("Check again") { Task { await store.refreshBots() } }.disabled(store.isLoadingBots)
                    }
                }
                if store.isLoadingBots, store.botCatalog == nil { ProgressView("Checking your bots…") }
                if let catalog = store.botCatalog {
                    if let workspace { BotTeamsSection(store: store, workspace: workspace, openChat: openChat, createTeam: { creatingTeam = true }) }
                    Section {
                        if catalog.bots.isEmpty, catalog.reason == nil { emptyBots }
                        ForEach(catalog.bots) { bot in
                            NavigationLink {
                                BotDetailView(store: store, botId: bot.id, openChat: openChat)
                            } label: { botCard(bot, catalog: catalog) }
                            .accessibilityIdentifier("bot-\(bot.id)")
                        }
                    } header: { Text("Your bots") } footer: {
                        Text("Connected through \(store.connection?.macName ?? "your Mac"). Create bots and set up providers and computers in Strata on Mac. Your model connections stay separate.")
                    }
                }
            }
          } }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if store.isPaired {
                Picker("Bots workspace", selection: $destination) {
                    ForEach(BotWorkspaceDestination.allCases) { item in Text(item.rawValue).tag(item) }
                }.pickerStyle(.segmented).padding(.horizontal, 20).padding(.vertical, 10)
                    .background(StrataTheme.background).accessibilityIdentifier("botsWorkspacePicker")
            }
        }
        .scrollContentBackground(.hidden).background(StrataTheme.background)
        .navigationTitle("Bots").toolbar(.visible, for: .navigationBar)
        .refreshable { await store.refresh(silently: true); await store.refreshBots() }
        .sheet(isPresented: $creatingTeam) { if let workspace { BotTeamEditor(store: store, workspace: workspace) } }
        .task(id: store.pairingGeneration) {
            if workspaceGeneration != store.pairingGeneration || workspace == nil {
                creatingTeam = false
                workspace = store.isPaired ? store.botWorkspaceStore() : nil
                workspaceGeneration = store.pairingGeneration
            }
            if store.isPaired { await store.refreshBots(); await workspace?.refreshTeams() }
        }
    }

    private var emptyBots: some View {
        VStack(alignment: .leading, spacing: 13) {
            Image(systemName: "sparkles.rectangle.stack").font(.system(size: 32, weight: .light)).foregroundStyle(StrataTheme.accentText)
            Text("Your team starts on Mac").font(.system(.title3, design: .rounded, weight: .semibold)).foregroundStyle(StrataTheme.ink)
            Text("Create a coding bot, a computer-control bot, or one that can do both. Its conversations will appear here.")
                .font(.subheadline).foregroundStyle(StrataTheme.secondaryInk).lineSpacing(4)
        }.frame(maxWidth: .infinity, alignment: .leading).strataCard(padding: 24)
        .accessibilityIdentifier("botsEmptyState")
    }

    private func botCard(_ bot: CompanionBot, catalog: CompanionBots) -> some View {
        let conversations = store.botConversations(bot)
        let active = conversations.contains { $0.active }
        return HStack(spacing: 12) {
            KoalaAvatar(bot.face, mood: active ? .working : .idle).frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(bot.name).font(.headline).foregroundStyle(StrataTheme.ink)
                Text(conversations.first?.preview ?? bot.capabilityLabel)
                    .font(.subheadline).foregroundStyle(StrataTheme.secondaryInk).lineLimit(1)
            }
            Spacer()
            if bot.paused == true { Image(systemName: "pause.circle").foregroundStyle(.secondary).accessibilityLabel("Paused") }
            else if active { ProgressView().controlSize(.small) }
            else if catalog.providers.first(where: { $0.id == bot.provider })?.available == false {
                Image(systemName: "exclamationmark.circle").foregroundStyle(StrataTheme.warning)
            }
        }.padding(.vertical, 4)
    }

}

private struct BotDetailView: View {
    @ObservedObject var store: CompanionStore
    let botId: String
    let openChat: () -> Void
    @State private var showingSetup = false
    @State private var showingAvatar = false
    private var bot: CompanionBot? { store.botCatalog?.bots.first { $0.id == botId } }

    // Profile sections follow the actual Cua Bots PhoneProfile layout while
    // every action uses the existing Strata companion catalog and history.
    var body: some View {
        List {
            if let bot {
                Section {
                    VStack(spacing: 6) {
                        Button { showingAvatar = true } label: { AvatarBadge(bot.face, size: 96, editable: true) }
                            .buttonStyle(.plain).accessibilityLabel("Customize avatar").accessibilityIdentifier("customizeBotAvatarButton")
                        Text(bot.name).font(.title2.weight(.semibold))
                        Text(bot.capabilityLabel).font(.subheadline).foregroundStyle(.secondary)
                        if bot.paused == true { Label("Paused", systemImage: "pause.circle").font(.subheadline).foregroundStyle(.secondary) }
                    }.frame(maxWidth: .infinity).listRowBackground(Color.clear)
                }
                Section("Computers") {
                    if bot.computerMode == "cua" {
                        NavigationLink {
                            BotComputerView(store: store, botId: bot.id, name: bot.name)
                        } label: { LabeledContent("Isolated computer", value: "Open view") }
                            .accessibilityIdentifier("botComputerViewButton")
                    }
                    LabeledContent("Execution", value: bot.executionLabel)
                        .accessibilityElement(children: .combine).accessibilityIdentifier("botComputerDetail")
                }
                Section("Provider") { botDetails(bot) }
                Section("Conversations") {
                    Button { showingSetup = true } label: {
                        HStack(spacing: 9) {
                            if store.creatingBotConversationId == bot.id { ProgressView() }
                            Label("New conversation", systemImage: "square.and.pencil")
                        }
                    }
                    .disabled(bot.paused == true || store.creatingBotConversationId != nil || store.isSending || store.isSubmittingMessage || store.status?.hostConnected != true)
                    .accessibilityIdentifier("newBotConversationButton")
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
        .scrollContentBackground(.hidden).background(StrataTheme.background)
        .navigationTitle(bot?.name ?? "Bot").navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .refreshable { await store.refresh(silently: true); await store.refreshBots() }
        .sheet(isPresented: $showingSetup) {
            if let bot { BotConversationSetupView(store: store, bot: bot, openChat: openChat) }
        }
        .sheet(isPresented: $showingAvatar) {
            if let bot { BotAvatarEditor(store: store, bot: bot) }
        }
    }

    private func botDetails(_ bot: CompanionBot) -> some View {
        let provider = store.botCatalog?.providers.first { $0.id == bot.provider }
        return VStack(alignment: .leading, spacing: 15) {
            LabeledContent("Provider", value: provider?.name ?? bot.provider.capitalized)
                .accessibilityElement(children: .combine).accessibilityIdentifier("botProviderDetail")
            LabeledContent("Model", value: bot.model.isEmpty ? "Provider default" : bot.model)
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
                    AvatarBadge(avatar, size: 120)
                    AvatarPicker(avatar: $avatar, name: bot.name)
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
    var body: some View {
        KoalaAvatar(config ?? .default(for: name)).frame(width: size, height: size)
            .accessibilityLabel("Bot avatar").accessibilityIdentifier("botAvatar")
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
    @FocusState private var workspaceFocused: Bool

    init(store: CompanionStore, bot: CompanionBot, openChat: @escaping () -> Void) {
        self.store = store; self.initialBot = bot; self.openChat = openChat
        _workspace = State(initialValue: bot.computerMode == "cua" ? "/workspace" : bot.workspace ?? "")
        _modelId = State(initialValue: bot.modelId ?? "")
    }

    private var bot: CompanionBot { store.botCatalog?.bots.first { $0.id == initialBot.id } ?? initialBot }
    private var supportsSelection: Bool { store.botCatalog?.selectionSupported == true }
    private var chosenComputer: BotComputer? { store.botCatalog?.computers.first { $0.id == computerId } }
    private var chosenModel: BotConfiguredModel? { store.botCatalog?.models?.first { $0.id == modelId } }
    private var isBusy: Bool { store.creatingBotConversationId != nil }
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
                            Text(bot.name).font(.headline)
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
                        if modelId.isEmpty, !supportedEfforts.isEmpty {
                            Picker("Effort", selection: $effortSelection) {
                                Text("Bot default").tag("__profile")
                                Text("Provider default").tag("")
                                ForEach(supportedEfforts, id: \.self) { level in Text(level.capitalized).tag(level) }
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
                    LabeledContent("Permissions", value: bot.policyLabel)
                    Text("Existing conversations keep their original settings. Work starts when you send a message.")
                        .font(.caption).foregroundStyle(StrataTheme.secondaryInk)
                    if let message {
                        Label(message, systemImage: "exclamationmark.circle").font(.subheadline).foregroundStyle(StrataTheme.warning)
                            .accessibilityIdentifier("botConversationSetupError")
                    }
                    Button {
                        workspaceFocused = false
                        Task {
                            message = nil
                            let folder = bot.computerMode == "cua" ? "/workspace" : (supportsSelection && workspace != bot.workspace ? workspace : nil)
                            if await store.newBotConversation(bot, computerId: computerId.isEmpty ? nil : computerId,
                                                              modelId: modelId.isEmpty ? nil : modelId, workspace: folder,
                                                              effort: effortOverride) {
                                dismiss(); openChat()
                            } else { message = store.error ?? "This conversation could not be created. Refresh Bots and try again."; store.error = nil }
                        }
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
            .scrollContentBackground(.hidden).background(StrataTheme.background)
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
            .interactiveDismissDisabled(isBusy)
        }
        .tint(StrataTheme.accentText)
        .task(id: bot.provider + ":" + bot.model) { supportedEfforts = await store.supportedBotEfforts(bot) }
    }
}
