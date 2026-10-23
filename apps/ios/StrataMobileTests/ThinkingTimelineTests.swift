import XCTest
@testable import StrataMobile

final class ThinkingTimelineTests: XCTestCase {
    func testOrderedProgressPreservesNarrativeAndExactToolMembership() throws {
        let message = try decode([
            "content": "First narrative.Second narrative.",
            "reasoning": "Inspect the workspace.\nCheck the final change.", "reasoningMs": 2400,
            "tools": [tool("session:command.1"), tool("session:browser.2"), tool("pending.3", state: "proposed")],
            "blocks": [
                ["kind": "text", "text": "First narrative."],
                ["kind": "group", "id": "group.1", "line": "Ran 3 commands", "closed": true, "toolIds": ["session:command.1"]],
                ["kind": "text", "text": "Second narrative."],
                ["kind": "group", "id": "group.2", "line": "Ran 3 commands, edited a file", "closed": false, "added": 8, "removed": 2, "toolIds": ["session:browser.2"]]
            ]
        ])
        XCTAssertEqual(message.timelineItems.map(\.id), ["text-0", "group-group.1", "text-2", "group-group.2", "tool-pending.3"])
        XCTAssertEqual(texts(message), ["First narrative.", "Second narrative."], "The aggregate content must not be repeated around ordered blocks.")
        XCTAssertEqual(actionIDs(message), ["session:command.1", "session:browser.2", "pending.3"])
        XCTAssertEqual(message.thinkingPreview, "Check the final change.")
    }

    func testUnmappedHistoricalGroupsDoNotClaimOrHideActions() throws {
        let message = try decode([
            "content": "", "tools": [tool("running", state: "running"), tool("pending", state: "proposed"), tool("denied", state: "denied")],
            "blocks": [["kind": "group", "id": "earlier", "line": "Ran 3 commands", "closed": false]]
        ])
        guard case .group(_, let members) = message.timelineItems.first else { return XCTFail("The group summary must remain first.") }
        XCTAssertTrue(members.isEmpty, "Membership must never be guessed from a summary count.")
        XCTAssertEqual(actionIDs(message), ["running", "pending", "denied"])
        XCTAssertEqual(message.timelineItems.count, 4)
    }

    func testOverlappingGroupsUnknownIDsAndDuplicateActionsRenderEachActionOnce() throws {
        let message = try decode([
            "content": "", "tools": [tool("helper:call.1"), tool("helper:call.1"), tool("unassigned")],
            "blocks": [
                ["kind": "group", "id": "first", "line": "Ran a command", "closed": true, "toolIds": ["helper:call.1", "missing", "helper:call.1"]],
                ["kind": "group", "id": "second", "line": "Checked the result", "closed": true, "toolIds": ["helper:call.1"]]
            ]
        ])
        XCTAssertEqual(actionIDs(message), ["helper:call.1", "unassigned"])
        guard case .group(_, let secondMembers) = message.timelineItems[1] else { return XCTFail("The second progress summary must stay in order.") }
        XCTAssertTrue(secondMembers.isEmpty)
    }

    func testMalformedOrUnknownBlocksKeepLegacyTextAndToolsReadable() throws {
        let message = try decode([
            "content": "A legacy answer", "tools": [tool("legacy")],
            "blocks": [NSNull(), ["kind": "future", "payload": "ignored"], ["kind": "text"], ["kind": "group", "line": "Missing ID"]]
        ])
        XCTAssertEqual(texts(message), ["A legacy answer"])
        XCTAssertEqual(actionIDs(message), ["legacy"])
        XCTAssertNil(message.thinkingText)
    }

    func testSummaryOnlyPartialSnapshotDoesNotLoseLegacyAnswer() throws {
        let message = try decode([
            "content": "An answer from an older host", "blocks": [["kind": "group", "id": "summary", "line": "Read a file", "closed": true]]
        ])
        XCTAssertEqual(message.timelineItems.map(\.id), ["group-summary", "fallback-text"])
        XCTAssertEqual(texts(message), ["An answer from an older host"])
    }

