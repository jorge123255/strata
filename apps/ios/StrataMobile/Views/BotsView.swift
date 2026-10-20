import SwiftUI

struct BotsView: View {
    @ObservedObject var store: CompanionStore
    let pair: () -> Void
    let openChat: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeading(eyebrow: "Your team, within reach", title: "Bots", subtitle: "Code, use a computer, and pick up the same work on your Mac.")
                if !store.isPaired {
                    ConnectionNeededView(icon: "sparkles.rectangle.stack", title: "Meet your bots", message: "Pair your Mac to open your bots and their shared conversations.", pair: pair)
                } else {
                    if let message = store.botsMessage {
                        VStack(alignment: .leading, spacing: 12) {
                            Label(message, systemImage: "info.circle").font(.subheadline).foregroundStyle(StrataTheme.secondaryInk)
                                .accessibilityIdentifier("botsUnavailable")
                            Button("Check again") { Task { await store.refreshBots() } }
                                .font(.subheadline.weight(.semibold)).foregroundStyle(StrataTheme.accentText)
                                .disabled(store.isLoadingBots)
                        }.strataCard()
                    }
                    if store.isLoadingBots, store.botCatalog == nil {
                        ProgressView("Checking your bots…").tint(StrataTheme.accentText)
                    } else if let catalog = store.botCatalog {
                        if catalog.bots.isEmpty, catalog.reason == nil { emptyBots }
                        ForEach(catalog.bots) { bot in
                            NavigationLink {
                                BotDetailView(store: store, botId: bot.id, openChat: openChat)
                            } label: { botCard(bot, catalog: catalog) }
                            .buttonStyle(.plain).accessibilityIdentifier("bot-\(bot.id)")
                        }
                    }
                    Text("Set up bots, provider sign-ins, and computer access in Strata on your Mac. Your existing model connections stay separate.")
                        .font(.caption).foregroundStyle(StrataTheme.secondaryInk).lineSpacing(3)
                }
            }
            .padding(.horizontal, 24).padding(.top, 27).padding(.bottom, 30)
        }
        .background(StrataTheme.background)
        .toolbar(.hidden, for: .navigationBar)
        .refreshable { await store.refresh(silently: true); await store.refreshBots() }
        .task(id: store.isPaired) { if store.isPaired { await store.refreshBots() } }
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
        let provider = catalog.providers.first { $0.id == bot.provider }
        return HStack(alignment: .top, spacing: 14) {
            Image(systemName: bot.capabilityIcon).font(.system(size: 23, weight: .light))
                .foregroundStyle(StrataTheme.accentText).frame(width: 46, height: 46)
                .background(StrataTheme.accentTint, in: RoundedRectangle(cornerRadius: 13))
            VStack(alignment: .leading, spacing: 7) {
                Text(bot.name).font(.system(.headline, design: .rounded)).foregroundStyle(StrataTheme.ink)
                Text((provider?.name ?? bot.provider.capitalized) + " · " + bot.capabilityLabel)
                    .font(.caption).foregroundStyle(StrataTheme.secondaryInk)
                Label(bot.executionLabel, systemImage: "desktopcomputer").font(.caption).foregroundStyle(StrataTheme.secondaryInk)
                if provider?.available == false {
                    Label("Needs attention on Mac", systemImage: "exclamationmark.circle")
                        .font(.caption).foregroundStyle(StrataTheme.warning)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(StrataTheme.secondaryInk).padding(.top, 5)
        }.strataCard()
    }
}

private struct BotDetailView: View {
    @ObservedObject var store: CompanionStore
    let botId: String
    let openChat: () -> Void
    private var bot: CompanionBot? { store.botCatalog?.bots.first { $0.id == botId } }

