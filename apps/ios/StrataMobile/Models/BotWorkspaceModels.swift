import Foundation

/// A compact, read-only view of actual bot turns. Opening the exact conversation
/// revalidates its current approvals; these display records grant no authority.
struct BotSupervisionSnapshot: Decodable, Equatable {
    struct Counts: Decodable, Equatable {
        var waiting: Int
        var working: Int
        var completed: Int
        var errors: Int
    }
    var supported: Bool
    var sessions: [BotSupervisionSession]
    var counts: Counts
    var hasMore: Bool
    var reason: String?
    var headline: String {
        if counts.waiting > 0 { return "\(counts.waiting) conversation\(counts.waiting == 1 ? "" : "s") waiting for you" }
        if counts.working > 0 { return "\(counts.working) conversation\(counts.working == 1 ? "" : "s") in motion" }
        if counts.errors > 0 { return "A bot needs your attention" }
        return "Your conversations,\ntogether."
    }
}

struct BotSupervisionSession: Decodable, Identifiable, Equatable {
    enum State: String, Decodable { case approval, error, working, thinking, completed }
    var id: String
    var botId: String
    var name: String
    var title: String
    var state: State
    var approvalCount: Int
    var toolName: String?
    var computerName: String?
    var teamId: String?
    var parentChatId: String?
    var updatedAt: String?
    var needsAttention: Bool { state == .approval || state == .error }
    var isWorking: Bool { state == .working || state == .thinking }
    var context: String {
        let kind = parentChatId != nil ? "Subagent" : teamId != nil ? "Team conversation" : "Personal conversation"
        return computerName.map { kind + " · " + $0 } ?? kind
    }
    var statusLabel: String {
        switch state {
        case .approval: "\(approvalCount) approval\(approvalCount == 1 ? "" : "s") waiting"
        case .error: "Needs attention"
        case .working: "Using a tool"
        case .thinking: "Thinking"
        case .completed: "Finished"
        }
    }
}

enum BotSupervisionFilter: String, CaseIterable, Identifiable {
    case all = "All", attention = "Needs you", working = "Working", completed = "Recently finished"
    var id: String { rawValue }
    func includes(_ session: BotSupervisionSession) -> Bool {
        switch self { case .all: true; case .attention: session.needsAttention; case .working: session.isWorking; case .completed: session.state == .completed }
    }
    func count(_ counts: BotSupervisionSnapshot.Counts) -> Int {
        switch self { case .all: counts.waiting + counts.working + counts.completed + counts.errors; case .attention: counts.waiting + counts.errors; case .working: counts.working; case .completed: counts.completed }
    }
}

struct BotTeamLimits: Codable, Equatable {
    var maxParallel = 2
    var maxDepth = 2
    var maxHops = 8
    var maxTurns = 24
    var maxDurationMs = 600_000
    static let continuous = Self(maxParallel: 0, maxDepth: 0, maxHops: 0, maxTurns: 0, maxDurationMs: 0)
    func forHost(unrestrictedTeams: Bool, continuousTeams: Bool = false) -> Self {
        if continuousTeams { return .continuous }
        var value = self
        if unrestrictedTeams { value.maxParallel = 0 }
        else if value.maxParallel == 0 { value.maxParallel = 2 }
        if value.maxDepth == 0 { value.maxDepth = 2 }
        if value.maxHops == 0 { value.maxHops = 8 }
        if value.maxTurns == 0 { value.maxTurns = 24 }
        if value.maxDurationMs == 0 { value.maxDurationMs = 600_000 }
        return value
    }
    func parallelLabel(unrestrictedTeams: Bool = false) -> String {
        unrestrictedTeams || maxParallel == 0 ? "All available teammates" : "\(maxParallel) parallel"
    }
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
    var rosterFanoutTurns: Int?
    var workTurns: Int {
        let total = max(0, consumedTurns)
        return total - min(total, max(0, rosterFanoutTurns ?? 0))
    }
    func turnLabel(unrestrictedTeams: Bool, continuousTeams: Bool = false) -> String {
        if continuousTeams { return consumedTurns > 0 ? "\(consumedTurns) turns used" : "Until finished or stopped" }
        return unrestrictedTeams ? "\(workTurns) work turns" : "\(consumedTurns) turns"
    }
    var detail: String?
    var isActive: Bool { ["queued", "running", "stopping", "cleanup_pending"].contains(state) }
    var stateLabel: String { state.replacingOccurrences(of: "_", with: " ").capitalized }
    func requestStateLabel(workReviewSupported: Bool) -> String {
        workReviewSupported && state == "completed" ? "Turn finished" : stateLabel
    }
}

