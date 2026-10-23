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
}
