import Foundation
import Combine
import AuthenticationServices
import UIKit

/// A pairing-scoped view model. A revoked or replaced pairing cannot publish a
/// late catalog, mutation result, or conversation navigation into its successor.
@MainActor
final class BotWorkspaceStore: ObservableObject {
    @Published private(set) var teams: BotTeamsSnapshot?
    @Published private(set) var channels: [String: BotTeamChannel] = [:]
    @Published private(set) var activity: [BotWorkspaceActivity] = []
    @Published private(set) var recoveryPlans: [String: BotTeamRecoveryPlan] = [:]
    @Published private(set) var activityWorkReviewSupported = false
    @Published private(set) var supervision: BotSupervisionSnapshot?
    @Published private(set) var skills: BotSkillsSnapshot?
    @Published private(set) var connections: BotConnectionsSnapshot?
    @Published private(set) var connectorCatalog: BotConnectorCatalog?
    @Published private(set) var messages: [String: String] = [:]
    @Published private(set) var loading: Set<String> = []
    @Published private(set) var mutation: String?
    @Published private(set) var isPreparingAssignment = false
    private let client: CompanionClient?
    private let isCurrent: () -> Bool
    private let currentBotIds: () -> Set<String>?
    private var requests: [String: UUID] = [:]
    private var channelCursors: [String: Int] = [:]
    private var workErrorStatus: [String: Int] = [:]

    init(client: CompanionClient?, isCurrent: @escaping () -> Bool, currentBotIds: @escaping () -> Set<String>? = { nil }) {
        self.client = client; self.isCurrent = isCurrent; self.currentBotIds = currentBotIds
    }
    var unrestrictedTeams: Bool { teams?.teamUnrestrictedSupported == true }
    var continuousTeams: Bool { teams?.teamContinuousSupported == true }
    var workReviewSupported: Bool { teams?.teamWorkReviewSupported == true || activityWorkReviewSupported }

    func refreshTeams() async {
        await load("teams", path: "/v1/bots/teams") { (value: BotTeamsSnapshot) in self.teams = value; self.messages["teams"] = value.reason }
    }
    func refreshActivity() async {
        struct Snapshot: Decodable { var activity: [BotWorkspaceActivity]; var reason: String?; var teamWorkReviewSupported: Bool? }
        await load("activity", path: "/v1/bots/activity") { (value: Snapshot) in
            self.activity = value.activity; self.messages["activity"] = value.reason
            self.activityWorkReviewSupported = value.teamWorkReviewSupported == true
            self.recoveryPlans = self.recoveryPlans.filter { id, plan in
                value.activity.contains { $0.id == id && $0.work?.revision == plan.expectedRevision && $0.work?.canPlanRecovery == true }
            }
        }
    }
    func refreshSupervision() async {
        await load("supervision", path: "/v1/bots/supervision") { (value: BotSupervisionSnapshot) in self.supervision = value; self.messages["supervision"] = value.reason }
    }
    func refreshSkills() async {
        await load("skills", path: "/v1/bots/skills") { (value: BotSkillsSnapshot) in self.skills = value; self.messages["skills"] = value.reason }
    }
    func refreshConnections() async {
        await load("connections", path: "/v1/bots/connections") { (value: BotConnectionsSnapshot) in self.connections = value; self.messages["connections"] = value.reason }
    }
    func refreshConnectorCatalog() async {
        guard connections?.connectorFeatures?.catalog == true else { return }
        await load("connectorCatalog", path: "/v1/bots/connectors/catalog") { (value: BotConnectorCatalog) in self.connectorCatalog = value; self.messages["connectorCatalog"] = value.reason }
    }
    private func load<T: Decodable>(_ key: String, path: String, apply: (T) -> Void) async {
        guard let client, isCurrent() else { return }
        let request = UUID(); requests[key] = request; loading.insert(key)
        defer { if requests[key] == request { requests[key] = nil; loading.remove(key) } }
        do {
            let value: T = try await client.perform(path)
            guard isCurrent(), requests[key] == request, !Task.isCancelled else { return }
            messages[key] = nil; apply(value)
        } catch is CancellationError { }
        catch { if isCurrent(), requests[key] == request { messages[key] = error.localizedDescription } }
    }
    private func change<T: Decodable, Body: Encodable>(_ key: String, path: String, method: String = "POST", body: Body) async -> T? {
        guard let client, isCurrent(), mutation == nil else { return nil }
        mutation = key; messages[key] = nil; workErrorStatus[key] = nil
        requests[key] = nil; loading.remove(key)
        defer { mutation = nil }
        do {
            let value: T
            if method == "DELETE" { value = try await client.perform(path, method: method) }
            else { value = try await client.perform(path, method: method, jsonBody: body) }
            guard isCurrent(), !Task.isCancelled else { return nil }
            return value
        } catch {
            guard isCurrent() else { return nil }
            let message = error.localizedDescription
            workErrorStatus[key] = (error as? CompanionHTTPError)?.statusCode
            if (error as? CompanionHTTPError)?.statusCode == 409 {
                if key == "skills" { await refreshSkills() }
                else if key == "connections" { await refreshConnections() }
                else if key == "teams" { await refreshTeams() }
            }
            if isCurrent() { messages[key] = message }
            return nil
        }
    }