struct BotTeamsSnapshot: Decodable, Equatable {
    var teams: [BotTeam]
    var runs: [BotTeamRun]
    var reason: String?
    var teamSettingsSupported: Bool?
    var teamInstructionsSupported: Bool?
    var teamUnrestrictedSupported: Bool?
    var teamContinuousSupported: Bool?
    var teamWorkReviewSupported: Bool?
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
    var usesCompactCard: Bool { kind == "assignment" || kind == "report" && content.count > 1_800 }
    var compactPreview: String {
        let first = content.split(whereSeparator: \.isNewline).first.map(String.init) ?? content
        let length = kind == "assignment" ? 160 : 220
        return String(first.prefix(length)) + (first.count > length || first != content ? "…" : "")
    }
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
    var work: BotTeamWork?
    var createdAt: BotWorkspaceTimestamp?
    var updatedAt: BotWorkspaceTimestamp?
    var isExecutionActive: Bool { ["queued", "running", "stopping", "cleanup_pending"].contains(state) }
    var workStatusLabel: String {
        if isExecutionActive {
            switch state { case "queued": return "Queued"; case "stopping": return "Stopping"; case "cleanup_pending": return "Finishing cleanup"; default: return "Working" }
        }
        if work?.status == .readyForReview { return "Ready for review" }
        if work?.status == .working { return "Working" }
        if isClosedLegacyWork { return "Earlier turn" }
        if work?.recoveryJobId != nil { return "Continuation created" }
        return work?.status.label ?? state.replacingOccurrences(of: "_", with: " ").capitalized
    }
    /// History is explicit: missing evidence, a missing summary and an older
    /// result shape never imply that a modern task can be hidden.
    var isClosedLegacyWork: Bool { work?.legacy == true && !isExecutionActive && work?.status != .readyForReview && work?.status != .working }
    var isCurrentWork: Bool {
        guard let work else { return false }
        if isExecutionActive || [.readyForReview, .working].contains(work.status) { return true }
        return work.status != .verified && work.legacy != true
    }
    var needsOwnerAttention: Bool {
        guard let work else { return false }
        guard isCurrentWork, !isExecutionActive else { return false }
        return work.status == .readyForReview || work.recoveryJobId == nil && [.blocked, .interrupted].contains(work.status)
    }
    var isWorkingNow: Bool { isCurrentWork && (isExecutionActive || work?.status == .working) }
    var currentWorkPriority: Int { needsOwnerAttention ? 0 : isWorkingNow ? 1 : 2 }
    var latestWorkDate: Date? { updatedAt?.date ?? createdAt?.date }
    var icon: String { type == "subagent" ? "arrow.triangle.branch" : type == "delivery" ? "bubble.left.and.bubble.right" : "person.3.sequence" }
}

