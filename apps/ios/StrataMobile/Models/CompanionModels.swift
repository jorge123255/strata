import Foundation

struct CompanionStatus: Codable, Equatable {
    var macName: String
    var hostConnected: Bool
    var modelName: String?
    var engineState: String
    var tokensPerSecond: Double?
    var memoryUsedGB: Double?
    var memoryTotalGB: Double?
    var activeRequests: Int
}

struct CompanionModel: Codable, Identifiable, Equatable {
    var id: String
    var name: String
    var size: String?
    var state: String
    var detail: String?
    var selected: Bool? = nil
}

struct ModelManagementTarget: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var kind: String
    var isRemote: Bool { kind == "remote" }
}

struct ModelManagementTargets: Decodable { var targets: [ModelManagementTarget]; var reason: String? }

struct ModelManagementCatalog: Decodable, Equatable {
    struct Capabilities: Decodable, Equatable { var downloads: Bool; var imports: Bool? }
    var supported: Bool
    var reason: String?
    var targetName: String
    var capabilities: Capabilities
    var models: [DownloadableModel]
    var jobs: [ModelDownloadJob]
    var canDownload: Bool { supported && capabilities.downloads }
}

struct DownloadableModel: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var sizeGb: Double?
    var state: String
    var detail: String?
    var readPictures: Bool
    var canDownload: Bool { ["available", "error", "cancelled"].contains(state) }
    var sizeLabel: String { ModelDownloadFormat.gigabytes(sizeGb) }
}

struct ModelDownloadJob: Decodable, Identifiable, Equatable {
    var id: String
    var modelId: String?
    var name: String
    var kind: String
    var state: String
    var summary: String
    var percent: Double?
    var doneGb: Double?
    var totalGb: Double?
    var error: String?
    var canCancel: Bool?

    var isRunning: Bool { state == "running" || state == "queued" }
    var canRetry: Bool { kind == "download" && ["error", "cancelled"].contains(state) && modelId != nil }
    var progress: Double? {
        guard let percent, percent.isFinite else { return nil }
        return min(100, max(0, percent)) / 100
    }
    var statusLabel: String {
        switch state {
        case "queued": return "Waiting to download"
        case "running": return "Downloading and preparing"
        case "done": return "Ready on computer"
        case "cancelled": return "Download stopped"
        case "error": return "Download needs attention"
        default: return state.capitalized
        }
    }
    var counterLabel: String? {
        guard let doneGb, doneGb.isFinite, doneGb >= 0,
              let totalGb, totalGb.isFinite, totalGb >= 0 else { return nil }
        return ModelDownloadFormat.gigabytes(doneGb) + " of " + ModelDownloadFormat.gigabytes(totalGb)
    }
}

struct ModelDownloadPlan: Decodable, Identifiable, Equatable {
    var planId: String
    var targetName: String
    var modelName: String
    var downloadGb: Double?
    var diskFreeGb: Double?
    var diskNeededGb: Double?
    var diskShort: String?
    var readPictures: Bool
    var warnings: [String]
    var expiresAt: Double
    var id: String { planId }

    func isExpired(at date: Date = Date()) -> Bool {
        !expiresAt.isFinite || date.timeIntervalSince1970 * 1000 >= expiresAt
    }
    func canStart(at date: Date = Date()) -> Bool {
        !planId.isEmpty && diskShort?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false && !isExpired(at: date)
    }
}

enum ModelDownloadFormat {
    static func gigabytes(_ value: Double?) -> String {
        guard let value, value.isFinite, value >= 0 else { return "Not reported" }
        return value.formatted(.number.precision(.fractionLength(0...1))) + " GB"
    }
}

struct ModelDownloadResult: Decodable { var job: ModelDownloadJob }

struct CompanionChat: Codable, Identifiable, Equatable {
    var id: String
    var title: String
}

struct CompanionBots: Decodable, Equatable {
    var bots: [CompanionBot]
    var providers: [BotProvider]
    var computers: [BotComputer]
    var models: [BotConfiguredModel]?
    var selectionSupported: Bool?
    var avatarShapes: [String]?
    var lifecycleSupported: Bool?
    var hostFolderSupported: Bool?
    var defaultWorkspace: String?
    var defaultPolicy: String?
    var reason: String?
}

struct BotHostFolder: Codable, Equatable {
    var path: String
    var access: String
}