    static func workKey(_ jobId: String) -> String { "work-" + jobId }
    private func currentWork(_ item: BotWorkspaceActivity) -> BotTeamWork? {
        guard isCurrent(), workReviewSupported, CompanionClient.isSafeIdentifier(item.teamId), CompanionClient.isSafeIdentifier(item.id),
              let work = item.work, work.revision > 0,
              activity.contains(where: { $0.id == item.id && $0.teamId == item.teamId && $0.work?.revision == work.revision }) else { return nil }
        return work
    }
    private func applyWork(_ item: BotWorkspaceActivity, replacing previous: BotWorkspaceActivity) throws {
        guard item.id == previous.id, item.teamId == previous.teamId, let revision = item.work?.revision,
              revision > (previous.work?.revision ?? 0) else {
            throw CompanionError.server("The task changed while it was being reviewed. Refresh its results before continuing.")
        }
        if let index = activity.firstIndex(where: { $0.id == item.id && $0.teamId == item.teamId }),
           (activity[index].work?.revision ?? 0) <= revision { activity[index] = item }
    }
    /// Reading a recovery plan never queues or resumes a task.
    func refreshRecovery(_ item: BotWorkspaceActivity) async {
        let key = Self.workKey(item.id)
        guard currentWork(item) != nil else {
            if isCurrent() { messages[key] = "The task changed or review is unavailable. Refresh its current results before continuing." }; return
        }
        recoveryPlans[item.id] = nil
        await load(key, path: "/v1/bots/teams/\(item.teamId)/jobs/\(item.id)/recovery") { (value: RecoveryResponse) in
            guard self.currentWork(item) != nil, value.plan.jobId == item.id,
                  value.plan.sourceRunId == item.runId, value.plan.expectedRevision == item.work?.revision,
                  CompanionClient.isSafeIdentifier(value.plan.id) else {
                self.recoveryPlans[item.id] = nil; self.messages[key] = "This recovery plan is out of date. Refresh the task before continuing."; return
            }
            self.recoveryPlans[item.id] = value.plan
        }
    }
    private struct RecoveryResponse: Decodable { var plan: BotTeamRecoveryPlan }
    private struct ReviewResponse: Decodable { var activity: BotWorkspaceActivity }
    private struct ResumeResponse: Decodable { var run: BotTeamRun; var activity: BotWorkspaceActivity }
    func reviewWork(_ item: BotWorkspaceActivity, decision: String, note: String = "") async -> Bool {
        let key = Self.workKey(item.id)
        guard let work = currentWork(item) else {
            if isCurrent() { messages[key] = "The submitted result changed. Refresh and review its current revision." }; return false
        }
        guard work.canReview, !item.isExecutionActive, ["accept", "reject"].contains(decision), note.utf16.count <= 2_500, !note.contains("\0") else { return false }
        requests["activity"] = nil; loading.remove("activity")
        let body = BotTeamReviewRequest(expectedRevision: work.revision, decision: decision, note: note.isEmpty ? nil : note)
        let value: ReviewResponse? = await change(key, path: "/v1/bots/teams/\(item.teamId)/jobs/\(item.id)/review", body: body)
        guard let value else { await reconcileWorkError(item); return false }
        guard value.activity.work?.status == (decision == "accept" ? .verified : .blocked) else {
            messages[key] = "The Mac returned an inconsistent review decision. Refresh the task before continuing."; return false
        }
        do { try applyWork(value.activity, replacing: item) }
        catch { messages[key] = error.localizedDescription; return false }
        recoveryPlans[item.id] = nil
        await refreshActivity(); await refreshTeams()
        return isCurrent()
    }
    func resumeWork(_ item: BotWorkspaceActivity, plan: BotTeamRecoveryPlan, idempotencyKey: String) async -> BotTeamRun? {
        let key = Self.workKey(item.id)
        guard let work = currentWork(item), work.canPlanRecovery, recoveryPlans[item.id] == plan,
              plan.jobId == item.id, plan.expectedRevision == work.revision, plan.canResume, !plan.isExpired(),
              CompanionClient.isSafeIdentifier(idempotencyKey) else {
            if isCurrent() { messages[key] = "The recovery plan changed or expired. Refresh the task and prepare a new plan." }; return nil
        }
        requests["activity"] = nil; loading.remove("activity")
        let body = BotTeamResumeRequest(planId: plan.id, expectedRevision: plan.expectedRevision, idempotencyKey: idempotencyKey)
        let value: ResumeResponse? = await change(key, path: "/v1/bots/teams/\(item.teamId)/jobs/\(item.id)/resume", body: body)
        guard let value else { await reconcileWorkError(item); return nil }
        guard value.run.teamId == item.teamId, CompanionClient.isSafeIdentifier(value.run.id),
              value.activity.teamId == item.teamId, value.activity.runId == value.run.id,
              value.activity.id != item.id, CompanionClient.isSafeIdentifier(value.activity.id),
              value.activity.work?.sourceJobId == item.id, (value.activity.work?.revision ?? 0) > 0 else {
            messages[key] = "The Mac returned an inconsistent recovery task. Refresh its current state before continuing."; return nil
        }
        if let index = activity.firstIndex(where: { $0.id == value.activity.id && $0.teamId == item.teamId }) {
            if (activity[index].work?.revision ?? 0) <= (value.activity.work?.revision ?? 0) { activity[index] = value.activity }
        } else { activity.insert(value.activity, at: 0) }
        recoveryPlans[item.id] = nil
        await refreshActivity(); await refreshTeams(); await refreshChannel(item.teamId)
        return isCurrent() ? value.run : nil
    }
    private func reconcileWorkError(_ item: BotWorkspaceActivity) async {
        let key = Self.workKey(item.id), message = messages[key]
        // A refused or unavailable plan cannot be retried implicitly. Refreshes
        // remain GET-only and preserve an explicit, stable resume request key.
        if [401, 403, 404, 409, 410].contains(workErrorStatus[key] ?? 0) { recoveryPlans[item.id] = nil }
        await refreshActivity(); await refreshTeams()
        if isCurrent() { messages[key] = message }
    }

