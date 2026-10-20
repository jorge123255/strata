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
}

struct BotTeamDraft: Encodable {
    var name: String
    var memberIds: [String]
    var coordinatorId: String
    var enabled = false
    var limits = BotTeamLimits()
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
    var statusLabel: String { status == "starting" ? "Checking…" : status.capitalized }
}

struct BotConnectionsSnapshot: Decodable, Equatable {
    var connections: [BotMCPConnection]
    var reason: String?
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