    func testThinkingUsesRealRecordedDurationAndLatestNonemptyPreview() throws {
        var message = try decode(["content": "Answer", "reasoning": "  First step\n\nLatest real step  \n", "reasoningMs": 6500])
        XCTAssertEqual(message.thinkingPreview, "Latest real step")
        XCTAssertEqual(message.thinkingTitle(isLive: true), "Thinking")
        XCTAssertEqual(message.thinkingTitle(isLive: false), "Thought for 7s")
        message.reasoningMs = nil
        XCTAssertEqual(message.thinkingTitle(isLive: false), "Thinking")
        message.reasoningMs = -10
        XCTAssertEqual(message.thinkingTitle(isLive: false), "Thinking")
        message.reasoningMs = .nan
        XCTAssertEqual(message.thinkingTitle(isLive: false), "Thinking")
        message.reasoningMs = 0
        XCTAssertEqual(message.thinkingTitle(isLive: false), "Thought for 0s")
    }

    func testThinkingStopsWhenAnswerStartsOrRecordedDurationArrives() throws {
        var message = try decode(["content": "", "reasoning": "Inspect the workspace", "streaming": true])
        XCTAssertTrue(message.isThinkingInProgress)
        message.content = "A narrative before using tools"
        XCTAssertFalse(message.isThinkingInProgress, "An ongoing tool turn is not ongoing model thinking once the answer started.")
        message.content = ""; message.reasoningMs = 1200
        XCTAssertFalse(message.isThinkingInProgress)
        message.reasoningMs = nil; message.streaming = false
        XCTAssertFalse(message.isThinkingInProgress, "A saved incomplete reasoning record must not pretend to be live.")
    }

    func testExplicitEditCountersAreNotRepeatedInTheSummarySentence() throws {
        let group = try JSONDecoder().decode(MacActivityGroup.self, from: JSONSerialization.data(withJSONObject: ["id": "edit", "line": "Edited a file +225 −0", "closed": true, "added": 225, "removed": 0]))
        XCTAssertEqual(group.displayTitle, "Edited a file")
        XCTAssertEqual(group.title, "Edited a file +225 −0", "The accessible description may preserve the complete Mac line.")
        let old = try JSONDecoder().decode(MacActivityGroup.self, from: JSONSerialization.data(withJSONObject: ["id": "edit", "line": "Edited a file +225 −0", "closed": true]))
        XCTAssertEqual(old.displayTitle, old.title, "A legacy summary without separate counters keeps its original information.")
    }

    func testWhitespaceReasoningDoesNotInventAThinkingBody() throws {
        let message = try decode(["content": "Answer", "reasoning": " \n\t "])
        XCTAssertNil(message.thinkingText)
        XCTAssertNil(message.thinkingPreview)
        XCTAssertEqual(texts(message), ["Answer"])
    }

    private func decode(_ fields: [String: Any]) throws -> MacChatMessage {
        var message: [String: Any] = ["id": "reply", "role": "assistant", "content": ""]
        fields.forEach { message[$0.key] = $0.value }
        return try JSONDecoder().decode(MacChatMessage.self, from: JSONSerialization.data(withJSONObject: message))
    }
    private func tool(_ id: String, state: String = "done") -> [String: Any] {
        ["id": id, "name": "mcp__shell__run", "state": state]
    }
    private func texts(_ message: MacChatMessage) -> [String] {
        message.timelineItems.compactMap { if case .text(_, let text) = $0 { return text }; return nil }
    }
    private func actionIDs(_ message: MacChatMessage) -> [String] {
        message.timelineItems.flatMap { item -> [String] in
            switch item {
            case .group(_, let tools): return tools.map(\.id)
            case .tool(let tool): return [tool.id]
            case .text: return []
            }
        }
    }

