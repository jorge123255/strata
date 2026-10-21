import SwiftUI

enum CompanionTab: Hashable {
    case overview, chat, bots, models, connection
}

struct ContentView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject private var notifications: CompanionNotifications
    @State private var botPath: [NotificationTeamDestination] = []
    @State private var navigationGeneration = UUID()
    @State private var selection: CompanionTab = .overview
    @State private var showingPairing = false

    init(store: CompanionStore) { self.store = store; _notifications = ObservedObject(wrappedValue: store.notifications) }

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack {
                OverviewView(store: store, pair: { showingPairing = true }, open: { selection = $0 })
            }
            .tabItem { Label("Home", systemImage: "house") }
            .tag(CompanionTab.overview)
            .accessibilityIdentifier("homeTab")

            NavigationStack {
                ChatView(store: store, pair: { showingPairing = true })
            }
            .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right") }
            .tag(CompanionTab.chat)
            .accessibilityIdentifier("chatTab")

            NavigationStack(path: $botPath) {
                BotsView(store: store, pair: { showingPairing = true }, openChat: { selection = .chat })
                    .navigationDestination(for: NotificationTeamDestination.self) { destination in
                        NotificationTeamView(store: store, teamId: destination.id, openChat: { selection = .chat })
                    }
            }
            .tabItem { Label("Bots", systemImage: "person.2") }
            .tag(CompanionTab.bots)
            .badge(notifications.unreadCount)
            .accessibilityIdentifier("botsTab")

            NavigationStack {
                ModelsView(store: store, pair: { showingPairing = true })
            }
            .tabItem { Label("Models", systemImage: "square.stack.3d.up") }
            .tag(CompanionTab.models)
            .accessibilityIdentifier("modelsTab")

            NavigationStack {
                ConnectionView(store: store, pair: { showingPairing = true })
            }
            .tabItem { Label("Connection", systemImage: "link") }
            .tag(CompanionTab.connection)
            .accessibilityIdentifier("connectionTab")
        }
        .tint(StrataTheme.accentText)
        .sheet(isPresented: $showingPairing) {
            PairMacView(store: store)
        }
        .onChange(of: store.pendingInvitation, initial: true) { _, invitation in
            if invitation != nil { showingPairing = true }
        }
        .alert("Couldn’t complete the request", isPresented: Binding(
            get: { store.error != nil && !showingPairing },
            set: { if !$0 { store.error = nil } }
        )) {
            Button("OK") { store.error = nil }
        } message: {
            Text(store.error ?? "Please try again.")
        }
        .onChange(of: selection, initial: true) { _, tab in
            navigationGeneration = UUID()
            if tab == .chat, let id = store.currentConversation?.id { notifications.focus(CompanionNotificationDestination(type: "chat", id: id)) }
            else { notifications.focus(nil) }
            store.setChatVisible(tab == .chat)
            store.setModelsVisible(tab == .models)
            store.setBotsVisible(tab == .bots)
        }
        .onChange(of: store.currentConversation?.id) { _, id in
            if selection == .chat { notifications.focus(id.map { CompanionNotificationDestination(type: "chat", id: $0) }) }
        }
        .onChange(of: store.pairingGeneration) { _, _ in botPath = []; navigationGeneration = UUID() }
        .task(id: notifications.route?.id) {
            guard let route = notifications.route, route.pairingGeneration == store.pairingGeneration, route.journalId == notifications.verifiedJournalId else { return }
            let navigation = navigationGeneration
            defer { notifications.clearRoute(route.id) }
            if route.destination.type == "chat" {
                let opened = await store.openNotificationConversation(route.destination.id, expectedPairingGeneration: route.pairingGeneration)
                guard opened, !Task.isCancelled, navigation == navigationGeneration, route.pairingGeneration == store.pairingGeneration, route.journalId == notifications.verifiedJournalId else { return }
                selection = .chat
            } else {
                guard route.pairingGeneration == store.pairingGeneration else { return }
                botPath = [NotificationTeamDestination(id: route.destination.id)]; selection = .bots
            }
        }
        .task { if store.isPaired { await store.refresh() } }
    }
}