    var body: some View {
        ScrollView {
            if let bot {
                VStack(alignment: .leading, spacing: 24) {
                    botDetails(bot)
                    Button {
                        Task { if await store.newBotConversation(bot) { openChat() } }
                    } label: {
                        HStack(spacing: 9) {
                            if store.creatingBotConversationId == bot.id { ProgressView().tint(StrataTheme.accentInk) }
                            Label("New conversation", systemImage: "square.and.pencil")
                        }
                    }
                    .buttonStyle(StrataPrimaryButtonStyle())
                    .disabled(store.creatingBotConversationId != nil || store.isSending || store.isSubmittingMessage || store.status?.hostConnected != true)
                    .accessibilityIdentifier("newBotConversationButton")
                    VStack(alignment: .leading, spacing: 14) {
                        Text("Conversations").font(.system(.title2, design: .rounded, weight: .bold)).foregroundStyle(StrataTheme.ink)
                        let conversations = store.botConversations(bot)
                        if conversations.isEmpty {
                            Text("Start a conversation to give this bot work. Opening this screen doesn’t start a task.")
                                .font(.subheadline).foregroundStyle(StrataTheme.secondaryInk).lineSpacing(4)
                        }
                        ForEach(conversations) { conversation in
                            Button {
                                Task {
                                    await store.selectConversation(conversation)
                                    if store.currentConversation?.id == conversation.id { openChat() }
                                }
                            } label: {
                                HStack(alignment: .top, spacing: 12) {
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(conversation.title).font(.subheadline.weight(.semibold)).foregroundStyle(StrataTheme.ink)
                                        if let preview = conversation.preview, !preview.isEmpty {
                                            Text(preview).font(.caption).foregroundStyle(StrataTheme.secondaryInk).lineLimit(2)
                                        }
                                    }
                                    Spacer(minLength: 0)
                                    Image(systemName: conversation.active ? "circle.fill" : "chevron.right")
                                        .font(.caption2).foregroundStyle(conversation.active ? StrataTheme.accentText : StrataTheme.secondaryInk)
                                }.frame(maxWidth: .infinity, alignment: .leading).strataCard()
                            }
                            .buttonStyle(.plain).disabled(store.isSubmittingMessage || store.isSending || store.creatingBotConversationId != nil)
                            .accessibilityIdentifier("botConversation-\(conversation.id)")
                        }
                    }
                }.padding(24)
            } else {
                Text("This bot is no longer available. Check Strata on your Mac.")
                    .foregroundStyle(StrataTheme.secondaryInk).padding(24)
            }
        }
        .background(StrataTheme.background)
        .navigationTitle(bot?.name ?? "Bot").navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .refreshable { await store.refresh(silently: true); await store.refreshBots() }
    }

    private func botDetails(_ bot: CompanionBot) -> some View {
        let provider = store.botCatalog?.providers.first { $0.id == bot.provider }
        return VStack(alignment: .leading, spacing: 15) {
            Label(bot.capabilityLabel, systemImage: bot.capabilityIcon)
                .font(.system(.title3, design: .rounded, weight: .semibold)).foregroundStyle(StrataTheme.ink)
            LabeledContent("Provider", value: provider?.name ?? bot.provider.capitalized)
                .accessibilityElement(children: .combine).accessibilityIdentifier("botProviderDetail")
            LabeledContent("Model", value: bot.model.isEmpty ? "Provider default" : bot.model)
            LabeledContent("Computer", value: bot.executionLabel)
                .accessibilityElement(children: .combine).accessibilityIdentifier("botComputerDetail")
            LabeledContent("Permissions", value: bot.policyLabel)
                .accessibilityElement(children: .combine).accessibilityIdentifier("botPermissionsDetail")
            if let provider, !provider.detail.isEmpty {
                Label(provider.detail, systemImage: provider.available ? "checkmark.circle" : "exclamationmark.circle")
                    .font(.caption).foregroundStyle(provider.available ? StrataTheme.secondaryInk : StrataTheme.warning)
            }
        }
        .font(.subheadline).foregroundStyle(StrataTheme.secondaryInk).strataCard()
    }
}