    func testCoucouSpringsMatchTheSharedMotion() {
        XCTAssertEqual(CoucouMotion.springResponse, 0.28, accuracy: 0.0001)
        XCTAssertEqual(CoucouMotion.springDamping, 0.82, accuracy: 0.0001)
        XCTAssertEqual(CoucouMotion.messageRise, 8, accuracy: 0.0001)
        XCTAssertEqual(CoucouMotion.messageStagger, 0.04, accuracy: 0.0001)
        XCTAssertEqual(CoucouMotion.typingDot, 5, accuracy: 0.0001)
        XCTAssertEqual(CoucouMotion.typingScaleMin, 0.6, accuracy: 0.0001)
        XCTAssertEqual(CoucouMotion.typingScaleMax, 1.2, accuracy: 0.0001)
        XCTAssertEqual(CoucouMotion.typingCycle, 0.9, accuracy: 0.0001)
        XCTAssertEqual(CoucouMotion.typingStagger, 0.14, accuracy: 0.0001)
        XCTAssertEqual(CoucouMotion.shimmerDuration, 2.2, accuracy: 0.0001)
    }

    func testCoucouHistoryStaysStillAndNewTurnsRise() {
        let arrivals = CoucouArrivals()
        let history = [CoucouRow(id: "m1", own: true), CoucouRow(id: "m2", own: false)]
        arrivals.begin(key: "chat", rows: history, ready: false)
        XCTAssertNil(arrivals.entrance(id: "m1"))
        arrivals.begin(key: "chat", rows: history, ready: true)
        XCTAssertNil(arrivals.entrance(id: "m1"))
        XCTAssertNil(arrivals.entrance(id: "m2"))
        arrivals.begin(key: "chat", rows: history + [CoucouRow(id: "m3", own: true)], ready: true)
        XCTAssertEqual(arrivals.entrance(id: "m3")?.fast, true)
        XCTAssertEqual(arrivals.entrance(id: "m3")?.delay ?? -1, 0, accuracy: 0.0001)
        arrivals.finish(id: "m3")
        XCTAssertNil(arrivals.entrance(id: "m3"))
        let burst = history + [CoucouRow(id: "m3", own: true), CoucouRow(id: "b1", own: false), CoucouRow(id: "b2", own: false)]
        arrivals.begin(key: "chat", rows: burst, ready: true)
        XCTAssertNil(arrivals.entrance(id: "m3"))
        XCTAssertEqual(arrivals.entrance(id: "b1")?.delay ?? -1, 0, accuracy: 0.0001)
        XCTAssertEqual(arrivals.entrance(id: "b2")?.delay ?? -1, 0.04, accuracy: 0.0001)
        XCTAssertEqual(arrivals.entrance(id: "b1")?.fast, false)
    }

    func testCoucouPrependAndEmptyReady() {
        let arrivals = CoucouArrivals()
        arrivals.begin(key: "room", rows: [], ready: true)
        arrivals.begin(key: "room", rows: [CoucouRow(id: "m1", own: true)], ready: true)
        XCTAssertEqual(arrivals.entrance(id: "m1")?.fast, true)
        arrivals.finish(id: "m1")
        XCTAssertNil(arrivals.entrance(id: "m1"))
        arrivals.begin(key: "room", rows: [CoucouRow(id: "old", own: false), CoucouRow(id: "m1", own: true)], ready: true)
        XCTAssertNil(arrivals.entrance(id: "old"))
        arrivals.begin(key: "room", rows: [CoucouRow(id: "old", own: false), CoucouRow(id: "m1", own: true), CoucouRow(id: "solo", own: false)], ready: true)
        XCTAssertEqual(arrivals.entrance(id: "solo")?.delay ?? -1, 0, accuracy: 0.0001)
        arrivals.begin(key: "other", rows: [CoucouRow(id: "m1", own: false)], ready: true)
        XCTAssertNil(arrivals.entrance(id: "m1"))
    }