/// A task result is an attributed submission, not proof that its execution succeeded.
/// Only an explicit owner review can move a submitted result to Verified.
struct BotTeamWork: Decodable, Equatable {
    enum Status: String, Decodable {
        case working, readyForReview = "ready_for_review", verified, blocked, interrupted
        var label: String {
            switch self {
            case .working: "Working"
            case .readyForReview: "Ready for review"
            case .verified: "Verified"
            case .blocked: "Blocked"
            case .interrupted: "Interrupted"
            }
        }
    }
    var status: Status
    /// True only when the host explicitly identifies a pre-result task.
    var legacy: Bool?
    var revision: Int
    var summary: String?
    var evidence: [BotTeamEvidence]
    var resultHistory: [BotTeamResult]
    var reviewHistory: [BotTeamOwnerReview]
    var sourceJobId: String?
    var recoveryJobId: String?
    var evidenceSummary: String {
        let kinds = [("file", "file", "files"), ("test", "test result", "test results"), ("link", "link", "links"), ("note", "note", "notes")]
        let groups = kinds.compactMap { kind, single, plural -> String? in
            let count = evidence.filter { $0.kind == kind }.count
            return count > 0 ? "\(count) \(count == 1 ? single : plural)" : nil
        }
        return groups.isEmpty ? "No evidence yet" : groups.joined(separator: " · ")
    }
    var latestRequestedChanges: String? {
        guard let latest = reviewHistory.last, latest.decision == "reject" else { return nil }
        return latest.note?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? latest.note : "Review the earlier result and address the unfinished work."
    }
    var canReview: Bool { status == .readyForReview && revision > 0 }
    var canPlanRecovery: Bool { [.blocked, .interrupted].contains(status) && revision > 0 && recoveryJobId == nil }
}
/// Keeps action-bearing current work ahead of saved history without changing
/// the host's saved task state or issuing any requests.
struct BotTeamWorkOverview {
    var current: [BotWorkspaceActivity]
    var history: [BotWorkspaceActivity]
    var attentionCount: Int { current.filter(\.needsOwnerAttention).count }
    var workingCount: Int { current.filter(\.isWorkingNow).count }
    init(_ activity: [BotWorkspaceActivity]) {
        let tasks = activity.enumerated().filter { $0.element.work != nil }
        func order(_ a: (offset: Int, element: BotWorkspaceActivity), _ b: (offset: Int, element: BotWorkspaceActivity), priorities: Bool) -> Bool {
            if priorities, a.element.currentWorkPriority != b.element.currentWorkPriority { return a.element.currentWorkPriority < b.element.currentWorkPriority }
            let left = a.element.latestWorkDate ?? .distantPast, right = b.element.latestWorkDate ?? .distantPast
            if left != right { return left > right }
            return a.offset < b.offset
        }
        current = tasks.filter { $0.element.isCurrentWork }.sorted { order($0, $1, priorities: true) }.map(\.element)
        history = tasks.filter { !$0.element.isCurrentWork }.sorted { order($0, $1, priorities: false) }.map(\.element)
    }
}

struct BotTeamEvidence: Decodable, Equatable {
    var kind: String
    var label: String
    var detail: String
    var icon: String { switch kind { case "file": "doc"; case "test": "checklist"; case "link": "link"; default: "note.text" } }
}
struct BotTeamResult: Decodable, Equatable, Identifiable {
    var id: String
    var summary: String
    var evidence: [BotTeamEvidence]
    var submittedAt: BotWorkspaceTimestamp
    var botId: String
}
struct BotTeamOwnerReview: Decodable, Equatable {
    var decision: String
    var note: String?
    var reviewedAt: BotWorkspaceTimestamp
    var resultId: String
}
struct BotTeamRecoveryPlan: Decodable, Equatable, Identifiable {
    var id: String
    var jobId: String
    var sourceRunId: String
    var expectedRevision: Int
    var expiresAt: String
    var canResume: Bool
    var blockedReason: String?
    var botId: String
    var botName: String
    var provider: String
    var model: String
    var computerLabel: String
    var workspace: String
    var summary: String
    var completedReports: [CompletedReport]
    var steps: [String]
    struct CompletedReport: Decodable, Equatable {
        var jobId: String
        var chatId: String
        var reportId: String?
        var summary: String
    }
    func isExpired(at now: Date = Date()) -> Bool {
        let fractional = ISO8601DateFormatter(); fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let expiry = fractional.date(from: expiresAt) ?? ISO8601DateFormatter().date(from: expiresAt) else { return true }
        return expiry <= now
    }
}
struct BotTeamReviewRequest: Encodable, Equatable {
    var expectedRevision: Int
    var decision: String
    var note: String?
}
struct BotTeamResumeRequest: Encodable, Equatable {
    var planId: String
    var expectedRevision: Int
    var idempotencyKey: String
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
    var iphoneOAuth: Bool?
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
    var setupState: String?
    var sourceURL: String?
    var phoneSignIn: Bool?
    var aliases: [String]?
    var isReady: Bool { setupState == nil || setupState == "ready" }
    var setupSummary: String {
        switch setupState {
        case "configuration": "Set up on Mac"
        case "managed": "Managed connection"
        case "unavailable": "Setup unavailable"
        case nil, "ready": supportsSignIn ? "Sign in with your account" : authTypes.contains("bearer") ? "API key required" : "Service connection"
        default: "Review service setup"
        }
    }
    var supportsSignIn: Bool { id != "custom-http" && authTypes.contains("oauth") }
    var accountAction: String { !isReady ? "View setup" : supportsSignIn ? "Connect" : "Add account" }
    func nextAccountLabel(in connections: [BotMCPConnection]) -> String {
        let used = Set(connections.filter { $0.catalogId == id }.map { ($0.accountLabel ?? "Personal").lowercased() })
        if !used.contains("personal") { return "Personal" }
        var number = 2
        while used.contains("personal \(number)") { number += 1 }
        return "Personal \(number)"
    }
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
    var callbackTarget: String?
    var redirectURL: String?
}