    func createTeam(_ draft: BotTeamDraft) async -> Bool {
        var body = draft; if continuousTeams { body.limits = .continuous }
        guard Self.validTeamDraft(body, unrestrictedTeams: unrestrictedTeams, continuousTeams: continuousTeams, availableMemberIds: currentBotIds()), validTeamExecution(body), body.briefing == nil || teams?.teamInstructionsSupported == true else { return false }
        struct Result: Decodable { var team: BotTeam }
        body.limits = body.limits.forHost(unrestrictedTeams: unrestrictedTeams, continuousTeams: continuousTeams)
        let value: Result? = await change("teams", path: "/v1/bots/teams", body: body)
        if value != nil { await refreshTeams() }
        return value != nil && isCurrent()
    }
    func updateTeam(_ team: BotTeam, draft: BotTeamDraft) async -> Bool {
        var draft = draft; if continuousTeams { draft.limits = .continuous }
        guard teams?.teamSettingsSupported == true, CompanionClient.isSafeIdentifier(team.id),
              let revision = team.revision, revision > 0,
              teams?.teams.first(where: { $0.id == team.id })?.revision == revision,
              teams?.runs.contains(where: { $0.teamId == team.id && $0.isActive }) != true,
              Self.validTeamDraft(draft, unrestrictedTeams: unrestrictedTeams, continuousTeams: continuousTeams, availableMemberIds: currentBotIds()), validTeamExecution(draft), draft.briefing == nil || teams?.teamInstructionsSupported == true else { return false }
        struct Result: Decodable { var team: BotTeam }
        let body = BotTeamUpdate(expectedRevision: revision, name: draft.name, memberIds: draft.memberIds,
                                 coordinatorId: draft.coordinatorId, limits: draft.limits.forHost(unrestrictedTeams: unrestrictedTeams, continuousTeams: continuousTeams), execution: draft.execution ?? .individual, briefing: draft.briefing)
        let value: Result? = await change("teams", path: "/v1/bots/teams/\(team.id)", method: "PATCH", body: body)
        if value != nil { await refreshTeams() }
        return value != nil && isCurrent()
    }
    private func validTeamExecution(_ draft: BotTeamDraft) -> Bool {
        guard let execution = draft.execution, execution.isShared else { return true }
        return teams?.teamSettingsSupported == true && teams?.teamComputers?.contains {
            $0.id == execution.computerId && $0.available && ($0.memberId == nil || draft.memberIds.contains($0.memberId!)) && $0.allowsFolder(execution.workspace ?? "")
        } == true
    }
    static func validTeamDraft(_ draft: BotTeamDraft, unrestrictedTeams: Bool = false, continuousTeams: Bool = false, availableMemberIds: Set<String>? = nil) -> Bool {
        let validLimits = continuousTeams ? draft.limits == .continuous :
            (unrestrictedTeams ? draft.limits.maxParallel >= 0 : (1...8).contains(draft.limits.maxParallel)) &&
            (1...4).contains(draft.limits.maxDepth) && (1...32).contains(draft.limits.maxHops) &&
            (1...100).contains(draft.limits.maxTurns) && (60_000...3_600_000).contains(draft.limits.maxDurationMs)
        guard !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, draft.name.count <= 80,
              draft.memberIds.count >= 2, unrestrictedTeams || draft.memberIds.count <= 12,
              Set(draft.memberIds).count == draft.memberIds.count,
              draft.memberIds.allSatisfy(CompanionClient.isSafeIdentifier), draft.memberIds.contains(draft.coordinatorId),
              availableMemberIds.map({ Set(draft.memberIds).isSubset(of: $0) }) != false, validLimits else { return false }
        if let briefing = draft.briefing {
            func validText(_ value: String, max: Int) -> Bool { value.utf16.count <= max && !value.contains("\0") }
            guard validText(briefing.instructions, max: 8_000), briefing.members.count <= draft.memberIds.count,
                  Set(briefing.members.map(\.botId)).count == briefing.members.count,
                  briefing.members.allSatisfy({ draft.memberIds.contains($0.botId) && validText($0.role, max: 120) && validText($0.instructions, max: 4_000) }),
                  briefing.instructions.utf16.count + briefing.members.reduce(0, { $0 + $1.role.utf16.count + $1.instructions.utf16.count }) <= 24_000 else { return false }
        }
        guard let execution = draft.execution else { return true }
        if execution.mode == "individual" { return execution.computerId == nil && execution.workspace == nil }
        guard execution.mode == "shared", let computer = execution.computerId, !computer.isEmpty, computer.utf8.count <= 250,
              let path = execution.workspace, path.hasPrefix("/"), path.utf16.count <= 4_000,
              !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return false }
        return true
    }
    func setTeamEnabled(_ team: BotTeam, enabled: Bool) async {
        struct Update: Encodable { var enabled: Bool; var expectedRevision: Int? }
        struct Result: Decodable { var team: BotTeam }
        let value: Result? = await change("teams", path: "/v1/bots/teams/\(team.id)", method: "PATCH", body: Update(enabled: enabled, expectedRevision: team.revision))
        if value != nil { await refreshTeams() }
    }
    func startTeam(_ team: BotTeam, message: String, requestId: String) async -> BotTeamRun? {
        guard CompanionClient.isSafeIdentifier(team.id), CompanionClient.isSafeIdentifier(requestId), team.enabled, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        struct TaskRequest: Encodable { var message: String; var requestId: String }
        struct Result: Decodable { var run: BotTeamRun }
        let value: Result? = await change("teams", path: "/v1/bots/teams/\(team.id)/runs", body: TaskRequest(message: message, requestId: requestId))
        if value != nil { await refreshTeams(); await refreshActivity() }
        return isCurrent() ? value?.run : nil
    }
    func stopRun(_ run: BotTeamRun) async {
        guard CompanionClient.isSafeIdentifier(run.teamId), CompanionClient.isSafeIdentifier(run.id) else { return }
        struct Result: Decodable { var run: BotTeamRun }
        let value: Result? = await change("teams", path: "/v1/bots/teams/\(run.teamId)/runs/\(run.id)/stop", body: [String: String]())
        if value != nil { await refreshTeams(); await refreshActivity() }
    }
    static func channelKey(_ teamId: String) -> String { "channel-" + teamId }

    func refreshChannel(_ teamId: String, reset: Bool = false, older: Bool = false) async {
        guard let client, isCurrent(), CompanionClient.isSafeIdentifier(teamId) else { return }
        let key = Self.channelKey(teamId)
        // A write invalidates any in-flight read. Polling cannot race its result.
        guard mutation != key else { return }
        let previous = channels[teamId]
        let before = older ? previous?.messages.first?.sequence : nil
        let after = !reset && !older ? channelCursors[teamId] : nil
        let token = UUID(); requests[key] = token; loading.insert(key)
        defer { if requests[key] == token { requests[key] = nil; loading.remove(key) } }
        do {
            let value = try await client.teamChannel(teamId: teamId, after: after, before: before)
            guard isCurrent(), requests[key] == token, !Task.isCancelled else { return }
            try applyChannel(value, teamId: teamId, replacing: reset || previous == nil, older: older)
            messages[key] = value.reason
        } catch is CancellationError { }
        catch {
            guard isCurrent(), requests[key] == token else { return }
            if (error as? CompanionHTTPError)?.isUnsupported == true {
                channels[teamId] = BotTeamChannel(teamId: teamId, supported: false, messages: [], activeRuns: [], nextSequence: 0, reason: "Update Strata on your Mac for the shared team channel. Existing team tasks remain available.")
            } else { messages[key] = error.localizedDescription }
        }
    }

    private func applyChannel(_ value: BotTeamChannel, teamId: String, replacing: Bool, older: Bool = false) throws {
        guard value.teamId == teamId, value.nextSequence >= 0,
              value.messages.allSatisfy({ $0.teamId == teamId && $0.sequence > 0 && CompanionClient.isSafeIdentifier($0.id) }),
              value.activeRuns.allSatisfy({ $0.teamId == teamId }),
              Set(value.messages.map(\.id)).count == value.messages.count,
              Set(value.messages.map(\.sequence)).count == value.messages.count else {
            throw CompanionError.server("The Mac returned inconsistent team history. Refresh the room.")
        }
        var combined = replacing ? [] : channels[teamId]?.messages ?? []
        for entry in value.messages {
            if let index = combined.firstIndex(where: { $0.id == entry.id }) {
                guard combined[index].sequence == entry.sequence else { throw CompanionError.server("A team message changed its history position. Refresh the room.") }
                combined[index] = entry
            } else { combined.append(entry) }
        }
        guard Set(combined.map(\.sequence)).count == combined.count else {
            throw CompanionError.server("The Mac returned conflicting team history. Refresh the room.")
        }
        combined.sort { $0.sequence < $1.sequence }
        var merged = value
        merged.messages = combined
        // Forward polls report forward pagination; only the initial/backward
        // page determines whether the user can load earlier messages.
        if !replacing && !older { merged.hasMoreBefore = channels[teamId]?.hasMoreBefore }
        // A POST returns the newest window, which can jump ahead of the last
        // read page. Advance only through contiguous known entries so a busy
        // room cannot permanently skip the gap on its next incremental poll.
        var cursor = replacing ? combined.last?.sequence ?? 0 : channelCursors[teamId] ?? 0
        let sequences = Set(combined.map(\.sequence))
        while cursor < Int.max - 1, sequences.contains(cursor + 1) { cursor += 1 }
        channelCursors[teamId] = cursor
        merged.nextSequence = cursor
        channels[teamId] = merged
    }

    func postTeamMessage(_ team: BotTeam, draft: BotTeamChannelPost) async -> Bool {
        let text = draft.message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard team.enabled, CompanionClient.isSafeIdentifier(team.id),
              CompanionClient.isSafeIdentifier(draft.requestId), !text.isEmpty, text.utf16.count <= 16_000,
              draft.replyToId == nil || CompanionClient.isSafeIdentifier(draft.replyToId!),
              draft.recipientIds == nil || (!draft.recipientIds!.isEmpty && draft.recipientIds!.count <= team.memberIds.count && Set(draft.recipientIds!).count == draft.recipientIds!.count && draft.recipientIds!.allSatisfy({ team.memberIds.contains($0) })),
              channels[team.id]?.supported == true else { return false }
        struct Result: Decodable { var channel: BotTeamChannel; var run: BotTeamRun? }
        let key = Self.channelKey(team.id)
        let value: Result? = await change(key, path: "/v1/bots/teams/\(team.id)/messages", body: draft)
        guard let value, isCurrent(), !Task.isCancelled else { return false }
        do {
            try applyChannel(value.channel, teamId: team.id, replacing: false)
            await refreshTeams()
            return isCurrent()
        } catch { messages[key] = error.localizedDescription; return false }
    }

    func saveSkill(_ draft: BotSkillDraft, reviewing skill: BotSkill? = nil) async -> Bool {
        let id = skill?.id
        guard id == nil || CompanionClient.isSafeIdentifier(id!) else { return false }
        struct Result: Decodable { var skill: BotSkill }
        let value: Result?
        if let id {
            struct Update: Encodable { var name: String; var description: String; var body: String; var triggers: [String]; var status = "draft"; var expectedRevision: BotSkillRevision; var expectedDigest: String }
            value = await change("skills", path: "/v1/bots/skills/\(id)", method: "PATCH", body: Update(name: draft.name, description: draft.description, body: draft.body, triggers: draft.triggers, expectedRevision: skill!.revision, expectedDigest: skill!.digest))
        } else { value = await change("skills", path: "/v1/bots/skills", body: draft) }
        if value != nil { await refreshSkills() }
        return value != nil && isCurrent()
    }
    func setSkillEnabled(_ skill: BotSkill, enabled: Bool) async {
        guard !skill.isLibrary else { return }
        struct Update: Encodable { var status: String; var expectedRevision: BotSkillRevision; var expectedDigest: String }
        struct Result: Decodable { var skill: BotSkill }
        let value: Result? = await change("skills", path: "/v1/bots/skills/\(skill.id)", method: "PATCH", body: Update(status: enabled ? "enabled" : "draft", expectedRevision: skill.revision, expectedDigest: skill.digest))
        if value != nil { await refreshSkills() }
    }
    func assignSkill(_ skill: BotSkill, botId: String, assigned: Bool) async {
        guard let client, isCurrent(), CompanionClient.isSafeIdentifier(botId), mutation == nil, !isPreparingAssignment else { return }
        isPreparingAssignment = true
        defer { isPreparingAssignment = false }
        // Merge one explicit toggle into a fresh assignment to retain unrelated
        // skills that may have been assigned on Mac since this page opened.
        let skills: BotSkillsSnapshot
        do { skills = try await client.perform("/v1/bots/skills") }
        catch { if isCurrent() { messages["skills"] = error.localizedDescription }; return }
        guard isCurrent(), !Task.isCancelled, skills.reason == nil else { return }
        let fresh = skills.skills.first(where: { $0.id == skill.id })
        guard !assigned || fresh?.isEnabled == true && fresh?.digest == skill.digest else {
            requests["skills"] = nil; loading.remove("skills"); self.skills = skills
            messages["skills"] = "This skill changed. Review its current instructions before assigning it."
            return
        }
        var ids = Set(skills.assignments.first { $0.botId == botId }?.skillIds ?? [])
        if assigned { ids.insert(skill.id) } else { ids.remove(skill.id) }
        struct Assignment: Encodable { var botId: String; var skillIds: [String] }
        struct Saved: Decodable { var saved: Bool }
        let value: Saved? = await change("skills", path: "/v1/bots/skills/assign", body: Assignment(botId: botId, skillIds: ids.sorted()))
        if value != nil { await refreshSkills() }
    }
    func checkConnection(_ connection: BotMCPConnection) async {
        struct Result: Decodable { var connection: BotMCPConnection }
        let value: Result? = await change("connections", path: "/v1/bots/connections/\(connection.id)/check", body: [String: String]())
        if value != nil { await refreshConnections() }
    }
    func saveConnection(_ connection: BotMCPConnection, botIds: [String], toolIds: [String], teamIds: [String]? = nil, instructions: String? = nil) async -> Bool {
        guard CompanionClient.isSafeIdentifier(connection.id),
              teamIds == nil || connections?.connectorFeatures?.teamAccess == true,
              instructions == nil || connections?.connectorFeatures?.teamAccess == true,
              (instructions?.utf16.count ?? 0) <= 8000, instructions?.contains("\0") != true else { return false }
        struct Update: Encodable { var botIds: [String]; var enabledToolIds: [String]; var readOnlyToolIds: [String]; var expectedInventoryDigest: String; var teamIds: [String]?; var customInstructions: String? }
        struct Result: Decodable { var connection: BotMCPConnection }
        let selected = Set(toolIds)
        let value: Result? = await change("connections", path: "/v1/bots/connections/\(connection.id)", method: "PATCH", body: Update(botIds: botIds, enabledToolIds: toolIds, readOnlyToolIds: connection.readOnlyToolIds.filter { selected.contains($0) }, expectedInventoryDigest: connection.inventoryDigest, teamIds: teamIds, customInstructions: instructions))
        if value != nil { await refreshConnections() }
        return value != nil && isCurrent()
    }
    func saveConnectorSetup(_ draft: BotConnectorDraft, editing connection: BotMCPConnection? = nil) async -> Bool {
        await saveConnectorAccountSetup(draft, editing: connection) != nil
    }
    /// Return the exact saved account so Discover can continue to its sign-in
    /// and access screen without guessing which row a refresh inserted.
    func saveConnectorAccountSetup(_ draft: BotConnectorDraft, editing connection: BotMCPConnection? = nil) async -> BotMCPConnection? {
        guard connections?.connectorFeatures?.httpCreation == true, draft.isValid,
              connection != nil || connectorCatalog?.connectors.first(where: { $0.id == draft.catalogId })?.isReady != false,
              draft.authType != "oauth" || connections?.connectorFeatures?.oauth == true,
              connection == nil || connection?.transport == "http", connection == nil || CompanionClient.isSafeIdentifier(connection!.id) else { return nil }
        struct Result: Decodable { var connection: BotMCPConnection }
        let path = connection.map { "/v1/bots/connections/\($0.id)" } ?? "/v1/bots/connections"
        var reviewedDraft = draft
        reviewedDraft.expectedInventoryDigest = connection?.inventoryDigest
        let value: Result? = await change("connections", path: path, method: connection == nil ? "POST" : "PATCH", body: reviewedDraft)
        if let value {
            if let index = connections?.connections.firstIndex(where: { $0.id == value.connection.id }) { connections?.connections[index] = value.connection }
            else { connections?.connections.append(value.connection) }
            await refreshConnections()
        }
        guard isCurrent() else { return nil }
        return value?.connection
    }
    func createConnectorAccount(_ entry: BotConnectorCatalogEntry) async -> BotMCPConnection? {
        // Only the current, advertised catalog may supply a one-tap preset.
        guard entry.isReady, entry.id != "custom-http", connectorCatalog?.connectors.contains(entry) == true else { return nil }
        var draft = BotConnectorDraft(entry: entry)
        draft.accountLabel = entry.nextAccountLabel(in: connections?.connections ?? [])
        return await saveConnectorAccountSetup(draft)
    }
    func setConnectorEnabled(_ connection: BotMCPConnection, enabled: Bool) async -> Bool {
        guard connections?.connectorFeatures?.teamAccess == true, CompanionClient.isSafeIdentifier(connection.id) else { return false }
        struct Update: Encodable { var enabled: Bool; var expectedInventoryDigest: String }
        struct Result: Decodable { var connection: BotMCPConnection }
        let value: Result? = await change("connections", path: "/v1/bots/connections/\(connection.id)", method: "PATCH", body: Update(enabled: enabled, expectedInventoryDigest: connection.inventoryDigest))
        if value != nil { await refreshConnections() }
        return value != nil && isCurrent()
    }
    func removeConnector(_ connection: BotMCPConnection) async -> Bool {
        guard connections?.connectorFeatures?.httpCreation == true, CompanionClient.isSafeIdentifier(connection.id) else { return false }
        struct Result: Decodable { var deleted: Bool }
        let value: Result? = await change("connections", path: "/v1/bots/connections/\(connection.id)", method: "DELETE", body: [String: String]())
        if value != nil { await refreshConnections() }
        return value?.deleted == true && isCurrent()
    }
    func canUsePhoneSignIn(_ connection: BotMCPConnection) -> Bool {
        guard connections?.connectorFeatures?.iphoneOAuth == true else { return false }
        guard let catalogId = connection.catalogId else { return true }
        // Unknown or unrefreshed preset policy falls back to Mac sign-in.
        guard let preset = connectorCatalog?.connectors.first(where: { $0.id == catalogId }) else { return false }
        return preset.isReady && preset.phoneSignIn != false
    }
    @discardableResult func connectorAuthentication(_ connection: BotMCPConnection, action: String, callbackURL: String? = nil, callbackTarget: String? = nil, expectedState: String? = nil) async -> Bool {
        guard connections?.connectorFeatures?.oauth == true, connection.authType == "oauth",
              CompanionClient.isSafeIdentifier(connection.id), ["start", "poll", "disconnect", "complete", "cancel"].contains(action),
              action != "cancel" || connections?.connectorFeatures?.iphoneOAuth == true && expectedState?.count == 64 && expectedState?.allSatisfy({ "0123456789abcdef".contains($0) }) == true,
              expectedState == nil || action == "cancel",
              callbackTarget == nil || callbackTarget == "iphone" && action == "start" && canUsePhoneSignIn(connection) else { return false }
        struct Result: Decodable { var connection: BotMCPConnection }
        let path = "/v1/bots/connections/\(connection.id)/auth" + (action == "complete" ? "/complete" : action == "cancel" ? "/cancel" : "")
        if action == "poll" {
            await load("connections", path: path) { (value: Result) in
                if let index = self.connections?.connections.firstIndex(where: { $0.id == value.connection.id }) { self.connections?.connections[index] = value.connection }
            }
            return messages["connections"] == nil && isCurrent()
        }
        var body = callbackURL.map { ["callbackURL": $0] } ?? [:]
        if let callbackTarget { body["callbackTarget"] = callbackTarget }
        if let expectedState { body["expectedState"] = expectedState }
        let value: Result? = await change("connections", path: path, method: action == "disconnect" ? "DELETE" : "POST", body: body)
        if value != nil { await refreshConnections() }
        return value != nil && isCurrent()
    }

}