    func testRoomMentionQueryFiltersAndInsertsRoutableTokens() {
        let phrase = "U try there a ui flaw there should be a @"
        XCTAssertEqual(RoomMention.query(text: phrase, cursor: phrase.count)?.start, phrase.count - 1)
        XCTAssertEqual(RoomMention.query(text: phrase, cursor: phrase.count)?.query, "")
        XCTAssertEqual(RoomMention.query(text: "hello @bot", cursor: "hello @bot".count)?.query, "bot")
        XCTAssertEqual(RoomMention.query(text: "hello\n@Bo", cursor: "hello\n@Bo".count)?.query, "Bo")
        XCTAssertNil(RoomMention.query(text: "hello @bot ", cursor: "hello @bot ".count))
        XCTAssertNil(RoomMention.query(text: "email@bot", cursor: "email@bot".count))
        XCTAssertNil(RoomMention.query(text: "say email@everyone", cursor: "say email@everyone".count))
        let members = [
            RoomMentionMember(id: "bot_dev", name: "Bot Strata Dev"),
            RoomMentionMember(id: "bot_helper", name: "Bot Strata Helper"),
            RoomMentionMember(id: "bot_short", name: "A"),
            RoomMentionMember(id: "bot_mark", name: "Bot (Dev)")
        ]
        XCTAssertEqual(RoomMention.choices(members: members, query: "").map(\.label), ["everyone", "Bot Strata Dev", "Bot Strata Helper", "A", "Bot (Dev)"])
        XCTAssertEqual(RoomMention.choices(members: members, query: "HELPER").map(\.memberID), ["bot_helper"])
        XCTAssertEqual(RoomMention.choices(members: members, query: "bot_dev").map(\.memberID), ["bot_dev"])
        XCTAssertEqual(RoomMention.choices(members: members, query: "eve").map(\.label), ["everyone"])
        XCTAssertEqual(RoomMention.choices(members: members, query: "all").map(\.label), ["everyone"])
        XCTAssertEqual(RoomMention.choices(members: [RoomMentionMember(id: "missing", name: "")], query: "").map(\.label), ["everyone", "Unavailable bot"])
        XCTAssertTrue(RoomMention.choices(members: members, query: "zzzz").isEmpty)
        let dev = RoomMention.choices(members: members, query: "Dev")[0]
        XCTAssertEqual(RoomMention.insertion(choice: dev, members: members), "@Bot Strata Dev ")
        let short = RoomMention.choices(members: members, query: "bot_short")[0]
        XCTAssertEqual(RoomMention.insertion(choice: short, members: members), "@bot_short ")
        XCTAssertEqual(RoomMention.insertion(choice: RoomMention.choices(members: members, query: "")[0], members: members), "@everyone ")
        let marked = RoomMention.choices(members: members, query: "Bot (Dev)")[0]
        XCTAssertEqual(RoomMention.insertion(choice: marked, members: members), "@bot_mark ")
        XCTAssertFalse(RoomMention.nameRoutes("Bot (Dev)"))
        XCTAssertTrue(RoomMention.nameRoutes("Bot Strata Dev"))
        let partial = "there should be a @he"
        let active = RoomMentionQuery(start: partial.distance(from: partial.startIndex, to: partial.lastIndex(of: "@") ?? partial.startIndex), query: "he")
        let placed = RoomMention.insert(text: partial, query: active, cursor: partial.count, token: "@Bot Strata Helper ")
        XCTAssertEqual(placed.text, "there should be a @Bot Strata Helper ")
        XCTAssertEqual(placed.cursor, placed.text.count)
        XCTAssertEqual(RoomMention.keyAction("ArrowDown"), "down")
        XCTAssertEqual(RoomMention.keyAction("ArrowUp"), "up")
        XCTAssertEqual(RoomMention.keyAction("Enter"), "pick")
        XCTAssertEqual(RoomMention.keyAction("Tab"), "pick")
        XCTAssertEqual(RoomMention.keyAction("Escape"), "close")
        XCTAssertEqual(RoomMention.keyAction(" "), "close")
        XCTAssertFalse(RoomMention.keyStops(" "))
        XCTAssertTrue(RoomMention.keyStops("Escape"))
        XCTAssertEqual(RoomMention.moveIndex(0, count: 3, direction: "down"), 1)
        XCTAssertEqual(RoomMention.moveIndex(2, count: 3, direction: "down"), 2)
        XCTAssertEqual(RoomMention.moveIndex(0, count: 3, direction: "up"), 0)
        XCTAssertTrue(RoomMention.listVisible(activeStart: 4, dismissedStart: nil, choiceCount: 1))
        XCTAssertFalse(RoomMention.listVisible(activeStart: 4, dismissedStart: 4, choiceCount: 1))
        XCTAssertFalse(RoomMention.listVisible(activeStart: nil, dismissedStart: 4, choiceCount: 1))
        XCTAssertTrue(RoomMention.addressesEveryone("@everyone hi"))
        XCTAssertTrue(RoomMention.addressesEveryone("please @all now"))
        XCTAssertFalse(RoomMention.addressesEveryone("email@everyone"))
        XCTAssertFalse(RoomMention.addressesEveryone("@everyoneish"))
        let room = ["bot_dev", "bot_helper"]
        XCTAssertEqual(RoomMention.audience(text: "@everyone hi", recipient: "", memberIds: room), RoomMentionAudience(recipientIds: nil, everyone: true))
        XCTAssertEqual(RoomMention.audience(text: "@Bot Strata Dev hi", recipient: "", memberIds: room), RoomMentionAudience(recipientIds: nil, everyone: nil))
        XCTAssertEqual(RoomMention.audience(text: "@everyone hi", recipient: "bot_dev", memberIds: room), RoomMentionAudience(recipientIds: ["bot_dev"], everyone: nil))
        XCTAssertEqual(RoomMention.audience(text: "hello", recipient: "everyone", memberIds: room), RoomMentionAudience(recipientIds: room, everyone: true))
    }