struct BotHostFolderUpdate: Encodable {
    var expectedUpdatedAt: String
    var hostFolder: BotHostFolder?
    enum CodingKeys: String, CodingKey { case expectedUpdatedAt, hostFolder }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(expectedUpdatedAt, forKey: .expectedUpdatedAt)
        if let hostFolder { try values.encode(hostFolder, forKey: .hostFolder) }
        else { try values.encodeNil(forKey: .hostFolder) }
    }
}

struct CompanionBot: Decodable, Identifiable, Equatable {
    struct Execution: Decodable, Equatable { var kind: String }
    var id: String
    var name: String
    var provider: String
    var model: String
    var capabilities: String
    var policy: String
    var execution: Execution
    var conversations: [String]?
    var avatar: String?
    var workspace: String?
    var modelId: String?
    var computerMode: String?
    var hostFolder: BotHostFolder?
    var avatarConfig: AvatarConfig?
    var paused: Bool?
    var effort: String?
    var instructions: String?
    var updatedAt: String?
    var computerId: String?
    var active: Bool?

    var face: AvatarConfig { avatarConfig ?? .default(for: name) }

    var avatarText: String {
        if let avatar, BotAvatar.allowed.contains(avatar) { return avatar }
        return "🤖"
    }

    var capabilityLabel: String {
        switch capabilities { case "computer": return "Computer control"; case "both": return "Code & computer"; default: return "Coding" }
    }
    var capabilityIcon: String {
        switch capabilities { case "computer": return "cursorarrow.motionlines"; case "both": return "desktopcomputer"; default: return "chevron.left.forwardslash.chevron.right" }
    }
    var executionLabel: String {
        if computerMode == "cua" { return "Isolated computer" }
        return switch execution.kind { case "ssh": "SSH computer"; case "sandbox": "Sandbox"; default: "Your Mac" }
    }
    var policyLabel: String {
        BotApprovalPolicy(rawValue: policy)?.label ?? "Ask before actions"
    }
}

enum BotAvatar {
    static let allowed = ["🤖", "🧑‍💻", "🦊", "🧠", "🚀", "🛠️", "🌿", "✨"]
}

struct BotConfiguredModel: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var connectionName: String
    var model: String
    var available: Bool
    var detail: String?
    var label: String { connectionName.isEmpty ? name : name + " · " + connectionName }
}

struct BotProvider: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var available: Bool
    var detail: String
    var models: [String]?
}

struct BotComputer: Decodable, Identifiable, Equatable {
    struct Provider: Decodable, Equatable { var id: String; var available: Bool }
    var id: String
    var name: String
    var kind: String
    var available: Bool
    var detail: String
    var providers: [Provider]?
}

enum BotApprovalPolicy: String, Codable, CaseIterable, Identifiable {
    case manual, plan, bypass
    var id: String { rawValue }
    var label: String { switch self { case .manual: "Ask before actions"; case .plan: "Plan mode"; case .bypass: "Bypass approvals" } }
    var detail: String {
        switch self {
        case .manual: "Ask for approval when an action requires it."
        case .plan: "Plan and inspect with permitted read-only tools. Actions that change things stay blocked."
        case .bypass: "Allow this bot's actions without approval prompts. Use only with computers and tools you trust."
        }
    }
}

struct BotProfileDraft: Encodable, Equatable {
    var name = ""
    var provider = ""
    var model = ""
    var modelId: String?
    var computerId = ""
    var workspace = ""
    var instructions = ""
    var capabilities = "code"
    var policy: BotApprovalPolicy = .manual
    var computerMode = "host"
    var effort: String?
    var avatarConfig = AvatarConfig()
    var expectedUpdatedAt: String?

    init() { }
    init(bot: CompanionBot) {
        name = bot.name; provider = bot.provider; model = bot.model; modelId = bot.modelId
        computerId = bot.computerId ?? ""; workspace = bot.workspace ?? ""; instructions = bot.instructions ?? ""
        capabilities = bot.capabilities; policy = BotApprovalPolicy(rawValue: bot.policy) ?? .manual
        computerMode = bot.computerMode ?? "host"; effort = bot.effort; avatarConfig = bot.face
        expectedUpdatedAt = bot.updatedAt
    }

