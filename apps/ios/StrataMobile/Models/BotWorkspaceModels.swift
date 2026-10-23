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
    var harness: BotHarnessDiagnostics?
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

struct BotHarnessDiagnostics: Decodable, Equatable {
    struct Timings: Decodable, Equatable {
        var startingMs: Int; var modelMs: Int; var approvalMs: Int; var toolMs: Int; var cleanupMs: Int
    }
    var phase: String
    var elapsedMs: Int
    var firstOutputMs: Int?
    var timings: Timings
    var toolCalls: Int
    var toolErrors: Int
    var contextCompactions: Int
    var isValid: Bool {
        let numbers = [elapsedMs, timings.startingMs, timings.modelMs, timings.approvalMs, timings.toolMs, timings.cleanupMs, toolCalls, toolErrors, contextCompactions] + (firstOutputMs.map { [$0] } ?? [])
        return ["starting", "model", "approval", "tool", "cleanup", "completed", "interrupted", "error"].contains(phase) && numbers.allSatisfy { (0...604_800_000).contains($0) }
    }
    var label: String {
        switch phase {
        case "starting": "Preparing run"
        case "model": "Waiting for provider"
        case "approval": "Waiting for approval"
        case "tool": "Using tools"
        case "cleanup": "Finishing cleanup"
        case "completed": "Run finished"
        case "interrupted": "Run interrupted"
        default: "Run needs attention"
        }
    }
    static func seconds(_ ms: Int) -> String { String(format: ms < 10_000 ? "%.1fs" : "%.0fs", Double(max(0, ms)) / 1_000) }
}

