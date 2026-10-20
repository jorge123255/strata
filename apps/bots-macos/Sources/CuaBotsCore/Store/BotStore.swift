// SPDX-License-Identifier: FSL-1.1-MIT
// Copyright (c) 2026 Cua AI, Inc.
// Adapted for Strata: the host owns every profile, transcript and approval.
import Foundation
import Combine

@MainActor public protocol Notifier: AnyObject { func post(_ notification: BotNotification, bot: Bot) }
@MainActor public final class BotStore: ObservableObject {
    @Published public private(set) var bots: [Bot] = []
    @Published public private(set) var messages: [String: [ChatMessage]] = [:]
    @Published public private(set) var tasks: [String: [BotTask]] = [:]
    @Published public private(set) var rules: [String: [CustomRule]] = [:]
    @Published public private(set) var approvals: [ApprovalRequest] = []
    @Published public private(set) var notifications: [BotNotification] = []
    @Published public private(set) var setupPhase: [String: String] = [:]
    @Published public private(set) var computers: [HostOption] = []
    @Published public private(set) var models: [HostOption] = []
    @Published public private(set) var providers: [HostOption] = []
    @Published public private(set) var conversations: [String: [HostConversation]] = [:]
    @Published public var selectedChats: [String: String] = [:]
    @Published public var lastError: String?
    @Published public private(set) var connected = false
    public let engine: StrataEngine
    public let volume = HostVolume()
    public weak var notifier: Notifier?
    private var profiles: [String: [String: Any]] = [:]
    private var approvalChats: [String: String] = [:]
    private var busy: Set<String> = []
    private var poller: Task<Void, Never>?
    private var selectedBot: String?
    private var lastCatalog = Date.distantPast
    private var catalogRevision: UInt64 = 0
    private var chatRevisions: [String: UInt64] = [:]
    private var selectionRevisions: [String: UInt64] = [:]
    public init(engine: StrataEngine) { self.engine = engine }
    deinit { poller?.cancel() }
    public func bot(_ id: String) -> Bot? { bots.first { $0.id == id } }
    public func profile(_ id: String) -> [String: Any] { profiles[id] ?? [:] }
    public func viewContext(for id: String) -> BotViewContext {
        if let chatID = selectedChats[id] {
            let chat = conversations[id]?.first { $0.id == chatID }
            return BotViewContext(chatID: chatID, computerMode: chat?.computerMode, computerName: chat?.computerName ?? "Conversation computer", modelName: chat?.modelName ?? "Conversation model", workspace: chat?.workspace)
        }
        let row = profile(id), execution = row["execution"] as? [String: Any] ?? [:]
        let computer: String
        if let name = execution["name"] as? String, !name.isEmpty { computer = name }
        else if execution["kind"] as? String == "ssh" {
            let user = execution["user"] as? String ?? "", host = execution["host"] as? String ?? "SSH computer"
            computer = (user.isEmpty ? "" : user + "@") + host + ((execution["port"] as? Int).map { ":\($0)" } ?? "")
        } else { computer = "This Mac" }
        let provider = bot(id)?.harness.name ?? "Provider", model = row["model"] as? String ?? ""
        return BotViewContext(chatID: nil, computerMode: row["computerMode"] as? String ?? "host", computerName: computer, modelName: row["modelLabel"] as? String ?? provider + " · " + (model.isEmpty ? "Provider default" : model), workspace: row["workspace"] as? String)
    }
    public func viewBot(_ id: String) -> Bot? {
        guard var bot = bot(id) else { return nil }
        bot.spaceID = viewContext(for: id).hasComputer ? id : nil
        return bot
    }
    public func messages(for id: String) -> [ChatMessage] { messages[id] ?? [] }
    public func tasks(for id: String) -> [BotTask] { tasks[id] ?? [] }
    public func rules(for id: String) -> [CustomRule] { rules[id] ?? [] }
    public func pendingApprovals(for id: String? = nil) -> [ApprovalRequest] { approvals.filter { $0.state == .pending && (id == nil || $0.botID == id) } }
    public func approval(_ id: String) -> ApprovalRequest? { approvals.first { $0.id == id } }
    public var unreadCount: Int { notifications.filter { !$0.read }.count }
    public func isBusy(_ id: String) -> Bool { busy.contains(id) }
    public func memory(for id: String) -> String { (try? volume.readText(VolumeLayout.memory(id))) ?? "" }
    public func outputs(for id: String) -> [VolumeEntry] { (try? volume.walk(VolumeLayout.outputs(id))) ?? [] }
    public func start() {
        poller?.cancel(); poller = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    if Date().timeIntervalSince(self.lastCatalog) >= 3 { try await self.refresh() }
                    if let id = self.selectedBot { try await self.refreshConversation(id) }
                } catch { self.connected = false; if self.lastError == nil { self.lastError = error.localizedDescription } }
                try? await Task.sleep(for: .milliseconds(800))
            }
        }
    }
    public func select(_ id: String?) { selectedBot = id; if let id { Task { await perform { try await self.refreshConversation(id); try await self.refreshWork(id) } } } }
    public func chooseChat(_ botID: String, _ chatID: String) { selectionRevisions[botID, default: 0] += 1; selectedChats[botID] = chatID; Task { await perform { try await self.refreshConversation(botID) } } }
    public func refresh() async throws {
        catalogRevision += 1; let revision = catalogRevision, selections = selectionRevisions
        let response = try await engine.request("/api/bots")
        guard revision == catalogRevision else { return }
        let catalog = try await engine.request("/api/companion/conversations")
        guard revision == catalogRevision else { return }
        let rows = response["bots"] as? [[String: Any]] ?? []
        profiles = Dictionary(uniqueKeysWithValues: rows.compactMap { row in (row["id"] as? String).map { ($0, row) } })
        bots = rows.compactMap { row in
            guard let id = row["id"] as? String, let name = row["name"] as? String else { return nil }
            let avatar = Self.decode(AvatarConfig.self, row["avatarConfig"]) ?? AvatarConfig.default(for: name)
            let execution = row["execution"] as? [String: Any] ?? [:]
            var bot = Bot(name: name, avatar: avatar, harness: Harness(rawValue: row["provider"] as? String ?? "") ?? .configured, placement: execution["kind"] as? String == "ssh" ? .remote : .local, createdAt: StrataEngine.date(row["createdAt"]) ?? Date())
            bot.id = id; bot.spaceID = row["computerMode"] as? String == "cua" ? id : nil
            bot.isPaused = row["paused"] as? Bool ?? false
            bot.status = row["detail"] as? String ?? "Ready"; bot.mood = bot.isPaused ? .paused : self.pendingApprovals(for: id).isEmpty ? (self.busy.contains(id) ? .thinking : .idle) : .needsApproval
            return bot
        }
        computers = (response["computers"] as? [[String: Any]] ?? []).compactMap { row in guard let id = row["id"] as? String else { return nil }; return HostOption(id: id, name: row["name"] as? String ?? id, detail: row["detail"] as? String ?? "", available: row["available"] as? Bool ?? false) }
        models = (response["models"] as? [[String: Any]] ?? []).compactMap { row in guard let id = row["id"] as? String else { return nil }; return HostOption(id: id, name: (row["connectionName"] as? String ?? "Connection") + " · " + (row["name"] as? String ?? row["model"] as? String ?? "Model"), detail: row["detail"] as? String ?? "", available: row["available"] as? Bool ?? false, connectionID: row["connectionId"] as? String, model: row["model"] as? String) }
        providers = (response["providers"] as? [[String: Any]] ?? []).compactMap { row in guard let id = row["id"] as? String else { return nil }; return HostOption(id: id, name: row["name"] as? String ?? id, detail: row["detail"] as? String ?? "", available: row["available"] as? Bool ?? false) }
        var grouped: [String: [HostConversation]] = [:]
        for conversation in catalog["conversations"] as? [[String: Any]] ?? [] {
            guard let id = conversation["id"] as? String, let preferences = conversation["preferences"] as? [String: Any], let botID = preferences["botId"] as? String else { continue }
            grouped[botID, default: []].append(Self.conversation(conversation, id: id))
        }
        // A catalog requested before a user selection may not yet contain a
        // newly created chat. Keep its known row so the picker and transcript
        // continue to identify the same selected conversation.
        for (id, selected) in selectedChats where selectionRevisions[id, default: 0] != selections[id, default: 0] && !(grouped[id] ?? []).contains(where: { $0.id == selected }) {
            if let known = conversations[id]?.first(where: { $0.id == selected }) { grouped[id, default: []].insert(known, at: 0) }
        }
        conversations = grouped
        for (id, chats) in grouped where selectionRevisions[id, default: 0] == selections[id, default: 0] { if selectedChats[id] == nil || !chats.contains(where: { $0.id == selectedChats[id] }) { selectedChats[id] = chats.first?.id; selectionRevisions[id, default: 0] += 1 } }
        connected = true; lastCatalog = Date()
        for (id, chats) in grouped where chats.contains(where: { $0.active }) { try await refreshConversation(id) }
        if let id = selectedBot, profiles[id] != nil { try await refreshWork(id) }
    }
    public func refreshConversation(_ botID: String) async throws {
        guard let chatID = selectedChats[botID] else { messages[botID] = []; return }
        chatRevisions[botID, default: 0] += 1; let revision = chatRevisions[botID]
        let response: [String: Any]
        do { response = try await engine.request("/api/companion/conversations/\(chatID)") }
        catch { guard selectedChats[botID] == chatID, chatRevisions[botID] == revision else { return }; throw error }
        guard selectedChats[botID] == chatID, chatRevisions[botID] == revision else { return }
        guard let conversation = response["conversation"] as? [String: Any], (conversation["preferences"] as? [String: Any])?["botId"] as? String == botID else { throw StrataError("This conversation belongs to a different bot.") }
        let snapshot = Self.conversation(conversation, id: chatID)
        if let index = conversations[botID]?.firstIndex(where: { $0.id == chatID }) { conversations[botID]?[index] = snapshot }
        else { conversations[botID, default: []].insert(snapshot, at: 0) }
        let active = conversation["active"] as? Bool ?? false
        if active { busy.insert(botID) } else { busy.remove(botID) }
        var mapped: [ChatMessage] = []
        for row in conversation["messages"] as? [[String: Any]] ?? [] {
            guard let id = row["id"] as? String else { continue }
            let date = StrataEngine.date(row["at"] ?? row["createdAt"] ?? row["date"]) ?? Date(timeIntervalSince1970: 0)
            let role: MessageRole = row["role"] as? String == "user" ? .user : row["role"] as? String == "assistant" ? .bot : .system
            let thinking = row["reasoning"] as? String ?? row["thinking"] as? String ?? ""
            if !thinking.isEmpty { mapped.append(ChatMessage(id: id + ":thinking", botID: botID, role: .system, text: thinking, kind: .thinking, date: date)) }
            let text = row["content"] as? String ?? row["text"] as? String ?? ""
            if !text.isEmpty { mapped.append(ChatMessage(id: id, botID: botID, role: role, text: text, date: date)) }
            if let error = row["error"] as? String, !error.isEmpty { mapped.append(ChatMessage(id: id + ":error", botID: botID, role: .system, text: error, kind: .notice, date: date)) }
            for tool in row["tools"] as? [[String: Any]] ?? [] {
                guard let toolID = tool["id"] as? String else { continue }
                let title = tool["name"] as? String ?? "Tool", state = tool["state"] as? String ?? ""
                let result = tool["result"] as? String ?? tool["preview"] as? String ?? ""
                mapped.append(ChatMessage(id: id + ":tool:" + toolID, botID: botID, role: .system, text: title + " · " + state + (result.isEmpty ? "" : "\n" + String(result.prefix(24000))), kind: .activity, date: date))
            }
        }
        approvals.removeAll { $0.botID == botID }
        for pending in response["pending"] as? [[String: Any]] ?? [] {
            guard let id = pending["id"] as? String else { continue }
            let date = StrataEngine.date(pending["createdAt"]) ?? StrataEngine.date(conversation["updatedAt"]) ?? Date(timeIntervalSince1970: 0)
            approvals.append(ApprovalRequest(id: id, botID: botID, action: pending["name"] as? String ?? "Tool", detail: pending["preview"] as? String ?? "", source: .rule(ruleID: nil), createdAt: date))
            approvalChats[id] = chatID
            mapped.append(ChatMessage(id: "approval:" + id, botID: botID, role: .system, text: "", kind: .approval(id: id), date: date))
        }
        if messages[botID] != mapped { messages[botID] = mapped }
        if let index = bots.firstIndex(where: { $0.id == botID }) { bots[index].mood = bots[index].isPaused ? .paused : !pendingApprovals(for: botID).isEmpty ? .needsApproval : active ? .thinking : .idle; bots[index].status = active ? "Working" : "Ready" }
    }
    public func newConversation(_ id: String, selection: [String: Any] = [:]) async throws -> String {
        let revision = selectionRevisions[id, default: 0]
        let response = try await engine.request("/api/bots/\(id)/conversations", method: "POST", body: selection)
        guard let conversation = response["conversation"] as? [String: Any], let chatID = conversation["id"] as? String else { throw StrataError("Strata could not create this conversation.") }
        if !(conversations[id] ?? []).contains(where: { $0.id == chatID }) { conversations[id, default: []].insert(Self.conversation(conversation, id: chatID), at: 0) }
        if selectionRevisions[id, default: 0] == revision { selectedChats[id] = chatID; selectionRevisions[id, default: 0] += 1 }
        try await refresh(); try await refreshConversation(id); return chatID
    }
    public func send(_ id: String, _ text: String) async {
        await perform {
            let chatID: String
            if let selected = self.selectedChats[id] { chatID = selected } else { chatID = try await self.newConversation(id) }
            _ = try await self.engine.request("/api/companion/conversations/\(chatID)/messages", method: "POST", body: ["message": text]); try await self.refreshConversation(id)
        }
    }
    public func decide(_ id: String, approve: Bool) async {
        await perform { guard let chatID = self.approvalChats[id] else { throw StrataError("This approval is no longer pending.") }; _ = try await self.engine.request("/api/companion/conversations/\(chatID)/approval", method: "POST", body: ["toolId": id, "decision": approve ? "approve" : "deny"]); if let botID = self.approval(id)?.botID { try await self.refreshConversation(botID) } }
    }
    public func pause(_ id: String) async { await perform { _ = try await self.engine.request("/api/bots/\(id)/pause", method: "POST", body: ["paused": true]); try await self.refresh(); try await self.refreshConversation(id) } }
    public func resume(_ id: String) async { await perform { _ = try await self.engine.request("/api/bots/\(id)/pause", method: "POST", body: ["paused": false]); try await self.refresh(); try await self.refreshConversation(id) } }
    public func reset(_ id: String) async { await perform { _ = try await self.engine.request("/api/bots/\(id)", method: "DELETE"); try await self.refresh() } }
    public func updateAvatar(_ id: String, _ avatar: AvatarConfig) { updateProfile(id, ["avatarConfig": StrataEngine.object(avatar)]) }
    public func rename(_ id: String, to name: String) { updateProfile(id, ["name": name]) }
    public func updateProfile(_ id: String, _ changes: [String: Any]) { Task { await perform { _ = try await self.engine.request("/api/bots/\(id)", method: "PATCH", body: changes); try await self.refresh() } } }
    public func create(_ body: [String: Any]) async throws -> String { let response = try await engine.request("/api/bots", method: "POST", body: body); guard let bot = response["bot"] as? [String: Any], let id = bot["id"] as? String else { throw StrataError("The bot could not be created.") }; try await refresh(); return id }
    public func refreshWork(_ id: String) async throws {
        let result = try await engine.request("/api/bots/\(id)/work")
        if let memory = result["memory"] as? String { volume.set(VolumeLayout.memory(id), Data(memory.utf8)) }
        rules[id] = Self.decode([CustomRule].self, result["rules"]) ?? []
        var rows: [BotTask] = []
        for row in result["routines"] as? [[String: Any]] ?? [] {
            guard let taskID = row["id"] as? String else { continue }
            let schedule = Self.schedule(row["schedule"] as? [String: Any] ?? [:])
            var task = BotTask(id: taskID, botID: id, title: row["title"] as? String ?? "Routine", prompt: row["prompt"] as? String ?? "", state: row["enabled"] as? Bool == true ? .scheduled : .paused, schedule: schedule, notifyOnCompletion: row["notifyOnCompletion"] as? Bool ?? true)
            task.nextRun = StrataEngine.date(row["nextRun"]); task.lastRun = StrataEngine.date(row["lastRun"]); rows.append(task)
        }
        tasks[id] = rows
        let files = result["outputs"] as? [[String: Any]] ?? []
        volume.entries[id] = files.compactMap { row in guard let path = row["path"] as? String else { return nil }; return VolumeEntry(path: VolumeLayout.home(id) + path, name: row["name"] as? String ?? (path as NSString).lastPathComponent, isFolder: false, size: (row["size"] as? NSNumber)?.uint64Value ?? 0, modified: StrataEngine.date(row["modified"])) }
        objectWillChange.send()
    }
    public func refreshAllWork() async { await perform { for bot in self.bots { try await self.refreshWork(bot.id) } } }
    public func loadOutput(_ path: String) async { await perform { let parts = path.split(separator: "/"); guard parts.count >= 3, parts[0] == "agents" else { throw StrataError("Choose a bot output.") }; let id = String(parts[1]), local = parts.dropFirst(2).joined(separator: "/"); var components = URLComponents(); components.queryItems = [URLQueryItem(name: "path", value: local)]; let result = try await self.engine.request("/api/bots/\(id)/work/file" + (components.string ?? "")); self.volume.set(path, Data((result["text"] as? String ?? "").utf8)); self.objectWillChange.send() } }
    public func setRules(_ id: String, _ rules: [CustomRule]) { Task { await perform { _ = try await self.engine.request("/api/bots/\(id)/work", method: "PATCH", body: ["rules": StrataEngine.object(rules)]); try await self.refreshWork(id) } } }
    public func saveMemory(_ id: String, _ memory: String) async { await perform { _ = try await self.engine.request("/api/bots/\(id)/work", method: "PATCH", body: ["memory": memory]); try await self.refreshWork(id) } }
    public func schedule(_ id: String, title: String, prompt: String, schedule: TaskSchedule) { Task { await perform { _ = try await self.engine.request("/api/bots/\(id)/routines", method: "POST", body: ["title": title, "prompt": prompt, "schedule": Self.scheduleObject(schedule), "timeZone": TimeZone.current.identifier, "enabled": true, "notifyOnCompletion": true]); try await self.refreshWork(id) } } }
    public func updateTask(_ task: BotTask) { Task { await perform { _ = try await self.engine.request("/api/bots/\(task.botID)/routines/\(task.id)", method: "PATCH", body: ["enabled": task.state == .scheduled, "notifyOnCompletion": task.notifyOnCompletion]); try await self.refreshWork(task.botID) } } }
    public func deleteTask(_ task: BotTask) { Task { await perform { _ = try await self.engine.request("/api/bots/\(task.botID)/routines/\(task.id)", method: "DELETE"); try await self.refreshWork(task.botID) } } }
    public func fire(taskID: String, botID: String) async { await perform { _ = try await self.engine.request("/api/bots/\(botID)/routines/\(taskID)/run", method: "POST", body: [:]); try await self.refreshWork(botID) } }
    public func markRead(_ id: String) { if let index = notifications.firstIndex(where: { $0.id == id }) { notifications[index].read = true } }
    private static func conversation(_ row: [String: Any], id: String) -> HostConversation {
        let preferences = row["preferences"] as? [String: Any] ?? [:]
        return HostConversation(id: id, title: row["title"] as? String ?? "Conversation", updatedAt: StrataEngine.date(row["updatedAt"]) ?? Date(), active: row["active"] as? Bool ?? false, computerMode: preferences["botComputerMode"] as? String, computerName: preferences["botComputer"] as? String, modelName: preferences["botModel"] as? String, workspace: row["workspace"] as? String)
    }
    public func perform(_ action: () async throws -> Void) async { do { try await action() } catch { lastError = error.localizedDescription } }
    static func decode<T: Decodable>(_ type: T.Type, _ value: Any?) -> T? { guard let value, JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }; let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601; return try? decoder.decode(type, from: data) }
    static func schedule(_ row: [String: Any]) -> TaskSchedule? { switch row["kind"] as? String { case "every": return .every(minutes: row["minutes"] as? Int ?? 30); case "daily": return .daily(hour: row["hour"] as? Int ?? 9, minute: row["minute"] as? Int ?? 0); case "weekly": return .weekly(weekday: (row["weekday"] as? Int ?? 1) + 1, hour: row["hour"] as? Int ?? 9, minute: row["minute"] as? Int ?? 0); default: return nil } }
    static func scheduleObject(_ schedule: TaskSchedule) -> [String: Any] { switch schedule { case .every(let minutes): return ["kind": "every", "minutes": minutes]; case .daily(let hour, let minute): return ["kind": "daily", "hour": hour, "minute": minute]; case .weekly(let weekday, let hour, let minute): return ["kind": "weekly", "weekday": weekday - 1, "hour": hour, "minute": minute] } }
}

// A read-only in-memory projection of host work files for the original views.
// There is no second on-disk Volume, conversation store, scheduler or pairing.
public final class HostVolume: VolumeStore, @unchecked Sendable {
    private let lock = NSLock(); private var files: [String: Data] = [:]
    public var entries: [String: [VolumeEntry]] = [:]
    public init() { }
    public func set(_ path: String, _ data: Data) { lock.lock(); defer { lock.unlock() }; files[path] = data }
    public func read(_ path: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return files[path] }
    public func ls(_ path: String) throws -> [VolumeEntry] { try walk(path) }
    public func walk(_ path: String) throws -> [VolumeEntry] { entries.values.flatMap { $0 }.filter { $0.path.hasPrefix(path) } }
    public func write(_ path: String, _ data: Data) throws { throw StrataError("Save work files through Strata’s shared host controls.") }
    public func delete(_ path: String) throws { throw StrataError("Delete work files through Strata’s shared host controls.") }
}