    func validated(in catalog: CompanionBots, original: CompanionBot?) throws -> Self {
        var result = self
        result.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        result.workspace = workspace.trimmingCharacters(in: .whitespacesAndNewlines)
        guard catalog.lifecycleSupported == true else { throw CompanionError.server("Update Strata on your Mac to create or edit bots here.") }
        guard !result.name.isEmpty, result.name.utf16.count <= 80, result.name.rangeOfCharacter(from: .controlCharacters) == nil,
              instructions.utf16.count <= 32_000, model.utf16.count <= 250,
              ["code", "computer", "both"].contains(capabilities), ["host", "cua"].contains(computerMode),
              ["claude", "codex", "devin", "grok", "kimi", "ollama", "configured"].contains(provider) else {
            throw CompanionError.server("Check the bot's name, instructions and provider.")
        }
        result.avatarConfig = try avatarConfig.validated(supportedShapes: catalog.avatarShapes)
        guard catalog.computers.contains(where: { $0.id == computerId }) else {
            throw CompanionError.server("Choose a saved computer. Set up more computers on your Mac.")
        }
        guard result.workspace.hasPrefix("/"), result.workspace.utf16.count <= 4_000,
              result.workspace.rangeOfCharacter(from: .controlCharacters) == nil,
              computerMode != "cua" || result.workspace == "/workspace" else {
            throw CompanionError.server("Enter the full workspace folder path on that computer. Isolated computers use /workspace.")
        }
        if provider == "configured" {
            guard let id = modelId, let chosen = catalog.models?.first(where: { $0.id == id }) else {
                throw CompanionError.server("Choose a saved model connection from your Mac.")
            }
            result.model = chosen.model; result.effort = nil
        } else {
            result.modelId = nil
            if let effort, effort.range(of: "^[a-z0-9_-]{0,32}$", options: .regularExpression) == nil {
                throw CompanionError.server("Choose an effort supported by this model.")
            }
        }
        if let original {
            guard let expectedUpdatedAt, !expectedUpdatedAt.isEmpty, expectedUpdatedAt == original.updatedAt else {
                throw CompanionError.server("Reload the latest bot before editing it.")
            }
        } else { result.expectedUpdatedAt = nil }
        return result
    }
}

struct BotProfileSaveResult: Decodable {
    var bot: CompanionBot
    var catalog: CompanionBots
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        bot = try values.decode(CompanionBot.self, forKey: .bot)
        catalog = try CompanionBots(from: decoder)
    }
    private enum CodingKeys: String, CodingKey { case bot }
}

struct ChatMessage: Codable, Identifiable, Equatable {
    var id: String
    var role: String
    var content: String
}

// Shared Mac conversations retain their identity, workspace, and permission mode.
struct MacConversationSummary: Decodable, Identifiable, Equatable {
    var id: String
    var title: String
    var updatedAt: String?
    var workspace: String?
    var modelName: String?
    var mode: String?
    var active: Bool
    var preview: String?
    var botId: String?
    var teamId: String?
    var teamRunId: String?
    var parentChatId: String?

    enum CodingKeys: String, CodingKey { case id, title, updatedAt, workspace, modelName, mode, active, preview, botId, teamId, teamRunId, parentChatId }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        title = try values.decode(String.self, forKey: .title)
        if let text = try? values.decode(String.self, forKey: .updatedAt) { updatedAt = text }
        else if let number = try? values.decode(Double.self, forKey: .updatedAt) { updatedAt = String(number) }
        else { updatedAt = nil }
        workspace = try values.decodeIfPresent(String.self, forKey: .workspace)
        modelName = try values.decodeIfPresent(String.self, forKey: .modelName)
        mode = try values.decodeIfPresent(String.self, forKey: .mode)
        active = try values.decodeIfPresent(Bool.self, forKey: .active) ?? false
        preview = try values.decodeIfPresent(String.self, forKey: .preview)
        botId = try values.decodeIfPresent(String.self, forKey: .botId)
        teamId = try values.decodeIfPresent(String.self, forKey: .teamId)
        teamRunId = try values.decodeIfPresent(String.self, forKey: .teamRunId)
        parentChatId = try values.decodeIfPresent(String.self, forKey: .parentChatId)
    }

    var workspaceName: String? { workspace.map { URL(fileURLWithPath: $0).lastPathComponent }.flatMap { $0.isEmpty ? nil : $0 } }
}