struct BotHarnessAction: Decodable, Equatable, Identifiable {
    var id: String; var chatId: String; var toolName: String; var state: String
    var revision: Int; var proof: String; var origin: String; var readOnly: Bool
    var updatedAt: BotWorkspaceTimestamp?
    var hasValidProof: Bool {
        id.count == 67 && id.hasPrefix("ba_") && id.dropFirst(3).utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } &&
        proof.count == 64 && proof.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } &&
        (1...9_007_199_254_740_991).contains(revision) && CompanionClient.isSafeIdentifier(chatId) &&
        ["local", "ssh-worker"].contains(origin) && ["pending", "succeeded", "error", "interrupted", "uncertain", "reviewed"].contains(state)
    }
    var needsReview: Bool { hasValidProof && (state == "uncertain" || state == "interrupted") }
    var canReview: Bool { needsReview && origin == "local" && !readOnly }
    func matches(_ other: Self) -> Bool { id == other.id && chatId == other.chatId && toolName == other.toolName && origin == other.origin && readOnly == other.readOnly && revision == other.revision && proof == other.proof && other.canReview }
}
struct BotHarnessActionsSnapshot: Decodable, Equatable {
    var available: Bool; var actions: [BotHarnessAction]; var counts: [String: Int]; var hasMore: Bool; var reason: String?
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
    var talkativeness: [String: Int]? = nil
    var bidding: Bool? = nil
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
    var planId: String?
    var workTurns: Int {
        let total = max(0, consumedTurns)
        return total - min(total, max(0, rosterFanoutTurns ?? 0))
    }
    var limits: BotTeamLimits?
    func turnLabel(unrestrictedTeams: Bool, continuousTeams: Bool = false) -> String {
        if let limits, limits != .continuous {
            return "\(consumedTurns) of \(limits.maxTurns) turns · depth \(limits.maxDepth) · \(limits.maxHops) hops"
        }
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
    var teamCoordinatorWorkToolsSupported: Bool?
    var teamWorkflowsSupported: Bool?
    var teamWorkPlansSupported: Bool?
    var teamComputers: [BotTeamComputer]?
}

/// Saved workflow state is authoritative. Evaluator checks are separate from
/// the owner's explicit acceptance, and a finished bot turn is never completion.
struct BotTeamWorkflow: Decodable, Identifiable, Equatable {
    enum Phase: String, Decodable {
        case planning, building, evaluating, repairing, awaitingReview = "awaiting_review"
        case completed, blocked, interrupted, stopping, stopped
        var label: String {
            switch self {
            case .awaitingReview: "Ready for your review"
            case .completed: "Accepted by you"
            case .repairing: "Addressing evaluator feedback"
            case .blocked: "Needs attention"
            default: rawValue.capitalized
            }
        }
        var isActive: Bool { [.planning, .building, .evaluating, .repairing, .stopping].contains(self) }
    }
    struct Criterion: Decodable, Identifiable, Equatable { var id: String; var text: String }
    struct Check: Decodable, Equatable { var criterionId: String; var passed: Bool; var detail: String }
    struct Plan: Decodable, Equatable { var summary: String; var items: [String] }
    struct Step: Decodable, Identifiable, Equatable {
        enum State: String, Decodable { case pending, running, completed, blocked, interrupted, stopped }
        var id: String; var phase: Phase; var botId: String; var state: State
        var chatId: String?; var runId: String?; var summary: String?; var evidence: [BotTeamEvidence]?
        var startedAt: BotWorkspaceTimestamp?; var completedAt: BotWorkspaceTimestamp?
    }
    var id: String; var teamId: String; var goal: String
    var plannerId: String; var builderId: String; var evaluatorId: String
    var criteria: [Criterion]; var phase: Phase; var revision: Int; var proof: String; var round: Int
    var summary: String?; var createdAt: BotWorkspaceTimestamp; var updatedAt: BotWorkspaceTimestamp
    var plan: Plan?; var steps: [Step]; var checks: [Check]; var canResume: Bool; var blockedReason: String?
    var totalSteps: Int; var stepsTruncated: Bool
    var canStop: Bool { hasValidProof && phase.isActive }
    var canReview: Bool { hasValidProof && phase == .awaitingReview }
    var canContinue: Bool { hasValidProof && canResume && [.blocked, .interrupted, .stopped].contains(phase) }
    var showsCurrentEvaluation: Bool { [.awaitingReview, .completed].contains(phase) }
    var hasValidProof: Bool {
        guard Self.validID(id, prefix: "wf_"), CompanionClient.isSafeIdentifier(teamId),
              [plannerId, builderId, evaluatorId].allSatisfy(CompanionClient.isSafeIdentifier), builderId != evaluatorId,
              (1...9_007_199_254_740_991).contains(revision), (0...9_007_199_254_740_991).contains(round),
              proof.utf8.count == 64, proof.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              Self.validText(goal, maximum: 16_000, empty: false), Self.validTimestamp(createdAt), Self.validTimestamp(updatedAt),
              summary.map({ Self.validText($0, maximum: 8_000) }) ?? true,
              blockedReason.map({ Self.validText($0, maximum: 2_500) }) ?? true,
              (1...16).contains(criteria.count), Set(criteria.map(\.id)).count == criteria.count,
              criteria.allSatisfy({ Self.validID($0.id, prefix: "wc_") && Self.validText($0.text, maximum: 1_000, empty: false) }),
              steps.count <= 12, (steps.count...9_007_199_254_740_991).contains(totalSteps), stepsTruncated == (totalSteps > steps.count),
              Set(steps.map(\.id)).count == steps.count, steps.allSatisfy(validStep),
              checks.count <= 16, Set(checks.map(\.criterionId)).count == checks.count,
              checks.allSatisfy({ check in criteria.contains { $0.id == check.criterionId } && Self.validText(check.detail, maximum: 2_000, empty: false) }),
              !canResume || [.blocked, .interrupted, .stopped].contains(phase) else { return false }
        if let plan {
            guard Self.validText(plan.summary, maximum: 2_000, empty: false), (1...16).contains(plan.items.count),
                  plan.items.allSatisfy({ Self.validText($0, maximum: 1_000, empty: false) }) else { return false }
        }
        if [.awaitingReview, .completed].contains(phase) {
            return checks.count == criteria.count && checks.allSatisfy(\.passed) && steps.last?.phase == .evaluating && steps.last?.state == .completed
        }
        return true
    }
    private func validStep(_ step: Step) -> Bool {
        let expectedBot = step.phase == .planning ? plannerId : step.phase == .evaluating ? evaluatorId : builderId
        guard Self.validID(step.id, prefix: "ws_"), [.planning, .building, .evaluating, .repairing].contains(step.phase), step.botId == expectedBot,
              step.chatId.map(CompanionClient.isSafeIdentifier) ?? true, step.runId.map(CompanionClient.isSafeIdentifier) ?? true,
              step.summary.map({ Self.validText($0, maximum: 1_000) }) ?? true,
              step.startedAt.map(Self.validTimestamp) ?? true, step.completedAt.map(Self.validTimestamp) ?? true,
              (step.evidence?.count ?? 0) <= 4 else { return false }
        return (step.evidence ?? []).allSatisfy { row in
            guard ["file", "test", "link", "note"].contains(row.kind), Self.validText(row.label, maximum: 160, empty: false), Self.validText(row.detail, maximum: 1_000, empty: false) else { return false }
            if row.kind != "link" { return true }
            guard let url = URL(string: row.detail), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.user == nil, url.password == nil, url.host != nil else { return false }
            return true
        }
    }
    static func validTimestamp(_ value: BotWorkspaceTimestamp) -> Bool {
        guard case .iso8601(let text) = value, text.range(of: "^\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z$", options: .regularExpression) != nil else { return false }
        return value.date != nil
    }
    static func validRequestID(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9_.:-]{1,160}$", options: .regularExpression) != nil }
    func matches(_ other: Self) -> Bool { id == other.id && teamId == other.teamId && revision == other.revision && proof == other.proof && self == other && hasValidProof }
    /// Availability is a fresh read of saved profiles/computers, not a new
    /// durable checkpoint. Every other field must retain the exact proof.
    func hasSameCheckpoint(as other: Self) -> Bool {
        var left = self, right = other
        left.canResume = false; right.canResume = false
        left.blockedReason = nil; right.blockedReason = nil
        return left == right
    }
    static func validID(_ value: String, prefix: String) -> Bool {
        value.hasPrefix(prefix) && UUID(uuidString: String(value.dropFirst(prefix.count))) != nil && value.count == prefix.count + 36
    }
    static func validText(_ value: String, maximum: Int, empty: Bool = true) -> Bool {
        value.utf16.count <= maximum && !value.contains("\0") && (empty || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
}

/// Presentation only: workflow stages never count as ordinary task completion.
struct BotTeamWorkflowWorkOverview {
    var working: [BotTeamWorkflow]
    var attention: [BotTeamWorkflow]
    var history: [BotTeamWorkflow]
    private var labels: [String: String]
    init(_ rows: [BotTeamWorkflow], teamId: String, supervision: [BotSupervisionSession] = []) {
        working = []; attention = []; history = []; labels = [:]
        for row in rows where row.teamId == teamId && row.hasValidProof {
            let current = row.steps.last
            let session = current?.chatId.flatMap { chat in supervision.first { $0.id == chat && $0.botId == current?.botId && $0.teamId == teamId } }
            let activeStep = current?.state == .pending || current?.state == .running
            let waiting = activeStep && (session?.state == .error || session?.state == .approval && (session?.approvalCount ?? 0) > 0)
            labels[row.id] = row.phase.isActive && waiting ? session?.statusLabel : row.phase == .stopping && row.blockedReason?.isEmpty == false ? "Cleanup needs attention" : row.phase.label
            if [.awaitingReview, .blocked, .interrupted].contains(row.phase) || row.phase.isActive && waiting || row.phase == .stopping && row.blockedReason?.isEmpty == false { attention.append(row) }
            else if row.phase.isActive { working.append(row) }
            else { history.append(row) }
        }
    }
    var summary: String { "\(working.count) working · \(attention.count) need you" }
    func statusLabel(_ row: BotTeamWorkflow) -> String { labels[row.id] ?? row.phase.label }
}

/// Incoming content growth must not be mistaken for an intentional scroll away.
struct BotTeamMessageFollowState: Equatable {
    private(set) var positioned = false
    private(set) var followingLatest = true
    private(set) var newestSequence = 0
    private(set) var acknowledgedSequence = 0
    var unreadCount: Int { max(0, newestSequence - acknowledgedSequence) }
    mutating func messagesChanged(to sequence: Int) -> Bool {
        guard sequence > 0 else { return false }
        if sequence < newestSequence { self = Self() }
        newestSequence = sequence
        guard !positioned || followingLatest else { return false }
        markLatestRead(); return true
    }
    mutating func viewportChanged(nearBottom: Bool, userInitiated: Bool) {
        if nearBottom { markLatestRead() }
        else if userInitiated { followingLatest = false }
    }
    mutating func markLatestRead() {
        positioned = true; followingLatest = true; acknowledgedSequence = newestSequence
    }
}

struct BotTeamWorkflowsSnapshot: Decodable, Equatable {
    var teamWorkflowsSupported: Bool
    var available: Bool
    var workflows: [BotTeamWorkflow]
    var hasMore: Bool
    var error: String?
    var isAvailable: Bool { teamWorkflowsSupported && available && error == nil }
}

struct BotTeamWorkflowDraft: Encodable, Equatable {
    var requestId: String
    var goal: String
    var plannerId: String
    var builderId: String
    var evaluatorId: String
    var criteria: [String]
    /// Read-only, local guidance. The host still revalidates saved bot policies
    /// and computers when creating or continuing actual work.
    func roleReadinessNotices(in bots: [CompanionBot]) -> [String] {
        [("Planner", plannerId), ("Builder", builderId), ("Evaluator", evaluatorId)].compactMap { role, id in
            guard !id.isEmpty else { return nil }
            guard let bot = bots.first(where: { $0.id == id }) else { return "\(role): this saved bot is unavailable. Refresh saved bots before starting." }
            if bot.paused == true { return "\(role): \(bot.name) is paused. Resume it in bot settings or choose another teammate." }
            if role != "Planner", bot.policy == "plan" { return "\(role): \(bot.name) uses Plan mode. Choose another bot for this role, or review its policy in bot settings." }
            return nil
        }
    }
    func isValid(memberIds: [String]) -> Bool {
        BotTeamWorkflow.validRequestID(requestId) &&
        BotTeamWorkflow.validText(goal, maximum: 16_000, empty: false) &&
        [plannerId, builderId, evaluatorId].allSatisfy { memberIds.contains($0) && CompanionClient.isSafeIdentifier($0) } &&
        builderId != evaluatorId && (1...16).contains(criteria.count) &&
        criteria.allSatisfy { BotTeamWorkflow.validText($0, maximum: 1_000, empty: false) }
    }
    static func criteria(from lines: String) -> [String] {
        lines.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
}

/// A durable team plan is distinct from transport completion. Task reports and
/// independent checks never record the owner's final acceptance.
struct BotTeamWorkPlan: Decodable, Identifiable, Equatable {
    enum Phase: String, Decodable {
        case planning, running, summarizing, awaitingReview = "awaiting_review", completed, blocked, interrupted, stopping, stopped
        var label: String {
            switch self {
            case .awaitingReview: "Ready for your review"
            case .completed: "Accepted by you"
            case .summarizing: "Preparing the team report"
            case .blocked: "Needs attention"
            default: rawValue.capitalized
            }
        }
        var isActive: Bool { [.planning, .running, .summarizing, .stopping].contains(self) }
    }
    enum TaskState: String, Decodable, CaseIterable {
        case pending, queued, running, working, readyForReview = "ready_for_review", blocked, interrupted, stopped
        var label: String {
            switch self {
            case .pending: "Waiting for prerequisites"
            case .queued: "Queued for saved computer"
            case .working: "Continuing from saved progress"
            case .readyForReview: "Result reported"
            default: rawValue.capitalized
            }
        }
    }
    struct Participation: Decodable, Equatable, Identifiable {
        var botId: String; var role: String; var reason: String
        var id: String { botId }
    }
    struct Task: Decodable, Equatable, Identifiable {
        enum Kind: String, Decodable { case work, review }
        var id: String; var key: String; var title: String; var instructions: String; var ownerId: String
        var collaboratorIds: [String]; var workspaceKey: String?; var dependsOn: [String]; var kind: Kind
        var criteria: [BotTeamWorkflow.Criterion]; var state: TaskState; var summary: String?; var nextStep: String?
        var checks: [BotTeamWorkflow.Check]?; var attemptId: String?; var instructionsTruncated: Bool?; var chatId: String?; var jobId: String?
        var evidence: [BotTeamEvidence]?
        func hasSameDefinition(as other: Self) -> Bool {
            if instructions == other.instructions, (instructionsTruncated == true) != (other.instructionsTruncated == true) { return false }
            guard BotTeamWorkPlan.samePreview(instructions, other.instructions, limits: [80, 200, 500, 1_000], shorterIsTruncated: instructionsTruncated == true, otherIsTruncated: other.instructionsTruncated == true) else { return false }
            var left = self, right = other
            left.instructions = ""; right.instructions = ""; left.instructionsTruncated = nil; right.instructionsTruncated = nil
            left.state = .pending; right.state = .pending
            left.summary = nil; right.summary = nil; left.nextStep = nil; right.nextStep = nil
            left.checks = nil; right.checks = nil; left.evidence = nil; right.evidence = nil
            left.attemptId = nil; right.attemptId = nil; left.chatId = nil; right.chatId = nil; left.jobId = nil; right.jobId = nil
            return left == right
        }
        func hasSameCheckpoint(as other: Self) -> Bool {
            guard hasSameDefinition(as: other), BotTeamWorkPlan.sameReport(summary, other.summary), BotTeamWorkPlan.sameReport(nextStep, other.nextStep),
                  checks?.count == other.checks?.count, evidence?.count == other.evidence?.count else { return false }
            var left = self, right = other
            for index in (checks ?? []).indices {
                guard BotTeamWorkPlan.sameReport(checks![index].detail, other.checks![index].detail) else { return false }
                left.checks![index].detail = ""; right.checks![index].detail = ""
            }
            for index in (evidence ?? []).indices where evidence![index].kind != "link" {
                guard BotTeamWorkPlan.sameReport(evidence![index].detail, other.evidence![index].detail) else { return false }
                left.evidence![index].detail = ""; right.evidence![index].detail = ""
            }
            left.instructions = ""; right.instructions = ""; left.instructionsTruncated = nil; right.instructionsTruncated = nil
            left.summary = nil; right.summary = nil; left.nextStep = nil; right.nextStep = nil
            return left == right
        }
    }
    struct Attempt: Decodable, Equatable, Identifiable {
        enum Kind: String, Decodable { case planning, task, synthesis }
        enum State: String, Decodable { case pending, running, completed, blocked, interrupted, stopped }
        var id: String; var kind: Kind; var taskId: String?; var botId: String; var state: State
        var chatId: String?; var jobId: String?; var summary: String?
        var startedAt: BotWorkspaceTimestamp?; var completedAt: BotWorkspaceTimestamp?
    }
    struct Counts: Decodable, Equatable {
        var pending: Int; var queued: Int; var running: Int; var working: Int
        var ready_for_review: Int; var blocked: Int; var interrupted: Int; var stopped: Int
        var values: [Int] { [pending, queued, running, working, ready_for_review, blocked, interrupted, stopped] }
        var total: Int { values.reduce(0, +) }
        var summary: String { "\(ready_for_review) of \(total) results reported · \(running + queued + working) in motion" }
    }
    var id: String; var teamId: String; var parentRunId: String; var sourceMessageId: String?; var goal: String
    var coordinatorId: String; var memberIds: [String]; var phase: Phase; var revision: Int; var proof: String
    var createdAt: BotWorkspaceTimestamp; var updatedAt: BotWorkspaceTimestamp; var summary: String?; var blockedReason: String?
    var participation: [Participation]; var tasks: [Task]; var counts: Counts; var totalTasks: Int; var tasksOffset: Int
    var nextTaskOffset: Int?; var tasksTruncated: Bool; var attempts: [Attempt]; var totalAttempts: Int; var attemptsTruncated: Bool; var canResume: Bool
    var canStop: Bool { hasValidProof && phase.isActive }
    var canReview: Bool { hasValidProof && phase == .awaitingReview }
    var canContinue: Bool { hasValidProof && canResume && ([.blocked, .interrupted, .stopped].contains(phase) || phase == .running && counts.blocked + counts.interrupted + counts.stopped > 0) }
    var hasValidProof: Bool {
        guard Self.validID(id, "tp_"), Self.safe(teamId), Self.safe(parentRunId), sourceMessageId.map(Self.safe) ?? true,
              Self.safe(coordinatorId), !memberIds.isEmpty, Set(memberIds).count == memberIds.count, memberIds.allSatisfy(Self.safe), memberIds.contains(coordinatorId),
              (1...9_007_199_254_740_991).contains(revision), proof.utf8.count == 64, proof.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              Self.text(goal, 16_000, false), BotTeamWorkflow.validTimestamp(createdAt), BotTeamWorkflow.validTimestamp(updatedAt),
              summary.map({ Self.text($0, 2_000) }) ?? true, blockedReason.map({ Self.text($0, 2_500) }) ?? true,
              participation.count <= memberIds.count, Set(participation.map(\.botId)).count == participation.count,
              participation.allSatisfy({ memberIds.contains($0.botId) && Self.text($0.role, 120, false) && Self.text($0.reason, 1_000, false) }),
              counts.values.allSatisfy({ (0...9_007_199_254_740_991).contains($0) }), counts.values.reduce(0.0, { $0 + Double($1) }) <= 9_007_199_254_740_991,
              counts.total == totalTasks, totalTasks >= 0, tasksOffset >= 0, tasksOffset <= totalTasks, tasks.count <= 64, tasks.count <= totalTasks - tasksOffset,
              Set(tasks.map(\.id)).count == tasks.count, Set(tasks.map(\.key)).count == tasks.count, tasks.allSatisfy(validTask),
              tasksTruncated == (tasks.count < totalTasks), nextTaskOffset.map({ $0 == tasksOffset + tasks.count && $0 < totalTasks && $0 > tasksOffset }) ?? (tasksOffset + tasks.count == totalTasks),
              attempts.count <= 12, (attempts.count...9_007_199_254_740_991).contains(totalAttempts), attemptsTruncated == (totalAttempts > attempts.count),
              Set(attempts.map(\.id)).count == attempts.count, attempts.allSatisfy(validAttempt),
              !canResume || [.blocked, .interrupted, .stopped].contains(phase) || phase == .running && counts.blocked + counts.interrupted + counts.stopped > 0 else { return false }
        if phase != .planning && !tasks.isEmpty && participation.count != memberIds.count { return false }
        if [.running, .summarizing, .awaitingReview, .completed].contains(phase), totalTasks == 0 { return false }
        if [.awaitingReview, .completed].contains(phase), counts.ready_for_review != totalTasks || attempts.last?.kind != .synthesis || attempts.last?.state != .completed { return false }
        let observedStates = Dictionary(grouping: tasks, by: \.state).mapValues(\.count)
        for (state, count) in zip(TaskState.allCases, counts.values) where (observedStates[state] ?? 0) > count { return false }
        return true
    }
    private func validTask(_ task: Task) -> Bool {
        guard Self.validID(task.id, "tpt_"), Self.key(task.key), Self.text(task.title, 160, false), Self.text(task.instructions, 1_000, false), memberIds.contains(task.ownerId),
              Set(task.collaboratorIds).count == task.collaboratorIds.count, task.collaboratorIds.allSatisfy({ $0 != task.ownerId && memberIds.contains($0) }),
              task.workspaceKey.map({ Self.text($0, 160, false) }) ?? true, Set(task.dependsOn).count == task.dependsOn.count, task.dependsOn.allSatisfy({ $0 != task.key && Self.key($0) }),
              (1...16).contains(task.criteria.count), Set(task.criteria.map(\.id)).count == task.criteria.count,
              task.criteria.allSatisfy({ Self.validID($0.id, "tpc_") && Self.text($0.text, 1_000, false) }),
              task.summary.map({ Self.text($0, 1_000) }) ?? true, task.nextStep.map({ Self.text($0, 1_000) }) ?? true,
              task.attemptId.map({ Self.validID($0, "tpa_") }) ?? true,
              task.chatId.map(Self.safe) ?? true, task.jobId.map(Self.safe) ?? true,
              (task.evidence?.count ?? 0) <= 4, (task.evidence ?? []).allSatisfy(Self.validEvidence),
              (task.checks?.count ?? 0) <= 16, Set((task.checks ?? []).map(\.criterionId)).count == (task.checks?.count ?? 0),
              (task.checks ?? []).allSatisfy({ check in task.criteria.contains { $0.id == check.criterionId } && Self.text(check.detail, 2_000, false) }) else { return false }
        if task.state == .readyForReview && task.evidence?.isEmpty != false { return false }
        if task.kind == .review && task.state == .readyForReview { return task.checks?.count == task.criteria.count && task.checks?.allSatisfy(\.passed) == true }
        return true
    }
    private static func validEvidence(_ row: BotTeamEvidence) -> Bool {
        guard ["file", "test", "link", "note"].contains(row.kind), text(row.label, 160, false), text(row.detail, 1_000, false) else { return false }
        if row.kind != "link" { return true }
        guard let url = URL(string: row.detail), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil, url.user == nil, url.password == nil else { return false }
        return true
    }
    private func validAttempt(_ attempt: Attempt) -> Bool {
        Self.validID(attempt.id, "tpa_") && memberIds.contains(attempt.botId) && (attempt.taskId.map({ Self.validID($0, "tpt_") }) ?? true) &&
        (attempt.kind == .task ? attempt.taskId != nil : attempt.taskId == nil && attempt.botId == coordinatorId) &&
        (attempt.chatId.map(Self.safe) ?? true) && (attempt.jobId.map(Self.safe) ?? true) && (attempt.summary.map({ Self.text($0, 1_000) }) ?? true) &&
        (attempt.startedAt.map(BotTeamWorkflow.validTimestamp) ?? true) && (attempt.completedAt.map(BotTeamWorkflow.validTimestamp) ?? true)
    }
    /// Core pages can shorten report previews to fit their byte budget. Only
    /// documented UTF-16 prefix boundaries may vary; saved authority and state stay exact.
    private static func samePreview(_ lhs: String, _ rhs: String, limits: [Int], shorterIsTruncated: Bool = true, otherIsTruncated: Bool = true) -> Bool {
        if lhs == rhs { return true }
        let a = Array(lhs.utf16), b = Array(rhs.utf16)
        let short = a.count < b.count ? a : b, long = a.count < b.count ? b : a
        guard a.count != b.count, (a.count < b.count ? shorterIsTruncated : otherIsTruncated), long.starts(with: short) else { return false }
        return limits.contains(short.count) || limits.contains(short.count + 1) && (0xD800...0xDBFF).contains(long[short.count])
    }
    private static func sameReport(_ lhs: String?, _ rhs: String?) -> Bool {
        guard let lhs, let rhs else { return lhs == rhs }
        return samePreview(lhs, rhs, limits: [80, 200, 500])
    }
    func hasSameCheckpoint(as other: Self) -> Bool {
        var left = self, right = other
        for task in tasks { if let previous = other.tasks.first(where: { $0.id == task.id || $0.key == task.key }), !task.hasSameCheckpoint(as: previous) { return false } }
        guard participation.count == other.participation.count, attempts.count == other.attempts.count else { return false }
        for index in participation.indices {
            guard Self.sameReport(participation[index].reason, other.participation[index].reason) else { return false }
            left.participation[index].reason = ""; right.participation[index].reason = ""
        }
        for index in attempts.indices {
            guard Self.sameReport(attempts[index].summary, other.attempts[index].summary) else { return false }
            left.attempts[index].summary = nil; right.attempts[index].summary = nil
        }
        left.tasks = []; right.tasks = []; left.tasksOffset = 0; right.tasksOffset = 0; left.nextTaskOffset = nil; right.nextTaskOffset = nil
        left.tasksTruncated = false; right.tasksTruncated = false; left.canResume = false; right.canResume = false; left.blockedReason = nil; right.blockedReason = nil
        return left == right
    }
    func hasSameScope(as other: Self) -> Bool {
        guard id == other.id, teamId == other.teamId, parentRunId == other.parentRunId, sourceMessageId == other.sourceMessageId,
              goal == other.goal, coordinatorId == other.coordinatorId, memberIds == other.memberIds, createdAt == other.createdAt,
              totalTasks >= other.totalTasks else { return false }
        return tasks.allSatisfy { task in
            guard let prior = other.tasks.first(where: { $0.id == task.id || $0.key == task.key }) else { return true }
            return task.hasSameDefinition(as: prior)
        }
    }
    func matches(_ other: Self) -> Bool { hasValidProof && id == other.id && teamId == other.teamId && revision == other.revision && proof == other.proof && hasSameCheckpoint(as: other) }
    static func validID(_ value: String, _ prefix: String) -> Bool { value == value.lowercased() && BotTeamWorkflow.validID(value, prefix: prefix) }
    static func safe(_ value: String) -> Bool { CompanionClient.isSafeIdentifier(value) }
    static func key(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9_.:-]{1,80}$", options: .regularExpression) != nil }
    static func text(_ value: String, _ maximum: Int, _ empty: Bool = true) -> Bool { BotTeamWorkflow.validText(value, maximum: maximum, empty: empty) }
}

struct BotTeamWorkPlansSnapshot: Decodable, Equatable {
    var teamWorkPlansSupported: Bool; var available: Bool; var plans: [BotTeamWorkPlan]; var hasMore: Bool; var error: String?
    var nextBeforePlanId: String?
    var isAvailable: Bool { teamWorkPlansSupported && available && error == nil }
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
    var workMode: BotTeamMessageWorkMode?
    var planId: String?
    var usesCompactCard: Bool { kind == "assignment" || kind == "report" && content.count > 1_800 }
    var compactPreview: String {
        let first = content.split(whereSeparator: \.isNewline).first.map(String.init) ?? content
        let length = kind == "assignment" ? 160 : 220
        return String(first.prefix(length)) + (first.count > length || first != content ? "…" : "")
    }
}

struct BotTeamPresence: Decodable, Equatable, Identifiable {
    var botId: String
    var state: String
    var runId: String
    var jobId: String
    var id: String { jobId }
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
    var presence: [BotTeamPresence]?
}

enum BotTeamMessageWorkMode: String, Codable, CaseIterable { case chat, work }

struct BotTeamChannelPost: Encodable, Equatable {
    var message: String
    var requestId: String
    var recipientIds: [String]?
    var replyToId: String?
    var workMode: BotTeamMessageWorkMode?
    var durablePlan: Bool?
    var everyone: Bool?
}

struct BotTeamDraft: Encodable {
    var name: String
    var memberIds: [String]
    var coordinatorId: String
    var enabled = false
    var limits = BotTeamLimits()
    var execution: BotTeamExecution?
    var briefing: BotTeamBriefing?
    var talkativeness: [String: Int]?
    var bidding: Bool?
}

struct BotTeamUpdate: Encodable {
    var expectedRevision: Int
    var name: String
    var memberIds: [String]
    var coordinatorId: String
    var limits: BotTeamLimits
    var execution: BotTeamExecution
    var briefing: BotTeamBriefing?
    var talkativeness: [String: Int]?
    var bidding: Bool?
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
    var earlierUnverifiedCount: Int { history.filter { $0.work?.legacy == true && $0.work?.status != .verified }.count }
    var earlierUnverifiedSummary: String {
        "\(earlierUnverifiedCount) earlier \(earlierUnverifiedCount == 1 ? "turn has" : "turns have") no verified result."
    }
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

/// Keep the complete reviewed schema, including scalar enum values. Unknown
/// JSON is never silently discarded when editing a tool from another device.
indirect enum BotToolJSON: Codable, Equatable {
    case object([String: BotToolJSON]), array([BotToolJSON]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let bool = try? value.decode(Bool.self) { self = .bool(bool) }
        else if let string = try? value.decode(String.self) { self = .string(string) }
        else if let number = try? value.decode(Double.self) { self = .number(number) }
        else if let array = try? value.decode([BotToolJSON].self) { self = .array(array) }
        else { self = .object(try value.decode([String: BotToolJSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let object): try value.encode(object)
        case .array(let array): try value.encode(array)
        case .string(let string): try value.encode(string)
        case .number(let number): try value.encode(number)
        case .bool(let bool): try value.encode(bool)
        case .null: try value.encodeNil()
        }
    }
    var formatted: String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }
}

struct BotCreatedTool: Decodable, Identifiable, Equatable {
    struct Provenance: Decodable, Equatable { var botId: String?; var chatId: String?; var turnId: String? }
    var id: String
    var name: String
    var description: String
    var command: String
    var inputSchema: BotToolJSON
    var timeoutSeconds: Int
    var status: String
    var revision: Int
    var digest: String
    var botIds: [String]
    var teamIds: [String]
    var provenance: Provenance?
    var requirements: BotToolRequirements?
    var isEnabled: Bool { status == "enabled" }
    func matchesReview(_ other: Self) -> Bool { id == other.id && revision == other.revision && digest == other.digest }
    var hasValidReview: Bool {
        CompanionClient.isSafeIdentifier(id) && revision > 0 && digest.count == 64 && digest.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}

struct BotCreatedToolsSnapshot: Decodable, Equatable {
    var tools: [BotCreatedTool]
    var createdToolsSupported: Bool?
    var createdToolReadinessSupported: Bool?
    var reason: String?
    var isAvailable: Bool { createdToolsSupported == true && reason == nil }
}

struct BotToolRequirements: Codable, Equatable {
    var platforms: [String] = []
    var executables: [String] = []
    var workspaceFiles: [String] = []
    private enum CodingKeys: String, CodingKey { case platforms, executables, workspaceFiles }
    init(platforms: [String] = [], executables: [String] = [], workspaceFiles: [String] = []) {
        self.platforms = platforms; self.executables = executables; self.workspaceFiles = workspaceFiles
    }
    init(from decoder: Decoder) throws {
        struct Field: CodingKey {
            var stringValue: String; var intValue: Int? { nil }
            init?(stringValue: String) { self.stringValue = stringValue }; init?(intValue: Int) { return nil }
        }
        let allFields = try decoder.container(keyedBy: Field.self)
        guard allFields.allKeys.allSatisfy({ ["platforms", "executables", "workspaceFiles"].contains($0.stringValue) }) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unsupported tool requirement field."))
        }
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        platforms = fields.contains(.platforms) ? try fields.decode([String].self, forKey: .platforms) : []
        executables = fields.contains(.executables) ? try fields.decode([String].self, forKey: .executables) : []
        workspaceFiles = fields.contains(.workspaceFiles) ? try fields.decode([String].self, forKey: .workspaceFiles) : []
        guard isValid else { throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid tool requirements.")) }
    }
    var isValid: Bool {
        guard platforms.count <= 3, Set(platforms).count == platforms.count, platforms.allSatisfy({ ["darwin", "linux", "win32"].contains($0) }),
              executables.count <= 16, Set(executables).count == executables.count,
              executables.allSatisfy({ $0.range(of: "^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$", options: .regularExpression) == $0.startIndex..<$0.endIndex }),
              workspaceFiles.count <= 16, Set(workspaceFiles).count == workspaceFiles.count else { return false }
        return workspaceFiles.allSatisfy { path in
            !path.isEmpty && path.utf16.count <= 240 && !path.contains("\\") &&
            path.range(of: "^[A-Za-z]:", options: .regularExpression) == nil &&
            !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) &&
            path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
        }
    }
}

struct BotCreatedToolDraft: Encodable {
    var name = ""
    var description = ""
    var command = ""
    var inputSchema: BotToolJSON = .object(["type": .string("object"), "properties": .object([:]), "required": .array([]), "additionalProperties": .bool(false)])
    var timeoutSeconds = 30
    var requirements: BotToolRequirements?
    init() { }
    init(tool: BotCreatedTool) {
        name = tool.name; description = tool.description; command = tool.command; inputSchema = tool.inputSchema; timeoutSeconds = tool.timeoutSeconds; requirements = tool.requirements
    }
    var isValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.utf16.count <= 120 &&
        description.utf16.count <= 2_000 && !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && command.utf16.count <= 32_000 &&
        ![name, description, command].contains(where: { $0.contains("\0") }) && (1...120).contains(timeoutSeconds) && (requirements?.isValid ?? true) && Self.isSupportedSchema(inputSchema)
    }
    /// V1 accepts flat object inputs. The Mac validates the complete definition
    /// again before saving; this check gives immediate feedback on the phone.
    static func isSupportedSchema(_ schema: BotToolJSON) -> Bool {
        func safeInteger(_ value: Double) -> Bool { value.isFinite && value.rounded() == value && abs(value) <= 9_007_199_254_740_991 }
        guard case .object(let root) = schema, root["type"] == .string("object"), root["additionalProperties"] == .bool(false),
              Set(root.keys).isSubset(of: ["type", "properties", "required", "additionalProperties"]),
              case .object(let properties) = root["properties"], properties.count <= 32,
              case .array(let required) = root["required"],
              let data = try? JSONEncoder().encode(schema), data.count <= 16_000 else { return false }
        var requiredNames = Set<String>()
        for value in required {
            guard case .string(let name) = value, properties[name] != nil, requiredNames.insert(name).inserted else { return false }
        }
        for (name, value) in properties {
            guard name.range(of: "^[A-Za-z_][A-Za-z0-9_]{0,63}$", options: .regularExpression) != nil,
                  !["__proto__", "prototype", "constructor"].contains(name), case .object(let property) = value,
                  Set(property.keys).isSubset(of: ["type", "description", "enum", "minimum", "maximum", "maxLength"]),
                  case .string(let type) = property["type"], ["string", "number", "integer", "boolean"].contains(type) else { return false }
            if let description = property["description"] { guard case .string(let text) = description, text.utf16.count <= 500, !text.contains("\0") else { return false } }
            for bound in ["minimum", "maximum"] {
                if let value = property[bound] { guard ["number", "integer"].contains(type), case .number(let number) = value, number.isFinite, type != "integer" || safeInteger(number) else { return false } }
            }
            if case .number(let minimum) = property["minimum"], case .number(let maximum) = property["maximum"], minimum > maximum { return false }
            if let length = property["maxLength"] { guard type == "string", case .number(let number) = length, safeInteger(number), (0...64_000).contains(number) else { return false } }
            if let values = property["enum"] {
                guard case .array(let list) = values, !list.isEmpty, list.count <= 64 else { return false }
                for item in list {
                    switch (type, item) {
                    case ("string", .string(let string)) where !string.contains("\0"): break
                    case ("boolean", .bool): break
                    case ("number", .number(let number)) where number.isFinite: break
                    case ("integer", .number(let number)) where safeInteger(number): break
                    default: return false
                    }
                }
            }
        }
        return true
    }
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
