import Foundation

struct BotTeamLimits: Codable, Equatable {
    var maxParallel = 2
    var maxDepth = 2
    var maxHops = 8
    var maxTurns = 24
    var maxDurationMs = 600_000
}

struct BotTeam: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var memberIds: [String]
    var coordinatorId: String
    var enabled: Bool
    var limits: BotTeamLimits
    var createdAt: BotWorkspaceTimestamp?
    var channelPreview: BotTeamChannelPreview?
    var revision: Int?
    var execution: BotTeamExecution?
    var briefing: BotTeamBriefing?
}

/// Public, team-scoped guidance. A bot's private profile is managed separately.
struct BotTeamBriefing: Codable, Equatable {
    var instructions = ""
    var members: [BotTeamMemberBriefing] = []
}

struct BotTeamMemberBriefing: Codable, Equatable, Identifiable {
    var botId: String
    var role = ""
    var instructions = ""
    var id: String { botId }
}

/// The target is a configured Mac/SSH computer or a member's exact CUA guest.
/// A team never invents a new SSH connection or computer from a path.
struct BotTeamExecution: Codable, Equatable {
    var mode: String
    var computerId: String?
    var workspace: String?
    static var individual: Self { Self(mode: "individual") }
    var isShared: Bool { mode == "shared" }
}

struct BotTeamComputer: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var label: String
    var computerMode: String
    var workspace: String
    var available: Bool
    var detail: String?
    var memberId: String?
    var isIsolated: Bool { computerMode == "cua" }
    func allowsFolder(_ path: String) -> Bool {
        !isIsolated || ((path == "/workspace" || path.hasPrefix("/workspace/")) && !path.split(separator: "/").contains(".."))
    }
}

struct BotTeamChannelPreview: Decodable, Equatable {
    var id: String
    var sequence: Int
    var kind: String
    var author: BotTeamChannelAuthor
    var content: String
    var createdAt: BotWorkspaceTimestamp
    var line: String { author.type == "system" ? content : "\(author.name): \(content)" }
}

struct BotTeamRun: Decodable, Identifiable, Equatable {
    var id: String
    var teamId: String
    var rootChatId: String
    var rootBotId: String
    var state: String
    var consumedTurns: Int
    var detail: String?
    var isActive: Bool { ["queued", "running", "stopping", "cleanup_pending"].contains(state) }
    var stateLabel: String { state.replacingOccurrences(of: "_", with: " ").capitalized }
}

struct BotTeamsSnapshot: Decodable, Equatable {
    var teams: [BotTeam]
    var runs: [BotTeamRun]
    var reason: String?
    var teamSettingsSupported: Bool?
    var teamInstructionsSupported: Bool?
    var teamComputers: [BotTeamComputer]?
}

/// Immutable, attributed entries in the shared room. Detailed Thinking and tool
/// activity stay in the linked bot conversation instead of being duplicated here.
struct BotTeamChannelAuthor: Decodable, Equatable {
    var type: String
    var botId: String?
    var name: String
    var avatarConfig: AvatarConfig?
}

struct BotTeamChannelMessage: Decodable, Identifiable, Equatable {
    var id: String
    var sequence: Int
    var teamId: String
    var kind: String
    var author: BotTeamChannelAuthor
    var content: String
    var createdAt: BotWorkspaceTimestamp
    var replyToId: String?
    var recipientIds: [String]?
    var runId: String?
    var chatId: String?
    var state: String?
}

struct BotTeamChannel: Decodable, Equatable {
    var teamId: String
    var supported: Bool
    var messages: [BotTeamChannelMessage]
    var activeRuns: [BotTeamRun]
    var nextSequence: Int
    var hasMore: Bool?
    var hasMoreBefore: Bool?
    var reason: String?
}

struct BotTeamChannelPost: Encodable, Equatable {
    var message: String
    var requestId: String
    var recipientIds: [String]?
    var replyToId: String?
}

struct BotTeamDraft: Encodable {
    var name: String
    var memberIds: [String]
    var coordinatorId: String
    var enabled = false
    var limits = BotTeamLimits()
    var execution: BotTeamExecution?
    var briefing: BotTeamBriefing?
}

struct BotTeamUpdate: Encodable {
    var expectedRevision: Int
    var name: String
    var memberIds: [String]
    var coordinatorId: String
    var limits: BotTeamLimits
    var execution: BotTeamExecution
    var briefing: BotTeamBriefing?
}

struct BotWorkspaceActivity: Decodable, Identifiable, Equatable {
    var id: String
    var type: String
    var teamId: String
    var runId: String
    var botId: String?
    var chatId: String?
    var parentChatId: String?
    var title: String
    var state: String
    var fromBotId: String?
    var toBotId: String?
    var detail: String?
    var icon: String { type == "subagent" ? "arrow.triangle.branch" : type == "delivery" ? "bubble.left.and.bubble.right" : "person.3.sequence" }
}

enum BotSkillRevision: Codable, Equatable, CustomStringConvertible {
    case number(Int), digest(String)
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let number = try? value.decode(Int.self) { self = .number(number) }
        else { self = .digest(try value.decode(String.self)) }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self { case .number(let number): try value.encode(number); case .digest(let digest): try value.encode(digest) }
    }
    var description: String { switch self { case .number(let number): String(number); case .digest(let digest): String(digest.prefix(12)) } }
}