struct MacConversation: Decodable, Identifiable, Equatable {
    var id: String
    var title: String
    var workspace: String?
    var modelName: String?
    var mode: String?
    var active: Bool
    var status: String?
    var messages: [MacChatMessage]
    var botId: String? = nil
    var botName: String? = nil
    var botAvatar: String? = nil
    var computerName: String? = nil
    var botModelName: String? = nil
    var computerMode: String? = nil
    var botAvatarConfig: AvatarConfig? = nil
    var botEffort: String? = nil
    var teamId: String? = nil
    var teamRunId: String? = nil
    var parentChatId: String? = nil

    var permissionLabel: String {
        switch mode {
        case "plan": return "Plan mode"
        case "bypass": return "Bypass approvals"
        case "accept-edits": return "Accept edits"
        case "auto": return "Automatic permissions"
        default: return "Ask before actions"
        }
    }
}

struct MacPauseOption: Decodable, Equatable {
    var id: String
    var label: String
}

struct MacPauseRecovery: Decodable, Equatable {
    var kind: String
    var text: String
    var question: String
    var options: [MacPauseOption]
    var choice: String?
}

struct MacChatMessage: Decodable, Identifiable, Equatable {
    var id: String
    var role: String
    var content: String
    var at: String?
    var streaming: Bool?
    var error: String?
    var tools: [MacToolActivity]?
    var reasoning: String?
    var reasoningMs: Double?
    var blocks: [MacMessageBlock]?
    var recovery: MacPauseRecovery? = nil

    var thinkingText: String? {
        guard let value = reasoning?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }
    var thinkingPreview: String? {
        thinkingText?.split(whereSeparator: \.isNewline).last.map { String($0).trimmingCharacters(in: .whitespaces) }
    }
    var isThinkingInProgress: Bool {
        streaming == true && reasoningMs == nil && content.isEmpty && thinkingText != nil
    }
    func thinkingTitle(isLive: Bool) -> String {
        guard !isLive, let duration = reasoningMs, duration.isFinite, duration >= 0 else { return "Thinking" }
        return "Thought for " + String(format: "%.0f", (duration / 1000).rounded()) + "s"
    }

    /// The host may raise or drop the step budget. This only hides that leftover sentence.
    var isStepPause: Bool {
        guard let error, !error.isEmpty else { return false }
        return isStepPauseText(error)
    }

