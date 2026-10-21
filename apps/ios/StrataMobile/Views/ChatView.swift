import SwiftUI

struct ChatView: View {
    @ObservedObject var store: CompanionStore
    let pair: () -> Void
    @State private var draft = ""
    @State private var showingHistory = false
    @State private var historyQuery = ""
    @State private var followsLatest = true
    @State private var nearBottom = true
    @State private var userScrolling = false
    @State private var setupBot: CompanionBot?
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            if !store.isPaired {
                ScrollView {
                    ConnectionNeededView(icon: "bubble.left.and.bubble.right", title: "An idea starts here", message: "Pair your Mac to pick up your Strata conversations and follow its work.", pair: pair)
                        .padding(.horizontal, 24).padding(.top, 24)
                }
            } else {
                if let conversation = store.currentConversation { contextBar(conversation) }
                conversation
                composer
            }
        }
        .background(StrataTheme.background)
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showingHistory) { history }
        .sheet(item: $setupBot) { bot in BotConversationSetupView(store: store, bot: bot, openChat: {}) }
        .onAppear { if let id = store.currentConversation?.id { store.notifications.focus(CompanionNotificationDestination(type: "chat", id: id)) } }
        .onDisappear { if store.notifications.focusedDestination?.type == "chat" { store.notifications.focus(nil) } }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Chat").font(.title2.weight(.bold)).tracking(-0.5).foregroundStyle(StrataTheme.ink)
                Text(chatSubtitle).font(.caption).foregroundStyle(StrataTheme.secondaryInk).lineLimit(1)
            }
            Spacer(minLength: 12)
            if store.isPaired {
                if let bot = conversationBot {
                    NavigationLink { BotDetailView(store: store, botId: bot.id, openChat: {}) } label: {
                        Image(systemName: "info.circle").font(.system(size: 19)).frame(width: 40, height: 44)
                    }.accessibilityLabel(bot.name + " profile and settings").accessibilityIdentifier("chatBotProfileButton")
                }
                if let id = store.currentConversation?.id {
                    Menu { NotificationMuteButton(notifications: store.notifications, destination: CompanionNotificationDestination(type: "chat", id: id)) } label: {
                        Image(systemName: "ellipsis").frame(width: 38, height: 44)
                    }.accessibilityLabel("Conversation options").accessibilityIdentifier("chatNotificationOptionsButton")
                }
                Button { showingHistory = true; Task { await store.refresh(silently: true) } } label: {
                    Image(systemName: "sidebar.left").font(.system(size: 18, weight: .medium)).frame(width: 44, height: 44).strataChrome()
                }
                .disabled(store.isSending)
                .accessibilityLabel("Conversation history").accessibilityIdentifier("chatHistoryButton")
                Button {
                    composerFocused = false
                    if store.currentConversation?.botId != nil {
                        if let bot = conversationBot { setupBot = bot }
                        else { store.error = "Refresh Bots to start another conversation with this bot." }
                    } else { store.newChat() }
                } label: {
                    Image(systemName: "square.and.pencil").font(.system(size: 18, weight: .medium)).frame(width: 44, height: 44).strataChrome()
                }
                .disabled(store.isSubmittingMessage || store.isSending || store.openingBotConversationId != nil)
                .accessibilityLabel("New conversation").accessibilityIdentifier("newChatButton")
            }
        }
        .foregroundStyle(StrataTheme.ink)
        .padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 14)
    }

    private func contextBar(_ value: MacConversation) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Group {
                if value.botId != nil {
                    BotAvatarView(avatar: value.botAvatar ?? "🤖", size: 36, config: value.botAvatarConfig ?? conversationBot?.avatarConfig,
                                  name: conversationBotName ?? "Bot", mood: store.currentBotMood, animated: true, interactive: true,
                                  flourishToken: BotAvatarState.flourish(conversation: value))
                } else { Image(systemName: "desktopcomputer").font(.subheadline).frame(width: 32, height: 32).background(StrataTheme.grouped, in: RoundedRectangle(cornerRadius: 10)) }
            }.foregroundStyle(StrataTheme.ink)
            VStack(alignment: .leading, spacing: 3) {
                Text(value.title).font(.subheadline.weight(.semibold)).foregroundStyle(StrataTheme.ink).lineLimit(2)
                    .accessibilityIdentifier("macConversationTitle")
                Text([conversationBotName, value.permissionLabel, value.computerName,
                      value.workspace.map { URL(fileURLWithPath: $0).lastPathComponent }].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption2).foregroundStyle(StrataTheme.secondaryInk).lineLimit(2)
            }
            Spacer(minLength: 5)
            if value.computerMode == "cua", let botId = value.botId {
                NavigationLink {
                    BotComputerView(store: store, botId: botId, chatId: value.id, name: value.botName ?? "Bot computer")
                } label: { Image(systemName: "display").frame(width: 36, height: 36) }
                    .accessibilityLabel("Computer view").accessibilityIdentifier("chatComputerViewButton")
            }
            if value.active {
                StrataStatusPill(title: "Live", icon: "circle.fill", tone: .success)
                    .accessibilityElement(children: .combine).accessibilityIdentifier("macConversationLiveBadge")
            }
        }
        .padding(14)
        .background(StrataTheme.surfaceSecondary, in: RoundedRectangle(cornerRadius: 18))
        .padding(.horizontal, 16).padding(.bottom, 8)
    }

    private var visibleMessages: [MacChatMessage] {
        if let current = store.currentConversation { return current.messages }
        return store.messages.map { MacChatMessage(id: $0.id, role: $0.role, content: $0.content) }
    }

    private var conversation: some View {
        ScrollViewReader { proxy in
            observeConversationScroll(conversationScroll)
                .scrollDismissesKeyboard(.interactively)
                .refreshable { await store.refreshCurrentConversation() }
                .overlay(alignment: .bottomTrailing) {
                    if showsLatestButton {
                        Button { followsLatest = true; scrollToBottom(proxy) } label: {
                            Label("Latest", systemImage: "arrow.down").font(.caption.weight(.semibold))
                                .padding(.horizontal, 13).padding(.vertical, 9)
                                .foregroundStyle(StrataTheme.primaryInk).background(StrataTheme.primaryFill, in: Capsule())
                        }
                        .padding(14).accessibilityIdentifier("followLatestMessagesButton")
                    }
                }
                .onChange(of: store.currentConversation?.id) { _, _ in
                    followsLatest = true; scrollToBottom(proxy)
                }
                .onChange(of: store.currentChatId) { _, _ in
                    followsLatest = true; scrollToBottom(proxy)
                }
                .onChange(of: store.isSubmittingMessage) { old, new in
                    if old, !new, followsLatest { scrollToBottom(proxy) }
                }
        }
    }

    private var conversationScroll: some View {
        ScrollView {
            if store.isSelectingConversation {
                ProgressView("Opening Mac conversation…").padding(.top, 40)
            } else if visibleMessages.isEmpty {
                chatWelcome
            } else {
                VStack(alignment: .leading, spacing: 23) {
                    ForEach(visibleMessages) { message in messageView(message).id(message.id) }
                    ForEach(additionalPendingApprovals) { tool in activity(tool) }
                    if store.isWorking { workingIndicator }
                    Color.clear.frame(height: 1).id("conversationBottom")
                }
                .padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 22)
            }
        }
    }

    @ViewBuilder private func observeConversationScroll<Content: View>(_ content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                // Native anchoring handles text and tool-card height changes
                // without re-entering lazy layout through proxy.scrollTo.
                .defaultScrollAnchor(followsLatest ? .bottom : nil, for: .sizeChanges)
                .onScrollGeometryChange(for: Bool.self, of: { geometry in
                    geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 70
                }, action: { _, newValue in
                    nearBottom = newValue
                    if userScrolling { followsLatest = newValue }
                    else if newValue { followsLatest = true }
                })
                .onScrollPhaseChange { _, newPhase, context in
                    let isUserPhase = newPhase == .tracking || newPhase == .interacting || newPhase == .decelerating
                    if isUserPhase || userScrolling {
                        followsLatest = context.geometry.contentOffset.y + context.geometry.containerSize.height >= context.geometry.contentSize.height - 70
                    }
                    userScrolling = isUserPhase
                }
        } else {
            // iOS 17 keeps native scrolling and offers an explicit Latest action.
            // Live updates never pull an older-history reader back to the bottom.
            content
        }
    }

    private var showsLatestButton: Bool {
        if #available(iOS 18.0, *) { return !followsLatest }
        return !visibleMessages.isEmpty
    }

    private var additionalPendingApprovals: [MacToolActivity] {
        let shown = Set(visibleMessages.flatMap { ($0.tools ?? []).map(\.id) })
        return store.pendingApprovals.filter { !shown.contains($0.id) }
    }

    private var workingIndicator: some View {
        HStack(spacing: 9) {
            ProgressView().controlSize(.small).tint(StrataTheme.accentText)
            Text(liveStatus).font(.caption).foregroundStyle(StrataTheme.secondaryInk)
        }
        .accessibilityIdentifier("chatThinkingIndicator")
    }

    private var liveStatus: String {
        if !store.pendingApprovals.isEmpty { return "Waiting for your approval" }
        if let tool = store.currentConversation?.messages.flatMap({ $0.tools ?? [] }).last(where: \.isRunning) {
            return tool.isBrowser ? (store.currentConversation?.botId == nil ? "Using the browser on your Mac…" : "Using the browser…") : tool.title + "…"
        }
        return store.currentConversation?.status?.isEmpty == false ? store.currentConversation!.status! : store.currentConversation?.botId == nil ? "Your Mac is working…" : "Your bot is working…"
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        // Explicit navigation jumps after the content has a deterministic height.
        // Animating a lazy footer lookup can repeatedly re-enter layout.
        proxy.scrollTo("conversationBottom", anchor: .bottom)
    }

    private var chatWelcome: some View {
        VStack(alignment: .leading, spacing: 26) {
            StrataMark(size: 52).padding(.bottom, 5)
            Text("Pick up where\nyou left off.")
                .font(.largeTitle.weight(.bold)).tracking(-0.8).foregroundStyle(StrataTheme.ink)
            Text("Open a Mac conversation to see its history, continue the work, and follow browser and tool activity as it happens.")
                .font(.subheadline).foregroundStyle(StrataTheme.secondaryInk).lineSpacing(4)
            if !store.conversations.isEmpty {
                Button { showingHistory = true } label: { Label("Open Mac conversations", systemImage: "desktopcomputer") }
                    .buttonStyle(StrataPrimaryButtonStyle())
                    .accessibilityIdentifier("openMacConversationsButton")
            }
            Text("Or send a message below to start a new conversation on your Mac.")
                .font(.caption).foregroundStyle(StrataTheme.secondaryInk)
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 24).padding(.top, 34).padding(.bottom, 26)
    }

    private func messageView(_ message: MacChatMessage) -> some View {
        let isUser = message.role == "user"
        return HStack(alignment: .top, spacing: 0) {
            if isUser { Spacer(minLength: 34) }
            VStack(alignment: .leading, spacing: 12) {
                if !isUser {
                    HStack(spacing: 6) {
                        if store.currentConversation?.botId != nil {
                            BotAvatarView(avatar: store.currentConversation?.botAvatar ?? "🤖", size: 22,
                                          config: store.currentConversation?.botAvatarConfig ?? conversationBot?.avatarConfig,
                                          name: conversationBotName ?? "Bot")
                        } else { StrataMark(size: 22) }
                        Text(conversationBotName ?? "Strata").font(.caption.weight(.semibold)).foregroundStyle(StrataTheme.secondaryInk)
                    }
                }
                if message.role == "assistant", message.thinkingText != nil {
                    MacThinkingView(message: message, isLive: isLiveMessage(message) && message.isThinkingInProgress)
                }
                ForEach(message.timelineItems) { item in
                    switch item {
                    case .text(_, let text):
                        messageText(text, isUser: isUser)
                    case .group(let group, let tools):
                        MacActivityGroupView(group: group, tools: tools,
                            isLive: isLiveMessage(message),
                            pendingToolIds: Set(store.pendingApprovals.map(\.id)),
                            activity: { tool in activity(tool) })
                    case .tool(let tool):
                        activity(tool)
                    }
                }
                if let error = message.error, !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(StrataTheme.warning)
                }
            }
            if !isUser { Spacer(minLength: 0) }
        }
    }

    private func isLiveMessage(_ message: MacChatMessage) -> Bool {
        message.streaming == true && store.currentConversation?.active == true
    }

    private func messageText(_ text: String, isUser: Bool) -> some View {
        // Timeline paragraph boundaries may contain separator newlines. Keep
        // internal Markdown and indentation, without empty space in a bubble.
        let displayed = isUser ? text : text.trimmingCharacters(in: .newlines)
        return Text(.init(displayed)).font(.body).foregroundStyle(isUser ? StrataTheme.userBubbleInk : StrataTheme.ink).lineSpacing(4).textSelection(.enabled)
            .tint(isUser ? StrataTheme.userBubbleInk : StrataTheme.accentText)
            .padding(15).frame(maxWidth: .infinity, alignment: .leading)
            .background(isUser ? StrataTheme.userBubble : StrataTheme.assistantBubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .accessibilityIdentifier(isUser ? "userMessage" : "assistantMessage")
    }

    private func activity(_ tool: MacToolActivity) -> some View {
        MacActivityCard(tool: tool,
                        awaitingApproval: store.pendingApprovals.contains(where: { $0.id == tool.id }),
                        deciding: store.decidingToolId != nil,
                        decide: { approve in Task { await store.decideApproval(tool, approve: approve) } })
    }

    private var composer: some View {
        VStack(spacing: 8) {
            HStack(alignment: .bottom, spacing: 10) {
                TextField(conversationBotName.map { "Message " + $0 + "…" } ?? "Message your Mac…", text: $draft, axis: .vertical)
                    .lineLimit(1...6).font(.body).foregroundStyle(StrataTheme.ink).focused($composerFocused)
                    .padding(.vertical, 12).padding(.leading, 16).accessibilityIdentifier("messageInput")
                if store.isWorking {
                    Button { Task { await store.cancelMessage() } } label: {
                        Image(systemName: "stop.fill").font(.system(size: 13, weight: .bold)).foregroundStyle(StrataTheme.primaryInk)
                            .frame(width: 44, height: 44).background(StrataTheme.primaryFill, in: Circle())
                    }
                    .padding(6).disabled(store.isSubmittingMessage)
                    .accessibilityLabel("Stop response").accessibilityIdentifier("stopMessageButton")
                } else {
                    Button(action: send) {
                        Group {
                            if store.isSubmittingMessage { ProgressView().controlSize(.small) }
                            else { Image(systemName: "arrow.up").font(.system(size: 18, weight: .semibold)) }
                        }
                        .foregroundStyle(canSend ? StrataTheme.primaryInk : StrataTheme.secondaryInk)
                        .frame(width: 44, height: 44).background(canSend ? StrataTheme.primaryFill : StrataTheme.grouped, in: Circle())
                    }
                    .padding(6).disabled(!canSend).accessibilityLabel("Send message").accessibilityIdentifier("sendMessageButton")
                }
            }
            .strataChrome(radius: 26)
            Text(composerNote).font(.caption2).foregroundStyle(StrataTheme.secondaryInk).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 8).background(StrataTheme.background)
    }

    private var canSend: Bool {
        conversationBot?.paused != true && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && store.isPaired &&
        store.status?.hostConnected == true && !store.isWorking && !store.isSubmittingMessage && !store.isSelectingConversation
    }
    private var composerNote: String {
        if conversationBot?.paused == true { return "This bot is paused. Resume it in Strata on your Mac." }
        if store.status?.hostConnected != true { return "Your Mac is unavailable. Check Connection to reconnect." }
        if store.currentConversation?.botId != nil { return "Same bot conversation · updates live while this screen is open" }
        return store.isLegacyConversation ? "Earlier iPhone conversation · saved on your Mac" : "Same Mac conversation · updates live while this screen is open"
    }
    private var chatSubtitle: String {
        guard store.isPaired else { return "Your Mac’s conversations, within reach." }
        guard store.status?.hostConnected == true else { return "Mac unavailable · check Connection" }
        return store.currentConversation?.botModelName ?? store.currentConversation?.modelName ?? store.status?.modelName ?? "Connected to your Mac"
    }
    private var conversationBot: CompanionBot? {
        guard let botId = store.currentConversation?.botId else { return nil }
        return store.botCatalog?.bots.first { $0.id == botId }
    }
    private var conversationBotName: String? { store.currentConversation?.botName ?? conversationBot?.name }
    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
        draft = ""; composerFocused = false; followsLatest = true
        Task {
            await store.sendMessage(text)
            if store.error != nil, draft.isEmpty { draft = text }
        }
    }

    private var filteredConversations: [MacConversationSummary] {
        store.conversations.filter { historyQuery.isEmpty || $0.title.localizedCaseInsensitiveContains(historyQuery) || ($0.workspace?.localizedCaseInsensitiveContains(historyQuery) == true) }
    }
    private var filteredLegacyChats: [CompanionChat] {
        store.chats.filter { historyQuery.isEmpty || $0.title.localizedCaseInsensitiveContains(historyQuery) }
    }
    private var history: some View {
        NavigationStack {
            List {
                Section("On your Mac") {
                    if filteredConversations.isEmpty {
                        Text(historyQuery.isEmpty ? "Mac conversations will appear here." : "No matching conversations.")
                            .font(.subheadline).foregroundStyle(StrataTheme.secondaryInk)
                    }
                    ForEach(filteredConversations) { chat in
                        Button {
                            showingHistory = false
                            Task { await store.selectConversation(chat) }
                        } label: {
                            HStack(spacing: 13) {
                                Image(systemName: chat.active ? "circle.fill" : "bubble.left").font(chat.active ? .caption2 : .body)
                                    .foregroundStyle(StrataTheme.accentText).frame(width: 20)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(chat.title).foregroundStyle(StrataTheme.ink).lineLimit(2)
                                    Text([chat.active ? "Working now" : nil, chat.workspaceName].compactMap { $0 }.joined(separator: " · "))
                                        .font(.caption).foregroundStyle(chat.active ? StrataTheme.accentText : StrataTheme.secondaryInk)
                                }
                                Spacer(minLength: 0)
                                if store.currentConversation?.id == chat.id { Image(systemName: "checkmark").foregroundStyle(StrataTheme.accentText) }
                            }
                            .padding(.vertical, 6)
                        }
                        .accessibilityIdentifier("macConversation-" + chat.id)
                    }
                }
                if !filteredLegacyChats.isEmpty {
                    Section("Earlier iPhone conversations") {
                        ForEach(filteredLegacyChats) { chat in
                            Button {
                                showingHistory = false
                                Task { await store.selectChat(chat) }
                            } label: {
                                Label(chat.title, systemImage: "iphone").foregroundStyle(StrataTheme.ink).lineLimit(2).padding(.vertical, 6)
                            }
                        }
                    }
                }
            }
            .refreshable { await store.refresh(silently: true) }
            .searchable(text: $historyQuery, prompt: "Search conversations")
            .strataList()
            .navigationTitle("Conversations").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { showingHistory = false } } }
        }
        .tint(StrataTheme.accentText)
    }
}
