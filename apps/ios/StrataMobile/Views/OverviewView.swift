import SwiftUI

struct OverviewView: View {
    @ObservedObject var store: CompanionStore
    let pair: () -> Void
    let open: (CompanionTab) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                StrataHeader(isPaired: store.isPaired, isOnline: store.status?.hostConnected == true) { open(.connection) }
                if store.isPaired { pairedContent } else { welcomeContent }
            }
            .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 32)
        }
        .background(StrataTheme.background)
        .toolbar(.hidden, for: .navigationBar)
        .refreshable { if store.isPaired { await store.refresh() } }
    }

    private var welcomeContent: some View {
        VStack(alignment: .leading, spacing: 24) {
            PageHeading(eyebrow: "Strata, wherever you are", title: "Your workspace.\nWithin reach.", subtitle: "Conversations, bots and computers. Connected to your Mac.")
            VStack(spacing: 18) {
                PairingIllustration()
                VStack(spacing: 8) {
                    Text("A powerful pair.").font(.title3.weight(.semibold)).foregroundStyle(StrataTheme.ink)
                    Text("Your Mac brings it together.\nYour iPhone keeps you connected.")
                        .font(.subheadline).foregroundStyle(StrataTheme.secondaryInk).multilineTextAlignment(.center).lineSpacing(3)
                }
                Button(action: pair) {
                    HStack { Image(systemName: "qrcode.viewfinder"); Text("Pair your Mac"); Spacer(); Image(systemName: "arrow.right") }
                }.buttonStyle(StrataPrimaryButtonStyle()).accessibilityIdentifier("pairMacButton")
            }.strataCard()
            DetailRow(icon: "lock.shield", title: "Made for your own Mac", detail: "Pair once on your local network. Your Mac stays in control of its models and tools.")
        }
    }

    private var pairedContent: some View {
        VStack(alignment: .leading, spacing: 26) {
            PageHeading(eyebrow: "Your workspace", title: "Everything,\nwithin reach.", subtitle: "Pick up a conversation or check on work happening on your Mac.")
            modelOverview
            if typeSize.isAccessibilitySize {
                VStack(spacing: 12) { chatShortcut; botsShortcut }
            } else { HStack(alignment: .top, spacing: 12) { chatShortcut; botsShortcut } }
            HStack(spacing: 12) {
                Button { open(.connectors) } label: { Label("Connectors", systemImage: "puzzlepiece.extension").frame(maxWidth: .infinity, minHeight: 44) }
                    .accessibilityIdentifier("homeConnectorsButton")
                Button { open(.connection) } label: { Label("Mac settings", systemImage: "desktopcomputer").frame(maxWidth: .infinity, minHeight: 44) }
                    .accessibilityIdentifier("homeMacSettingsButton")
            }.font(.subheadline.weight(.semibold)).buttonStyle(.bordered)
            if !store.conversations.isEmpty {
                VStack(alignment: .leading, spacing: 13) {
                    HStack {
                        StrataSectionHeading(title: "Recent conversations")
                        Spacer()
                        Button("See all") { open(.chat) }.font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                    }
                    VStack(spacing: 0) {
                        ForEach(Array(store.conversations.prefix(3).enumerated()), id: \.element.id) { index, conversation in
                            Button { Task { await store.selectConversation(conversation); open(.chat) } } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: conversation.active ? "waveform" : "bubble.left.and.bubble.right")
                                        .font(.subheadline).foregroundStyle(conversation.active ? StrataTheme.success : StrataTheme.ink)
                                        .frame(width: 38, height: 38).background(StrataTheme.grouped, in: RoundedRectangle(cornerRadius: 12))
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(conversation.title).font(.subheadline.weight(.semibold)).foregroundStyle(StrataTheme.ink).lineLimit(2)
                                        Text(conversation.active ? "Working now · follow live" : (conversation.workspaceName ?? "Continue conversation"))
                                            .font(.caption).foregroundStyle(conversation.active ? StrataTheme.success : StrataTheme.secondaryInk)
                                    }
                                    Spacer(minLength: 0)
                                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(StrataTheme.secondaryInk)
                                }.padding(16).contentShape(Rectangle())
                            }.buttonStyle(.plain).accessibilityIdentifier("homeMacConversation-" + conversation.id)
                            if index < min(3, store.conversations.count) - 1 { Divider().overlay(StrataTheme.line).padding(.leading, 66) }
                        }
                    }.strataCard(padding: 0)
                }
            }
            if store.status?.hostConnected != true {
                Button { Task { await store.refresh() } } label: { Label(store.isLoading ? "Reconnecting…" : "Reconnect to your Mac", systemImage: "arrow.clockwise") }
                    .buttonStyle(StrataSecondaryButtonStyle()).disabled(store.isLoading)
            }
        }
    }

    private var modelOverview: some View {
        VStack(alignment: .leading, spacing: 20) {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 14) { modelIdentity; engineStatus }
            } else {
                HStack(spacing: 12) { modelIdentity; Spacer(minLength: 4); engineStatus }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("ACTIVE MODEL").font(.caption2.weight(.semibold)).tracking(0.6).foregroundStyle(StrataTheme.secondaryInk)
                Text(store.status?.modelName ?? "No model loaded").font(.title2.weight(.semibold)).foregroundStyle(StrataTheme.ink).fixedSize(horizontal: false, vertical: true)
            }
            if let status = store.status, status.hostConnected {
                Divider().overlay(StrataTheme.line)
                if typeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 16) { metrics(status) }
                } else { HStack(alignment: .top, spacing: 20) { metrics(status) } }
            }
            Button { open(.models) } label: {
                HStack { Text("Manage models"); Spacer(); Image(systemName: "arrow.up.right") }
                    .font(.subheadline.weight(.semibold)).frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).foregroundStyle(StrataTheme.accentText)
        }.strataCard()
    }

    private var modelIdentity: some View {
        HStack(spacing: 12) {
            Image(systemName: "desktopcomputer").font(.title3).frame(width: 44, height: 44)
                .foregroundStyle(StrataTheme.ink).background(StrataTheme.grouped, in: RoundedRectangle(cornerRadius: 14))
            VStack(alignment: .leading, spacing: 4) {
                Text(store.status?.macName ?? store.connection?.macName ?? "Your Mac").font(.subheadline.weight(.semibold)).foregroundStyle(StrataTheme.ink).fixedSize(horizontal: false, vertical: true)
                Text(store.status?.hostConnected == true ? "Connected workspace" : "Paired workspace").font(.caption).foregroundStyle(StrataTheme.secondaryInk)
            }
        }
    }
    private var engineStatus: some View {
        StrataStatusPill(title: engineLabel, icon: "circle.fill", tone: engineLabel == "Ready" ? .success : engineLabel == "Starting" ? .attention : .neutral)
    }

    @ViewBuilder private func metrics(_ status: CompanionStatus) -> some View {
        if let speed = status.tokensPerSecond { metric(value: speed.formatted(.number.precision(.fractionLength(1))), label: "tokens / sec") }
        if let used = status.memoryUsedGB { metric(value: used.formatted(.number.precision(.fractionLength(1))) + " GB", label: "memory in use") }
        metric(value: "\(status.activeRequests)", label: "active requests")
    }

    private var chatShortcut: some View {
        Button { store.newChat(); open(.chat) } label: {
            shortcut(icon: "bubble.left.and.bubble.right", title: "Start a conversation", detail: "Make room for an idea")
        }.buttonStyle(.plain).accessibilityIdentifier("startChatButton")
    }
    private var botsShortcut: some View {
        Button { open(.bots) } label: { shortcut(icon: "person.2", title: "Your bots", detail: "Teams, activity and tools") }
            .buttonStyle(.plain).accessibilityIdentifier("homeBotsButton")
    }
    private func shortcut(icon: String, title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Image(systemName: icon).font(.title3); Spacer(); Image(systemName: "arrow.up.right").font(.caption) }.foregroundStyle(StrataTheme.ink)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(StrataTheme.ink)
                Text(detail).font(.caption).foregroundStyle(StrataTheme.secondaryInk)
            }
        }.frame(maxWidth: .infinity, alignment: .leading).strataCard(padding: 18)
    }

    private var engineLabel: String {
        guard let status = store.status, status.hostConnected else { return "Offline" }
        switch status.engineState.lowercased() {
        case "ready", "running", "serving": return "Ready"
        case "loading", "starting": return "Starting"
        case "stopped", "idle": return "Standby"
        default: return status.engineState.capitalized
        }
    }

    private func metric(value: String, label: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value).font(.title3.weight(.semibold)).foregroundStyle(StrataTheme.ink)
            Text(label).font(.caption2).foregroundStyle(StrataTheme.secondaryInk)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