    /// A paused run from the host: `recovery.text` is the summary and `continue` is Keep going.
    var pauseChoice: MacPauseRecovery? {
        guard let recovery, recovery.kind == "paused" else { return nil }
        let summary = recovery.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !summary.isEmpty, recovery.options.contains(where: { $0.id == "continue" && !$0.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else { return nil }
        return recovery
    }

    func isPauseNotice(_ value: String) -> Bool {
        let text = value.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.count <= 280 && (isStepPauseText(text) || text.range(of: "try sending the message again", options: .caseInsensitive) != nil)
    }

    private func isStepPauseText(_ value: String) -> Bool {
        value.range(of: #"reached its (?:\d+-)?step limit"#, options: [.regularExpression, .caseInsensitive]) != nil
            || value.range(of: "ran out of steps", options: .caseInsensitive) != nil
    }

    /// Ordered Mac text/activity blocks are authoritative. Tool membership is
    /// explicit; old groups without IDs keep their actions in the flat remainder.
    var timelineItems: [MacMessageTimelineItem] {
        let usable = (blocks ?? []).filter { block in
            switch block {
            case .text(let text): return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            case .group: return true
            case .unsupported: return false
            }
        }
        var result: [MacMessageTimelineItem] = []
        var seenTools = Set<String>()
        var seenGroups = Set<String>()
        let actions = tools ?? []
        if usable.isEmpty {
            if !content.isEmpty { result.append(.text(id: "fallback-text", text: content)) }
        } else {
            var hasText = false
            for (index, block) in usable.enumerated() {
                switch block {
                case .text(let text):
                    hasText = true
                    result.append(.text(id: "text-\(index)", text: text))
                case .group(let group):
                    guard seenGroups.insert(group.id).inserted else { continue }
                    let ids = Set(group.toolIds ?? [])
                    let members = actions.filter { ids.contains($0.id) && seenTools.insert($0.id).inserted }
                    result.append(.group(group, tools: members))
                case .unsupported: break
                }
            }
            // Older snapshots can have group summaries without text blocks.
            if !hasText, !content.isEmpty { result.append(.text(id: "fallback-text", text: content)) }
        }
        for tool in actions where seenTools.insert(tool.id).inserted { result.append(.tool(tool)) }
        return result
    }
}

struct MacActivityGroup: Decodable, Identifiable, Equatable {
    var id: String
    var line: String
    var closed: Bool
    var added: Double?
    var removed: Double?
    var toolIds: [String]?

    enum CodingKeys: String, CodingKey { case id, line, closed, added, removed, toolIds }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        line = try values.decodeIfPresent(String.self, forKey: .line) ?? ""
        closed = try values.decodeIfPresent(Bool.self, forKey: .closed) ?? false
        added = try values.decodeIfPresent(Double.self, forKey: .added)
        removed = try values.decodeIfPresent(Double.self, forKey: .removed)
        toolIds = try values.decodeIfPresent([String].self, forKey: .toolIds)
    }
    var title: String { line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Mac activity" : line }
    var displayTitle: String {
        guard added != nil, removed != nil else { return title }
        let sentence = title.replacingOccurrences(of: #"\s*\+\d+\s*[−-]\s*\d+\s*$"#, with: "", options: .regularExpression)
        return sentence.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Mac activity" : sentence
    }
}

enum MacMessageBlock: Decodable, Equatable {
    case text(String)
    case group(MacActivityGroup)
    case unsupported

    private enum CodingKeys: String, CodingKey { case kind, text }
    init(from decoder: Decoder) throws {
        guard let values = try? decoder.container(keyedBy: CodingKeys.self),
              let kind = try? values.decode(String.self, forKey: .kind) else { self = .unsupported; return }
        switch kind {
        case "text":
            if let text = try? values.decode(String.self, forKey: .text) { self = .text(text) }
            else { self = .unsupported }
        case "group":
            if let group = try? MacActivityGroup(from: decoder), !group.id.isEmpty { self = .group(group) }
            else { self = .unsupported }
        default: self = .unsupported
        }
    }
}

enum MacMessageTimelineItem: Identifiable, Equatable {
    case text(id: String, text: String)
    case group(MacActivityGroup, tools: [MacToolActivity])
    case tool(MacToolActivity)

    var id: String {
        switch self {
        case .text(let id, _): return id
        case .group(let group, _): return "group-" + group.id
        case .tool(let tool): return "tool-" + tool.id
        }
    }
}

struct MacToolActivity: Decodable, Identifiable, Equatable {
    struct Ask: Decodable, Equatable { var why: String?; var detail: String? }
    var id: String
    var name: String
    var preview: String?
    var effect: String?
    var scope: String?
    var verb: String?
    var target: String?
    var ask: Ask?
    var state: String
    var result: String?
    var live: Bool?
    var approved: Bool?
    var durationMs: Double?

    var isBrowser: Bool { name.lowercased().contains("browser") }
    var isRunning: Bool { state == "running" || state == "approved" }
    var title: String {
        if let verb, !verb.isEmpty { return verb }
        if isBrowser { return "Browser activity" }
        if name.lowercased().contains("shell") || scope == "shell" { return "Run a command" }
        return name.replacingOccurrences(of: "_", with: " ")
    }
    var statusLabel: String {
        switch state {
        case "proposed": return "Needs approval"
        case "approved", "running": return "Working"
        case "done": return "Completed"
        case "denied": return "Denied"
        case "error": return "Failed"
        default: return state.capitalized
        }
    }
    var icon: String {
        if isBrowser { return "globe" }
        if scope == "shell" { return "terminal" }
        if scope == "write" { return "doc.badge.gearshape" }
        return "wrench.and.screwdriver"
    }
    var browserURL: URL? {
        guard isBrowser, let target, let url = URL(string: target), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        return url
    }
}

struct MacConversationList: Decodable { var conversations: [MacConversationSummary]; var activeChatId: String? }
struct MacConversationDetail: Decodable { var conversation: MacConversation; var pending: [MacToolActivity] }

struct PairedConnection: Codable, Equatable {
    var baseURL: URL
    var macName: String
    var fingerprint: String
    var token: String
    // Optional for existing Keychain records. Every route belongs to this same
    // pairing and must present the exact saved certificate before HTTP is sent.
    var endpoints: [CompanionEndpoint]? = nil
    // Notification inboxes were historically scoped to the enrollment URL.
    // Keep that exact spelling when the saved connection address later changes.
    var originalPairingURL: URL? = nil
}

struct CompanionEndpoint: Codable, Equatable {
    enum Kind: String, Codable, CaseIterable { case lan, tailscale }
    var kind: Kind
    var url: URL

    func validated() throws -> CompanionEndpoint {
        guard url.absoluteString.utf8.count <= 2048 else { throw CompanionError.invalidInvitation("Enter a Mac address of at most 2048 characters.") }
        let checked = try PairingInvitation.validatedURL(url.absoluteString)
        var parts = URLComponents(url: checked, resolvingAgainstBaseURL: false)!
        parts.host = parts.host?.lowercased(); parts.path = ""
        if parts.port == 443 { parts.port = nil }
        guard let normalized = parts.url else { throw CompanionError.invalidInvitation("Enter a valid Mac HTTPS address.") }
        return CompanionEndpoint(kind: kind, url: normalized)
    }

    static func merged(_ values: [CompanionEndpoint], keeping first: CompanionEndpoint) throws -> [CompanionEndpoint] {
        var result = [try first.validated()]
        // Keep the saved route, then reserve space for reachable-away routes
        // even when DHCP has left an old LAN address outside the new inventory.
        let checked = try values.map { try $0.validated() }
        for value in checked.filter({ $0.kind == .tailscale }) + checked.filter({ $0.kind == .lan }) {
            if !result.contains(where: { $0.url == value.url }) { result.append(value) }
        }
        return Array(result.prefix(8))
    }
}

struct CompanionConnectionDetails: Decodable {
    var macName: String
    var endpoints: [CompanionEndpoint]

    func validatedEndpoints() throws -> [CompanionEndpoint] {
        guard endpoints.count <= 8 else { throw CompanionError.server("The Mac returned too many connection addresses.") }
        let result = try endpoints.map { try $0.validated() }
        guard Set(result.map(\.url)).count == result.count else { throw CompanionError.server("The Mac returned duplicate connection addresses.") }
        return result
    }
}

enum CompanionError: LocalizedError {
    case invalidInvitation(String)
    case server(String)
    case unpaired
    case keychain(Int32)
    var errorDescription: String? {
        switch self {
        case .invalidInvitation(let message), .server(let message): return message
        case .unpaired: return "Pair with your Mac to continue."
        case .keychain: return "Your connection could not be saved securely. Please try pairing again."
        }
    }
}

struct PairingInvitation: Equatable {
    var url: String
    var code: String
    var fingerprint: String

    static func validatedURL(_ value: String) throws -> URL {
        guard let url = URL(string: value), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              (parts.path.isEmpty || parts.path == "/"), (parts.port ?? 443) > 0, (parts.port ?? 443) <= 65535 else {
            throw CompanionError.invalidInvitation("Enter the HTTPS address shown on your Mac, including its port.")
        }
        return url
    }

    static func normalizedFingerprint(_ value: String) throws -> String {
        let fingerprint = value.replacingOccurrences(of: ":", with: "").lowercased()
        guard fingerprint.count == 64, fingerprint.allSatisfy({ $0.isASCII && $0.isHexDigit }) else {
            throw CompanionError.invalidInvitation("The Mac certificate fingerprint must contain 64 hexadecimal characters. Scan the QR code to fill it in.")
        }
        return fingerprint
    }

    static func parse(_ value: String) throws -> PairingInvitation {
        guard let parts = URLComponents(string: value), parts.scheme == "strata", parts.host == "pair" else {
            throw CompanionError.invalidInvitation("This is not a Strata pairing code. Choose Pair iPhone in Strata on your Mac and scan its QR code.")
        }
        let items = parts.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count else {
            throw CompanionError.invalidInvitation("The pairing code contains duplicate fields.")
        }
        func item(_ key: String) -> String? { items.first { $0.name == key }?.value }
        let address: String
        if let url = item("url") { address = url }
        else if let host = item("host"), let port = item("port"), let number = Int(port), (1...65535).contains(number) {
            var endpoint = URLComponents(); endpoint.scheme = "https"; endpoint.host = host; endpoint.port = number
            guard let url = endpoint.url else { throw CompanionError.invalidInvitation("The Mac address is invalid.") }
            address = url.absoluteString
        } else { throw CompanionError.invalidInvitation("The pairing code is missing the Mac address.") }
        _ = try validatedURL(address)
        guard let code = item("code"), code.count == 6, code.allSatisfy({ $0 >= "0" && $0 <= "9" }),
              let pin = item("fingerprint") else {
            throw CompanionError.invalidInvitation("The pairing code is incomplete. Generate a new code on your Mac.")
        }
        return PairingInvitation(url: address, code: code, fingerprint: try normalizedFingerprint(pin))
    }
}
