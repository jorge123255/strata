import Foundation
import Combine

/// A pairing-scoped view model. A revoked or replaced pairing cannot publish a
/// late catalog, mutation result, or conversation navigation into its successor.
@MainActor
final class BotWorkspaceStore: ObservableObject {
    @Published private(set) var teams: BotTeamsSnapshot?
    @Published private(set) var channels: [String: BotTeamChannel] = [:]
    @Published private(set) var activity: [BotWorkspaceActivity] = []
    @Published private(set) var skills: BotSkillsSnapshot?
    @Published private(set) var connections: BotConnectionsSnapshot?
    @Published private(set) var connectorCatalog: BotConnectorCatalog?
    @Published private(set) var messages: [String: String] = [:]
    @Published private(set) var loading: Set<String> = []
    @Published private(set) var mutation: String?
    @Published private(set) var isPreparingAssignment = false
    private let client: CompanionClient?
    private let isCurrent: () -> Bool
    private var requests: [String: UUID] = [:]
    private var channelCursors: [String: Int] = [:]

    init(client: CompanionClient?, isCurrent: @escaping () -> Bool) { self.client = client; self.isCurrent = isCurrent }

    func refreshTeams() async {
        await load("teams", path: "/v1/bots/teams") { (value: BotTeamsSnapshot) in self.teams = value; self.messages["teams"] = value.reason }
    }
    func refreshActivity() async {
        struct Snapshot: Decodable { var activity: [BotWorkspaceActivity]; var reason: String? }
        await load("activity", path: "/v1/bots/activity") { (value: Snapshot) in self.activity = value.activity; self.messages["activity"] = value.reason }
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
        mutation = key; messages[key] = nil
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
            if (error as? CompanionHTTPError)?.statusCode == 409 {
                if key == "skills" { await refreshSkills() }
                else if key == "connections" { await refreshConnections() }
                else if key == "teams" { await refreshTeams() }
            }
            if isCurrent() { messages[key] = message }
            return nil
        }
    }

    func createTeam(_ draft: BotTeamDraft) async -> Bool {
        guard Self.validTeamDraft(draft), validTeamExecution(draft), draft.briefing == nil || teams?.teamInstructionsSupported == true else { return false }
        struct Result: Decodable { var team: BotTeam }
        let value: Result? = await change("teams", path: "/v1/bots/teams", body: draft)
        if value != nil { await refreshTeams() }
        return value != nil && isCurrent()
    }
    func updateTeam(_ team: BotTeam, draft: BotTeamDraft) async -> Bool {
        guard teams?.teamSettingsSupported == true, CompanionClient.isSafeIdentifier(team.id),
              let revision = team.revision, revision > 0,
              teams?.teams.first(where: { $0.id == team.id })?.revision == revision,
              teams?.runs.contains(where: { $0.teamId == team.id && $0.isActive }) != true,
              Self.validTeamDraft(draft), validTeamExecution(draft), draft.briefing == nil || teams?.teamInstructionsSupported == true else { return false }
        struct Result: Decodable { var team: BotTeam }
        let body = BotTeamUpdate(expectedRevision: revision, name: draft.name, memberIds: draft.memberIds,
                                 coordinatorId: draft.coordinatorId, limits: draft.limits, execution: draft.execution ?? .individual, briefing: draft.briefing)
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
    static func validTeamDraft(_ draft: BotTeamDraft) -> Bool {
        guard !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, draft.name.count <= 80,
              (2...12).contains(draft.memberIds.count), Set(draft.memberIds).count == draft.memberIds.count,
              draft.memberIds.allSatisfy(CompanionClient.isSafeIdentifier), draft.memberIds.contains(draft.coordinatorId) else { return false }
        if let briefing = draft.briefing {
            func validText(_ value: String, max: Int) -> Bool { value.utf16.count <= max && !value.contains("\0") }
            guard validText(briefing.instructions, max: 8_000), briefing.members.count <= 12,
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
        guard connections?.connectorFeatures?.httpCreation == true, draft.isValid,
              draft.authType != "oauth" || connections?.connectorFeatures?.oauth == true,
              connection == nil || connection?.transport == "http", connection == nil || CompanionClient.isSafeIdentifier(connection!.id) else { return false }
        struct Result: Decodable { var connection: BotMCPConnection }
        let path = connection.map { "/v1/bots/connections/\($0.id)" } ?? "/v1/bots/connections"
        var reviewedDraft = draft
        reviewedDraft.expectedInventoryDigest = connection?.inventoryDigest
        let value: Result? = await change("connections", path: path, method: connection == nil ? "POST" : "PATCH", body: reviewedDraft)
        if value != nil { await refreshConnections() }
        return value != nil && isCurrent()
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
    @discardableResult func connectorAuthentication(_ connection: BotMCPConnection, action: String, callbackURL: String? = nil) async -> Bool {
        guard connections?.connectorFeatures?.oauth == true, connection.authType == "oauth",
              CompanionClient.isSafeIdentifier(connection.id), ["start", "poll", "disconnect", "complete"].contains(action) else { return false }
        struct Result: Decodable { var connection: BotMCPConnection }
        let path = "/v1/bots/connections/\(connection.id)/auth" + (action == "complete" ? "/complete" : "")
        if action == "poll" {
            await load("connections", path: path) { (value: Result) in
                if let index = self.connections?.connections.firstIndex(where: { $0.id == value.connection.id }) { self.connections?.connections[index] = value.connection }
            }
            return messages["connections"] == nil && isCurrent()
        }
        let body = callbackURL.map { ["callbackURL": $0] } ?? [:]
        let value: Result? = await change("connections", path: path, method: action == "disconnect" ? "DELETE" : "POST", body: body)
        if value != nil { await refreshConnections() }
        return value != nil && isCurrent()
    }

}
