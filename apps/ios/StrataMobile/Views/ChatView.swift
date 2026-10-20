import SwiftUI

struct ChatView: View {
    @ObservedObject var store: CompanionStore
    let pair: () -> Void
    @State private var draft = ""
    @State private var showingHistory = false
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            if !store.isPaired {
                ScrollView {
                    ConnectionNeededView(icon: "bubble.left.and.bubble.right", title: "An idea starts here", message: "Pair your Mac and bring your Strata models into the conversation.", pair: pair)
                        .padding(.horizontal, 24)
                        .padding(.top, 24)
                }
            } else {
                conversation
                composer
            }
        }
        .background(StrataTheme.background)
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showingHistory) { history }
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Chat")
                    .font(.system(.largeTitle, design: .rounded, weight: .bold))
                    .tracking(-1.3)
                    .foregroundStyle(StrataTheme.ink)
                Text(chatSubtitle)
                    .font(.caption)
                    .foregroundStyle(StrataTheme.secondaryInk)
                    .lineLimit(1)
            }
            Spacer(minLength: 12)
            if store.isPaired {
                Button { showingHistory = true } label: {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 19, weight: .regular))
                        .frame(width: 40, height: 44)
                }
                .accessibilityLabel("Conversation history")
                .accessibilityIdentifier("chatHistoryButton")
                Button {
                    store.newChat()
                    composerFocused = false
                } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 20, weight: .regular))
                        .frame(width: 40, height: 44)
                }
                .disabled(store.isSending)
                .accessibilityLabel("New conversation")
                .accessibilityIdentifier("newChatButton")
            }
        }
        .foregroundStyle(StrataTheme.ink)
        .padding(.horizontal, 24)
        .padding(.top, 27)
        .padding(.bottom, 20)
    }

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if store.messages.isEmpty {
                    chatWelcome
                } else {
                    LazyVStack(alignment: .leading, spacing: 23) {
                        ForEach(store.messages) { message in
                            messageView(message).id(message.id)
                        }
                        if store.isSending {
                            HStack(spacing: 9) {
                                ProgressView().controlSize(.small).tint(StrataTheme.accentText)
                                Text("Your model is thinking…")
                                    .font(.caption)
                                    .foregroundStyle(StrataTheme.secondaryInk)
                            }
                            .accessibilityIdentifier("chatThinkingIndicator")
                        }
                        Color.clear.frame(height: 1).id("conversationBottom")
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 16)
                    .padding(.bottom, 22)
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: store.messages.last?.content) { _, _ in
                withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo("conversationBottom", anchor: .bottom) }
            }
            .onChange(of: store.isSending) { _, _ in
                withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo("conversationBottom", anchor: .bottom) }
            }
        }
    }

    private var chatWelcome: some View {
        VStack(alignment: .leading, spacing: 26) {
            VStack(alignment: .leading, spacing: 14) {
                StrataMark(size: 52)
                    .padding(.bottom, 5)
                Text("What’s on\nyour mind?")
                    .font(.system(.largeTitle, design: .rounded, weight: .bold))
                    .tracking(-1)
                    .foregroundStyle(StrataTheme.ink)
                Text("A fresh conversation.\nConnected through your Mac.")
                    .font(.subheadline)
                    .foregroundStyle(StrataTheme.secondaryInk)
                    .lineSpacing(4)
            }
            .padding(.top, 34)
            VStack(spacing: 11) {
                prompt("Explain something simply", icon: "lightbulb")
                prompt("Help me find the right words", icon: "pencil.line")
                prompt("Turn an idea into a plan", icon: "list.bullet.rectangle")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 24)
        .padding(.bottom, 26)
    }

    private func prompt(_ text: String, icon: String) -> some View {
        Button {
            draft = text + ": "
            composerFocused = true
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon).foregroundStyle(StrataTheme.accentText).frame(width: 22)
                Text(text).foregroundStyle(StrataTheme.ink).font(.subheadline)
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.left").foregroundStyle(StrataTheme.secondaryInk).font(.caption)
            }
            .padding(16)
            .background(StrataTheme.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(StrataTheme.line.opacity(0.7), lineWidth: 0.7))
        }
        .buttonStyle(.plain)
    }

    private func messageView(_ message: ChatMessage) -> some View {
        let isUser = message.role == "user"
        return HStack(alignment: .top, spacing: 0) {
            if isUser { Spacer(minLength: 34) }
            VStack(alignment: .leading, spacing: 9) {
                if !isUser {
                    HStack(spacing: 6) {
                        StrataMark(size: 22)
                        Text("STRATA").font(.system(.caption2, weight: .bold)).tracking(1.5)
                            .foregroundStyle(StrataTheme.secondaryInk)
                    }
                }
                Text(.init(message.content))
                    .font(.body)
                    .foregroundStyle(StrataTheme.ink)
                    .lineSpacing(5)
                    .textSelection(.enabled)
                    .padding(isUser ? 15 : 0)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(isUser ? StrataTheme.accentTint : .clear, in: RoundedRectangle(cornerRadius: 19))
                    .accessibilityIdentifier(isUser ? "userMessage" : "assistantMessage")
            }
            if !isUser { Spacer(minLength: 8) }
        }
    }

    private var composer: some View {
        VStack(spacing: 9) {
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Message your Mac…", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .font(.body)
                    .foregroundStyle(StrataTheme.ink)
                    .focused($composerFocused)
                    .padding(.vertical, 12)
                    .padding(.leading, 16)
                    .accessibilityIdentifier("messageInput")
                if store.isSending {
                    Button { Task { await store.cancelMessage() } } label: {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(StrataTheme.accentInk)
                            .frame(width: 37, height: 37)
                            .background(StrataTheme.accent, in: Circle())
                    }
                    .padding(6)
                    .accessibilityLabel("Stop response")
                    .accessibilityIdentifier("stopMessageButton")
                } else {
                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(canSend ? StrataTheme.accentInk : StrataTheme.secondaryInk)
                            .frame(width: 37, height: 37)
                            .background(canSend ? StrataTheme.accent : StrataTheme.surfaceSecondary, in: Circle())
                    }
                    .padding(6)
                    .disabled(!canSend)
                    .accessibilityLabel("Send message")
                    .accessibilityIdentifier("sendMessageButton")
                }
            }
            .background(StrataTheme.surface, in: RoundedRectangle(cornerRadius: 25))
            .overlay(RoundedRectangle(cornerRadius: 25).strokeBorder(StrataTheme.line, lineWidth: 1))
            Text(store.status?.hostConnected == true ? "Requests go through your paired Mac." : "Your Mac is unavailable. Check Connection to reconnect.")
                .font(.system(size: 10))
                .foregroundStyle(StrataTheme.secondaryInk)
        }
        .padding(.horizontal, 20)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .background(StrataTheme.background)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        store.isPaired && store.status?.hostConnected == true
    }

    private var chatSubtitle: String {
        guard store.isPaired else { return "A little room to think." }
        guard store.status?.hostConnected == true else { return "Mac unavailable · check Connection" }
        return store.status?.modelName ?? "Choose a model in Models."
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        composerFocused = false
        Task { await store.sendMessage(text) }
    }

    private var history: some View {
        NavigationStack {
            Group {
                if store.chats.isEmpty {
                    ContentUnavailableView("A clean slate", systemImage: "bubble.left.and.bubble.right", description: Text("Your conversations from this iPhone will appear here."))
                } else {
                    List(store.chats) { chat in
                        Button {
                            showingHistory = false
                            Task { await store.selectChat(chat) }
                        } label: {
                            HStack(spacing: 13) {
                                Image(systemName: "bubble.left").foregroundStyle(StrataTheme.accentText)
                                Text(chat.title).foregroundStyle(StrataTheme.ink).lineLimit(2)
                                Spacer()
                                if store.currentChatId == chat.id {
                                    Image(systemName: "checkmark").foregroundStyle(StrataTheme.accentText)
                                }
                            }
                            .padding(.vertical, 6)
                        }
                    }
                    .scrollContentBackground(.hidden)
                }
            }
            .background(StrataTheme.background)
            .navigationTitle("Conversations")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { showingHistory = false } }
            }
        }
        .tint(StrataTheme.accentText)
    }
}