/// Public authorization metadata only. PKCE and tokens remain on the paired Mac.
struct BotConnectorOAuthRequest: Equatable {
    static let redirect = "strata://connector-oauth/callback"
    let authorizationURL: URL
    private let state: String
    var expectedState: String { state }
    init?(auth: BotConnectorAuth?) {
        guard let auth, auth.callbackTarget == "iphone", auth.redirectURL == Self.redirect,
              let url = BotConnectorDraft.authorizationURL(auth.authorizationURL),
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.fragment == nil,
              parts.queryItems?.filter({ $0.name == "redirect_uri" }).map(\.value) == [Self.redirect],
              let states = parts.queryItems?.filter({ $0.name == "state" }), states.count == 1,
              let state = states[0].value, state.count == 64, state.allSatisfy({ "0123456789abcdef".contains($0) }) else { return nil }
        authorizationURL = url; self.state = state
    }
    func validatedCallback(_ url: URL) -> URL? {
        guard Self.isCallbackTarget(url), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let states = parts.queryItems?.filter({ $0.name == "state" }), states.count == 1,
              states[0].value == state else { return nil }
        return url
    }
    static func isCallbackTarget(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return parts.scheme == "strata" && parts.host == "connector-oauth" && parts.path == "/callback" &&
            parts.port == nil && parts.user == nil && parts.password == nil && parts.fragment == nil
    }
}

/// Own the entire sign-in attempt, including host completion and refresh after
/// the system browser closes. A stale continuation cannot clear its successor.
struct BotConnectorSignInProgress: Equatable {
    private(set) var attemptId: UUID?
    private(set) var nativeState: String?
    var isActive: Bool { attemptId != nil }
    mutating func begin() -> UUID? {
        guard !isActive else { return nil }
        let id = UUID(); attemptId = id; nativeState = nil; return id
    }
    func isCurrent(_ id: UUID) -> Bool { attemptId == id }
    func owns(_ id: UUID, state: String) -> Bool { isCurrent(id) && nativeState == state }
    @discardableResult mutating func bind(_ state: String, to id: UUID) -> Bool {
        guard isCurrent(id) else { return false }
        nativeState = state; return true
    }
    @discardableResult mutating func releaseFlow(_ state: String, from id: UUID) -> Bool {
        guard owns(id, state: state) else { return false }
        nativeState = nil; return true
    }
    @discardableResult mutating func finish(_ id: UUID) -> Bool {
        guard isCurrent(id) else { return false }
        attemptId = nil; nativeState = nil; return true
    }
    @discardableResult mutating func invalidate() -> String? {
        let captured = nativeState; attemptId = nil; nativeState = nil; return captured
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
