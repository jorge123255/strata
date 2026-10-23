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
    @Published private(set) var activityLoaded = false
    @Published private(set) var recoveryPlans: [String: BotTeamRecoveryPlan] = [:]
    @Published private(set) var workflows: [String: BotTeamWorkflowsSnapshot] = [:]
    @Published private(set) var workflowDetails: [String: BotTeamWorkflow] = [:]
    @Published private(set) var workPlans: [String: BotTeamWorkPlansSnapshot] = [:]
    @Published private(set) var workPlanDetails: [String: BotTeamWorkPlan] = [:]
    @Published private(set) var workPlanTaskPages: [String: [Int: [BotTeamWorkPlan.Task]]] = [:]
    @Published private(set) var activityWorkReviewSupported = false
    @Published private(set) var supervision: BotSupervisionSnapshot?
    @Published private(set) var harnessActions: BotHarnessActionsSnapshot?
    private var harnessActionsCheckedAt: Date?
    @Published private(set) var skills: BotSkillsSnapshot?
    @Published private(set) var createdTools: BotCreatedToolsSnapshot?
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
    var workflowsSupported: Bool { teams?.teamWorkflowsSupported == true }
    var workPlansSupported: Bool { teams?.teamWorkPlansSupported == true }

    static func workPlansKey(_ teamId: String) -> String { "workPlans-" + teamId }
    static func workPlanKey(_ id: String) -> String { "workPlan-" + id }
    func workPlan(_ id: String, teamId: String) -> BotTeamWorkPlan? {
        let detail = workPlanDetails[id].flatMap { $0.teamId == teamId ? $0 : nil }
        let listed = workPlans[teamId]?.plans.first { $0.id == id }
        if let detail, let listed { return detail.revision >= listed.revision ? detail : listed }
        return detail ?? listed
    }
    func workPlanTasks(_ id: String, teamId: String) -> [BotTeamWorkPlan.Task] {
        guard workPlan(id, teamId: teamId) != nil else { return [] }
        var positions: [Int: BotTeamWorkPlan.Task] = [:]
        for (start, tasks) in (workPlanTaskPages[id] ?? [:]).sorted(by: { $0.key < $1.key }) {
            for (index, task) in tasks.enumerated() { positions[start + index] = task }
        }
        return positions.sorted { $0.key < $1.key }.map(\.value)
    }
    func nextWorkPlanTaskOffset(_ id: String, teamId: String) -> Int? {
        guard let plan = workPlan(id, teamId: teamId) else { return nil }
        var offset = 0
        for (start, tasks) in (workPlanTaskPages[id] ?? [:]).sorted(by: { $0.key < $1.key }) {
            guard start <= offset, !tasks.isEmpty else { break }
            offset = max(offset, start + tasks.count)
        }
        return offset < plan.totalTasks ? offset : nil
    }
    private func workPlanTeam(_ teamId: String) -> BotTeam? {
        guard isCurrent(), workPlansSupported, teams?.reason == nil, CompanionClient.isSafeIdentifier(teamId) else { return nil }
        return teams?.teams.first { $0.id == teamId }
    }
    func refreshWorkPlans(_ teamId: String, beforePlanId: String? = nil) async {
        let key = Self.workPlansKey(teamId)
        guard let client, workPlanTeam(teamId) != nil, mutation != key, mutation?.hasPrefix("workPlan-") != true,
              beforePlanId == nil || beforePlanId == workPlans[teamId]?.nextBeforePlanId else { return }
        let request = UUID(); requests[key] = request; setLoading(key, true)
        defer { if requests[key] == request { requests[key] = nil; setLoading(key, false) } }
        do {
            var value = try await client.teamWorkPlans(teamId: teamId, beforePlanId: beforePlanId)
            guard isCurrent(), requests[key] == request, !Task.isCancelled, workPlanTeam(teamId) != nil else { return }
            guard value.plans.count <= 20, Set(value.plans.map(\.id)).count == value.plans.count,
                  value.hasMore ? !value.plans.isEmpty && value.nextBeforePlanId == value.plans.last?.id : value.nextBeforePlanId == nil else {
                throw CompanionError.server("Strata returned an inconsistent team plan list or cursor.")
            }
            for row in value.plans { try validateWorkPlan(row, id: row.id, teamId: teamId) }
            for row in value.plans { try applyWorkPlan(row, id: row.id, teamId: teamId) }
            if beforePlanId != nil, let previous = workPlans[teamId] {
                guard previous.nextBeforePlanId == beforePlanId, Set(previous.plans.map(\.id)).isDisjoint(with: value.plans.map(\.id)) else { throw CompanionError.server("The earlier team plan page changed. Refresh before loading it again.") }
                value.plans = previous.plans + value.plans
            } else if !value.isAvailable && value.plans.isEmpty, let previous = workPlans[teamId] {
                value.plans = previous.plans
            }
            if workPlans[teamId] != value { workPlans[teamId] = value }
            setMessage(key, value.error ?? (value.isAvailable ? nil : "Team plans are unavailable. Refresh before changing saved work."))
        } catch is CancellationError { }
        catch { if isCurrent(), requests[key] == request, !Task.isCancelled { setMessage(key, error.localizedDescription) } }
    }
    private struct WorkPlanResponse: Decodable { var plan: BotTeamWorkPlan }
    func refreshWorkPlan(_ id: String, teamId: String, taskOffset: Int = 0) async {
        let key = Self.workPlanKey(id)
        guard let client, workPlanTeam(teamId) != nil, BotTeamWorkPlan.validID(id, "tp_"), taskOffset >= 0,
              mutation != key, mutation != Self.workPlansKey(teamId) else { return }
        let request = UUID(); requests[key] = request; setLoading(key, true)
        defer { if requests[key] == request { requests[key] = nil; setLoading(key, false) } }
        do {
            let value = WorkPlanResponse(plan: try await client.teamWorkPlan(teamId: teamId, planId: id, taskOffset: taskOffset))
            guard isCurrent(), requests[key] == request, !Task.isCancelled, workPlanTeam(teamId) != nil else { return }
            guard value.plan.tasksOffset == taskOffset else { throw CompanionError.server("Strata returned a different team task page. Refresh before continuing.") }
            try applyWorkPlan(value.plan, id: id, teamId: teamId)
            setMessage(key, nil)
        } catch is CancellationError { }
        catch { if isCurrent(), requests[key] == request, !Task.isCancelled { setMessage(key, error.localizedDescription) } }
    }
    private func validateWorkPlan(_ value: BotTeamWorkPlan, id: String, teamId: String) throws {
        guard value.hasValidProof, value.id == id, value.teamId == teamId else { throw CompanionError.server("Strata returned a different or unreadable team plan.") }
        if let old = workPlan(id, teamId: teamId), value.revision >= old.revision, !value.hasSameScope(as: old) {
            throw CompanionError.server("This team plan changed its original scope or saved task definitions. Inspect it on the Mac before continuing.")
        }
        if let old = workPlan(id, teamId: teamId), value.revision == old.revision, !value.hasSameCheckpoint(as: old) {
            throw CompanionError.server("This team plan changed without a new checkpoint. Refresh before continuing.")
        }
        if let old = workPlan(id, teamId: teamId), value.revision > old.revision, value.proof == old.proof {
            throw CompanionError.server("This team plan changed without a new proof. Refresh before continuing.")
        }
        if let old = workPlan(id, teamId: teamId), value.revision >= old.revision {
            let saved = workPlanTasks(id, teamId: teamId)
            for (index, task) in value.tasks.enumerated() {
                if let previous = saved.first(where: { $0.id == task.id || $0.key == task.key }) {
                    guard task.hasSameDefinition(as: previous), value.revision != old.revision || task.hasSameCheckpoint(as: previous) else { throw CompanionError.server("A saved team task changed its definition or original checkpoint.") }
                }
                if value.revision == old.revision {
                    let position = value.tasksOffset + index
                    for (start, page) in workPlanTaskPages[id] ?? [:] where position >= start && position - start < page.count {
                        guard page[position - start].id == task.id else { throw CompanionError.server("A saved team task changed its original checkpoint position.") }
                    }
                }
            }
        }
    }
    private func applyWorkPlan(_ value: BotTeamWorkPlan, id: String, teamId: String) throws {
        try validateWorkPlan(value, id: id, teamId: teamId)
        if let old = workPlan(id, teamId: teamId), value.revision < old.revision { return }
        if workPlan(id, teamId: teamId)?.revision != value.revision { workPlanTaskPages[id] = [:] }
        workPlanTaskPages[id, default: [:]][value.tasksOffset] = value.tasks
        if workPlanDetails[id] != value { workPlanDetails[id] = value }
    }
    @discardableResult func changeWorkPlan(_ value: BotTeamWorkPlan, action: String, requestId: String? = nil, decision: String? = nil, note: String = "", inspected: Bool = false) async -> Bool {
        let key = Self.workPlanKey(value.id), listKey = Self.workPlansKey(value.teamId)
        guard let client, workPlanTeam(value.teamId) != nil, !Task.isCancelled, mutation == nil,
              workPlans[value.teamId]?.isAvailable == true, messages[listKey] == nil, messages[key] == nil,
              workPlan(value.id, teamId: value.teamId).map(value.matches) == true, ["resume", "stop", "review"].contains(action) else { return false }
        struct Proof: Encodable { var expectedRevision: Int; var expectedProof: String; var requestId: String?; var inspected: Bool?; var decision: String?; var note: String? }
        var proof = Proof(expectedRevision: value.revision, expectedProof: value.proof)
        switch action {
        case "resume":
            guard workPlanTeam(value.teamId)?.enabled == true, value.canContinue, workPlan(value.id, teamId: value.teamId)?.canContinue == true, inspected, let requestId, BotTeamWorkflow.validRequestID(requestId) else { return false }
            proof.requestId = requestId; proof.inspected = true
        case "stop": guard value.canStop else { return false }
        default:
            guard inspected, value.canReview, let decision, ["accept", "changes_requested"].contains(decision), BotTeamWorkPlan.text(note, 4_000), decision != "changes_requested" || workPlanTeam(value.teamId)?.enabled == true else { return false }
            guard decision != "changes_requested" || !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
            proof.decision = decision; proof.note = note.isEmpty ? nil : note
        }
        requests[listKey] = nil; setLoading(listKey, false)
        let request = UUID(); mutation = key; requests[key] = request; setMessage(key, nil)
        defer { if requests[key] == request { requests[key] = nil }; if mutation == key { mutation = nil } }
        do {
            let response: WorkPlanResponse = try await client.perform("/v1/bots/teams/\(value.teamId)/plans/\(value.id)/\(action)", method: "POST", jsonBody: proof)
            guard isCurrent(), requests[key] == request, !Task.isCancelled, workPlanTeam(value.teamId) != nil, workPlans[value.teamId]?.isAvailable == true else { return false }
            let next = response.plan
            guard next.hasValidProof, next.id == value.id, next.teamId == value.teamId, next.parentRunId == value.parentRunId, next.sourceMessageId == value.sourceMessageId,
                  next.goal == value.goal, next.coordinatorId == value.coordinatorId, next.memberIds == value.memberIds, next.createdAt == value.createdAt,
                  next.revision > value.revision, next.proof != value.proof,
                  action != "stop" || [.stopping, .stopped].contains(next.phase),
                  action != "resume" || ![.completed, .stopped, .stopping].contains(next.phase),
                  action != "review" || decision != "accept" || next.phase == .completed,
                  action != "review" || decision != "changes_requested" || next.phase != .completed else { throw CompanionError.server("Strata did not confirm this exact team plan action. Refresh its saved state before continuing.") }
            try applyWorkPlan(next, id: value.id, teamId: value.teamId)
            return true
        } catch is CancellationError { return false }
        catch {
            guard isCurrent(), requests[key] == request, !Task.isCancelled else { return false }
            // A lost reply or conflict is not permission to replay the action.
            setMessage(key, error.localizedDescription)
            return false
        }
    }

    static func workflowsKey(_ teamId: String) -> String { "workflows-" + teamId }
    static func workflowKey(_ id: String) -> String { "workflow-" + id }
    func workflow(_ id: String, teamId: String) -> BotTeamWorkflow? {
        let detail = workflowDetails[id].flatMap { $0.teamId == teamId ? $0 : nil }
        let listed = workflows[teamId]?.workflows.first { $0.id == id }
        if let detail, let listed { return detail.revision >= listed.revision ? detail : listed }
        return detail ?? listed
    }
    private func workflowTeam(_ id: String) -> BotTeam? {
        guard isCurrent(), workflowsSupported, teams?.reason == nil, CompanionClient.isSafeIdentifier(id) else { return nil }
        return teams?.teams.first { $0.id == id }
    }
    func refreshWorkflows(_ teamId: String) async {
        guard workflowTeam(teamId) != nil, mutation != Self.workflowsKey(teamId), mutation?.hasPrefix("workflow-") != true else { return }
        let key = Self.workflowsKey(teamId)
        await load(key, path: "/v1/bots/teams/\(teamId)/workflows") { (value: BotTeamWorkflowsSnapshot) in
            guard self.workflowTeam(teamId) != nil else { return }
            guard value.workflows.count <= 20, Set(value.workflows.map(\.id)).count == value.workflows.count,
                  value.workflows.allSatisfy({ $0.teamId == teamId && $0.hasValidProof }) else {
                self.setMessage(key, "Strata returned inconsistent workflow state. Refresh before making changes."); return
            }
            for row in value.workflows {
                if let old = self.workflow(row.id, teamId: teamId), row.revision < old.revision { continue }
                if let old = self.workflow(row.id, teamId: teamId), row.revision == old.revision, !row.hasSameCheckpoint(as: old) {
                    self.setMessage(key, "A workflow changed without a new revision. Refresh its details before continuing."); return
                }
                self.workflowDetails[row.id] = row
            }
            if self.workflows[teamId] != value { self.workflows[teamId] = value }
            self.setMessage(key, value.error ?? (value.isAvailable ? nil : "Update Strata on your Mac to start or change saved workflows."))
        }
    }
    private struct WorkflowResponse: Decodable { var workflow: BotTeamWorkflow }
    func refreshWorkflow(_ id: String, teamId: String) async {
        guard let client, workflowTeam(teamId) != nil, BotTeamWorkflow.validID(id, prefix: "wf_"), mutation != Self.workflowKey(id) else { return }
        let key = Self.workflowKey(id), request = UUID()
        requests[key] = request; setLoading(key, true)
        defer { if requests[key] == request { requests[key] = nil; setLoading(key, false) } }
        do {
            let value: WorkflowResponse = try await client.perform("/v1/bots/teams/\(teamId)/workflows/\(id)")
            guard isCurrent(), requests[key] == request, !Task.isCancelled, workflowTeam(teamId) != nil else { return }
            try applyWorkflow(value.workflow, id: id, teamId: teamId)
            setMessage(key, nil)
        } catch is CancellationError { }
        catch { if isCurrent(), requests[key] == request, !Task.isCancelled { setMessage(key, error.localizedDescription) } }
    }
    private func applyWorkflow(_ value: BotTeamWorkflow, id: String, teamId: String) throws {
        guard value.hasValidProof, value.id == id, value.teamId == teamId else { throw CompanionError.server("The Mac returned a different or unreadable workflow. Refresh before continuing.") }
        if let old = workflow(id, teamId: teamId) {
            guard value.revision >= old.revision else { return }
            guard value.revision != old.revision || value.hasSameCheckpoint(as: old) else { throw CompanionError.server("The workflow changed without a new revision. Refresh before continuing.") }
        }
        if workflowDetails[id] != value { workflowDetails[id] = value }
        if let index = workflows[teamId]?.workflows.firstIndex(where: { $0.id == id }), workflows[teamId]?.workflows[index] != value {
            workflows[teamId]?.workflows[index] = value
        }
    }
    private func workflowMutation<Body: Encodable>(_ key: String, teamId: String, path: String, body: Body) async -> BotTeamWorkflow? {
        guard let client, isCurrent(), !Task.isCancelled, mutation == nil, workflowTeam(teamId) != nil,
              workflows[teamId]?.isAvailable == true, messages[Self.workflowsKey(teamId)] == nil else { return nil }
        requests[Self.workflowsKey(teamId)] = nil; setLoading(Self.workflowsKey(teamId), false)
        let request = UUID(); mutation = key; requests[key] = request; setMessage(key, nil)
        defer { if requests[key] == request { requests[key] = nil }; if mutation == key { mutation = nil } }
        do {
            let value: WorkflowResponse = try await client.perform(path, method: "POST", jsonBody: body)
            guard isCurrent(), requests[key] == request, !Task.isCancelled, workflowTeam(teamId) != nil,
                  workflows[teamId]?.isAvailable == true else { return nil }
            return value.workflow
        } catch is CancellationError { return nil }
        catch {
            guard isCurrent(), requests[key] == request, !Task.isCancelled else { return nil }
            setMessage(key, error.localizedDescription)
            return nil
        }
    }
    @discardableResult func createWorkflow(teamId: String, draft: BotTeamWorkflowDraft) async -> BotTeamWorkflow? {
        let key = Self.workflowsKey(teamId)
        guard let team = workflowTeam(teamId), team.enabled, draft.isValid(memberIds: team.memberIds),
              currentBotIds().map({ Set([draft.plannerId, draft.builderId, draft.evaluatorId]).isSubset(of: $0) }) != false else { return nil }
        let value = await workflowMutation(key, teamId: teamId, path: "/v1/bots/teams/\(teamId)/workflows", body: draft)
        guard isCurrent(), !Task.isCancelled else { return nil }
        guard let value else { return nil }
        guard value.hasValidProof, value.teamId == teamId, value.goal == draft.goal, value.plannerId == draft.plannerId,
              value.builderId == draft.builderId, value.evaluatorId == draft.evaluatorId, value.criteria.map(\.text) == draft.criteria else {
            setMessage(key, "Strata did not confirm this exact workflow. Refresh before making another request."); return nil
        }
        do { try applyWorkflow(value, id: value.id, teamId: teamId) }
        catch { setMessage(key, error.localizedDescription); return nil }
        await refreshWorkflows(teamId)
        guard isCurrent(), !Task.isCancelled else { return nil }
        return workflow(value.id, teamId: teamId)
    }
    private func currentWorkflow(_ value: BotTeamWorkflow) -> Bool {
        workflowTeam(value.teamId) != nil && workflows[value.teamId]?.isAvailable == true &&
        messages[Self.workflowsKey(value.teamId)] == nil && messages[Self.workflowKey(value.id)] == nil &&
        workflow(value.id, teamId: value.teamId).map(value.matches) == true
    }
    @discardableResult func changeWorkflow(_ value: BotTeamWorkflow, action: String, requestId: String? = nil, decision: String? = nil, note: String = "", inspected: Bool = false) async -> Bool {
        guard currentWorkflow(value), ["resume", "stop", "review"].contains(action) else { return false }
        struct Proof: Encodable { var expectedRevision: Int; var expectedProof: String; var requestId: String?; var inspected: Bool?; var decision: String?; var note: String? }
        var proof = Proof(expectedRevision: value.revision, expectedProof: value.proof)
        switch action {
        case "resume":
            guard teams?.teams.first(where: { $0.id == value.teamId })?.enabled == true, value.canContinue, inspected, let requestId, BotTeamWorkflow.validRequestID(requestId) else { return false }
            proof.requestId = requestId; proof.inspected = true
        case "stop": guard value.canStop else { return false }
        default:
            guard value.canReview, let decision, ["accept", "changes_requested"].contains(decision), BotTeamWorkflow.validText(note, maximum: 2_500) else { return false }
            if decision == "changes_requested", teams?.teams.first(where: { $0.id == value.teamId })?.enabled != true { return false }
            proof.decision = decision; proof.note = note.isEmpty ? nil : note
        }
        let key = Self.workflowKey(value.id)
        let response = await workflowMutation(key, teamId: value.teamId, path: "/v1/bots/teams/\(value.teamId)/workflows/\(value.id)/\(action)", body: proof)
        guard isCurrent(), !Task.isCancelled else { return false }
        guard let response else {
            let message = messages[key]
            // Reconcile only by reading. A conflict or lost reply never replays
            // resume, stop or owner acceptance automatically.
            await refreshWorkflow(value.id, teamId: value.teamId)
            guard isCurrent(), !Task.isCancelled else { return false }
            setMessage(key, message); return false
        }
        guard response.hasValidProof, response.id == value.id, response.teamId == value.teamId,
              response.goal == value.goal, response.plannerId == value.plannerId, response.builderId == value.builderId,
              response.evaluatorId == value.evaluatorId, response.criteria == value.criteria, response.createdAt == value.createdAt,
              response.revision > value.revision, response.proof != value.proof,
              action != "stop" || [.stopping, .stopped].contains(response.phase),
              action != "resume" || ![.completed, .stopping, .stopped].contains(response.phase),
              action != "review" || decision != "accept" || response.phase == .completed,
              action != "review" || decision != "changes_requested" || response.phase != .completed else {
            setMessage(key, "Strata did not confirm this exact workflow action. Refresh its saved state before continuing."); return false
        }
        do { try applyWorkflow(response, id: value.id, teamId: value.teamId) }
        catch { setMessage(key, error.localizedDescription); return false }
        await refreshWorkflow(value.id, teamId: value.teamId)
        guard isCurrent(), !Task.isCancelled else { return false }
        return true
    }

    func refreshTeams() async {
        await load("teams", path: "/v1/bots/teams") { (value: BotTeamsSnapshot) in if self.teams != value { self.teams = value }; self.setMessage("teams", value.reason) }
    }
    func refreshActivity() async {
        struct Snapshot: Decodable { var activity: [BotWorkspaceActivity]; var reason: String?; var teamWorkReviewSupported: Bool? }
        await load("activity", path: "/v1/bots/activity") { (value: Snapshot) in
            self.setMessage("activity", value.reason)
            guard value.reason == nil else { return }
            if self.activity != value.activity { self.activity = value.activity }
            if !self.activityLoaded { self.activityLoaded = true }
            let reviewSupported = value.teamWorkReviewSupported == true
            if self.activityWorkReviewSupported != reviewSupported { self.activityWorkReviewSupported = reviewSupported }
            let retainedPlans = self.recoveryPlans.filter { id, plan in
                value.activity.contains { $0.id == id && $0.work?.revision == plan.expectedRevision && $0.work?.canPlanRecovery == true }
            }
            if self.recoveryPlans != retainedPlans { self.recoveryPlans = retainedPlans }
        }
    }
    func refreshSupervision() async {
        await load("supervision", path: "/v1/bots/supervision") { (value: BotSupervisionSnapshot) in if self.supervision != value { self.supervision = value }; self.setMessage("supervision", value.reason) }
    }
    func refreshHarnessActions(force: Bool = false) async {
        if !force, let checked = harnessActionsCheckedAt, Date().timeIntervalSince(checked) < 10 { return }
        harnessActionsCheckedAt = Date()
        await load("harnessActions", path: "/v1/bots/harness/actions") { (value: BotHarnessActionsSnapshot) in
            if self.harnessActions != value { self.harnessActions = value }; self.setMessage("harnessActions", value.reason)
        }
    }
    @discardableResult func reviewHarnessAction(_ action: BotHarnessAction) async -> Bool {
        guard action.canReview, harnessActions?.available == true, messages["harnessActions"] == nil,
              action.id.range(of: "^ba_[a-f0-9]{64}$", options: .regularExpression) != nil,
              let current = harnessActions?.actions.first(where: { $0.id == action.id }), action.matches(current) else { return false }
        struct Proof: Encodable { var expectedRevision: Int; var expectedProof: String; var decision = "acknowledge" }
        struct Result: Decodable { var acknowledged: Bool; var action: BotHarnessAction; var resumed: Bool; var retried: Bool }
        let result: Result? = await change("harnessActions", path: "/v1/bots/harness/actions/\(action.id)/review", body: Proof(expectedRevision: action.revision, expectedProof: action.proof))
        if let result, result.acknowledged, result.action.hasValidProof, result.action.id == action.id,
           result.action.chatId == action.chatId, result.action.toolName == action.toolName, result.action.origin == "local", !result.action.readOnly,
           result.action.revision == action.revision + 1, result.action.proof != action.proof, result.action.state == "reviewed", !result.resumed, !result.retried {
            await refreshHarnessActions(force: true); return isCurrent()
        }
        if result != nil { setMessage("harnessActions", "Strata did not confirm review of this exact action. Refresh its receipt before continuing.") }
        return false
    }
    func refreshSkills() async {
        await load("skills", path: "/v1/bots/skills") { (value: BotSkillsSnapshot) in if self.skills != value { self.skills = value }; self.setMessage("skills", value.reason) }
    }
    func refreshCreatedTools() async {
        await load("createdTools", path: "/v1/bots/tools") { (value: BotCreatedToolsSnapshot) in
            if self.createdTools != value { self.createdTools = value }
            self.setMessage("createdTools", value.reason ?? (value.isAvailable ? nil : "Update Strata on your Mac to manage reusable tools."))
        }
    }
    func refreshConnections() async {
        await load("connections", path: "/v1/bots/connections") { (value: BotConnectionsSnapshot) in if self.connections != value { self.connections = value }; self.setMessage("connections", value.reason) }
    }
    func refreshConnectorCatalog() async {
        guard connections?.connectorFeatures?.catalog == true else { return }
        await load("connectorCatalog", path: "/v1/bots/connectors/catalog") { (value: BotConnectorCatalog) in if self.connectorCatalog != value { self.connectorCatalog = value }; self.setMessage("connectorCatalog", value.reason) }
    }
    private func setMessage(_ key: String, _ message: String?) {
        if messages[key] != message { messages[key] = message }
    }
    private func setLoading(_ key: String, _ active: Bool) {
        if active, !loading.contains(key) { loading.insert(key) }
        else if !active, loading.contains(key) { loading.remove(key) }
    }
    private func load<T: Decodable>(_ key: String, path: String, apply: (T) -> Void) async {
        guard let client, isCurrent() else { return }
        let request = UUID(); requests[key] = request; setLoading(key, true)
        defer { if requests[key] == request { requests[key] = nil; setLoading(key, false) } }
        do {
            let value: T = try await client.perform(path)
            guard isCurrent(), requests[key] == request, !Task.isCancelled else { return }
            apply(value)
        } catch is CancellationError { }
        catch { if isCurrent(), requests[key] == request, !Task.isCancelled { setMessage(key, error.localizedDescription) } }
    }
    private func change<T: Decodable, Body: Encodable>(_ key: String, path: String, method: String = "POST", body: Body) async -> T? {
        guard let client, isCurrent(), mutation == nil else { return nil }
        mutation = key; messages[key] = nil; workErrorStatus[key] = nil
        requests[key] = nil; setLoading(key, false)
        defer { mutation = nil }
        do {
            let value: T
            if method == "DELETE", key != "createdTools" { value = try await client.perform(path, method: method) }
            else { value = try await client.perform(path, method: method, jsonBody: body) }
            guard isCurrent(), !Task.isCancelled else { return nil }
            return value
        } catch {
            guard isCurrent() else { return nil }
            let message = error.localizedDescription
            workErrorStatus[key] = (error as? CompanionHTTPError)?.statusCode
            if (error as? CompanionHTTPError)?.statusCode == 409 {
                if key == "skills" { await refreshSkills() }
                else if key == "createdTools" { await refreshCreatedTools() }
                else if key == "connections" { await refreshConnections() }
                else if key == "teams" { await refreshTeams() }
                else if key == "harnessActions" { await refreshHarnessActions(force: true) }
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
            self.setMessage(key, nil)
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
        var body = draft
        let chosenContinuous = body.limits == .continuous
        guard Self.validTeamDraft(body, unrestrictedTeams: unrestrictedTeams, continuousTeams: chosenContinuous, availableMemberIds: currentBotIds()), validTeamExecution(body), body.briefing == nil || teams?.teamInstructionsSupported == true else { return false }
        struct Result: Decodable { var team: BotTeam }
        body.limits = body.limits.forHost(unrestrictedTeams: unrestrictedTeams, continuousTeams: chosenContinuous)
        let value: Result? = await change("teams", path: "/v1/bots/teams", body: body)
        if value != nil { await refreshTeams() }
        return value != nil && isCurrent()
    }
    func updateTeam(_ team: BotTeam, draft: BotTeamDraft, retainedMemberIds: Set<String>? = nil) async -> Bool {
        var draft = draft
        let chosenContinuous = draft.limits == .continuous
        guard teams?.teamSettingsSupported == true, CompanionClient.isSafeIdentifier(team.id),
              let revision = team.revision, revision > 0,
              teams?.teams.first(where: { $0.id == team.id })?.revision == revision,
              teams?.runs.contains(where: { $0.teamId == team.id && $0.isActive }) != true,
              Self.validTeamDraft(draft, unrestrictedTeams: unrestrictedTeams, continuousTeams: chosenContinuous, availableMemberIds: currentBotIds(), retainedMemberIds: retainedMemberIds ?? Set(team.memberIds)), validTeamExecution(draft), draft.briefing == nil || teams?.teamInstructionsSupported == true else { return false }
        struct Result: Decodable { var team: BotTeam }
        let body = BotTeamUpdate(expectedRevision: revision, name: draft.name, memberIds: draft.memberIds,
                                 coordinatorId: draft.coordinatorId, limits: draft.limits.forHost(unrestrictedTeams: unrestrictedTeams, continuousTeams: chosenContinuous), execution: draft.execution ?? .individual, briefing: draft.briefing, talkativeness: draft.talkativeness, bidding: draft.bidding)
        let value: Result? = await change("teams", path: "/v1/bots/teams/\(team.id)", method: "PATCH", body: body)
        if value != nil { await refreshTeams() }
        return value != nil && isCurrent()
    }
    /// Drops one saved teammate and patches the roster. A failed save puts the previous team back.
    func removeTeamMember(_ team: BotTeam, botId: String) async -> Bool {
        guard var snapshot = teams, let index = snapshot.teams.firstIndex(where: { $0.id == team.id }) else { return false }
        let original = snapshot.teams[index]
        guard original.memberIds.contains(botId) else { return false }
        guard teams?.teamSettingsSupported == true else {
            if isCurrent() { messages["teams"] = "Update Strata on your Mac to edit this team." }
            return false
        }
        if teams?.runs.contains(where: { $0.teamId == original.id && $0.isActive }) == true {
            if isCurrent() { messages["teams"] = "Finish or stop team work before removing a teammate." }
            return false
        }
        if let computerId = original.execution?.computerId, teams?.teamComputers?.first(where: { $0.id == computerId })?.memberId == botId {
            if isCurrent() { messages["teams"] = "Choose another computer before removing the teammate who hosts it." }
            return false
        }
        var memberIds = original.memberIds
        memberIds.removeAll { $0 == botId }
        var coordinatorId = original.coordinatorId
        if coordinatorId == botId { coordinatorId = memberIds.first ?? "" }
        guard memberIds.count >= 2, memberIds.contains(coordinatorId) else {
            if isCurrent() { messages["teams"] = "Choose from 2 to 12 team members." }
            return false
        }
        var next = original
        next.memberIds = memberIds
        next.coordinatorId = coordinatorId
        if let briefing = next.briefing {
            next.briefing = BotTeamBriefing(instructions: briefing.instructions, members: briefing.members.filter { memberIds.contains($0.botId) })
        }
        if let voice = next.talkativeness { next.talkativeness = voice.filter { memberIds.contains($0.key) } }
        let previous = teams
        snapshot.teams[index] = next
        teams = snapshot
        let draft = BotTeamDraft(name: next.name, memberIds: next.memberIds, coordinatorId: next.coordinatorId, enabled: next.enabled, limits: next.limits, execution: next.execution, briefing: next.briefing, talkativeness: next.talkativeness, bidding: next.bidding)
        let saved = await updateTeam(original, draft: draft, retainedMemberIds: Set(original.memberIds))
        if !saved, isCurrent(), teams?.teams.first(where: { $0.id == original.id })?.memberIds == memberIds { teams = previous }
        return saved && isCurrent()
    }
    private func validTeamExecution(_ draft: BotTeamDraft) -> Bool {
        guard let execution = draft.execution, execution.isShared else { return true }
        return teams?.teamSettingsSupported == true && teams?.teamComputers?.contains {
            $0.id == execution.computerId && $0.available && ($0.memberId == nil || draft.memberIds.contains($0.memberId!)) && $0.allowsFolder(execution.workspace ?? "")
        } == true
    }
    static let deletedBotName = "Deleted bot"
    static func teamCapMessage(count: Int, cap: Int = 12) -> String {
        "This team has \(count) of \(cap) members; remove some to save changes"
    }
    static func validTeamDraft(_ draft: BotTeamDraft, unrestrictedTeams: Bool = false, continuousTeams: Bool = false, availableMemberIds: Set<String>? = nil, retainedMemberIds: Set<String>? = nil) -> Bool {
        let validLimits = continuousTeams ? draft.limits == .continuous :
            (unrestrictedTeams ? draft.limits.maxParallel >= 0 : (1...8).contains(draft.limits.maxParallel)) &&
            (1...4).contains(draft.limits.maxDepth) && (1...32).contains(draft.limits.maxHops) &&
            (1...100).contains(draft.limits.maxTurns) && (60_000...3_600_000).contains(draft.limits.maxDurationMs)
        let unique = Set(draft.memberIds)
        let shrinking = retainedMemberIds.map { unique.isSubset(of: $0) && draft.memberIds.count <= $0.count && unique.count == draft.memberIds.count } ?? false
        let known = availableMemberIds.map { available in draft.memberIds.allSatisfy { available.contains($0) || (shrinking && retainedMemberIds?.contains($0) == true) } } ?? true
        guard !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, draft.name.count <= 80,
              draft.memberIds.count >= 2, shrinking || draft.memberIds.count <= 12,
              unique.count == draft.memberIds.count,
              draft.memberIds.allSatisfy(CompanionClient.isSafeIdentifier), draft.memberIds.contains(draft.coordinatorId),
              known, validLimits else { return false }
        if let voice = draft.talkativeness, voice.contains(where: { !draft.memberIds.contains($0.key) || !(0...100).contains($0.value) }) { return false }
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

    /// Posts the host's recovery choice. The saved message comes back with `recovery.choice` set.
    func chooseMessageRecovery(teamId: String, messageId: String, choice: String) async -> String? {
        guard CompanionClient.isSafeIdentifier(teamId), CompanionClient.isSafeIdentifier(messageId), ["retry", "skip", "different"].contains(choice) else {
            return "That choice is not available yet."
        }
        struct Body: Encodable { var choice: String }
        struct Result: Decodable { var accepted: Bool; var choice: String; var message: BotTeamChannelMessage }
        let key = "recovery-choice-" + messageId
        let value: Result? = await change(key, path: "/v1/bots/teams/\(teamId)/messages/\(messageId)/choice", body: Body(choice: choice))
        guard let value, value.accepted, value.choice == choice, value.message.id == messageId, value.message.teamId == teamId else {
            return messages[key] ?? "The choice was not saved. Try again."
        }
        if var channel = channels[teamId], let index = channel.messages.firstIndex(where: { $0.id == messageId && $0.sequence == value.message.sequence }) {
            channel.messages[index] = value.message
            channels[teamId] = channel
        }
        await refreshChannel(teamId)
        return nil
    }

    func refreshChannel(_ teamId: String, reset: Bool = false, older: Bool = false) async {
        guard let client, isCurrent(), CompanionClient.isSafeIdentifier(teamId) else { return }
        let key = Self.channelKey(teamId)
        // A write invalidates any in-flight read. Polling cannot race its result.
        guard mutation != key else { return }
        let previous = channels[teamId]
        let before = older ? previous?.messages.first?.sequence : nil
        let after = !reset && !older ? channelCursors[teamId] : nil
        let token = UUID(); requests[key] = token; setLoading(key, true)
        defer { if requests[key] == token { requests[key] = nil; setLoading(key, false) } }
        do {
            let value = try await client.teamChannel(teamId: teamId, after: after, before: before)
            guard isCurrent(), requests[key] == token, !Task.isCancelled else { return }
            try applyChannel(value, teamId: teamId, replacing: reset || previous == nil, older: older)
            setMessage(key, value.reason)
        } catch is CancellationError { }
        catch {
            guard isCurrent(), requests[key] == token else { return }
            if (error as? CompanionHTTPError)?.isUnsupported == true {
                let unavailable = BotTeamChannel(teamId: teamId, supported: false, messages: [], activeRuns: [], nextSequence: 0, reason: "Update Strata on your Mac for the shared team channel. Existing team tasks remain available.")
                if channels[teamId] != unavailable { channels[teamId] = unavailable }
            } else { setMessage(key, error.localizedDescription) }
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
        // Most incremental polls contain no new entries. Preserve the exact
        // retained history and cursor without re-indexing and sorting it.
        if !replacing && !older && value.messages.isEmpty, let previous = channels[teamId] {
            var merged = value
            merged.messages = previous.messages
            merged.hasMoreBefore = previous.hasMoreBefore
            merged.nextSequence = channelCursors[teamId] ?? 0
            if channels[teamId] != merged { channels[teamId] = merged }
            return
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
        if channels[teamId] != merged { channels[teamId] = merged }
    }

    func postTeamMessage(_ team: BotTeam, draft: BotTeamChannelPost) async -> Bool {
        let text = draft.message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard team.enabled, CompanionClient.isSafeIdentifier(team.id),
              CompanionClient.isSafeIdentifier(draft.requestId), !text.isEmpty, text.utf16.count <= 16_000,
              draft.replyToId == nil || CompanionClient.isSafeIdentifier(draft.replyToId!),
              draft.recipientIds == nil || (!draft.recipientIds!.isEmpty && draft.recipientIds!.count <= team.memberIds.count && Set(draft.recipientIds!).count == draft.recipientIds!.count && draft.recipientIds!.allSatisfy({ team.memberIds.contains($0) })),
              channels[team.id]?.supported == true,
              draft.workMode == nil || teams?.teamCoordinatorWorkToolsSupported == true,
              draft.durablePlan == nil || draft.durablePlan == true && draft.workMode == .work && workPlansSupported else { return false }
        struct Result: Decodable { var channel: BotTeamChannel; var run: BotTeamRun?; var planId: String?; var sourceMessage: BotTeamChannelMessage?; var sourceMessageId: String? }
        let key = Self.channelKey(team.id)
        let value: Result? = await change(key, path: "/v1/bots/teams/\(team.id)/messages", body: draft)
        guard let value, isCurrent(), !Task.isCancelled else { return false }
        do {
            if draft.durablePlan == true {
                let source = value.sourceMessage.map { [$0] } ?? []
                guard workPlansSupported, let planId = value.planId, BotTeamWorkPlan.validID(planId, "tp_"),
                      let run = value.run, run.teamId == team.id, run.planId == planId,
                      value.channel.teamId == team.id, (value.channel.messages + source).contains(where: { $0.teamId == team.id && $0.author.type == "user" && $0.kind == "message" && $0.workMode == .work && $0.content == text && $0.runId == run.id && $0.planId == planId && $0.replyToId == draft.replyToId && ($0.recipientIds ?? []).sorted() == (draft.recipientIds ?? []).sorted() && (value.sourceMessageId == nil || $0.id == value.sourceMessageId) }) else {
                    throw CompanionError.server("Strata did not confirm this exact team plan request. Refresh the channel before sending again.")
                }
            }
            try applyChannel(value.channel, teamId: team.id, replacing: false)
            await refreshTeams()
            guard isCurrent(), !Task.isCancelled else { return false }
            if draft.durablePlan == true { await refreshWorkPlans(team.id) }
            return isCurrent()
        } catch { messages[key] = error.localizedDescription; return false }
    }

    private func currentCreatedTool(_ reviewed: BotCreatedTool) -> BotCreatedTool? {
        guard isCurrent(), createdTools?.isAvailable == true, messages["createdTools"] == nil,
              reviewed.hasValidReview, let current = createdTools?.tools.first(where: { $0.id == reviewed.id }),
              current.matchesReview(reviewed) else { return nil }
        return current
    }
    @discardableResult func saveCreatedTool(_ draft: BotCreatedToolDraft, reviewing tool: BotCreatedTool? = nil) async -> Bool {
        guard draft.requirements == nil || createdTools?.createdToolReadinessSupported == true else {
            setMessage("createdTools", "Update Strata on your Mac before reviewing tool requirements."); return false
        }
        guard draft.isValid, createdTools?.isAvailable == true,
              tool == nil || currentCreatedTool(tool!) != nil else {
            setMessage("createdTools", "This tool changed or is unavailable. Refresh and review its current definition."); return false
        }
        struct Result: Decodable { var tool: BotCreatedTool }
        let value: Result?
        if let tool {
            struct Update: Encodable { var name: String; var description: String; var command: String; var inputSchema: BotToolJSON; var timeoutSeconds: Int; var requirements: BotToolRequirements?; var status = "draft"; var expectedRevision: Int; var expectedDigest: String }
            value = await change("createdTools", path: "/v1/bots/tools/\(tool.id)", method: "PATCH", body: Update(name: draft.name, description: draft.description, command: draft.command, inputSchema: draft.inputSchema, timeoutSeconds: draft.timeoutSeconds, requirements: draft.requirements, expectedRevision: tool.revision, expectedDigest: tool.digest))
        } else { value = await change("createdTools", path: "/v1/bots/tools", body: draft) }
        if value != nil { await refreshCreatedTools() }
        return value != nil && isCurrent()
    }
    @discardableResult func setCreatedToolEnabled(_ tool: BotCreatedTool, enabled: Bool) async -> Bool {
        guard currentCreatedTool(tool) != nil else {
            setMessage("createdTools", "This tool changed. Review its current definition before changing its status."); return false
        }
        struct Update: Encodable { var status: String; var expectedRevision: Int; var expectedDigest: String }
        struct Result: Decodable { var tool: BotCreatedTool }
        let value: Result? = await change("createdTools", path: "/v1/bots/tools/\(tool.id)", method: "PATCH", body: Update(status: enabled ? "enabled" : "draft", expectedRevision: tool.revision, expectedDigest: tool.digest))
        if value != nil { await refreshCreatedTools() }
        return value != nil && isCurrent()
    }
    @discardableResult func deleteCreatedTool(_ tool: BotCreatedTool) async -> Bool {
        guard currentCreatedTool(tool) != nil else {
            setMessage("createdTools", "This tool changed. Review its current definition before deleting it."); return false
        }
        struct Proof: Encodable { var expectedRevision: Int; var expectedDigest: String }
        struct Result: Decodable { var deleted: Bool }
        let value: Result? = await change("createdTools", path: "/v1/bots/tools/\(tool.id)", method: "DELETE", body: Proof(expectedRevision: tool.revision, expectedDigest: tool.digest))
        if value?.deleted == true { await refreshCreatedTools() }
        return value?.deleted == true && isCurrent()
    }
    /// Merge one explicit grant into the latest exact revision, so a phone
    /// toggle cannot overwrite assignments made on Mac while the page was open.
    @discardableResult func assignCreatedTool(_ tool: BotCreatedTool, botId: String? = nil, teamId: String? = nil, assigned: Bool) async -> Bool {
        guard let client, isCurrent(), mutation == nil, !isPreparingAssignment,
              (botId == nil) != (teamId == nil), CompanionClient.isSafeIdentifier(botId ?? teamId ?? ""),
              currentCreatedTool(tool) != nil else { return false }
        isPreparingAssignment = true
        defer { isPreparingAssignment = false }
        let snapshot: BotCreatedToolsSnapshot
        do { snapshot = try await client.perform("/v1/bots/tools") }
        catch { if isCurrent() { setMessage("createdTools", error.localizedDescription) }; return false }
        guard isCurrent(), !Task.isCancelled else { return false }
        requests["createdTools"] = nil; setLoading("createdTools", false)
        if createdTools != snapshot { createdTools = snapshot }
        guard snapshot.isAvailable, let fresh = snapshot.tools.first(where: { $0.id == tool.id }),
              fresh.matchesReview(tool), !assigned || fresh.isEnabled else {
            setMessage("createdTools", "This tool changed. Review its current definition before assigning it."); return false
        }
        var botIds = Set(fresh.botIds), teamIds = Set(fresh.teamIds)
        if let botId { if assigned { botIds.insert(botId) } else { botIds.remove(botId) } }
        if let teamId { if assigned { teamIds.insert(teamId) } else { teamIds.remove(teamId) } }
        struct Update: Encodable { var botIds: [String]; var teamIds: [String]; var expectedRevision: Int; var expectedDigest: String }
        struct Result: Decodable { var tool: BotCreatedTool }
        let value: Result? = await change("createdTools", path: "/v1/bots/tools/\(tool.id)", method: "PATCH", body: Update(botIds: botIds.sorted(), teamIds: teamIds.sorted(), expectedRevision: fresh.revision, expectedDigest: fresh.digest))
        if value != nil { await refreshCreatedTools() }
        return value != nil && isCurrent()
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
                guard value.connection.id == connection.id,
                      let index = self.connections?.connections.firstIndex(where: { $0.id == connection.id }) else {
                    self.setMessage("connections", "The account changed while its sign-in status was being checked. Refresh your connectors.")
                    return
                }
                if self.connections?.connections[index] != value.connection { self.connections?.connections[index] = value.connection }
                self.setMessage("connections", nil)
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