    func testRoomChoiceUsesPlainButtonsAndKeepsTheEventShape() {
        let stalled = RoomChoiceTask(id: "job_fix", teamId: "team_1", runId: "run_1", state: "error", updatedAt: "2026-10-22T12:00:00.000Z", status: "blocked", revision: 3, recoveryJobId: nil, legacy: false)
        let resolved = RoomChoice.resolve(roomTeamId: "team_1", event: nil, tasks: [stalled], activeRunIds: [], dismissedIds: [])
        XCTAssertEqual(resolved?.source, "recovery")
        XCTAssertEqual(resolved?.choice.question, "The work stopped partway through. Want me to try again?")
        XCTAssertEqual(resolved?.choice.options.map(\.label), ["Try again", "Skip it", "A different approach"])
        XCTAssertFalse(resolved?.choice.question.contains("implement_fix") ?? true)
        XCTAssertNil(RoomChoice.resolve(roomTeamId: "team_1", event: nil, tasks: [RoomChoiceTask(id: "job_fix", teamId: "team_1", runId: "run_1", state: "running", updatedAt: "", status: "blocked", revision: 1, recoveryJobId: nil, legacy: false)], activeRunIds: [], dismissedIds: []))
        let event = RoomChoiceEvent(type: "needs-choice", id: "choice_1", teamId: "team_1", jobId: "job_fix", runId: "run_1", question: "Try a different folder?", options: [
            RoomChoiceOption(id: "retry", label: "Retry", style: "primary"),
            RoomChoiceOption(id: "different-approach", label: "Another way", style: "weird")
        ])
        let fromEvent = RoomChoice.resolve(roomTeamId: "team_1", event: event, tasks: [stalled], activeRunIds: [], dismissedIds: [])
        XCTAssertEqual(fromEvent?.source, "event")
        XCTAssertEqual(fromEvent?.choice.question, "Try a different folder?")
        XCTAssertNil(fromEvent?.choice.options.last?.style)
        XCTAssertEqual(RoomChoice.action("retry", teamId: "team_1", jobId: "job_fix", runId: "run_1", revision: 3), .resume(teamId: "team_1", jobId: "job_fix", revision: 3))
        XCTAssertEqual(RoomChoice.action("skip", teamId: "team_1", jobId: "job_fix", runId: "run_1", revision: 3), .skip)
        XCTAssertEqual(RoomChoice.action("different-approach", teamId: "team_1", jobId: "job_fix", runId: "run_1", revision: 3), .different)
        XCTAssertNil(RoomChoice.action("invent", teamId: "team_1", jobId: "job_fix", runId: "run_1", revision: 3))
    }
}
