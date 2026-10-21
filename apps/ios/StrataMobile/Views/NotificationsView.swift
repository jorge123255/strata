import SwiftUI

struct NotificationsView: View {
    @ObservedObject var notifications: CompanionNotifications
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink { NotificationSettingsView(notifications: notifications) } label: {
                        Label("Notification settings", systemImage: "bell.badge")
                    }.accessibilityIdentifier("notificationSettingsButton")
                    if let error = notifications.error { Text(error).font(.caption).foregroundStyle(StrataTheme.warning) }
                }
                Section("Recent notifications") {
                    if notifications.events.isEmpty {
                        ContentUnavailableView("You’re all caught up", systemImage: "bell", description: Text("New bot replies, team messages, completed work and approvals appear here after notifications are enabled."))
                            .accessibilityIdentifier("notificationInboxEmpty")
                    }
                    ForEach(notifications.events) { event in
                        Button {
                            notifications.open(event); dismiss()
                        } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: event.icon).font(.title3).frame(width: 30).foregroundStyle(StrataTheme.accentText)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(event.title).font(.subheadline.weight(.semibold)).foregroundStyle(StrataTheme.ink)
                                    Text(event.body).font(.subheadline).foregroundStyle(StrataTheme.secondaryInk)
                                    if let date = ISO8601DateFormatter().date(from: event.createdAt) { Text(date, style: .relative).font(.caption2).foregroundStyle(.secondary) }
                                }
                                Spacer(minLength: 0)
                                if !notifications.readIds.contains(event.id) { Circle().fill(StrataTheme.accentText).frame(width: 7, height: 7).padding(.top, 5) }
                            }.padding(.vertical, 7).contentShape(Rectangle())
                        }.buttonStyle(.plain).disabled(!notifications.canOpenInbox).accessibilityIdentifier("notification-" + event.id)
                    }
                }
            }.strataList().navigationTitle("Notifications").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("closeNotificationsButton") }
                    ToolbarItem(placement: .topBarTrailing) { Button("Mark all read") { notifications.markAllRead() }.disabled(notifications.unreadCount == 0).accessibilityIdentifier("markNotificationsReadButton") }
                }
                .refreshable { await notifications.refresh() }
                .task { await notifications.updateAuthorization(); await notifications.refresh() }
        }
    }
}

struct NotificationSettingsView: View {
    @ObservedObject var notifications: CompanionNotifications
    @Environment(\.openURL) private var openURL
    var body: some View {
        List {
            Section {
                Toggle("Notifications", isOn: binding(\.enabled, requestPermission: true)).accessibilityIdentifier("notificationsEnabledToggle")
                LabeledContent("iOS permission", value: permissionLabel).accessibilityIdentifier("notificationPermissionStatus")
                if notifications.authorization == .denied {
                    Button("Open iPhone Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) } }.accessibilityIdentifier("openNotificationSystemSettingsButton")
                }
                Text(notifications.deliveryDescription).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("notificationDeliveryStatus")
            } footer: { Text("Notifications are specific to this paired iPhone. Turning them off does not stop your bots or change Mac notifications.") }
            Section("Notify me about") {
                Toggle("Bot replies", isOn: binding(\.replies)).accessibilityIdentifier("notificationRepliesToggle")
                Toggle("Team messages", isOn: binding(\.teams)).accessibilityIdentifier("notificationTeamsToggle")
                Toggle("Completed or failed work", isOn: binding(\.work)).accessibilityIdentifier("notificationWorkToggle")
                Toggle("Approval requests", isOn: binding(\.approvals)).accessibilityIdentifier("notificationApprovalsToggle")
            }.disabled(!notifications.settings.enabled)
            Section {
                Toggle("Sound", isOn: binding(\.sound)).accessibilityIdentifier("notificationSoundToggle")
                Text("Alerts use a short, private summary. Prompts, Thinking and tool details stay inside Strata.").font(.caption).foregroundStyle(.secondary)
            }
            if !notifications.settings.muted.isEmpty {
                Section("Muted conversations") {
                    ForEach(notifications.settings.muted, id: \.self) { key in
                        HStack {
                            Label(key.hasPrefix("team:") ? "Team conversation" : "Bot conversation", systemImage: "bell.slash")
                            Spacer()
                            Button("Unmute") {
                                guard let split = key.firstIndex(of: ":") else { return }
                                let destination = CompanionNotificationDestination(type: String(key[..<split]), id: String(key[key.index(after: split)...]))
                                Task { await notifications.setMuted(destination, muted: false) }
                            }.accessibilityIdentifier("unmuteNotification-" + key)
                        }
                    }
                }
            }
            if let error = notifications.error { Section { Text(error).foregroundStyle(StrataTheme.warning).font(.caption) } }
        }.strataList().navigationTitle("Notification settings").navigationBarTitleDisplayMode(.inline)
            .disabled(notifications.saving || !notifications.supported)
            .task { await notifications.updateAuthorization() }
    }
    private var permissionLabel: String {
        switch notifications.authorization { case .authorized: "Allowed"; case .provisional: "Quiet delivery"; case .ephemeral: "Temporary"; case .denied: "Off in Settings"; case .notDetermined: "Not requested"; @unknown default: "Unavailable" }
    }
    private func binding(_ keyPath: WritableKeyPath<CompanionNotificationSettings, Bool>, requestPermission: Bool = false) -> Binding<Bool> {
        Binding(get: { notifications.settings[keyPath: keyPath] }, set: { enabled in
            var updated = notifications.settings; updated[keyPath: keyPath] = enabled
            Task { await notifications.save(updated, requestPermission: requestPermission && enabled) }
        })
    }
}

struct NotificationInboxButton: View {
    @ObservedObject var notifications: CompanionNotifications
    @State private var showing = false
    var body: some View {
        Button { showing = true } label: {
            Image(systemName: notifications.unreadCount > 0 ? "bell.badge" : "bell").frame(width: 38, height: 38)
        }.accessibilityLabel(notifications.unreadCount > 0 ? "Notifications, \(notifications.unreadCount) unread" : "Notifications")
            .accessibilityIdentifier("notificationInboxButton")
            .sheet(isPresented: $showing) { NotificationsView(notifications: notifications) }
    }
}

struct NotificationMuteButton: View {
    @ObservedObject var notifications: CompanionNotifications
    let destination: CompanionNotificationDestination
    var body: some View {
        Button {
            Task { await notifications.setMuted(destination, muted: !notifications.isMuted(destination)) }
        } label: {
            Label(notifications.isMuted(destination) ? "Unmute notifications" : "Mute notifications", systemImage: notifications.isMuted(destination) ? "bell" : "bell.slash")
        }.disabled(notifications.saving).accessibilityIdentifier("muteNotification-" + destination.key)
    }
}

struct NotificationTeamDestination: Hashable { var id: String }

struct NotificationTeamView: View {
    @ObservedObject var store: CompanionStore
    @StateObject private var workspace: BotWorkspaceStore
    let teamId: String
    let openChat: () -> Void
    init(store: CompanionStore, teamId: String, openChat: @escaping () -> Void) {
        self.store = store; self.teamId = teamId; self.openChat = openChat
        _workspace = StateObject(wrappedValue: store.botWorkspaceStore())
    }
    var body: some View {
        BotTeamDetailView(store: store, workspace: workspace, teamId: teamId, openChat: openChat)
            .task { await store.refreshBots(); await workspace.refreshTeams() }
    }
}
