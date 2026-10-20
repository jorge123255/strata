// SPDX-License-Identifier: FSL-1.1-MIT
// Copyright (c) 2026 Cua AI, Inc.
// Strata adaptation: shared host authority replaces the sample's CUA engine.
import AppKit
import CuaBotsCore
import Combine
import SwiftUI
import UserNotifications

struct BotDraft {
    var step = 0
    var name = ""
    var avatar = AvatarConfig(color: .sky, eyes: .star, ears: .scalloped)
    var harness: Harness = .claudeCode
    var placement: Placement = .local
    var customizedLook = false
    var computerID = "local"
    var customHost = ""
    var customUser = ""
    var customPort = ""
    var modelID = ""
    var nativeModel = ""
    var workspace = "/workspace"
    var computerMode = "cua"
    var capabilities = "both"
    var policy = "manual"
    var instructions = ""
}
enum Route: Hashable { case bot(String), scheduled, approvals, outputs, newBot }
@MainActor final class AppModel: ObservableObject {
    let store: BotStore
    let engine: StrataEngine?
    @Published var route: Route = .newBot
    @Published var draft = BotDraft()
    @Published var showProfile = true
    @Published var showComputer = false
    @Published var editingAvatar = false
    @Published var editingRule: CustomRule?
    @Published var showingRules = false
    @Published var showingMemory = false
    @Published var showingSettings = false
    @Published var signInFor: ApprovalRequest?
    @Published var confirmReset: Bot?
    @Published var pairing: Bot?
    @Published var newConversationFor: Bot?
    @Published var toast: BotNotification?
    @Published var openOutput: String?
    @Published var systemNotifications = UNAuthorizationStatus.notDetermined
    @Published var creating = false
    private var forwarding: AnyCancellable?
    private var sessions: [String: ComputerSession] = [:]
    private var panels: [String: NSPanel] = [:]
    init() {
        let engine = StrataEngine(); self.engine = engine; store = BotStore(engine: engine)
        forwarding = store.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }
        store.start()
        Task { await store.perform { try await store.refresh() }; if let first = store.bots.first { route = .bot(first.id); store.select(first.id) } }
    }
    var selectedBot: Bot? { if case .bot(let id) = route { return store.viewBot(id) }; return nil }
    func lastActive(_ id: String) -> Date? { store.messages(for: id).last { $0.role == .bot }?.date }
    var canUseSystemNotifications: Bool { Bundle.main.bundleIdentifier != nil }
    func enableNotifications() async { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]); systemNotifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus }
    func createFromDraft() {
        guard !creating else { return }; let draft = draft; creating = true
        Task {
            defer { creating = false }
            await store.perform {
                var execution: [String: Any] = ["kind": "local"]
                if draft.computerID == "custom-ssh" {
                    execution = ["kind": "ssh", "host": draft.customHost]
                    if !draft.customUser.isEmpty { execution["user"] = draft.customUser }
                    if !draft.customPort.isEmpty { guard let port = Int(draft.customPort), (1...65535).contains(port) else { throw StrataError("Use a port from 1 to 65535.") }; execution["port"] = port }
                } else if draft.computerID != "local" {
                    let catalog = try await store.engine.request("/api/bots")
                    guard let computer = (catalog["computers"] as? [[String: Any]])?.first(where: { $0["id"] as? String == draft.computerID }), let saved = computer["execution"] as? [String: Any] else { throw StrataError("Choose an available execution computer.") }; execution = saved
                }
                var body: [String: Any] = ["name": draft.name, "avatar": "🤖", "avatarConfig": StrataEngine.object(draft.avatar), "provider": draft.harness.rawValue, "model": draft.nativeModel, "capabilities": draft.capabilities, "policy": draft.policy, "workspace": draft.workspace, "execution": execution, "computerMode": draft.computerMode, "instructions": draft.instructions]
                if draft.harness == .configured {
                    guard let model = store.models.first(where: { $0.id == draft.modelID }), let connection = model.connectionID, let name = model.model else { throw StrataError("Choose a model from your saved Models connections.") }
                    body["modelSource"] = ["connectionId": connection, "model": name]; body["model"] = name
                }
                let id = try await store.create(body); self.draft = BotDraft(); route = .bot(id); store.select(id)
            }
        }
    }
    func send(_ text: String) { guard let bot = selectedBot else { return }; Task { await store.send(bot.id, text) } }
    func decide(_ approval: ApprovalRequest, _ approve: Bool) { Task { await store.decide(approval.id, approve: approve) } }
    func togglePause(_ bot: Bot) { Task { if bot.isPaused { await store.resume(bot.id) } else { await store.pause(bot.id) } } }
    func releaseControls() { for session in sessions.values { Task { await session.release() } } }
    func reset(_ bot: Bot) { Task { await store.reset(bot.id); route = store.bots.first.map { .bot($0.id) } ?? .newBot } }
    func session(for bot: Bot) -> ComputerSession {
        let chatID = store.selectedChats[bot.id], key = bot.id + ":" + (chatID ?? "profile")
        if let session = sessions[key] { return session }
        let session = ComputerSession(engine: store.engine, bot: bot, chatID: chatID); sessions[key] = session; return session
    }
    func popOut(_ bot: Bot) {
        if let panel = panels[bot.id] { panel.makeKeyAndOrderFront(nil); return }
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 720, height: 520), styleMask: [.titled, .closable, .resizable, .utilityWindow], backing: .buffered, defer: false)
        panel.title = bot.computerTitle; panel.isFloatingPanel = true; panel.isReleasedWhenClosed = false
        panel.contentView = NSHostingView(rootView: ComputerPane(bot: bot).environmentObject(self)); panels[bot.id] = panel; panel.center(); panel.makeKeyAndOrderFront(nil)
    }
    func openPairing() { guard let origin = engine?.origin, let url = URL(string: "/#/chat?settings=1", relativeTo: origin) else { return }; NSWorkspace.shared.open(url) }
}