/// A single owner-initiated system browser session. Never writes callback URLs
/// or authorization codes to logs, preferences, or shared chat history.
@MainActor
final class BotConnectorAuthenticationSession: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    @Published private(set) var isActive = false
    private var session: ASWebAuthenticationSession?
    private var continuation: CheckedContinuation<URL, Error>?
    private var sessionId: UUID?
    enum Failure: LocalizedError {
        case unavailable, invalidCallback
        var errorDescription: String? { switch self {
        case .unavailable: "Couldn’t open sign-in. Try again, or finish sign-in on your Mac."
        case .invalidCallback: "The service returned an unexpected sign-in address. Try again or finish on your Mac."
        } }
    }
    func authenticate(_ request: BotConnectorOAuthRequest) async throws -> URL {
        guard session == nil else { throw Failure.unavailable }
        try Task.checkCancellation()
        let id = UUID()
        let url: URL = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.sessionId = id
                self.continuation = continuation
                let session = ASWebAuthenticationSession(url: request.authorizationURL, callbackURLScheme: "strata") { [weak self] url, error in
                    Task { @MainActor in self?.finish(id: id, url: url, error: error) }
                }
                self.session = session; isActive = true
                session.presentationContextProvider = self
                if !session.start() { finish(id: id, url: nil, error: Failure.unavailable) }
            }
        } onCancel: { Task { @MainActor in self.cancel(id: id) } }
        guard let callback = request.validatedCallback(url) else { throw Failure.invalidCallback }
        return callback
    }
    func cancel() {
        if let sessionId { cancel(id: sessionId) }
    }
    private func cancel(id: UUID) {
        guard sessionId == id else { return }
        session?.cancel(); finish(id: id, url: nil, error: CancellationError())
    }
    private func finish(id: UUID, url: URL?, error: Error?) {
        guard sessionId == id, let continuation else { return }
        self.continuation = nil; sessionId = nil; session = nil; isActive = false
        if let url { continuation.resume(returning: url) }
        else { continuation.resume(throwing: error ?? Failure.unavailable) }
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}