struct BotSkill: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var description: String
    var body: String
    var triggers: [String]
    var source: String
    var status: String
    var revision: BotSkillRevision
    var digest: String
    var botIds: [String]
    var isLibrary: Bool { source == "library" }
    var isEnabled: Bool { status == "enabled" }
}

struct BotSkillAssignment: Decodable, Equatable {
    var botId: String
    var skillIds: [String]
}

struct BotSkillsSnapshot: Decodable, Equatable {
    var skills: [BotSkill]
    var assignments: [BotSkillAssignment]
    var reason: String?
}

struct BotSkillDraft: Encodable {
    var name = ""
    var description = ""
    var body = ""
    var triggers: [String] = []
    init() { }
    init(skill: BotSkill) { name = skill.name; description = skill.description; body = skill.body; triggers = skill.triggers }
}

struct BotConnectionTool: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var description: String
    var readOnly: Bool
}

enum BotWorkspaceTimestamp: Decodable, Equatable {
    case milliseconds(Double), iso8601(String)
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let number = try? value.decode(Double.self) { self = .milliseconds(number) }
        else { self = .iso8601(try value.decode(String.self)) }
    }
    var date: Date? {
        switch self {
        case .milliseconds(let value): return Date(timeIntervalSince1970: value / 1_000)
        case .iso8601(let value):
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        }
    }
}

struct BotConnectorFeatures: Decodable, Equatable {
    var catalog: Bool?
    var httpCreation: Bool?
    var teamAccess: Bool?
    var oauth: Bool?
}

struct BotConnectorCatalogEntry: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var description: String
    var category: String
    var transport: String
    var url: String?
    var authTypes: [String]
    var documentationURL: String?
    var setupNote: String?
}

struct BotConnectorCatalog: Decodable, Equatable {
    var connectors: [BotConnectorCatalogEntry]
    var connectorFeatures: BotConnectorFeatures?
    var reason: String?
}

struct BotConnectorAuth: Decodable, Equatable {
    var status: String
    var detail: String
    var authorizationURL: String?
    var expiresAt: String?
}

struct BotMCPConnection: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var transport: String
    var apiKeySet: Bool
    var inventoryDigest: String
    var botIds: [String]
    var enabledToolIds: [String]
    var readOnlyToolIds: [String]
    var status: String
    var detail: String
    var tools: [BotConnectionTool]
    var checkedAt: BotWorkspaceTimestamp?
    var url: String?
    var catalogId: String?
    var accountLabel: String?
    var authType: String?
    var teamIds: [String]?
    var customInstructions: String?
    var enabled: Bool?
    var auth: BotConnectorAuth?
    var oauthClientIdSet: Bool?
    var oauthClientSecretSet: Bool?
    var statusLabel: String {
        if enabled == false { return "Disabled" }
        if auth?.status == "waiting" { return "Sign-in waiting" }
        return status == "starting" ? "Checking…" : status.capitalized
    }
}

struct BotConnectionsSnapshot: Decodable, Equatable {
    var connections: [BotMCPConnection]
    var reason: String?
    var connectorFeatures: BotConnectorFeatures?
}

/// Phone setup is deliberately HTTP-only. Programs and their environments are configured on Mac.
struct BotConnectorDraft: Encodable, Equatable {
    var name = ""
    var transport = "http"
    var url = ""
    var accountLabel = "Personal"
    var authType = "none"
    var catalogId: String?
    var apiKey: String?
    var clearKey: Bool?
    var expectedInventoryDigest: String?
    init() {}
    init(entry: BotConnectorCatalogEntry) {
        name = entry.name; url = entry.url ?? ""; catalogId = entry.id
        authType = entry.authTypes.contains("oauth") ? "oauth" : entry.authTypes.contains("bearer") ? "bearer" : "none"
    }
    init(connection: BotMCPConnection) {
        name = connection.name; url = connection.url ?? ""; accountLabel = connection.accountLabel ?? "Personal"
        authType = connection.authType ?? (connection.apiKeySet ? "bearer" : "none"); catalogId = connection.catalogId; expectedInventoryDigest = connection.inventoryDigest
    }
    var isValid: Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard transport == "http", !trimmed.isEmpty, name.utf16.count <= 120, !name.contains("\0"),
              !accountLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, accountLabel.utf16.count <= 120,
              !accountLabel.contains("\0"), ["none", "bearer", "oauth"].contains(authType),
              let value = URLComponents(string: url), let scheme = value.scheme?.lowercased(), let host = value.host,
              value.user == nil, value.password == nil, value.query == nil, value.fragment == nil,
              scheme == "https" || scheme == "http" && ["127.0.0.1", "localhost", "[::1]", "::1"].contains(host),
              url.utf16.count <= 4000 else { return false }
        return [apiKey].compactMap { $0 }.allSatisfy { $0.utf16.count <= 8192 && !$0.contains("\0") }
    }
    static func authorizationURL(_ value: String?) -> URL? {
        guard let value, let parts = URLComponents(string: value), parts.scheme?.lowercased() == "https", parts.host != nil, parts.user == nil, parts.password == nil else { return nil }
        return parts.url
    }
}

struct BotProviderModel: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var efforts: [String]
    var defaultEffort: String?
}

struct BotProviderModels: Decodable, Equatable {
    var provider: String
    var models: [BotProviderModel]
    var detail: String?
    var reason: String?
}
