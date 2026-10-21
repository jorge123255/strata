import XCTest
import Combine
import SwiftUI
@testable import StrataMobile

@MainActor
final class StoreRaceTests: XCTestCase {
    func testPendingHistoryCannotReplaceNewConversation() async throws {
        let fixture = StoreTransport()
        defer { fixture.close() }
        let store = fixture.makeStore()
        let history = fixture.hold("/v1/chats/old")
        let selection = Task { await store.selectChat(CompanionChat(id: "old", title: "Old conversation")) }
        await fulfillment(of: [history.requested], timeout: 2)

        store.newChat()
        history.finish(["messages": [["id": "old-message", "role": "assistant", "content": "Old content"]]])
        await selection.value

        XCTAssertNil(store.currentChatId)
        XCTAssertTrue(store.messages.isEmpty)
        XCTAssertNil(store.error)
    }

    func testOlderHistoryCannotReplaceMoreRecentSelection() async throws {
        let fixture = StoreTransport()
        defer { fixture.close() }
        let store = fixture.makeStore()
        let old = fixture.hold("/v1/chats/old")
        let newer = fixture.hold("/v1/chats/new")
        let first = Task { await store.selectChat(CompanionChat(id: "old", title: "Old")) }
        await fulfillment(of: [old.requested], timeout: 2)
        let second = Task { await store.selectChat(CompanionChat(id: "new", title: "New")) }
        await fulfillment(of: [newer.requested], timeout: 2)

        newer.finish(["messages": [["id": "new-message", "role": "assistant", "content": "New content"]]])
        await second.value
        old.finish(["messages": [["id": "old-message", "role": "assistant", "content": "Old content"]]])
        await first.value

        XCTAssertEqual(store.currentChatId, "new")
        XCTAssertEqual(store.messages.map(\.content), ["New content"])
    }

    func testRefreshCompletingAfterForgetDoesNotRestoreOldMacState() async throws {
        let fixture = StoreTransport()
        defer { fixture.close() }
        let store = fixture.makeStore()
        let status = fixture.hold("/v1/status")
        let models = fixture.hold("/v1/models")
        let chats = fixture.hold("/v1/chats")
        let refreshing = Task { await store.refresh() }
        await fulfillment(of: [status.requested, models.requested, chats.requested], timeout: 2)
        XCTAssertTrue(store.isLoading)

        store.forgetMac()
        XCTAssertEqual(fixture.deletedConnections, 1)
        XCTAssertFalse(store.isLoading)
        status.finish(StoreTransport.status)
        models.finish(["models": [["id": "old-model", "name": "Old Mac model", "state": "loaded"]]])
        chats.finish(["chats": [["id": "old-chat", "title": "Old Mac chat"]]])
        await refreshing.value

        XCTAssertFalse(store.isPaired)
        XCTAssertNil(store.status)
        XCTAssertTrue(store.models.isEmpty)
        XCTAssertTrue(store.chats.isEmpty)
        XCTAssertFalse(store.isLoading)
        XCTAssertNil(store.error)
    }

    func testPairingCannotReplaceConnectionWhileReplyIsSending() async throws {
        let fixture = StoreTransport()
        defer { fixture.close() }
        let store = fixture.makeStore()
        let original = store.connection
        let stream = fixture.hold("/v1/chat")
        let sending = Task { await store.sendLegacyMessage("Synthetic fixture") }
        await fulfillment(of: [stream.requested], timeout: 2)
        XCTAssertTrue(store.isSending)

        await store.pair(url: "https://unexpected.invalid:8787", code: "123456", fingerprint: String(repeating: "a", count: 64))
        XCTAssertEqual(store.connection, original)
        XCTAssertEqual(fixture.savedConnections, 0)
        stream.finishSSE("event: frame\ndata: {\"type\":\"session\",\"chatId\":\"fixture-chat\"}\n\nevent: frame\ndata: {\"type\":\"delta\",\"text\":\"Fixture reply\"}\n\nevent: frame\ndata: {\"type\":\"done\"}\n\n")
        await sending.value

        XCTAssertFalse(store.isSending)
        XCTAssertEqual(store.connection, original)
        XCTAssertEqual(store.messages.last?.content, "Fixture reply")
        XCTAssertNil(store.error)
    }

    func testSharedHistoryContinuesTheSameMacConversation() async throws {
        let fixture = StoreTransport()
        defer { fixture.close() }
        fixture.respond { request in
            switch request.url!.path {
            case "/v1/conversations/mac-existing": return StoreTransport.detail(active: false)
            case "/v1/conversations/mac-existing/messages": return StoreTransport.detail(active: true, content: "Continuing the existing work")
            default: return nil
            }
        }
        let store = fixture.makeStore()
        await store.selectConversation(try StoreTransport.summary())
        XCTAssertEqual(store.currentConversation?.messages.first?.content, "Earlier Mac history")
        XCTAssertEqual(store.currentConversation?.permissionLabel, "Ask before actions")
        await store.sendMessage("Continue that work")
        XCTAssertEqual(store.currentConversation?.id, "mac-existing")
        XCTAssertTrue(store.isWorking)
        let posts = fixture.requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts.map(\.path), ["/v1/conversations/mac-existing/messages"])
        XCTAssertEqual(posts.first?.body?["message"], "Continue that work")
        XCTAssertNil(posts.first?.body?["mode"], "The phone must preserve the Mac conversation's permissions.")
        XCTAssertNil(store.error)
    }

    func testMacStartedBrowserActivityUpdatesWithoutPhoneSending() async throws {
        let fixture = StoreTransport()
        defer { fixture.close() }
        fixture.respond { request in request.url!.path == "/v1/conversations/mac-existing" ? StoreTransport.detail(active: true, toolState: "running") : nil }
        let store = fixture.makeStore()
        await store.selectConversation(try StoreTransport.summary())
        let initialReads = fixture.requests.count
        store.setChatVisible(false)
        await store.refreshLiveState(refreshOverview: false)
        XCTAssertEqual(fixture.requests.count, initialReads, "An offscreen Chat view must stop its fast polling.")
        store.setChatVisible(true)
        await store.refreshLiveState(refreshOverview: false)
        XCTAssertEqual(fixture.requests.count, initialReads + 1)
        let browser = try XCTUnwrap(store.currentConversation?.messages.first?.tools?.first)
        XCTAssertTrue(browser.isBrowser)
        XCTAssertTrue(browser.isRunning)
        XCTAssertEqual(browser.browserURL?.absoluteString, "https://example.com/research")
        XCTAssertEqual(browser.title, "Opened a page")
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }

    func testNewPhoneWorkCreatesASharedMacConversation() async throws {
        let fixture = StoreTransport()
        defer { fixture.close() }
        fixture.respond { request in
            if request.url!.path == "/v1/conversations", request.httpMethod == "POST" { return StoreTransport.detail(active: false, content: "") }
            if request.url!.path == "/v1/conversations/mac-existing/messages" { return StoreTransport.detail(active: true, content: "Started on Mac") }
            return nil
        }
        let store = fixture.makeStore()
        store.newChat()
        await store.sendMessage("New shared work")
        XCTAssertEqual(fixture.requests.filter { $0.method == "POST" }.map(\.path), ["/v1/conversations", "/v1/conversations/mac-existing/messages"])
        XCTAssertNil(store.currentChatId)
        XCTAssertEqual(store.currentConversation?.id, "mac-existing")
        XCTAssertEqual(store.currentConversation?.mode, "manual")
        XCTAssertNil(store.error)
    }

    func testDelayedLiveSnapshotCannotReopenConversationAfterNewChat() async throws {
        let fixture = StoreTransport()
        defer { fixture.close() }
        fixture.respond { request in request.url!.path == "/v1/conversations/mac-existing" ? StoreTransport.detail(active: true) : nil }
        let store = fixture.makeStore()
        await store.selectConversation(try StoreTransport.summary())
        let snapshot = fixture.hold("/v1/conversations/mac-existing")
        let polling = Task { await store.refreshCurrentConversation() }
        await fulfillment(of: [snapshot.requested], timeout: 2)
        store.newChat()
        snapshot.finish(StoreTransport.detail(active: true, content: "A late Mac update"))
        await polling.value
        XCTAssertNil(store.currentConversation)
        XCTAssertTrue(store.pendingApprovals.isEmpty)
        XCTAssertFalse(fixture.requests.contains { $0.path.hasSuffix("/stop") }, "Changing views must leave Mac work running.")
    }

    func testApprovalUsesOpaqueToolIdAndStopTargetsSameConversation() async throws {
        let fixture = StoreTransport()
        defer { fixture.close() }
        fixture.respond { request in
            switch request.url!.path {
            case "/v1/conversations/mac-existing": return StoreTransport.detail(active: true, toolState: "proposed")
            case "/v1/conversations/mac-existing/approval": return StoreTransport.detail(active: true, toolState: "running")
            case "/v1/conversations/mac-existing/stop": return StoreTransport.detail(active: false)
            default: return nil
            }
        }
        let store = fixture.makeStore()
        await store.selectConversation(try StoreTransport.summary())
        let tool = try XCTUnwrap(store.pendingApprovals.first)
        await store.decideApproval(tool, approve: true)
        XCTAssertTrue(store.pendingApprovals.isEmpty)
        await store.stopConversation()
        XCTAssertFalse(store.isWorking)
        let posts = fixture.requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts.map(\.path), ["/v1/conversations/mac-existing/approval", "/v1/conversations/mac-existing/stop"])
        XCTAssertEqual(posts.first?.body?["toolId"], "helper-session:browser-call")
        XCTAssertEqual(posts.first?.body?["decision"], "approve")
        XCTAssertNil(store.error)
    }

    func testUnchangedLiveSnapshotDoesNotPublishNewViewState() async throws {
        let fixture = StoreTransport()
        defer { fixture.close() }
        fixture.respond { request in request.url!.path == "/v1/conversations/mac-existing" ? StoreTransport.detail(active: true, toolState: "running") : nil }
        let store = fixture.makeStore()
        await store.selectConversation(try StoreTransport.summary())
        var publications = 0
        let observation = store.objectWillChange.sink { publications += 1 }
        defer { observation.cancel() }

        await store.refreshCurrentConversation()
        await store.refreshCurrentConversation()
        XCTAssertEqual(publications, 0, "Unchanged polling must not invalidate the conversation's scroll controls.")

        fixture.respond { request in request.url!.path == "/v1/conversations/mac-existing" ? StoreTransport.detail(active: true, toolState: "done") : nil }
        await store.refreshCurrentConversation()
        XCTAssertEqual(publications, 1, "A changed action must still update the visible conversation.")
        XCTAssertEqual(store.currentConversation?.messages.first?.tools?.first?.state, "done")
    }

    func testReasoningAndProgressUpdatesArriveWhenAnswerTextIsUnchanged() async throws {
        let fixture = StoreTransport()
        defer { fixture.close() }
        func snapshot(reasoning: String, line: String) -> [String: Any] {
            var detail = StoreTransport.detail(active: true)
            var conversation = detail["conversation"] as! [String: Any]
            var messages = conversation["messages"] as! [[String: Any]]
            messages[0]["reasoning"] = reasoning
            messages[0]["blocks"] = [["kind": "text", "text": "Earlier Mac history"], ["kind": "group", "id": "progress", "line": line, "closed": false, "toolIds": []]]
            conversation["messages"] = messages; detail["conversation"] = conversation
            return detail
        }
        fixture.respond { request in request.url!.path == "/v1/conversations/mac-existing" ? snapshot(reasoning: "First step", line: "Ran 3 commands") : nil }
        let store = fixture.makeStore()
        await store.selectConversation(try StoreTransport.summary())
        fixture.respond { request in request.url!.path == "/v1/conversations/mac-existing" ? snapshot(reasoning: "First step\nNext step", line: "Ran 3 commands, edited a file") : nil }
        await store.refreshCurrentConversation()
        let reply = try XCTUnwrap(store.currentConversation?.messages.first)
        XCTAssertEqual(reply.content, "Earlier Mac history")
        XCTAssertEqual(reply.thinkingPreview, "Next step")
        guard case .group(let progress, _) = reply.timelineItems.last else { return XCTFail("The updated progress must follow the same answer text.") }
        XCTAssertEqual(progress.line, "Ran 3 commands, edited a file")
    }

    func testSharedChatRejectsSecondMessageWhileMacIsWorking() async throws {
        let fixture = StoreTransport()
        defer { fixture.close() }
        fixture.respond { request in request.url!.path == "/v1/conversations/mac-existing" ? StoreTransport.detail(active: true) : nil }
        let store = fixture.makeStore()
        await store.selectConversation(try StoreTransport.summary())
        await store.sendMessage("This must not interrupt the Mac")
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }
}

/// Delayed responses exercise the real HTTP decoding path without a live bridge,
/// simulator changes, or access to the app's saved Keychain entry.
@MainActor
final class ModelManagementTests: XCTestCase {
    func testDownloadPlanReportsStorageVisionAndExpiresInMilliseconds() throws {
        let now = Date(timeIntervalSince1970: 1000)
        var json = StoreTransport.downloadPlan(expiresAt: 1_001_000)
        let plan = try decode(ModelDownloadPlan.self, json)
        XCTAssertTrue(plan.canStart(at: now))
        XCTAssertFalse(plan.canStart(at: Date(timeIntervalSince1970: 1001)))
        XCTAssertEqual(plan.downloadGb, 12)
        XCTAssertEqual(plan.diskFreeGb, 100)
        XCTAssertEqual(plan.diskNeededGb, 14)
        XCTAssertTrue(plan.readPictures)
        XCTAssertFalse(plan.warnings.isEmpty)
        json["diskShort"] = "Not enough free storage"
        XCTAssertFalse(try decode(ModelDownloadPlan.self, json).canStart(at: now))
        XCTAssertEqual(ModelDownloadFormat.gigabytes(nil), "Not reported")
    }

    func testDownloadProgressClampsValuesAndMissingOwnershipCannotCancel() throws {
        var job = try decode(ModelDownloadJob.self, StoreTransport.downloadJob(state: "queued", canCancel: nil))
        XCTAssertTrue(job.isRunning)
        XCTAssertNil(job.canCancel)
        job.percent = 120; XCTAssertEqual(job.progress, 1)
        job.percent = -10; XCTAssertEqual(job.progress, 0)
        job.percent = .nan; XCTAssertNil(job.progress)
        job.state = "cancelled"; XCTAssertTrue(job.canRetry)
        XCTAssertFalse(job.isRunning)
        job.modelId = nil; XCTAssertFalse(job.canRetry)
        XCTAssertNotNil(job.counterLabel)
        job.doneGb = .infinity; XCTAssertNil(job.counterLabel)
    }

    func testOldMacDownloadCapabilityFallbackPreservesTheLibrary() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            request.url!.path == "/v1/models" ? ["models": [["id": "api-fixture", "name": "API model", "state": "available"]]] : nil
        }
        let store = fixture.makeStore()
        await store.refresh()
        let unsupported = fixture.hold("/v1/model-management/targets")
        let refreshing = Task { await store.refreshModelManagement() }
        await fulfillment(of: [unsupported.requested], timeout: 2)
        unsupported.finish(["error": "Unknown endpoint"], status: 404)
        await refreshing.value
        XCTAssertEqual(store.models.map(\.id), ["api-fixture"])
        XCTAssertTrue(store.modelTargets.isEmpty)
        XCTAssertTrue(store.modelManagementMessage?.contains("Update Strata") == true)
        XCTAssertNil(store.error)
    }

    func testReviewCannotStartUntilExplicitConfirmationAndPostsOnlyThePlanToken() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respondManagement()
        let store = fixture.makeStore()
        await store.refreshModelManagement()
        let model = try XCTUnwrap(store.modelCatalog?.models.first)
        await store.reviewModelDownload(model, readPictures: false)
        XCTAssertEqual(store.modelDownloadPlan?.planId, "fresh-plan")
        let planRequest = try XCTUnwrap(fixture.requests.last(where: { $0.path.hasSuffix("/plan") }))
        XCTAssertEqual(planRequest.jsonBody?["readPictures"] as? Bool, false)
        XCTAssertNil(planRequest.jsonBody?["readPictures"] as? String)
        XCTAssertFalse(fixture.requests.contains(where: { $0.path.hasSuffix("/downloads") }))

        let started = fixture.hold("/v1/model-management/targets/local/downloads")
        let starting = Task { await store.startModelDownload() }
        await fulfillment(of: [started.requested], timeout: 2)
        fixture.respondManagement(jobs: [StoreTransport.downloadJob()])
        started.finish(["job": StoreTransport.downloadJob()])
        await starting.value
        let request = try XCTUnwrap(fixture.requests.last(where: { $0.path.hasSuffix("/downloads") }))
        XCTAssertEqual(request.body, ["planId": "fresh-plan"])
        XCTAssertEqual(store.modelCatalog?.jobs.first?.id, "own-download")
        XCTAssertNil(store.reviewingModelDownload)
        XCTAssertFalse(store.isStartingModelDownload)
    }

    func testTargetChangeRejectsLateCatalogAndReviewResponses() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respondManagement()
        let store = fixture.makeStore()
        await store.refreshModelManagement()
        let model = try XCTUnwrap(store.modelCatalog?.models.first)
        let oldCatalog = fixture.hold("/v1/model-management/targets/local")
        let oldPlan = fixture.hold("/v1/model-management/targets/local/plan")
        let polling = Task { await store.refreshModelManagement() }
        let reviewing = Task { await store.reviewModelDownload(model, readPictures: true) }
        await fulfillment(of: [oldCatalog.requested, oldPlan.requested], timeout: 2)
        await store.selectModelTarget(StoreTransport.remoteTargetId)
        oldCatalog.finish(StoreTransport.managementCatalog(targetName: "Old Mac"))
        oldPlan.finish(StoreTransport.downloadPlan())
        await polling.value; await reviewing.value
        XCTAssertEqual(store.selectedModelTargetId, StoreTransport.remoteTargetId)
        XCTAssertEqual(store.modelCatalog?.targetName, "Remote Strata")
        XCTAssertNil(store.modelDownloadPlan)
        XCTAssertNil(store.reviewingModelDownload)
        XCTAssertFalse(store.isPlanningModelDownload)
        XCTAssertFalse(fixture.requests.contains(where: { $0.path.hasSuffix("/downloads") }))
    }

    func testForgetDuringReviewCannotRestoreOldMacDownloadState() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respondManagement()
        let store = fixture.makeStore()
        await store.refreshModelManagement()
        let model = try XCTUnwrap(store.modelCatalog?.models.first)
        let plan = fixture.hold("/v1/model-management/targets/local/plan")
        let reviewing = Task { await store.reviewModelDownload(model, readPictures: true) }
        await fulfillment(of: [plan.requested], timeout: 2)
        store.forgetMac()
        plan.finish(StoreTransport.downloadPlan())
        await reviewing.value
        XCTAssertFalse(store.isPaired)
        XCTAssertTrue(store.modelTargets.isEmpty)
        XCTAssertNil(store.modelCatalog)
        XCTAssertNil(store.modelDownloadPlan)
        XCTAssertNil(store.reviewingModelDownload)
        XCTAssertFalse(store.isPlanningModelDownload)
    }

    func testExpiredReviewCannotPostADownload() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respondManagement(expiresAt: 1)
        let store = fixture.makeStore()
        await store.refreshModelManagement()
        await store.reviewModelDownload(try XCTUnwrap(store.modelCatalog?.models.first), readPictures: true)
        await store.startModelDownload()
        XCTAssertTrue(store.modelDownloadReviewError?.contains("expired") == true)
        XCTAssertFalse(fixture.requests.contains(where: { $0.path.hasSuffix("/downloads") }))
    }

    func testMacStartedDownloadPollsOnlyInModelsAndCannotCancelAnotherDevice() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respondManagement(jobs: [StoreTransport.downloadJob(canCancel: false)])
        let store = fixture.makeStore()
        await store.refreshModelManagement()
        let reads = fixture.requests.count
        await store.refreshLiveState(refreshOverview: false)
        XCTAssertEqual(fixture.requests.count, reads)
        store.setModelsVisible(true)
        var changed = StoreTransport.downloadJob(canCancel: false); changed["percent"] = 45
        fixture.respondManagement(jobs: [changed])
        await store.refreshLiveState(refreshOverview: false)
        XCTAssertEqual(fixture.requests.count, reads + 1)
        XCTAssertEqual(store.modelCatalog?.jobs.first?.progress, 0.45)
        var forged = try XCTUnwrap(store.modelCatalog?.jobs.first); forged.canCancel = true
        await store.cancelModelDownload(forged)
        XCTAssertFalse(fixture.requests.contains(where: { $0.method == "POST" }))
        var publications = 0
        let observation = store.objectWillChange.sink { publications += 1 }
        defer { observation.cancel() }
        await store.refreshLiveState(refreshOverview: false)
        XCTAssertEqual(publications, 0, "An unchanged progress snapshot should not rebuild the Models screen.")
    }

    func testStopIsScopedAndAPreStopPollCannotReviveTheJob() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respondManagement(jobs: [StoreTransport.downloadJob()])
        let store = fixture.makeStore()
        await store.refreshModelManagement()
        let job = try XCTUnwrap(store.modelCatalog?.jobs.first)
        let oldCatalog = fixture.hold("/v1/model-management/targets/local")
        let polling = Task { await store.refreshModelManagement() }
        await fulfillment(of: [oldCatalog.requested], timeout: 2)
        let cancelled = fixture.hold("/v1/model-management/targets/local/downloads/own-download/cancel")
        let cancelling = Task { await store.cancelModelDownload(job) }
        await fulfillment(of: [cancelled.requested], timeout: 2)
        fixture.release("/v1/model-management/targets/local")
        let stopped = StoreTransport.downloadJob(state: "cancelled", canCancel: false)
        fixture.respondManagement(jobs: [stopped])
        cancelled.finish(["job": stopped])
        await cancelling.value
        oldCatalog.finish(StoreTransport.managementCatalog(jobs: [StoreTransport.downloadJob()]))
        await polling.value
        XCTAssertEqual(store.modelCatalog?.jobs.first?.state, "cancelled")
        XCTAssertEqual(fixture.requests.filter { $0.method == "POST" }.map(\.path), ["/v1/model-management/targets/local/downloads/own-download/cancel"])
        XCTAssertNil(store.cancellingModelDownloadId)
        await store.reviewModelDownload(try XCTUnwrap(store.modelCatalog?.models.first), readPictures: true)
        XCTAssertEqual(store.modelDownloadPlan?.planId, "fresh-plan", "Retry must obtain a fresh review instead of restarting the old job.")
        XCTAssertFalse(fixture.requests.contains(where: { $0.path.hasSuffix("/downloads") }))
    }

    func testAPIOnlyModelCannotBeSentToTheDownloadPlanner() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respondManagement()
        let store = fixture.makeStore()
        await store.refreshModelManagement()
        let apiModel = try decode(DownloadableModel.self, ["id": "api-provider-model", "name": "API only", "state": "available", "readPictures": false])
        await store.reviewModelDownload(apiModel, readPictures: false)
        XCTAssertNil(store.reviewingModelDownload)
        XCTAssertFalse(fixture.requests.contains(where: { $0.method == "POST" }))
    }

    func testDisappearingTargetsLeaveThePickerBindingSafe() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respondManagement()
        let store = fixture.makeStore()
        await store.refreshModelManagement()
        XCTAssertEqual(store.modelTargetSelection, "local")
        fixture.respond { request in
            request.url!.path == "/v1/model-management/targets" ? ["targets": [], "reason": "Update Strata"] : nil
        }
        await store.refreshModelManagement(refreshTargets: true)
        XCTAssertTrue(store.modelTargets.isEmpty)
        XCTAssertEqual(store.modelTargetSelection, "", "SwiftUI may read the old Picker binding after its targets disappear.")
        XCTAssertNil(store.modelCatalog)
        XCTAssertEqual(store.modelManagementMessage, "Update Strata")
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: [String: Any]) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: json))
    }
}

@MainActor
final class BotsTests: XCTestCase {
    func testCatalogListsAllProvidersWithoutStartingWork() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { $0.url!.path == "/v1/bots" ? Self.catalog : nil }
        let store = fixture.makeStore()
        await store.refreshBots()
        XCTAssertEqual(store.botCatalog?.providers.map(\.id), ["claude", "codex", "devin", "grok", "kimi", "ollama"])
        XCTAssertEqual(store.botCatalog?.bots.first?.capabilityLabel, "Code & computer")
        XCTAssertEqual(fixture.requests.map(\.path), ["/v1/bots"])
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        XCTAssertNil(store.currentConversation)
        XCTAssertNil(store.botsMessage)
    }

    func testBotConversationUsesSavedSettingsAndSameThinkingHistory() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            switch request.url!.path {
            case "/v1/bots": return Self.catalog
            case "/v1/bots/bot_coder/conversations": return Self.botDetail
            default: return nil
            }
        }
        let store = fixture.makeStore()
        await store.refreshBots()
        let bot = try XCTUnwrap(store.botCatalog?.bots.first)
        let created = await store.newBotConversation(bot)
        XCTAssertTrue(created)
        XCTAssertEqual(store.currentConversation?.botId, bot.id)
        XCTAssertEqual(store.currentConversation?.id, "mac-existing")
        XCTAssertEqual(store.currentConversation?.messages.first?.thinkingText, "Inspect the code before continuing.")
        XCTAssertEqual(store.currentConversation?.mode, "manual")
        let posts = fixture.requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts.map(\.path), ["/v1/bots/bot_coder/conversations"])
        XCTAssertEqual(posts.first?.jsonBody?.count, 0, "Provider credentials and bot settings must remain on the Mac.")
        XCTAssertNil(store.creatingBotConversationId)
        XCTAssertFalse(store.isSelectingConversation)
    }

    func testPendingBotCreationCannotReopenAfterNewChatSelection() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { $0.url!.path == "/v1/bots" ? Self.catalog : nil }
        let store = fixture.makeStore()
        await store.refreshBots()
        let pending = fixture.hold("/v1/bots/bot_coder/conversations")
        let bot = try XCTUnwrap(store.botCatalog?.bots.first)
        let creating = Task { await store.newBotConversation(bot) }
        await fulfillment(of: [pending.requested], timeout: 2)
        store.newChat()
        pending.finish(Self.botDetail)
        let created = await creating.value
        XCTAssertFalse(created)
        XCTAssertNil(store.currentConversation)
        XCTAssertFalse(store.isSelectingConversation)
        XCTAssertNil(store.creatingBotConversationId)
        XCTAssertFalse(fixture.requests.contains { $0.path.hasSuffix("/messages") || $0.path.hasSuffix("/stop") })
    }

    func testDelayedCatalogCannotRestoreForgottenMac() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let store = fixture.makeStore()
        let pending = fixture.hold("/v1/bots")
        let refreshing = Task { await store.refreshBots() }
        await fulfillment(of: [pending.requested], timeout: 2)
        store.forgetMac()
        pending.finish(Self.catalog)
        await refreshing.value
        XCTAssertFalse(store.isPaired)
        XCTAssertNil(store.botCatalog)
        XCTAssertFalse(store.isLoadingBots)
        XCTAssertNil(store.botsMessage)
    }

    func testUnsupportedBotsDoesNotDisturbExistingSharedHistory() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { $0.url!.path == "/v1/conversations/mac-existing" ? StoreTransport.detail(active: false) : nil }
        let store = fixture.makeStore()
        await store.selectConversation(try StoreTransport.summary())
        await store.refreshBots() // The fixture's unknown route returns 404.
        XCTAssertTrue(store.botsMessage?.contains("Update Strata") == true)
        XCTAssertEqual(store.currentConversation?.id, "mac-existing")
        XCTAssertEqual(store.currentConversation?.messages.first?.content, "Earlier Mac history")
        XCTAssertNil(store.error)
    }

    func testCatalogFailureKeepsLastReadableBots() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { $0.url!.path == "/v1/bots" ? Self.catalog : nil }
        let store = fixture.makeStore()
        await store.refreshBots()
        let pending = fixture.hold("/v1/bots")
        let refreshing = Task { await store.refreshBots() }
        await fulfillment(of: [pending.requested], timeout: 2)
        pending.finish(["error": "Bots are unavailable. Open Strata on your Mac and try again."], status: 503)
        await refreshing.value
        XCTAssertEqual(store.botCatalog?.bots.first?.id, "bot_coder")
        XCTAssertTrue(store.botsMessage?.contains("unavailable") == true)
        XCTAssertFalse(store.isLoadingBots)
    }

    func testHistoryGroupsByBotIdentityAndPreservesLegacySummaryDecoding() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            switch request.url!.path {
            case "/v1/bots": return Self.catalog
            case "/v1/conversations": return ["conversations": [
                ["id": "mac-existing", "title": "Older bot conversation", "active": false],
                ["id": "bot-new", "title": "New bot conversation", "active": true, "botId": "bot_coder"],
                ["id": "other", "title": "Other conversation", "active": false, "botId": "other-bot"],
            ]]
            case "/v1/conversations/mac-existing": return Self.botDetail
            default: return nil
            }
        }
        let store = fixture.makeStore()
        await store.refreshBots(); await store.refresh()
        let bot = try XCTUnwrap(store.botCatalog?.bots.first)
        XCTAssertEqual(store.botConversations(bot).map(\.id), ["mac-existing", "bot-new"])
        XCTAssertNil(store.conversations.first?.botId, "Older summaries remain decodable, with catalog conversation IDs as fallback.")
    }

    func testRosterPreviewExcludesTeamRoutingWhileFullBotHistoryRemainsAvailable() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            switch request.url!.path {
            case "/v1/bots": return Self.catalog
            case "/v1/conversations": return ["conversations": [
                ["id": "public-direct", "title": "Direct work", "active": false, "botId": "bot_coder", "preview": "The requested change is ready."],
                ["id": "private-router", "title": "Routing", "active": false, "botId": "bot_coder", "teamId": "team_fixture", "preview": "[Internal team routing instruction]"],
            ]]
            default: return nil
            }
        }
        let store = fixture.makeStore(); await store.refreshBots(); await store.refresh()
        let bot = try XCTUnwrap(store.botCatalog?.bots.first)
        XCTAssertEqual(Set(store.botConversations(bot).map(\.id)), ["public-direct", "private-router"])
        XCTAssertEqual(store.botRosterConversations(bot).map(\.id), ["public-direct"])
        XCTAssertEqual(store.conversations.first { $0.id == "private-router" }?.teamId, "team_fixture")
        XCTAssertNil(store.conversations.first { $0.id == "public-direct" }?.teamId)
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }

    func testNewChatSelectsOnlySavedComputerAndConfiguredModelWithoutChangingServing() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            switch request.url!.path {
            case "/v1/bots": return Self.selectableCatalog
            case "/v1/bots/bot_coder/conversations": return Self.selectedDetail
            default: return nil
            }
        }
        let store = fixture.makeStore(); await store.refreshBots()
        let bot = try XCTUnwrap(store.botCatalog?.bots.first)
        XCTAssertEqual(bot.avatarText, "🦊")
        XCTAssertEqual(store.botCatalog?.models?.first?.label, "Configured fixture · Fixture connection")
        let created = await store.newBotConversation(bot, computerId: "ssh_fixture", modelId: "bm_fixture", workspace: "/srv/project")
        XCTAssertTrue(created)
        let posts = fixture.requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts.map(\.path), ["/v1/bots/bot_coder/conversations"])
        XCTAssertEqual(posts.first?.body, ["computerId": "ssh_fixture", "modelId": "bm_fixture", "workspace": "/srv/project"])
        XCTAssertEqual(store.currentConversation?.computerName, "Remote fixture")
        XCTAssertEqual(store.currentConversation?.botModelName, "Configured fixture")
        XCTAssertEqual(store.currentConversation?.botAvatar, "🧠", "Conversation identity comes from its frozen host snapshot.")
        XCTAssertEqual(store.currentConversation?.workspace, "/srv/project")
        XCTAssertTrue(fixture.requests.allSatisfy { !$0.path.contains("/load") && !$0.path.contains("/unload") && !$0.path.contains("/prepare") })
    }

    func testMissingUnavailableOrRemovedSelectionsNeverCreateAChat() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { $0.url!.path == "/v1/bots" ? Self.selectableCatalog : nil }
        let store = fixture.makeStore(); await store.refreshBots()
        let bot = try XCTUnwrap(store.botCatalog?.bots.first)
        for id in ["missing", "ssh_unavailable"] {
            let created = await store.newBotConversation(bot, computerId: id)
            XCTAssertFalse(created)
        }
        for id in ["missing", "bm_unavailable"] {
            let created = await store.newBotConversation(bot, modelId: id)
            XCTAssertFalse(created)
        }
        let relative = await store.newBotConversation(bot, workspace: "relative/folder")
        XCTAssertFalse(relative)
        fixture.respond { request in
            guard request.url!.path == "/v1/bots" else { return nil }
            var catalog = Self.selectableCatalog; catalog["models"] = []
            return catalog
        }
        await store.refreshBots()
        let removed = await store.newBotConversation(bot, modelId: "bm_fixture")
        XCTAssertFalse(removed)
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        XCTAssertNil(store.currentConversation)
    }

    func testOlderBotsCatalogRejectsOverridesAndUntrustedAvatarUsesNativeFallback() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            guard request.url!.path == "/v1/bots" else { return nil }
            var value = Self.catalog
            var bots = value["bots"] as! [[String: Any]]
            bots[0]["avatar"] = "https://untrusted.invalid/image.png"; value["bots"] = bots
            return value
        }
        let store = fixture.makeStore(); await store.refreshBots()
        let bot = try XCTUnwrap(store.botCatalog?.bots.first)
        XCTAssertEqual(bot.avatarText, "🤖")
        let created = await store.newBotConversation(bot, computerId: "local")
        XCTAssertFalse(created)
        XCTAssertTrue(store.error?.contains("Update Strata") == true)
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }

    func testRosterTapOpensPersonalHistoryInsteadOfNewerTeamWorker() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            switch request.url!.path {
            case "/v1/bots": return Self.catalog
            case "/v1/conversations": return Self.rosterList(personal: true)
            case "/v1/conversations/mac-existing": return Self.botDetail
            default: return nil
            }
        }
        let store = fixture.makeStore(); await store.refreshBots()
        let opened = await store.openBotConversation("bot_coder")
        XCTAssertTrue(opened); XCTAssertEqual(store.currentConversation?.id, "mac-existing")
        XCTAssertEqual(store.currentConversation?.messages.first?.thinkingText, "Inspect the code before continuing.")
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        XCTAssertFalse(fixture.requests.contains { $0.path.contains("team-worker") })
        XCTAssertNil(store.openingBotConversationId); XCTAssertFalse(store.isSelectingConversation)
    }

    func testRosterTapWithOnlyTeamHistoryCreatesOneEmptySavedDefaultChat() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            switch request.url!.path {
            case "/v1/bots": return Self.catalog
            case "/v1/conversations": return Self.rosterList(personal: false)
            case "/v1/bots/bot_coder/conversations":
                var detail = Self.botDetail, conversation = detail["conversation"] as! [String: Any]
                conversation["messages"] = []; conversation["mode"] = "bypass"; detail["conversation"] = conversation
                return detail
            default: return nil
            }
        }
        let store = fixture.makeStore(); await store.refreshBots()
        let opened = await store.openBotConversation("bot_coder")
        XCTAssertTrue(opened); XCTAssertEqual(store.currentConversation?.messages.count, 0)
        XCTAssertEqual(store.currentConversation?.mode, "bypass")
        let writes = fixture.requests.filter { $0.method != "GET" }
        XCTAssertEqual(writes.map(\.path), ["/v1/bots/bot_coder/conversations"])
        XCTAssertEqual(writes.first?.body, [:], "Empty creation retains the saved model, computer, workspace and policy; no work is submitted.")
        XCTAssertNil(store.creatingBotConversationId); XCTAssertNil(store.openingBotConversationId)
    }

    func testRepeatedRosterTapDeduplicatesPendingRequest() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            if request.url!.path == "/v1/bots" { return Self.catalog }
            if request.url!.path == "/v1/bots/bot_coder/conversations" { return Self.botDetail }
            return nil
        }
        let store = fixture.makeStore(); await store.refreshBots()
        let pending = fixture.hold("/v1/conversations")
        let first = Task { await store.openBotConversation("bot_coder") }
        await fulfillment(of: [pending.requested], timeout: 2)
        XCTAssertEqual(store.openingBotConversationId, "bot_coder")
        let repeated = await store.openBotConversation("bot_coder"); XCTAssertFalse(repeated)
        pending.finish(Self.rosterList(personal: false))
        let opened = await first.value; XCTAssertTrue(opened)
        XCTAssertEqual(fixture.requests.filter { $0.path == "/v1/conversations" }.count, 1)
        XCTAssertEqual(fixture.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testRosterOpeningCannotReturnAfterNewChatOrNavigationAway() async throws {
        for cancelNavigation in [false, true] {
            let fixture = StoreTransport(); defer { fixture.close() }
            fixture.respond { $0.url!.path == "/v1/bots" ? Self.catalog : nil }
            let store = fixture.makeStore(); await store.refreshBots()
            let pending = fixture.hold("/v1/conversations")
            let opening = Task { await store.openBotConversation("bot_coder") }
            await fulfillment(of: [pending.requested], timeout: 2)
            if cancelNavigation { store.cancelOpeningBotConversation() } else { store.newChat() }
            pending.finish(Self.rosterList(personal: false))
            let opened = await opening.value; XCTAssertFalse(opened)
            XCTAssertNil(store.currentConversation); XCTAssertNil(store.openingBotConversationId)
            XCTAssertFalse(store.isSelectingConversation)
            XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        }
    }

    func testForgottenPairingCannotRestorePendingRosterChat() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { $0.url!.path == "/v1/bots" ? Self.catalog : nil }
        let store = fixture.makeStore(); await store.refreshBots()
        let pending = fixture.hold("/v1/conversations")
        let opening = Task { await store.openBotConversation("bot_coder") }
        await fulfillment(of: [pending.requested], timeout: 2)
        store.forgetMac(); pending.finish(Self.rosterList(personal: false))
        let opened = await opening.value; XCTAssertFalse(opened)
        XCTAssertFalse(store.isPaired); XCTAssertNil(store.currentConversation); XCTAssertNil(store.openingBotConversationId)
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }

    func testPausedBotPersonalHistoryIsReadableButCannotCreateBlank() async throws {
        for hasPersonal in [false, true] {
            let fixture = StoreTransport(); defer { fixture.close() }
            fixture.respond { request in
                switch request.url!.path {
                case "/v1/bots":
                    var catalog = Self.catalog, bots = Self.catalog["bots"] as! [[String: Any]]
                    bots[0]["paused"] = true; catalog["bots"] = bots; return catalog
                case "/v1/conversations": return Self.rosterList(personal: hasPersonal)
                case "/v1/conversations/mac-existing": return Self.botDetail
                default: return nil
                }
            }
            let store = fixture.makeStore(); await store.refreshBots()
            let opened = await store.openBotConversation("bot_coder")
            XCTAssertEqual(opened, hasPersonal)
            if !hasPersonal { XCTAssertTrue(store.error?.contains("paused") == true) }
            XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
            XCTAssertNil(store.openingBotConversationId)
        }
    }

    func testRosterDetailMustRetainExactBotAndPersonalIdentity() async throws {
        for changedField in ["botId", "teamId", "teamRunId", "parentChatId", "id"] {
            let fixture = StoreTransport(); defer { fixture.close() }
            fixture.respond { request in
                switch request.url!.path {
                case "/v1/bots": return Self.catalog
                case "/v1/conversations": return Self.rosterList(personal: true)
                case "/v1/conversations/mac-existing":
                    var detail = Self.botDetail, conversation = detail["conversation"] as! [String: Any]
                    conversation[changedField] = "unexpected-other"; detail["conversation"] = conversation; return detail
                default: return nil
                }
            }
            let store = fixture.makeStore(); await store.refreshBots()
            let opened = await store.openBotConversation("bot_coder"); XCTAssertFalse(opened)
            XCTAssertNil(store.currentConversation); XCTAssertNotNil(store.error)
            XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        }
    }

    func testRosterReadFailureShowsErrorAndAllowsRetryWithoutCreatingWork() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            if request.url!.path == "/v1/bots" { return Self.catalog }
            if request.url!.path == "/v1/conversations/mac-existing" { return Self.botDetail }
            return nil
        }
        let store = fixture.makeStore(); await store.refreshBots()
        // Empty default list enters creation; its unregistered fixture route
        // deliberately returns HTTP 404 before the app can select a chat.
        let failed = await store.openBotConversation("bot_coder"); XCTAssertFalse(failed)
        XCTAssertNotNil(store.error); XCTAssertNil(store.openingBotConversationId)
        fixture.respond { request in
            switch request.url!.path {
            case "/v1/bots": return Self.catalog
            case "/v1/conversations": return Self.rosterList(personal: true)
            case "/v1/conversations/mac-existing": return Self.botDetail
            default: return nil
            }
        }
        let opened = await store.openBotConversation("bot_coder"); XCTAssertTrue(opened); XCTAssertNil(store.error)
        XCTAssertFalse(fixture.requests.contains { $0.path.hasSuffix("/messages") || $0.path.contains("/computer/") })
    }

    private static func rosterList(personal: Bool) -> [String: Any] {
        let team: [String: Any] = ["id": "team-worker", "title": "Private team worker", "botId": "bot_coder", "teamId": "team_fixture", "active": false, "updatedAt": "99999"]
        let direct: [String: Any] = ["id": "mac-existing", "title": "Personal bot chat", "botId": "bot_coder", "active": false, "updatedAt": "12345"]
        let legacyRun: [String: Any] = ["id": "legacy-run", "title": "Legacy team worker", "botId": "bot_coder", "teamRunId": "run_fixture", "active": false]
        let child: [String: Any] = ["id": "child-worker", "title": "Child worker", "botId": "bot_coder", "parentChatId": "parent_fixture", "active": false]
        return ["conversations": personal ? [team, legacyRun, child, direct] : [team, legacyRun, child]]
    }

    private static var selectableCatalog: [String: Any] {
        var result = catalog
        var bots = result["bots"] as! [[String: Any]]
        bots[0]["avatar"] = "🦊"; bots[0]["workspace"] = "/fixture/default"
        result["bots"] = bots; result["selectionSupported"] = true
        result["computers"] = [["id": "local", "name": "Your Mac", "kind": "local", "available": true, "detail": "Ready"],
                               ["id": "ssh_fixture", "name": "Remote fixture", "kind": "ssh", "available": true, "detail": "Prepared on the Mac"],
                               ["id": "ssh_unavailable", "name": "Unavailable computer", "kind": "ssh", "available": false, "detail": "Set up on Mac"]]
        result["models"] = [["id": "bm_fixture", "name": "Configured fixture", "connectionName": "Fixture connection", "model": "fixture/model", "available": true],
                            ["id": "bm_unavailable", "name": "Unavailable model", "connectionName": "Other connection", "model": "other/model", "available": false]]
        return result
    }
    private static var selectedDetail: [String: Any] {
        var result = botDetail, conversation = result["conversation"] as! [String: Any]
        conversation["botAvatar"] = "🧠"; conversation["botName"] = "Original bot"
        conversation["computerName"] = "Remote fixture"; conversation["botModelName"] = "Configured fixture"
        conversation["workspace"] = "/srv/project"; result["conversation"] = conversation
        return result
    }

    private static var catalog: [String: Any] {
        ["bots": [["id": "bot_coder", "name": "Coder", "provider": "codex", "model": "default", "capabilities": "both", "policy": "manual",
                   "execution": ["kind": "local"], "conversations": ["mac-existing"]]],
         "providers": ["claude", "codex", "devin", "grok", "kimi", "ollama"].map { ["id": $0, "name": $0.capitalized, "available": true, "detail": "Ready"] as [String: Any] },
         "computers": [["id": "local", "name": "Your Mac", "kind": "local", "available": true, "detail": "Ready"]]]
    }
    private static var botDetail: [String: Any] {
        var result = StoreTransport.detail(active: false)
        var conversation = result["conversation"] as! [String: Any]
        conversation["botId"] = "bot_coder"
        var messages = conversation["messages"] as! [[String: Any]]
        messages[0]["reasoning"] = "Inspect the code before continuing."
        conversation["messages"] = messages; result["conversation"] = conversation
        return result
    }
}

private final class StoreTransport {
    static let status: [String: Any] = ["macName": "Fixture Mac", "hostConnected": true, "engineState": "idle", "activeRequests": 0]
    let host = "fixture-\(UUID().uuidString.lowercased()).invalid"
    private let lock = NSLock()
    private var held: [String: HeldStoreResponse] = [:]
    struct RecordedRequest { var path: String; var method: String; var body: [String: String]?; var jsonBody: [String: Any]? }
    private var recordedRequests: [RecordedRequest] = []
    var requests: [RecordedRequest] { lock.lock(); defer { lock.unlock() }; return recordedRequests }
    private var responder: ((URLRequest) -> [String: Any]?)?
    func respond(_ value: @escaping (URLRequest) -> [String: Any]?) { lock.lock(); responder = value; lock.unlock() }
    private var session: URLSession?
    private(set) var deletedConnections = 0
    private(set) var savedConnections = 0

    init() { StoreURLProtocol.register(self, host: host) }

    @MainActor func makeStore() -> CompanionStore {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StoreURLProtocol.self]
        let session = URLSession(configuration: config)
        self.session = session
        let connection = PairedConnection(baseURL: URL(string: "https://\(host):8787")!, macName: "Fixture Mac", fingerprint: String(repeating: "a", count: 64), token: "fixture-token")
        let client = CompanionClient(baseURL: connection.baseURL, fingerprint: connection.fingerprint, token: connection.token, session: session)
        return CompanionStore(connection: connection, client: client,
                              saveConnection: { [weak self] _ in self?.savedConnections += 1 },
                              deleteConnection: { [weak self] in self?.deletedConnections += 1 })
    }

    func hold(_ path: String) -> HeldStoreResponse {
        let response = HeldStoreResponse()
        lock.lock(); held[path] = response; lock.unlock()
        return response
    }

    func release(_ path: String) {
        lock.lock(); held.removeValue(forKey: path); lock.unlock()
    }

    func receive(_ request: StoreURLProtocol) {
        let path = request.request.url!.path
        let payload: Data?
        if let data = request.request.httpBody { payload = data }
        else if let stream = request.request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            payload = data
        } else { payload = nil }
        let body = payload.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }
        let jsonBody = payload.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        lock.lock()
        recordedRequests.append(RecordedRequest(path: path, method: request.request.httpMethod ?? "GET", body: body, jsonBody: jsonBody))
        let response = held[path]
        let responder = responder
        lock.unlock()
        if let response { response.receive(request); return }
        if let json = responder?(request.request) { request.finishJSON(json); return }
        switch path {
        case "/v1/status": request.finishJSON(Self.status)
        case "/v1/models": request.finishJSON(["models": []])
        case "/v1/chats": request.finishJSON(["chats": []])
        case "/v1/conversations": request.finishJSON(["conversations": []])
        default: request.finishJSON(["error": "Unexpected fixture request"], status: 404)
        }
    }

    static func summary() throws -> MacConversationSummary {
        try JSONDecoder().decode(MacConversationSummary.self, from: JSONSerialization.data(withJSONObject: ["id": "mac-existing", "title": "Mac research", "active": true, "updatedAt": 12345]))
    }

    static func detail(active: Bool, content: String = "Earlier Mac history", toolState: String? = nil) -> [String: Any] {
        var message: [String: Any] = ["id": "mac-message", "role": "assistant", "content": content]
        var pending: [[String: Any]] = []
        if let toolState {
            let tool: [String: Any] = ["id": "helper-session:browser-call", "name": "mcp__browser__browser_navigate", "state": toolState, "verb": "Opened a page", "target": "https://example.com/research", "scope": "connected", "result": "Page title: Example", "live": true]
            message["tools"] = [tool]
            if toolState == "proposed" { pending = [tool] }
        }
        return ["conversation": ["id": "mac-existing", "title": "Mac research", "active": active, "mode": "manual", "workspace": "/tmp/fixture-project", "messages": [message]], "pending": pending]
    }

    func close() {
        StoreURLProtocol.unregister(host: host)
        session?.invalidateAndCancel()
    }
}

private final class HeldStoreResponse {
    let requested = XCTestExpectation(description: "Delayed HTTP request started")
    private let lock = NSLock()
    private var request: StoreURLProtocol?
    func receive(_ request: StoreURLProtocol) {
        lock.lock(); self.request = request; lock.unlock()
        requested.fulfill()
    }
    func finish(_ json: [String: Any], status: Int = 200) {
        lock.lock(); let request = self.request; self.request = nil; lock.unlock()
        request?.finishJSON(json, status: status)
    }
    func finishSSE(_ value: String) {
        lock.lock(); let request = self.request; self.request = nil; lock.unlock()
        request?.finish(Data(value.utf8), contentType: "text/event-stream")
    }
}

private extension StoreTransport {
    static var remoteTargetId: String { "remote-aaaaaaaaaaaaaaaaaaaaaaaa" }
    static func downloadJob(state: String = "running", canCancel: Bool? = true) -> [String: Any] {
        var job: [String: Any] = ["id": "own-download", "modelId": "catalog-native", "name": "Native fixture", "kind": "download", "state": state,
            "summary": "Downloading model files", "percent": 25, "doneGb": 3, "totalGb": 12]
        if let canCancel { job["canCancel"] = canCancel }
        return job
    }
    static func managementCatalog(targetName: String = "Fixture Mac", jobs: [[String: Any]] = []) -> [String: Any] {
        ["supported": true, "targetName": targetName, "capabilities": ["downloads": true, "imports": false],
         "models": [["id": "catalog-native", "name": "Native fixture", "sizeGb": 12, "state": "available", "readPictures": true]], "jobs": jobs]
    }
    static func downloadPlan(expiresAt: Double = Date().timeIntervalSince1970 * 1000 + 60_000) -> [String: Any] {
        ["planId": "fresh-plan", "targetName": "Fixture Mac", "modelName": "Native fixture", "downloadGb": 12, "diskFreeGb": 100, "diskNeededGb": 14,
         "readPictures": true, "expiresAt": expiresAt,
         "warnings": ["Running native models will be unloaded before preparing files.", "The engine may be downloaded or updated.", "The model will not be loaded automatically."]]
    }
    func respondManagement(jobs: [[String: Any]] = [], expiresAt: Double = Date().timeIntervalSince1970 * 1000 + 60_000) {
        respond { request in
            switch request.url!.path {
            case "/v1/model-management/targets":
                return ["targets": [["id": "local", "name": "Fixture Mac", "kind": "local"], ["id": Self.remoteTargetId, "name": "Remote Strata", "kind": "remote"]]]
            case "/v1/model-management/targets/local": return Self.managementCatalog(jobs: jobs)
            case "/v1/model-management/targets/" + Self.remoteTargetId: return Self.managementCatalog(targetName: "Remote Strata")
            case "/v1/model-management/targets/local/plan": return Self.downloadPlan(expiresAt: expiresAt)
            default: return nil
            }
        }
    }
}

private final class StoreURLProtocol: URLProtocol {
    private static let registryLock = NSLock()
    private static var registry: [String: StoreTransport] = [:]
    static func register(_ transport: StoreTransport, host: String) {
        registryLock.lock(); registry[host] = transport; registryLock.unlock()
    }
    static func unregister(host: String) {
        registryLock.lock(); registry.removeValue(forKey: host); registryLock.unlock()
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.registryLock.lock(); let transport = Self.registry[request.url!.host!]; Self.registryLock.unlock()
        transport?.receive(self)
    }
    override func stopLoading() { }
    func finishJSON(_ json: [String: Any], status: Int = 200) {
        finish(try! JSONSerialization.data(withJSONObject: json), contentType: "application/json", status: status)
    }
    func finish(_ data: Data, contentType: String, status: Int = 200) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["content-type": contentType])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor
final class BotComputerTests: XCTestCase {
    private let path = "/v1/bots/bot_fixture/computer"
    private func frame(grant: Bool = false) -> [String: Any] {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 80), format: format).image { context in
            UIColor.systemBlue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 100, height: 80))
        }
        var value: [String: Any] = ["available": true, "computerName": "Isolated fixture", "detail": "Ready", "width": 100, "height": 80,
            "image": ["mimeType": "image/png", "data": image.pngData()!.base64EncodedString()], "control": ["active": true, "owned": true]]
        if grant { value["leaseToken"] = "fixture_lease_0123456789"; value["expiresAt"] = Date().timeIntervalSince1970 * 1000 + 60_000 }
        return value
    }

    func testCanvasPixelsExcludeLetterboxingAndRejectInvalidGeometry() {
        let canvas = CGSize(width: 300, height: 300), image = CGSize(width: 600, height: 400)
        XCTAssertEqual(ComputerCanvasPosition.pixel(at: CGPoint(x: 150, y: 150), canvas: canvas, image: image), CGPoint(x: 300, y: 200))
        XCTAssertEqual(ComputerCanvasPosition.pixel(at: CGPoint(x: 0, y: 50), canvas: canvas, image: image), CGPoint.zero)
        XCTAssertNil(ComputerCanvasPosition.pixel(at: CGPoint(x: 150, y: 49), canvas: canvas, image: image))
        XCTAssertNil(ComputerCanvasPosition.pixel(at: CGPoint(x: 300, y: 150), canvas: canvas, image: image))
        XCTAssertNil(ComputerCanvasPosition.pixel(at: CGPoint(x: CGFloat.infinity, y: 0), canvas: canvas, image: image))
        XCTAssertNil(ComputerCanvasPosition.pixel(at: .zero, canvas: .zero, image: image))
    }

    func testReadingDoesNotStartComputerOrAcquireControlAndOnlyExplicitLeaseCanSendInputs() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let state = frame(), grant = frame(grant: true)
        fixture.respond { request in
            if request.url!.path.hasSuffix("/takeover") { return grant }
            if request.url!.path.hasSuffix("/control") { return ["accepted": true] }
            if request.url!.path.hasSuffix("/release") { return ["released": true] }
            if request.url!.path == self.path { return state }
            return nil
        }
        let store = fixture.makeStore(), session = store.computerSession(botId: "bot_fixture", chatId: "s_frozen")
        session.activate(); await session.refresh()
        XCTAssertNotNil(session.image)
        await session.click(x: 5, y: 6); await session.type("ignored"); await session.key("Enter")
        XCTAssertEqual(fixture.requests.map(\.path), [path])
        XCTAssertFalse(session.hasControl)
        await session.takeOver()
        XCTAssertTrue(session.hasControl)
        await session.click(x: 50, y: 40); await session.type("hello"); await session.key("Control+L")
        await session.type(String(repeating: "x", count: 4_001))
        await session.key("unsupported"); await session.click(x: 100, y: 0)
        let controls = fixture.requests.filter { $0.path.hasSuffix("/control") }
        XCTAssertEqual(controls.count, 3)
        guard controls.count == 3 else { return }
        XCTAssertEqual(controls[0].jsonBody?["x"] as? Double, 50)
        XCTAssertEqual(controls[0].jsonBody?["y"] as? Double, 40)
        XCTAssertEqual(controls[0].jsonBody?["chatId"] as? String, "s_frozen")
        XCTAssertEqual(controls[1].jsonBody?["text"] as? String, "hello")
        XCTAssertEqual(controls[2].jsonBody?["key"] as? String, "Control+L")
        await session.release()
        XCTAssertFalse(session.hasControl)
        await session.type("ignored after release")
        XCTAssertEqual(fixture.requests.filter { $0.path.hasSuffix("/control") }.count, 3)
        XCTAssertFalse(fixture.requests.contains { $0.path.hasSuffix("/start") || $0.path.hasSuffix("/messages") })
        session.deactivate()
    }

    func testTakeoverCompletingAfterNavigationReleasesGrantWithoutRestoringControl() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in request.url!.path.hasSuffix("/release") ? ["released": true] : nil }
        let store = fixture.makeStore(), session = store.computerSession(botId: "bot_fixture", chatId: "s_frozen")
        let held = fixture.hold(path + "/takeover")
        session.activate()
        let takeover = Task { await session.takeOver() }
        await fulfillment(of: [held.requested], timeout: 2)
        session.deactivate(); held.finish(frame(grant: true)); await takeover.value
        XCTAssertFalse(session.hasControl); XCTAssertNil(session.state); XCTAssertFalse(session.isBusy)
        let release = try XCTUnwrap(fixture.requests.first { $0.path.hasSuffix("/release") })
        XCTAssertEqual(release.body?["chatId"], "s_frozen")
        XCTAssertEqual(release.body?["leaseToken"], "fixture_lease_0123456789")
    }

    func testForgetPairingSuppressesInFlightFrameAndFutureComputerCommands() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let store = fixture.makeStore(), session = store.computerSession(botId: "bot_fixture")
        let held = fixture.hold(path)
        session.activate()
        let refreshing = Task { await session.refresh() }
        await fulfillment(of: [held.requested], timeout: 2)
        store.forgetMac(); held.finish(frame()); await refreshing.value
        await session.start(); await session.takeOver(); await session.key("Enter")
        XCTAssertNil(session.state); XCTAssertFalse(session.hasControl)
        XCTAssertEqual(fixture.requests.map(\.path), [path])
        session.deactivate()
    }

    func testExpiredTakeoverIsReleasedAndCannotLeaveBusyState() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        var expired = frame(grant: true); expired["expiresAt"] = 1
        fixture.respond { request in request.url!.path.hasSuffix("/takeover") ? expired : ["released": true] }
        let store = fixture.makeStore(), session = store.computerSession(botId: "bot_fixture")
        session.activate(); await session.takeOver()
        XCTAssertFalse(session.hasControl); XCTAssertFalse(session.isBusy)
        XCTAssertEqual(fixture.requests.map(\.path), [path + "/takeover", path + "/release"])
        session.deactivate()
    }

    func testPreparedStoppedComputerIsNotRunningAndForgottenPairingClearsCachedImage() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        var stopped = frame(); stopped["running"] = false; stopped["cleanupConfirmed"] = false
        fixture.respond { _ in stopped }
        let store = fixture.makeStore(), session = store.computerSession(botId: "bot_fixture")
        session.activate(); await session.refresh()
        XCTAssertFalse(session.isRunning)
        XCTAssertEqual(session.state?.cleanupConfirmed, false)
        XCTAssertNotNil(session.image)
        store.forgetMac(); session.deactivate(); session.activate()
        XCTAssertNil(session.image); XCTAssertNil(session.state); XCTAssertFalse(session.hasControl)
    }

    func testCUAUsesItsActualWorkspaceAndPausedCatalogBlocksNewWork() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        var paused = true
        fixture.respond { request in
            switch request.url!.path {
            case "/v1/bots": return ["bots": [["id": "bot_fixture", "name": "Fixture", "provider": "codex", "model": "", "capabilities": "both", "policy": "manual", "execution": ["kind": "local"], "workspace": "/workspace", "computerMode": "cua", "paused": paused]], "providers": [], "computers": [], "models": [], "selectionSupported": true]
            case "/v1/bots/bot_fixture/conversations": return ["conversation": ["id": "s_frozen", "title": "Fixture", "active": false, "botId": "bot_fixture", "messages": []], "pending": []]
            default: return nil
            }
        }
        let store = fixture.makeStore()
        await store.refreshBots()
        let bot = try XCTUnwrap(store.botCatalog?.bots.first)
        let pausedCreation = await store.newBotConversation(bot)
        XCTAssertFalse(pausedCreation); XCTAssertTrue(store.error?.contains("paused") == true)
        paused = false; await store.refreshBots()
        let wrongFolder = await store.newBotConversation(bot, workspace: "/outside")
        XCTAssertFalse(wrongFolder)
        let created = await store.newBotConversation(bot)
        XCTAssertTrue(created)
        XCTAssertEqual(fixture.requests.first(where: { $0.path.hasSuffix("/conversations") && $0.method == "POST" })?.body, ["workspace": "/workspace"])
        paused = true; await store.refreshBots()
        let count = fixture.requests.count
        await store.sendMessage("must not start")
        XCTAssertEqual(fixture.requests.count, count)
        XCTAssertTrue(store.error?.contains("paused") == true)
    }

    func testAvatarSaveUsesOnlyActualSampleConfigurationAndPreservesOtherConnectionState() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let catalog: [String: Any] = ["bots": [["id": "bot_fixture", "name": "Fixture", "provider": "codex", "model": "", "capabilities": "both", "policy": "manual", "execution": ["kind": "local"], "avatarConfig": ["color": "sky", "eyes": "star", "ears": "scalloped"]]], "providers": [], "computers": []]
        fixture.respond { request in
            if request.url!.path == "/v1/bots" { return catalog }
            if request.url!.path == "/v1/bots/bot_fixture/avatar" { return ["saved": true] }
            return nil
        }
        let store = fixture.makeStore(), connection = store.connection
        await store.refreshBots()
        let saved = await store.saveBotAvatar(botId: "bot_fixture", avatar: AvatarConfig(color: .violet, eyes: .happy, ears: .small))
        XCTAssertTrue(saved)
        let change = try XCTUnwrap(fixture.requests.first { $0.path.hasSuffix("/avatar") })
        XCTAssertEqual(Set(change.jsonBody?.keys.map { $0 } ?? []), Set(["avatarConfig"]))
        XCTAssertEqual(change.jsonBody?["avatarConfig"] as? [String: String], ["color": "violet", "eyes": "happy", "ears": "small"])
        XCTAssertEqual(store.connection, connection); XCTAssertNil(store.currentConversation)
        XCTAssertNil(store.savingBotAvatarId)
        XCTAssertFalse(fixture.requests.contains { $0.path.contains("serving") || $0.path.contains("/messages") })
    }

    func testFrozenSampleAvatarAndComputerModeDecodeWithoutCatalogFallback() throws {
        let json: [String: Any] = ["id": "s_frozen", "title": "Earlier bot", "active": false, "messages": [], "botId": "bot_fixture", "computerMode": "cua",
            "botAvatarConfig": ["color": "violet", "eyes": "happy", "ears": "small"]]
        let conversation = try JSONDecoder().decode(MacConversation.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(conversation.botAvatarConfig, AvatarConfig(color: .violet, eyes: .happy, ears: .small))
        XCTAssertEqual(conversation.computerMode, "cua")
        XCTAssertThrowsError(try CompanionClient.computerPath(botId: "../private"))
        XCTAssertThrowsError(try CompanionClient.computerPath(botId: "bot_fixture", action: "prepare"))
    }

    func testNewAvatarCharacterSaveRetainsNarrowAPIAndFrozenHistory() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            if request.url!.path == "/v1/bots" { return ["bots": [["id": "bot_fixture", "name": "Fixture", "provider": "codex", "model": "", "capabilities": "both", "policy": "manual", "execution": ["kind": "local"]]], "providers": [], "computers": []] }
            if request.url!.path == "/v1/bots/bot_fixture/avatar" { return ["saved": true] }
            return nil
        }
        let store = fixture.makeStore(), connection = store.connection
        await store.refreshBots()
        let saved = await store.saveBotAvatar(botId: "bot_fixture", avatar: AvatarConfig(color: .orange, eyes: .delight, ears: .round, kind: .fox))
        XCTAssertTrue(saved)
        let change = try XCTUnwrap(fixture.requests.first { $0.path.hasSuffix("/avatar") })
        XCTAssertEqual(Set(change.jsonBody?.keys.map { $0 } ?? []), Set(["avatarConfig"]))
        XCTAssertEqual(change.jsonBody?["avatarConfig"] as? [String: String], ["kind": "fox", "color": "orange", "eyes": "delight", "ears": "round"])
        XCTAssertEqual(store.connection, connection)
        XCTAssertNil(store.currentConversation)
        XCTAssertFalse(fixture.requests.contains { $0.path.contains("serving") || $0.path.contains("/messages") || $0.path.contains("/computer") })
    }
    func testUnsupportedGeometricAvatarCannotWriteAndOldHostClassicUsesLegacyFields() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            if request.url!.path == "/v1/bots" { return ["bots": [["id": "bot_fixture", "name": "Fixture", "provider": "codex", "model": "", "capabilities": "both", "policy": "manual", "execution": ["kind": "local"]]], "providers": [], "computers": []] }
            if request.url!.path.hasSuffix("/avatar") { return ["saved": true] }
            return nil
        }
        let store = fixture.makeStore(); await store.refreshBots()
        let before = fixture.requests.count
        let rejected = await store.saveBotAvatar(botId: "bot_fixture", avatar: AvatarConfig(shape: .orb))
        XCTAssertFalse(rejected); XCTAssertEqual(fixture.requests.count, before)
        let clear = await store.saveBotAvatar(botId: "bot_fixture", avatar: AvatarConfig(shape: .classic))
        XCTAssertTrue(clear)
        XCTAssertEqual(fixture.requests.first { $0.path.hasSuffix("/avatar") }?.jsonBody?["avatarConfig"] as? [String: String], ["color": "sky", "eyes": "star", "ears": "scalloped"])
    }

}

@MainActor
final class AvatarSchemaTests: XCTestCase {
    func testLegacyAndExplicitKoalaEncodeExactlyThreeFields() throws {
        let legacy: [String: String] = ["color": "violet", "eyes": "happy", "ears": "small"]
        for json in [legacy, legacy.merging(["kind": "koala"], uniquingKeysWith: { _, value in value })] {
            let face = try JSONDecoder().decode(AvatarConfig.self, from: JSONSerialization.data(withJSONObject: json))
            XCTAssertEqual(face.kind, .koala)
            let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(face)) as? [String: String]
            XCTAssertEqual(encoded, legacy)
        }
    }

    func testUnknownNullAndWrongTypeCharacterCannotSilentlyChangeIdentity() throws {
        let invalidKinds: [Any] = ["unrecognized", NSNull(), 3, ["fox"]]
        for kind in invalidKinds {
            let json: [String: Any] = ["kind": kind, "color": "sky", "eyes": "star", "ears": "scalloped"]
            XCTAssertThrowsError(try JSONDecoder().decode(AvatarConfig.self, from: JSONSerialization.data(withJSONObject: json)))
        }
    }

    func testAll432CharacterConfigurationsRoundTripWithoutLegacyWireChanges() throws {
        var faces = Set<AvatarConfig>()
        for kind in AvatarKind.allCases { for color in BotColor.allCases { for eyes in EyeStyle.allCases { for ears in EarShape.allCases {
            let face = AvatarConfig(color: color, eyes: eyes, ears: ears, kind: kind)
            let encoded = try JSONEncoder().encode(face)
            let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: String])
            XCTAssertEqual(Set(fields.keys), Set(kind == .koala ? ["color", "eyes", "ears"] : ["kind", "color", "eyes", "ears"]))
            XCTAssertEqual(try JSONDecoder().decode(AvatarConfig.self, from: encoded), face)
            faces.insert(face)
        }}}}
        XCTAssertEqual(faces.count, 432)
    }

    func testGeometricConfigurationRoundTripsAndLegacyDecoderKeepsStableFallback() throws {
        struct LegacyFace: Decodable { var color: BotColor; var eyes: EyeStyle; var ears: EarShape; var kind: AvatarKind? }
        for shape in AvatarShape.geometric {
            let face = AvatarConfig(color: .violet, eyes: .round, ears: .small, shape: shape)
            let data = try JSONEncoder().encode(face)
            let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
            XCTAssertEqual(fields, ["color": "violet", "eyes": "round", "ears": "small", "shape": shape.rawValue])
            XCTAssertEqual(try JSONDecoder().decode(AvatarConfig.self, from: data), face)
            let old = try JSONDecoder().decode(LegacyFace.self, from: data)
            XCTAssertNil(old.kind); XCTAssertEqual(old.color, .violet); XCTAssertEqual(old.eyes, .round); XCTAssertEqual(old.ears, .small)
        }
    }

    func testFutureGeometryDoesNotBreakRosterAndMalformedShapesAreRejected() throws {
        let future: [String: Any] = ["color": "sky", "eyes": "star", "ears": "round", "shape": "future-shape"]
        let decoded = try JSONDecoder().decode(AvatarConfig.self, from: JSONSerialization.data(withJSONObject: future))
        XCTAssertNil(decoded.shape); XCTAssertEqual(decoded.kind, .koala)
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded)) as? [String: String])
        XCTAssertEqual(encoded, ["color": "sky", "eyes": "star", "ears": "round"])
        for value: Any in [NSNull(), 7, ["orb"]] {
            var malformed = future; malformed["shape"] = value
            XCTAssertThrowsError(try JSONDecoder().decode(AvatarConfig.self, from: JSONSerialization.data(withJSONObject: malformed)))
        }
    }

    func testExplicitKoalaChoiceClearsUnknownFutureShapeWithoutChangingUntouchedLegacyWire() throws {
        let source = Data("{\"color\":\"sky\",\"eyes\":\"round\",\"ears\":\"small\",\"shape\":\"future-geometry\"}".utf8)
        var face = try JSONDecoder().decode(AvatarConfig.self, from: source)
        XCTAssertNil(face.shape)
        let untouched = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(face)) as? [String: String])
        XCTAssertNil(untouched["shape"])
        face.chooseAnimal(.koala)
        XCTAssertEqual(face.shape, .classic); XCTAssertEqual(face.kind, .koala)
        XCTAssertEqual(face.color, .sky); XCTAssertEqual(face.eyes, .round); XCTAssertEqual(face.ears, .small)
        let clear = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(face.validated(supportedShapes: ["orb"]))) as? [String: String])
        XCTAssertEqual(clear["shape"], "classic")
        let old = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(face.validated(supportedShapes: nil))) as? [String: String])
        XCTAssertEqual(old, untouched)
    }

    func testShapeCapabilityBlocksUnsupportedGeometryAndClassicClearsExplicitly() throws {
        let orb = AvatarConfig(shape: .orb)
        XCTAssertThrowsError(try orb.validated(supportedShapes: nil))
        XCTAssertThrowsError(try orb.validated(supportedShapes: ["tile", "future"]))
        XCTAssertEqual(try orb.validated(supportedShapes: ["orb"]), orb)
        XCTAssertThrowsError(try AvatarConfig(kind: .fox, shape: .orb).validated(supportedShapes: ["orb"]))
        let clear = AvatarConfig(shape: .classic)
        XCTAssertEqual(try clear.validated(supportedShapes: ["orb"]).shape, .classic)
        XCTAssertNil(try clear.validated(supportedShapes: nil).shape, "Old Mac validators cannot accept a shape key.")
    }

    func testOriginalGeometricPathsAndEyeGridMatchSharedFixture() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../host/tests/fixtures/strata-geometric-avatars.json").standardizedFileURL
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any])
        let shapes = try XCTUnwrap(object["shapes"] as? [[String: String]])
        let paths = Dictionary(uniqueKeysWithValues: try shapes.map { value in (try XCTUnwrap(AvatarShape(rawValue: try XCTUnwrap(value["id"]))), try XCTUnwrap(value["path"])) })
        XCTAssertEqual(GeometricAvatarGeometry.paths, paths)
        let grid = try XCTUnwrap(object["eyeGrid"] as? [String: Double])
        XCTAssertEqual(GeometricAvatarGeometry.leftX, grid["leftX"]); XCTAssertEqual(GeometricAvatarGeometry.rightX, grid["rightX"]); XCTAssertEqual(GeometricAvatarGeometry.eyeY, grid["y"])
        for path in KoalaRenderer.geometricHeads.values {
            let bounds = path.cgPath.boundingBoxOfPath
            XCTAssertGreaterThan(bounds.width, 1.8); XCTAssertGreaterThan(bounds.height, 1.8)
            XCTAssertGreaterThanOrEqual(bounds.minX, -1.425); XCTAssertLessThanOrEqual(bounds.maxX, 1.425)
            XCTAssertGreaterThanOrEqual(bounds.minY, -1.425); XCTAssertLessThanOrEqual(bounds.maxY, 1.425)
        }
    }

    func testSixOriginalGeometricCharactersRenderDistinctlyAndClassicPreservesKoala() throws {
        func png(_ face: AvatarConfig) throws -> Data {
            let renderer = ImageRenderer(content: KoalaAvatar(face, animated: false).frame(width: 96, height: 96)); renderer.scale = 1
            return try XCTUnwrap(renderer.uiImage?.pngData())
        }
        var images = Set<Data>()
        for shape in AvatarShape.geometric { images.insert(try png(AvatarConfig(color: .sky, eyes: .round, shape: shape))) }
        XCTAssertEqual(images.count, 6)
        XCTAssertEqual(try png(AvatarConfig()), try png(AvatarConfig(shape: .classic)))
    }

    func testFamilySelectionPreservesPaletteEyesAndEars() throws {
        var face = AvatarConfig(color: .graphite, eyes: .delight, ears: .small)
        for kind in AvatarKind.allCases {
            face.kind = kind
            XCTAssertEqual(face.color, .graphite); XCTAssertEqual(face.eyes, .delight); XCTAssertEqual(face.ears, .small)
            XCTAssertEqual(face.kind, kind)
        }
        face.kind = .koala
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(face)) as? [String: String])
        XCTAssertNil(fields["kind"])
    }

    func testQuadraticPathsRenderTheirActualCurveAndCharacterHeadsStayInCanvas() {
        let curve = SVGPath.parse("M0 0Q1 2 2 0").cgPath.boundingBoxOfPath
        XCTAssertEqual(curve.width, 2, accuracy: 0.0001)
        XCTAssertEqual(curve.height, 1, accuracy: 0.0001)
        for kind in [AvatarKind.fox, .cat, .robot] {
            let bounds = KoalaRenderer.characterHeads[kind]!.cgPath.boundingBoxOfPath
            XCTAssertGreaterThan(bounds.width, 1.5); XCTAssertGreaterThan(bounds.height, 1.5)
            XCTAssertTrue(bounds.minX.isFinite && bounds.maxY.isFinite)
            XCTAssertGreaterThanOrEqual(bounds.minX, -1.425); XCTAssertLessThanOrEqual(bounds.maxX, 1.425)
            XCTAssertGreaterThanOrEqual(bounds.minY, -1.485); XCTAssertLessThanOrEqual(bounds.maxY, 1.365)
        }
    }

    func testEachFamilyRendersDistinctImageWithSharedPaletteAndExpression() throws {
        var images = Set<Data>()
        for kind in AvatarKind.allCases {
            let view = KoalaAvatar(AvatarConfig(color: .violet, eyes: .happy, ears: .small, kind: kind), animated: false).frame(width: 96, height: 96)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 1
            let image = try XCTUnwrap(renderer.uiImage)
            XCTAssertEqual(image.size.width, 96); XCTAssertEqual(image.size.height, 96)
            images.insert(try XCTUnwrap(image.pngData()))
        }
        XCTAssertEqual(images.count, 4)
    }
}

@MainActor
final class BotWorkspaceTests: XCTestCase {
    private var limits: [String: Any] { ["maxParallel": 2, "maxDepth": 2, "maxHops": 8, "maxTurns": 24, "maxDurationMs": 600000] }
    private func team(enabled: Bool = false, name: String = "Team") -> [String: Any] {
        ["id": "team_fixture", "name": name, "memberIds": ["bot_coder", "bot_reviewer"], "coordinatorId": "bot_coder", "enabled": enabled, "limits": limits]
    }
    private func runRecord(state: String = "running") -> [String: Any] {
        ["id": "run_fixture", "teamId": "team_fixture", "rootChatId": "s_shared", "rootBotId": "bot_coder", "state": state, "consumedTurns": 1]
    }
    private func skill(id: String = "skill_fixture", source: String = "draft") -> [String: Any] {
        ["id": id, "name": "Review", "description": "Review changes", "body": "Read the diff.", "triggers": ["review"], "source": source, "status": "enabled", "revision": source == "library" ? "library-digest" : 2, "digest": "abc", "botIds": []]
    }
    private func decode<T: Decodable>(_ value: [String: Any], as type: T.Type) throws -> T { try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value)) }

    private func managedTeam(revision: Int = 1) -> [String: Any] {
        var value = team(enabled: true); value["revision"] = revision; value["execution"] = ["mode": "individual"]; return value
    }
    private func settingsSnapshot(revision: Int = 1, active: Bool = false) -> [String: Any] {
        ["teams": [managedTeam(revision: revision)], "runs": active ? [runRecord()] : [], "teamSettingsSupported": true,
         "teamComputers": [["id": "host:ssh_fixture", "name": "Saved SSH computer", "label": "Configured remote computer", "computerMode": "host", "workspace": "/srv/team", "available": true],
                           ["id": "cua:bot_coder", "name": "Coder’s computer", "label": "Isolated computer", "computerMode": "cua", "workspace": "/workspace", "available": true, "memberId": "bot_coder"]]]
    }
    private func sharedDraft() -> BotTeamDraft {
        BotTeamDraft(name: "Edited team", memberIds: ["bot_coder", "bot_reviewer"], coordinatorId: "bot_reviewer", execution: BotTeamExecution(mode: "shared", computerId: "host:ssh_fixture", workspace: "/srv/team project"))
    }
    func testTeamSettingsRemainOptionalForOlderHosts() throws {
        let old = try decode(["teams": [team()], "runs": []], as: BotTeamsSnapshot.self)
        XCTAssertNil(old.teamSettingsSupported); XCTAssertNil(old.teamInstructionsSupported); XCTAssertNil(old.teamComputers)
        XCTAssertNil(old.teams.first?.revision); XCTAssertNil(old.teams.first?.execution)
        XCTAssertNil(old.teams.first?.briefing)
        let modern = try decode(settingsSnapshot(), as: BotTeamsSnapshot.self)
        XCTAssertEqual(modern.teamComputers?.last?.workspace, "/workspace")
        XCTAssertTrue(modern.teamComputers?.last?.isIsolated == true)
    }
    func testTeamBriefingsDecodeAndValidatePublicRosterAndUTF16Bounds() throws {
        let briefing = BotTeamBriefing(instructions: "Keep work flowing in the shared channel.", members: [BotTeamMemberBriefing(botId: "bot_reviewer", role: "Reviewer", instructions: "Review the implementation and report the result.")])
        var value = managedTeam(); value["briefing"] = ["instructions": briefing.instructions, "members": [["botId": "bot_reviewer", "role": "Reviewer", "instructions": "Review the implementation and report the result."]]]
        let decoded = try decode(value, as: BotTeam.self); XCTAssertEqual(decoded.briefing, briefing)
        var draft = sharedDraft(); draft.briefing = briefing
        XCTAssertTrue(BotWorkspaceStore.validTeamDraft(draft))
        draft.briefing?.members[0].botId = "outside"; XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft))
        draft.briefing = briefing; draft.briefing?.members.append(briefing.members[0]); XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft))
        draft.briefing = briefing; draft.briefing?.instructions = String(repeating: "😀", count: 4_001); XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft))
        draft.briefing = briefing; draft.briefing?.members[0].role = String(repeating: "😀", count: 61); XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft))
        draft.briefing = briefing; draft.briefing?.members[0].instructions = String(repeating: "x", count: 4_001); XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft))
        draft.briefing = briefing; draft.briefing?.instructions = "bad\0text"; XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft))
        draft.memberIds = (0..<5).map { "bot_\($0)" }; draft.coordinatorId = "bot_0"
        draft.briefing = BotTeamBriefing(instructions: String(repeating: "界", count: 8_000), members: (0..<4).map { BotTeamMemberBriefing(botId: "bot_\($0)", instructions: String(repeating: "界", count: 4_000)) })
        XCTAssertTrue(BotWorkspaceStore.validTeamDraft(draft))
        draft.briefing?.members.append(BotTeamMemberBriefing(botId: "bot_4", role: "X")); XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft))
    }
    func testTeamBriefingUpdatesUseRevisionAndOlderHostsCannotReceiveNewFields() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var supported = false
        fixture.respond { request in
            if request.httpMethod == "PATCH" { return ["team": self.managedTeam(revision: 2)] }
            var value = self.settingsSnapshot(); value["teamInstructionsSupported"] = supported; return value
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshTeams()
        let original = try XCTUnwrap(workspace.teams?.teams.first)
        var draft = sharedDraft(); draft.briefing = BotTeamBriefing(instructions: "Keep everyone informed.", members: [BotTeamMemberBriefing(botId: "bot_coder", role: "Developer", instructions: "Implement the coordinator’s assignment.")])
        let rejected = await workspace.updateTeam(original, draft: draft); XCTAssertFalse(rejected)
        let notCreated = await workspace.createTeam(draft); XCTAssertFalse(notCreated)
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        supported = true; await workspace.refreshTeams()
        let saved = await workspace.updateTeam(original, draft: draft); XCTAssertTrue(saved)
        let patch = try XCTUnwrap(fixture.requests.first { $0.method == "PATCH" })
        XCTAssertEqual(patch.jsonBody?["expectedRevision"] as? Int, 1)
        let sent = try XCTUnwrap(patch.jsonBody?["briefing"] as? [String: Any])
        XCTAssertEqual(sent["instructions"] as? String, "Keep everyone informed.")
        XCTAssertEqual(sent["members"] as? [[String: String]], [["botId": "bot_coder", "role": "Developer", "instructions": "Implement the coordinator’s assignment."]])
        XCTAssertFalse(fixture.requests.contains { $0.path.contains("/profiles") || $0.path.contains("/conversations") || $0.path.contains("/computer") || $0.path.contains("/runs") })
    }
    func testTeamUpdateUsesExactRevisionAnchorAndFolderWithoutRecreatingOrChangingHistory() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var revision = 1
        fixture.respond { request in
            if request.url!.path.hasSuffix("/channel") { return self.channelSnapshot([self.channelEntry(1)]) }
            if request.httpMethod == "PATCH" { revision = 2; return ["team": self.managedTeam(revision: revision)] }
            if request.url!.path == "/v1/bots/teams" { return self.settingsSnapshot(revision: revision) }
            return nil
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshTeams(); await workspace.refreshChannel("team_fixture")
        let original = try XCTUnwrap(workspace.teams?.teams.first)
        let saved = await workspace.updateTeam(original, draft: sharedDraft())
        XCTAssertTrue(saved); XCTAssertEqual(workspace.teams?.teams.first?.revision, 2)
        XCTAssertEqual(workspace.channels["team_fixture"]?.messages.map(\.id), ["tm_1"])
        let patch = try XCTUnwrap(fixture.requests.first { $0.method == "PATCH" })
        XCTAssertEqual(patch.path, "/v1/bots/teams/team_fixture")
        XCTAssertEqual(Set(patch.jsonBody!.keys), Set(["name", "memberIds", "coordinatorId", "limits", "execution", "expectedRevision"]))
        XCTAssertEqual(patch.jsonBody?["expectedRevision"] as? Int, 1)
        XCTAssertEqual(patch.jsonBody?["execution"] as? [String: String], ["mode": "shared", "computerId": "host:ssh_fixture", "workspace": "/srv/team project"])
        XCTAssertFalse(fixture.requests.contains { $0.method == "POST" || $0.path.contains("/conversations") || $0.path.contains("/computer") })
    }
    func testInvalidMembershipFolderAnchorAndActiveOrStaleEditsCannotWrite() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var active = true; var revision = 1
        fixture.respond { _ in self.settingsSnapshot(revision: revision, active: active) }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshTeams()
        let original = try XCTUnwrap(workspace.teams?.teams.first)
        let busy = await workspace.updateTeam(original, draft: sharedDraft()); XCTAssertFalse(busy)
        active = false; revision = 2; await workspace.refreshTeams()
        let stale = await workspace.updateTeam(original, draft: sharedDraft()); XCTAssertFalse(stale)
        let fresh = try XCTUnwrap(workspace.teams?.teams.first)
        var invalid = sharedDraft(); invalid.memberIds = ["bot_coder", "bot_coder"]
        var drafts = [invalid]
        invalid = sharedDraft(); invalid.coordinatorId = "outside"; drafts.append(invalid)
        invalid = sharedDraft(); invalid.execution?.computerId = "outside"; drafts.append(invalid)
        invalid = sharedDraft(); invalid.execution?.workspace = "relative/folder"; drafts.append(invalid)
        invalid = sharedDraft(); invalid.execution?.workspace = "/srv/invalid\nfolder"; drafts.append(invalid)
        invalid = sharedDraft(); invalid.execution?.mode = "unknown"; drafts.append(invalid)
        for draft in drafts { let saved = await workspace.updateTeam(fresh, draft: draft); XCTAssertFalse(saved) }
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }
    func testSharedCUARequiresItsMemberAndContainedFolderAndUnavailableTargetCannotWrite() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        var snapshot = settingsSnapshot()
        fixture.respond { _ in snapshot }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshTeams()
        let original = try XCTUnwrap(workspace.teams?.teams.first)
        var draft = sharedDraft(); draft.execution = BotTeamExecution(mode: "shared", computerId: "cua:bot_coder", workspace: "/workspace/sub project")
        XCTAssertTrue(BotWorkspaceStore.validTeamDraft(draft))
        let isolated = try XCTUnwrap(workspace.teams?.teamComputers?.last)
        XCTAssertTrue(isolated.allowsFolder("/workspace/sub project"))
        for folder in ["/workspace/../outside", "/workspace-sibling", "/etc", "/workspace/sub/../../outside"] {
            draft.execution?.workspace = folder
            let saved = await workspace.updateTeam(original, draft: draft); XCTAssertFalse(saved)
        }
        draft.execution?.workspace = "/workspace"
        draft.memberIds = ["bot_reviewer", "bot_other"]
        let removedAnchor = await workspace.updateTeam(original, draft: draft); XCTAssertFalse(removedAnchor)
        var rows = try XCTUnwrap(snapshot["teamComputers"] as? [[String: Any]])
        rows[0]["available"] = false; snapshot["teamComputers"] = rows; await workspace.refreshTeams()
        let unavailable = await workspace.updateTeam(original, draft: sharedDraft()); XCTAssertFalse(unavailable)
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }
    func testTeamConflictRefreshesLatestWithoutRetryOrReplacingDraftHistory() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var revision = 1
        fixture.respond { _ in self.settingsSnapshot(revision: revision) }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshTeams()
        let original = try XCTUnwrap(workspace.teams?.teams.first), held = fixture.hold("/v1/bots/teams/team_fixture")
        let saved = Task { await workspace.updateTeam(original, draft: self.sharedDraft()) }
        await fulfillment(of: [held.requested], timeout: 2)
        revision = 2; held.finish(["error": "This team changed. Reload its latest settings."], status: 409)
        let result = await saved.value; XCTAssertFalse(result)
        XCTAssertEqual(workspace.teams?.teams.first?.revision, 2); XCTAssertEqual(original.revision, 1)
        XCTAssertTrue(workspace.messages["teams"]?.contains("changed") == true)
        XCTAssertEqual(fixture.requests.filter { $0.method == "PATCH" }.count, 1)
        XCTAssertNil(workspace.mutation)
    }
    func testTeamUpdateAfterForgetCannotPublishOrRefreshAnotherMac() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { _ in self.settingsSnapshot() }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshTeams()
        let original = try XCTUnwrap(workspace.teams?.teams.first), held = fixture.hold("/v1/bots/teams/team_fixture")
        let saving = Task { await workspace.updateTeam(original, draft: self.sharedDraft()) }
        await fulfillment(of: [held.requested], timeout: 2); store.forgetMac()
        held.finish(["team": managedTeam(revision: 2)])
        let result = await saving.value; XCTAssertFalse(result)
        XCTAssertEqual(workspace.teams?.teams.first?.revision, 1)
        XCTAssertEqual(fixture.requests.count, 2); XCTAssertNil(workspace.mutation)
    }
    func testSharedTeamCreationAndEnablementUseSavedAnchorsWithoutStartingWork() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in request.httpMethod == "GET" ? self.settingsSnapshot() : ["team": self.managedTeam(revision: 2)] }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshTeams()
        let created = await workspace.createTeam(sharedDraft()); XCTAssertTrue(created)
        let original = try XCTUnwrap(workspace.teams?.teams.first)
        await workspace.setTeamEnabled(original, enabled: false)
        let creation = try XCTUnwrap(fixture.requests.first { $0.method == "POST" })
        XCTAssertEqual(creation.jsonBody?["enabled"] as? Bool, false)
        XCTAssertEqual(creation.jsonBody?["execution"] as? [String: String], ["mode": "shared", "computerId": "host:ssh_fixture", "workspace": "/srv/team project"])
        XCTAssertEqual(fixture.requests.first { $0.method == "PATCH" }?.jsonBody?["expectedRevision"] as? Int, 1)
        XCTAssertFalse(fixture.requests.contains { $0.path.contains("/runs") || $0.path.contains("/messages") || $0.path.contains("/computer") })
    }

    private func channelEntry(_ sequence: Int, teamId: String = "team_fixture", content: String = "Public team reply") -> [String: Any] {
        ["id": "tm_\(sequence)", "sequence": sequence, "teamId": teamId, "kind": "message", "author": ["type": "bot", "botId": "bot_reviewer", "name": "Reviewer", "avatarConfig": ["color": "sky", "eyes": "round", "ears": "round", "shape": "orb"]], "content": content, "createdAt": "2026-10-21T01:00:00.000Z", "chatId": "s_shared"]
    }
    private func channelSnapshot(_ rows: [[String: Any]], older: Bool = false) -> [String: Any] {
        ["teamId": "team_fixture", "supported": true, "messages": rows, "activeRuns": [], "nextSequence": rows.last?["sequence"] as? Int ?? 0, "hasMore": false, "hasMoreBefore": older]
    }

    func testTeamPublicPreviewDecodesUnicodeAndItsOwnActivityDate() throws {
        var data = team(enabled: true)
        data["createdAt"] = "2026-10-20T01:00:00.000Z"
        data["channelPreview"] = ["id": "tm_public", "sequence": 3, "kind": "message", "author": ["type": "bot", "name": "Reviewer", "botId": "bot_reviewer"], "content": "Ready 👩🏽‍💻 — 你好", "createdAt": "2026-10-21T02:30:00.000Z"]
        let value = try decode(data, as: BotTeam.self)
        XCTAssertEqual(value.channelPreview?.line, "Reviewer: Ready 👩🏽‍💻 — 你好")
        XCTAssertEqual(value.channelPreview?.sequence, 3)
        XCTAssertGreaterThan(try XCTUnwrap(value.channelPreview?.createdAt.date), try XCTUnwrap(value.createdAt?.date))
    }
    func testTeamPreviewIsOptionalForEmptyAndOlderHostsAndSystemLineStaysUnattributed() throws {
        let value = try decode(team(), as: BotTeam.self)
        XCTAssertNil(value.channelPreview); XCTAssertNil(value.createdAt)
        let preview = try decode(["id": "tm_status", "sequence": 5, "kind": "status", "author": ["type": "system", "name": "Strata"], "content": "Stopped by you.", "createdAt": 1_792_544_400_000], as: BotTeamChannelPreview.self)
        XCTAssertEqual(preview.line, "Stopped by you."); XCTAssertNotNil(preview.createdAt.date)
    }

    func testTeamChannelReadsMergeOrderedHistoryAndKeepForwardCursorAfterOlderPages() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        var queries: [String] = []
        fixture.respond { request in
            guard request.url!.path.hasSuffix("/channel") else { return nil }
            let query = request.url!.query ?? ""; queries.append(query)
            if query == "before=101" { return self.channelSnapshot([self.channelEntry(1), self.channelEntry(100)]) }
            if query == "after=102" { return self.channelSnapshot([self.channelEntry(103)]) }
            return self.channelSnapshot([self.channelEntry(101), self.channelEntry(102)], older: true)
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshChannel("team_fixture")
        XCTAssertTrue(workspace.channels["team_fixture"]?.hasMoreBefore == true)
        await workspace.refreshChannel("team_fixture", older: true)
        await workspace.refreshChannel("team_fixture")
        XCTAssertEqual(queries, ["", "before=101", "after=102"])
        XCTAssertEqual(workspace.channels["team_fixture"]?.messages.map(\.sequence), [1, 100, 101, 102, 103])
        XCTAssertFalse(workspace.channels["team_fixture"]?.hasMoreBefore ?? true)
        XCTAssertEqual(workspace.channels["team_fixture"]?.messages.first?.author.avatarConfig?.shape, .orb)
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        XCTAssertNil(store.currentConversation)
    }

    func testTeamChannelSendStaysInRoomAndRetriesUseExactTypedRequest() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let posted = channelSnapshot([channelEntry(1), channelEntry(2)])
        fixture.respond { request in
            if request.url!.path.hasSuffix("/channel") { return self.channelSnapshot([self.channelEntry(1)]) }
            if request.url!.path.hasSuffix("/messages") { return ["channel": posted, "run": self.runRecord()] }
            if request.url!.path == "/v1/bots/teams" { return ["teams": [self.team(enabled: true)], "runs": [self.runRecord()]] }
            return nil
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshChannel("team_fixture")
        let selected = try decode(team(enabled: true), as: BotTeam.self)
        let draft = BotTeamChannelPost(message: "Hi everyone", requestId: "request_room", recipientIds: selected.memberIds, replyToId: "tm_1")
        let sent = await workspace.postTeamMessage(selected, draft: draft)
        let repeated = await workspace.postTeamMessage(selected, draft: draft)
        XCTAssertTrue(sent); XCTAssertTrue(repeated)
        let writes = fixture.requests.filter { $0.method == "POST" }
        XCTAssertEqual(writes.count, 2)
        XCTAssertEqual(writes.map { $0.jsonBody?["requestId"] as? String }, ["request_room", "request_room"])
        XCTAssertEqual(writes.first?.jsonBody?["recipientIds"] as? [String], selected.memberIds)
        XCTAssertEqual(Set(writes.first!.jsonBody!.keys), ["message", "requestId", "recipientIds", "replyToId"])
        XCTAssertEqual(workspace.channels["team_fixture"]?.messages.map(\.sequence), [1, 2])
        XCTAssertNil(store.currentConversation)
        XCTAssertFalse(fixture.requests.contains { $0.path.hasSuffix("/runs") || $0.path.contains("serving") || $0.path.contains("model-management") })
    }

    func testBusyChannelPostWindowCannotSkipUnreadGapAndIdsKeepTheirSequences() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        var queries: [String] = []
        fixture.respond { request in
            if request.url!.path.hasSuffix("/channel") {
                let query = request.url!.query ?? ""; queries.append(query)
                if query == "after=100" { return self.channelSnapshot((101...200).map { self.channelEntry($0) }) }
                if query == "after=251" {
                    var moved = self.channelEntry(252); moved["id"] = "tm_1"
                    return self.channelSnapshot([moved])
                }
                return self.channelSnapshot((1...100).map { self.channelEntry($0) })
            }
            if request.url!.path.hasSuffix("/messages") { return ["channel": self.channelSnapshot((152...251).map { self.channelEntry($0) })] }
            if request.url!.path == "/v1/bots/teams" { return ["teams": [self.team(enabled: true)], "runs": []] }
            return nil
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshChannel("team_fixture")
        let sent = await workspace.postTeamMessage(try decode(team(enabled: true), as: BotTeam.self), draft: BotTeamChannelPost(message: "Hello", requestId: "request_room"))
        XCTAssertTrue(sent)
        XCTAssertEqual(workspace.channels["team_fixture"]?.nextSequence, 100)
        await workspace.refreshChannel("team_fixture")
        XCTAssertEqual(workspace.channels["team_fixture"]?.messages.map(\.sequence), Array(1...251))
        XCTAssertEqual(workspace.channels["team_fixture"]?.nextSequence, 251)
        await workspace.refreshChannel("team_fixture")
        XCTAssertEqual(queries, ["", "after=100", "after=251"])
        XCTAssertEqual(workspace.channels["team_fixture"]?.messages.first?.sequence, 1)
        XCTAssertEqual(workspace.channels["team_fixture"]?.messages.count, 251)
        XCTAssertNotNil(workspace.messages[BotWorkspaceStore.channelKey("team_fixture")])
    }

    func testLateChannelReadCannotOverwriteNewerSendOrForgottenPairing() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            if request.url!.path.hasSuffix("/channel") { return self.channelSnapshot([self.channelEntry(1)]) }
            if request.url!.path.hasSuffix("/messages") { return ["channel": self.channelSnapshot([self.channelEntry(1), self.channelEntry(2)])] }
            if request.url!.path == "/v1/bots/teams" { return ["teams": [self.team(enabled: true)], "runs": []] }
            return nil
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshChannel("team_fixture")
        let held = fixture.hold("/v1/bots/teams/team_fixture/channel")
        let reading = Task { await workspace.refreshChannel("team_fixture") }
        await fulfillment(of: [held.requested], timeout: 2)
        let sent = await workspace.postTeamMessage(try decode(team(enabled: true), as: BotTeam.self), draft: BotTeamChannelPost(message: "Coordinate this task", requestId: "request_room"))
        XCTAssertTrue(sent)
        held.finish(channelSnapshot([channelEntry(1)])); await reading.value
        XCTAssertEqual(workspace.channels["team_fixture"]?.messages.count, 2)
        fixture.release("/v1/bots/teams/team_fixture/channel")
        let late = fixture.hold("/v1/bots/teams/team_fixture/channel")
        let forgetting = Task { await workspace.refreshChannel("team_fixture", reset: true) }
        await fulfillment(of: [late.requested], timeout: 2)
        store.forgetMac(); late.finish(channelSnapshot([channelEntry(9)])); await forgetting.value
        XCTAssertEqual(workspace.channels["team_fixture"]?.messages.map(\.sequence), [1, 2])
    }

    func testChannelUnsupportedIsExplicitAndTransientErrorKeepsReadableHistory() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { _ in self.channelSnapshot([self.channelEntry(1)]) }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshChannel("team_fixture")
        let error = fixture.hold("/v1/bots/teams/team_fixture/channel")
        let reading = Task { await workspace.refreshChannel("team_fixture") }
        await fulfillment(of: [error.requested], timeout: 2)
        error.finish(["error": "Synthetic offline Mac"], status: 503); await reading.value
        XCTAssertEqual(workspace.channels["team_fixture"]?.messages.count, 1)
        XCTAssertTrue(workspace.channels["team_fixture"]?.supported == true)
        XCTAssertEqual(workspace.messages[BotWorkspaceStore.channelKey("team_fixture")], "Synthetic offline Mac")
        fixture.release("/v1/bots/teams/team_fixture/channel")
        let unsupported = fixture.hold("/v1/bots/teams/team_fixture/channel")
        let old = Task { await workspace.refreshChannel("team_fixture") }
        await fulfillment(of: [unsupported.requested], timeout: 2)
        unsupported.finish(["error": "Unsupported"], status: 404); await old.value
        XCTAssertFalse(workspace.channels["team_fixture"]?.supported ?? true)
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }

    func testMalformedCrossTeamChannelAndInvalidRecipientsNeverPublishOrSend() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { _ in self.channelSnapshot([self.channelEntry(1, teamId: "other_team")]) }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshChannel("team_fixture")
        XCTAssertNil(workspace.channels["team_fixture"])
        XCTAssertNotNil(workspace.messages[BotWorkspaceStore.channelKey("team_fixture")])
        fixture.respond { _ in self.channelSnapshot([]) }
        await workspace.refreshChannel("team_fixture")
        let selected = try decode(team(enabled: true), as: BotTeam.self)
        let sent = await workspace.postTeamMessage(selected, draft: BotTeamChannelPost(message: "Hello", requestId: "request_room", recipientIds: ["other_bot"]))
        XCTAssertFalse(sent)
        await workspace.refreshChannel("../other")
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }

    func testPairingRevokedDuringTeamMessageCannotPublishChannelOrNavigate() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { _ in self.channelSnapshot([]) }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshChannel("team_fixture")
        let held = fixture.hold("/v1/bots/teams/team_fixture/messages")
        let selected = try decode(team(enabled: true), as: BotTeam.self)
        let sending = Task { await workspace.postTeamMessage(selected, draft: BotTeamChannelPost(message: "Hello", requestId: "request_room")) }
        await fulfillment(of: [held.requested], timeout: 2)
        store.forgetMac(); held.finish(["channel": channelSnapshot([channelEntry(1)]), "run": runRecord()])
        let sent = await sending.value
        XCTAssertFalse(sent); XCTAssertTrue(workspace.channels["team_fixture"]?.messages.isEmpty == true)
        XCTAssertNil(store.currentConversation)
    }

    func testTeamCatalogAndCreationDoNotPromptAndOnlyExplicitTaskStartsTheSharedRun() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let savedTeam = team(), running = runRecord(), cancelled = runRecord(state: "cancelled")
        fixture.respond { request in
            switch request.url!.path {
            case "/v1/bots/teams": return request.httpMethod == "POST" ? ["team": savedTeam] : ["teams": [savedTeam], "runs": []]
            case "/v1/bots/teams/team_fixture/runs": return ["run": running]
            case "/v1/bots/activity": return ["activity": []]
            case "/v1/bots/teams/team_fixture/runs/run_fixture/stop": return ["run": cancelled]
            default: return nil
            }
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshTeams()
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        let created = await workspace.createTeam(BotTeamDraft(name: "Team", memberIds: ["bot_coder", "bot_reviewer"], coordinatorId: "bot_coder"))
        XCTAssertTrue(created)
        XCTAssertEqual(fixture.requests.first { $0.method == "POST" }?.jsonBody?["enabled"] as? Bool, false)
        XCTAssertFalse(fixture.requests.contains { $0.path.contains("/runs") })
        var enabled = try decode(savedTeam, as: BotTeam.self); enabled.enabled = true
        let started = await workspace.startTeam(enabled, message: "Review the fixture", requestId: "request_fixture")
        XCTAssertEqual(started?.rootChatId, "s_shared")
        let sent = try XCTUnwrap(fixture.requests.first { $0.path.hasSuffix("/runs") })
        XCTAssertEqual(sent.body, ["message": "Review the fixture", "requestId": "request_fixture"])
        await workspace.stopRun(try XCTUnwrap(started))
        XCTAssertEqual(fixture.requests.first { $0.path.hasSuffix("/stop") }?.body, [:])
        XCTAssertNil(store.currentConversation, "The workspace must not navigate the shared store on its own.")
        XCTAssertFalse(fixture.requests.contains { $0.path.contains("/serving") || $0.path.contains("/native") || $0.path == "/v1/chat" })
    }

    func testWorkspaceReadAndLateTaskResultCannotPublishAfterPairingIsForgotten() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        let held = fixture.hold("/v1/bots/teams")
        let reading = Task { await workspace.refreshTeams() }
        await fulfillment(of: [held.requested], timeout: 2)
        store.forgetMac(); held.finish(["teams": [team()], "runs": []]); await reading.value
        XCTAssertNil(workspace.teams)
        XCTAssertFalse(store.isPaired)

        let other = StoreTransport(); defer { other.close() }
        let otherStore = other.makeStore(), otherWorkspace = otherStore.botWorkspaceStore()
        let task = other.hold("/v1/bots/teams/team_fixture/runs"), selected = try decode(team(enabled: true), as: BotTeam.self)
        let sending = Task { await otherWorkspace.startTeam(selected, message: "Explicit task", requestId: "request_fixture") }
        await fulfillment(of: [task.requested], timeout: 2)
        otherStore.forgetMac(); task.finish(["run": runRecord()])
        let result = await sending.value
        XCTAssertNil(result); XCTAssertNil(otherWorkspace.teams); XCTAssertNil(otherStore.currentConversation)
    }

    func testNewerWorkspaceCatalogWinsOverAnOlderDelayedRead() async {
        let fixture = StoreTransport(); defer { fixture.close() }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        let first = fixture.hold("/v1/bots/teams"), readingFirst = Task { await workspace.refreshTeams() }
        await fulfillment(of: [first.requested], timeout: 2)
        let second = fixture.hold("/v1/bots/teams"), readingSecond = Task { await workspace.refreshTeams() }
        await fulfillment(of: [second.requested], timeout: 2)
        second.finish(["teams": [team(name: "Latest")], "runs": []]); await readingSecond.value
        first.finish(["teams": [team(name: "Stale")], "runs": []]); await readingFirst.value
        XCTAssertEqual(workspace.teams?.teams.first?.name, "Latest")
    }

    func testSkillEditReturnsToDraftAndAssignmentMergesOneToggleIntoFreshLibraryAssignments() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let draft = skill(), library = skill(id: "library.review", source: "library")
        fixture.respond { request in
            switch request.url!.path {
            case "/v1/bots/skills": return ["skills": [draft, library], "assignments": [["botId": "bot_coder", "skillIds": ["library.review"]]]]
            case "/v1/bots/skills/skill_fixture": return ["skill": draft]
            case "/v1/bots/skills/assign": return ["saved": true]
            default: return nil
            }
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        let parsed = try decode(draft, as: BotSkill.self)
        let saved = await workspace.saveSkill(BotSkillDraft(skill: parsed), reviewing: parsed)
        XCTAssertTrue(saved)
        XCTAssertEqual(fixture.requests.first { $0.method == "PATCH" }?.jsonBody?["status"] as? String, "draft")
        var beforeEnable = draft; beforeEnable["status"] = "draft"
        await workspace.assignSkill(try decode(beforeEnable, as: BotSkill.self), botId: "bot_coder", assigned: true)
        XCTAssertEqual(fixture.requests.first { $0.path.hasSuffix("/assign") }?.jsonBody?["skillIds"] as? [String], ["library.review", "skill_fixture"])
        XCTAssertEqual(workspace.skills?.skills.last?.revision.description, "library-dige")
        XCTAssertFalse(fixture.requests.contains { $0.path.contains("messages") || $0.path.contains("serving") })
    }

    func testMCPAccessRetainsOnlyAlreadyReviewedReadOnlyToolsWithoutSendingProgramsOrSecrets() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let value: [String: Any] = ["id": "mcpc_fixture", "name": "Tools", "transport": "stdio", "apiKeySet": true, "inventoryDigest": String(repeating: "a", count: 64), "botIds": ["bot_coder"], "enabledToolIds": ["tool_read", "tool_old"], "readOnlyToolIds": ["tool_read", "tool_old"], "status": "starting", "detail": "Checking", "checkedAt": "2026-10-20T22:00:00.000Z", "tools": [["id": "tool_read", "name": "Read", "description": "Read files", "readOnly": true], ["id": "tool_write", "name": "Write", "description": "Write files", "readOnly": false]]]
        fixture.respond { request in request.url!.path == "/v1/bots/connections" ? ["connections": [value]] : ["connection": value] }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(), connection = try decode(value, as: BotMCPConnection.self)
        XCTAssertEqual(connection.statusLabel, "Checking…"); XCTAssertNotNil(connection.checkedAt?.date)
        let saved = await workspace.saveConnection(connection, botIds: ["bot_reviewer"], toolIds: ["tool_read", "tool_write"])
        XCTAssertTrue(saved)
        let body = try XCTUnwrap(fixture.requests.first { $0.method == "PATCH" }?.jsonBody)
        XCTAssertEqual(Set(body.keys), ["botIds", "enabledToolIds", "readOnlyToolIds", "expectedInventoryDigest"])
        XCTAssertEqual(body["expectedInventoryDigest"] as? String, String(repeating: "a", count: 64))
        XCTAssertEqual(body["readOnlyToolIds"] as? [String], ["tool_read"])
        await workspace.checkConnection(connection)
        XCTAssertEqual(fixture.requests.first { $0.path.hasSuffix("/check") }?.body, [:])
    }

    func testUnsupportedWorkspaceUsesUpgradeReasonAndEffortComesOnlyFromExactDeclaredModel() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            if request.url!.path == "/v1/bots/teams" { return ["teams": [], "runs": [], "reason": "Update Strata on Mac"] }
            if request.url!.path == "/v1/bots/provider-models" { return ["provider": "codex", "models": [["id": "supported", "name": "Known", "efforts": ["low", "high"]]]] }
            return nil
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshTeams(); XCTAssertEqual(workspace.messages["teams"], "Update Strata on Mac")
        var bot = try decode(["id": "bot_coder", "name": "Coder", "provider": "codex", "model": "supported", "capabilities": "code", "policy": "manual", "execution": ["kind": "local"]], as: CompanionBot.self)
        let supported = await store.supportedBotEfforts(bot); XCTAssertEqual(supported, ["low", "high"])
        bot.model = "unknown"; let unknown = await store.supportedBotEfforts(bot); XCTAssertTrue(unknown.isEmpty)
        bot.provider = "configured"; let configured = await store.supportedBotEfforts(bot); XCTAssertTrue(configured.isEmpty)
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        let frozen = try decode(["id": "s_shared", "title": "Task", "active": false, "messages": [], "botEffort": "high", "teamId": "team_fixture", "teamRunId": "run_fixture", "parentChatId": "s_parent"], as: MacConversation.self)
        XCTAssertEqual(frozen.botEffort, "high"); XCTAssertEqual(frozen.teamRunId, "run_fixture"); XCTAssertEqual(frozen.parentChatId, "s_parent")
    }

    func testSkillEnableUsesReviewedVersionAndConflictRefreshesWithoutEnablingAgain() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let reviewed = try decode(skill(), as: BotSkill.self)
        var newer = skill(); newer["revision"] = 3; newer["digest"] = "changed-digest"; newer["body"] = "New unseen instructions"
        fixture.respond { request in request.url!.path == "/v1/bots/skills" ? ["skills": [newer], "assignments": []] : nil }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(), patch = fixture.hold("/v1/bots/skills/skill_fixture")
        let enabling = Task { await workspace.setSkillEnabled(reviewed, enabled: true) }
        await fulfillment(of: [patch.requested], timeout: 2)
        let proof = try XCTUnwrap(fixture.requests.first { $0.method == "PATCH" }?.jsonBody)
        XCTAssertEqual(proof["expectedRevision"] as? Int, 2); XCTAssertEqual(proof["expectedDigest"] as? String, "abc")
        patch.finish(["error": "This skill changed; review it again."], status: 409)
        await enabling.value
        XCTAssertEqual(workspace.skills?.skills.first?.digest, "changed-digest")
        XCTAssertNotNil(workspace.messages["skills"])
        XCTAssertEqual(fixture.requests.filter { $0.method == "PATCH" }.count, 1)
        XCTAssertTrue(store.isPaired)
    }

    func testMCPConflictRefreshesInventoryWithoutReplayingStaleAccess() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let old: [String: Any] = ["id": "mcpc_fixture", "name": "Tools", "transport": "stdio", "apiKeySet": false, "inventoryDigest": String(repeating: "a", count: 64), "botIds": [], "enabledToolIds": [], "readOnlyToolIds": [], "status": "connected", "detail": "Ready", "tools": []]
        var changed = old; changed["inventoryDigest"] = String(repeating: "b", count: 64)
        fixture.respond { request in request.url!.path == "/v1/bots/connections" ? ["connections": [changed]] : nil }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(), patch = fixture.hold("/v1/bots/connections/mcpc_fixture")
        let displayed = try decode(old, as: BotMCPConnection.self)
        let saving = Task { await workspace.saveConnection(displayed, botIds: ["bot_coder"], toolIds: []) }
        await fulfillment(of: [patch.requested], timeout: 2)
        patch.finish(["error": "Connection changed. Review its tools again."], status: 409)
        let saved = await saving.value
        XCTAssertFalse(saved); XCTAssertEqual(workspace.connections?.connections.first?.inventoryDigest, String(repeating: "b", count: 64))
        XCTAssertEqual(fixture.requests.filter { $0.method == "PATCH" }.count, 1)
        XCTAssertNotNil(workspace.messages["connections"]); XCTAssertTrue(store.isPaired)
    }

    func testEditedDraftAssignmentCanBeRevokedWithoutReenablingItsChangedInstructions() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        var changed = skill(); changed["status"] = "draft"; changed["digest"] = "new-unreviewed-digest"; changed["botIds"] = ["bot_coder"]
        let draft = changed, library = skill(id: "library.review", source: "library")
        fixture.respond { request in
            if request.url!.path == "/v1/bots/skills" { return ["skills": [draft, library], "assignments": [["botId": "bot_coder", "skillIds": ["skill_fixture", "library.review"]]]] }
            if request.url!.path.hasSuffix("/assign") { return ["saved": true] }
            return nil
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.assignSkill(try decode(draft, as: BotSkill.self), botId: "bot_coder", assigned: false)
        XCTAssertEqual(fixture.requests.first { $0.path.hasSuffix("/assign") }?.jsonBody?["skillIds"] as? [String], ["library.review"])
        XCTAssertFalse(fixture.requests.contains { $0.method == "PATCH" })
        XCTAssertTrue(store.isPaired)
    }
}


@MainActor
final class BotLifecycleTests: XCTestCase {
    private static var catalog: [String: Any] {
        ["lifecycleSupported": true, "selectionSupported": true, "defaultWorkspace": "/fixture", "bots": [bot],
         "providers": [["id": "codex", "name": "Codex", "available": true, "detail": "Ready"], ["id": "configured", "name": "Configured", "available": true, "detail": "Saved models"]],
         "computers": [["id": "local", "name": "Mac", "kind": "local", "available": true, "detail": "Ready"], ["id": "ssh_offline", "name": "Offline saved computer", "kind": "ssh", "available": false, "detail": "Set up on Mac"]],
         "models": [["id": "bm_saved", "name": "Saved model", "connectionName": "Separate API", "model": "provider/exact-model", "available": true]]]
    }
    private static var bot: [String: Any] {
        ["id": "bot_coder", "name": "Coder", "provider": "codex", "model": "", "computerId": "local", "workspace": "/fixture", "instructions": "Check the requested change.", "policy": "manual", "capabilities": "code", "computerMode": "host", "execution": ["kind": "local"], "updatedAt": "2026-10-21T00:00:00.000Z"]
    }
    private func decode<T: Decodable>(_ value: Any, as: T.Type) throws -> T { try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: value)) }
    private func draft() -> BotProfileDraft {
        var value = BotProfileDraft(); value.name = "Phone bot"; value.provider = "codex"; value.computerId = "local"; value.workspace = "/fixture"
        return value
    }
    private func saved(_ bot: [String: Any]) -> [String: Any] { var value = Self.catalog; value["bots"] = [bot]; value["bot"] = bot; return value }

    func testHostFolderRequestEncodesExplicitRevocationAndNoPrivateBindings() throws {
        let value = BotHostFolderUpdate(expectedUpdatedAt: "version", hostFolder: nil)
        let removed = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
        XCTAssertTrue(removed["hostFolder"] is NSNull)
        XCTAssertEqual(Set(removed.keys), ["expectedUpdatedAt", "hostFolder"])
        let grant = BotHostFolderUpdate(expectedUpdatedAt: "version", hostFolder: BotHostFolder(path: "/srv/project", access: "read"))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(grant)) as? [String: Any])
        XCTAssertEqual(body["hostFolder"] as? [String: String], ["path": "/srv/project", "access": "read"])
    }

    func testHostFolderSaveUsesExactBotAndPairingGenerationWithoutStartingWork() async throws {
        let transport = StoreTransport(); defer { transport.close() }
        var isolated = Self.bot; isolated["computerMode"] = "cua"; isolated["workspace"] = "/workspace"
        var catalog = Self.catalog; catalog["hostFolderSupported"] = true; catalog["bots"] = [isolated]
        var savedBot = isolated; savedBot["hostFolder"] = ["path": "/srv/👩‍💻 Project", "access": "read"]
        var result = catalog; result["bots"] = [savedBot]; result["bot"] = savedBot
        transport.respond { request in
            if request.url!.path == "/v1/bots/bot_coder/host-folder" { return result }
            return request.url!.path == "/v1/bots" ? catalog : nil
        }
        let store = transport.makeStore(); await store.refresh(); await store.refreshBots()
        let bot = try XCTUnwrap(store.botCatalog?.bots.first)
        let stale = await store.saveBotHostFolder(bot, folder: nil, expectedPairingGeneration: UUID()); XCTAssertFalse(stale)
        let saved = await store.saveBotHostFolder(bot, folder: BotHostFolder(path: "/srv/👩‍💻 Project", access: "read"), expectedPairingGeneration: store.pairingGeneration)
        XCTAssertTrue(saved); XCTAssertEqual(store.botCatalog?.bots.first?.hostFolder?.access, "read")
        let writes = transport.requests.filter { $0.method != "GET" }
        XCTAssertEqual(writes.count, 1); XCTAssertEqual(writes.first?.path, "/v1/bots/bot_coder/host-folder")
        XCTAssertEqual(writes.first?.method, "PUT"); XCTAssertNil(store.currentConversation)
        XCTAssertEqual((writes.first?.jsonBody?["hostFolder"] as? [String: String])?["path"], "/srv/👩‍💻 Project")
    }

    func testIdleDraftDefaultsToAskAndAcceptsSavedOfflineComputerWithoutExecutionOrCredentials() throws {
        let catalog = try decode(Self.catalog, as: CompanionBots.self)
        var value = draft(); value.computerId = "ssh_offline"; value.workspace = "/srv/project"
        let checked = try value.validated(in: catalog, original: nil)
        XCTAssertEqual(checked.policy, .manual)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(checked)) as? [String: Any])
        XCTAssertNil(json["expectedUpdatedAt"]); XCTAssertNil(json["execution"]); XCTAssertNil(json["providerSettings"]); XCTAssertNil(json["apiKey"])
        XCTAssertEqual(json["computerId"] as? String, "ssh_offline")
    }

    func testConfiguredDraftSendsExactSavedModelIdentity() throws {
        var value = draft(); value.provider = "configured"; value.modelId = "bm_saved"; value.model = "old native model"; value.effort = "high"
        let checked = try value.validated(in: decode(Self.catalog, as: CompanionBots.self), original: nil)
        XCTAssertEqual(checked.model, "provider/exact-model"); XCTAssertEqual(checked.modelId, "bm_saved"); XCTAssertNil(checked.effort)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(checked)) as? [String: Any])
        XCTAssertEqual(json["model"] as? String, "provider/exact-model"); XCTAssertNil(json["modelSource"])
    }

    func testProfileCannotSaveUnsupportedGeometryAndPreservesExactCapableShape() throws {
        var value = draft(); value.avatarConfig.shape = .diamond
        var catalog = try decode(Self.catalog, as: CompanionBots.self)
        XCTAssertThrowsError(try value.validated(in: catalog, original: nil))
        catalog.avatarShapes = ["diamond", "future-shape"]
        let checked = try value.validated(in: catalog, original: nil)
        XCTAssertEqual(checked.avatarConfig.shape, .diamond); XCTAssertEqual(checked.policy, .manual)
        XCTAssertEqual(checked.computerId, "local")
        value.avatarConfig.shape = .classic; catalog.avatarShapes = nil
        XCTAssertNil(try value.validated(in: catalog, original: nil).avatarConfig.shape)
    }

    func testMissingSavedSelectionsAndOlderMacCannotSaveDraft() throws {
        var value = draft(); let catalog = try decode(Self.catalog, as: CompanionBots.self)
        value.computerId = "removed"; XCTAssertThrowsError(try value.validated(in: catalog, original: nil))
        value.computerId = "local"; value.provider = "configured"; value.modelId = "removed"; XCTAssertThrowsError(try value.validated(in: catalog, original: nil))
        var old = catalog; old.lifecycleSupported = nil; value = draft(); XCTAssertThrowsError(try value.validated(in: old, original: nil))
        value.computerMode = "cua"; XCTAssertThrowsError(try value.validated(in: catalog, original: nil)); value.workspace = "/workspace"; XCTAssertNoThrow(try value.validated(in: catalog, original: nil))
    }

    func testDevinCatalogModelsUseHostChoicesAndDoNotInventEffort() async throws {
        let transport = StoreTransport(); defer { transport.close() }
        var catalog = Self.catalog
        catalog["providers"] = [["id": "devin", "name": "Devin CLI", "available": true, "detail": "Ready"]]
        transport.respond { request in
            if request.url!.path == "/v1/bots" { return catalog }
            if request.url!.path == "/v1/bots/provider-models" {
                XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems, [URLQueryItem(name: "provider", value: "devin")])
                return ["provider": "devin", "models": [["id": "fixture-devin-model", "name": "Host's Devin model", "efforts": []]]]
            }
            return nil
        }
        let store = transport.makeStore(); await store.refreshBots()
        XCTAssertEqual(store.botCatalog?.providers.map(\.id), ["devin"])
        XCTAssertEqual(store.botCatalog?.providers.first?.name, "Devin CLI")
        let loaded = await store.botModels(provider: "devin")
        let choices = try XCTUnwrap(loaded)
        XCTAssertEqual(choices.provider, "devin"); XCTAssertEqual(choices.models.map(\.id), ["fixture-devin-model"])
        var bot = try decode(Self.bot, as: CompanionBot.self); bot.provider = "devin"; bot.model = "fixture-devin-model"
        let efforts = await store.supportedBotEfforts(bot); XCTAssertTrue(efforts.isEmpty)
        let before = transport.requests.count
        let unsupported = await store.botModels(provider: "not-a-provider"); XCTAssertNil(unsupported)
        XCTAssertEqual(transport.requests.count, before, "Unknown providers never reach the paired host.")
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testDevinProfileSavesSelectedModelWithoutStartingAConversationOrProvider() async throws {
        let transport = StoreTransport(); defer { transport.close() }
        var catalog = Self.catalog
        catalog["providers"] = [["id": "devin", "name": "Devin CLI", "available": true, "detail": "Ready"]]
        var created = Self.bot; created["id"] = "bot_devin"; created["provider"] = "devin"; created["model"] = "fixture-devin-model"
        var saved = catalog; saved["bot"] = created; saved["bots"] = [created]
        transport.respond { request in request.url!.path == "/v1/bots" ? (request.httpMethod == "POST" ? saved : catalog) : nil }
        let store = transport.makeStore(); await store.refresh(); await store.refreshBots()
        var value = draft(); value.provider = "devin"; value.model = "fixture-devin-model"; value.modelId = "old-configured-selection"
        let result = await store.saveBotProfile(value, original: nil, expectedPairingGeneration: store.pairingGeneration)
        XCTAssertEqual(result?.provider, "devin"); XCTAssertEqual(result?.model, "fixture-devin-model")
        let writes = transport.requests.filter { $0.method != "GET" }
        XCTAssertEqual(writes.map(\.path), ["/v1/bots"])
        let body = try XCTUnwrap(writes.first?.jsonBody)
        XCTAssertEqual(body["provider"] as? String, "devin"); XCTAssertEqual(body["model"] as? String, "fixture-devin-model")
        XCTAssertEqual(body["policy"] as? String, "manual"); XCTAssertNil(body["effort"]); XCTAssertNil(body["modelId"])
        XCTAssertNil(body["apiKey"]); XCTAssertNil(body["execution"])
        XCTAssertNil(store.currentConversation)
    }

    func testCreateProfileUsesOnlyManagementEndpointAndLeavesSelectedHistoryUntouched() async throws {
        let transport = StoreTransport(); defer { transport.close() }
        var created = Self.bot; created["id"] = "bot_new"; created["name"] = "Phone bot"
        transport.respond { request in request.url!.path == "/v1/bots" ? (request.httpMethod == "POST" ? self.saved(created) : Self.catalog) : nil }
        let store = transport.makeStore(); await store.refresh(); await store.refreshBots()
        let result = await store.saveBotProfile(draft(), original: nil, expectedPairingGeneration: store.pairingGeneration)
        XCTAssertEqual(result?.id, "bot_new"); XCTAssertEqual(store.botCatalog?.bots.first?.id, "bot_new"); XCTAssertNil(store.currentConversation)
        XCTAssertEqual(transport.requests.filter { $0.method != "GET" }.map(\.path), ["/v1/bots"])
        XCTAssertEqual(transport.requests.last?.jsonBody?["policy"] as? String, "manual")
    }

    func testStaleCatalogCannotReplaceSuccessfulProfileSave() async throws {
        let transport = StoreTransport(); defer { transport.close() }
        var created = Self.bot; created["name"] = "New result"
        transport.respond { request in request.url!.path == "/v1/bots" ? (request.httpMethod == "POST" ? self.saved(created) : Self.catalog) : nil }
        let store = transport.makeStore(); await store.refresh(); await store.refreshBots()
        let pending = transport.hold("/v1/bots"), read = Task { await store.refreshBots() }
        await fulfillment(of: [pending.requested], timeout: 2); transport.release("/v1/bots")
        let result = await store.saveBotProfile(draft(), original: nil, expectedPairingGeneration: store.pairingGeneration); XCTAssertNotNil(result)
        pending.finish(Self.catalog); await read.value
        XCTAssertEqual(store.botCatalog?.bots.first?.name, "New result")
    }

    func testStaleEditSendsOriginalVersionOnceAndRetainsDraftForExplicitReload() async throws {
        let transport = StoreTransport(); defer { transport.close() }
        transport.respond { request in request.url!.path == "/v1/bots" ? Self.catalog : nil }
        let store = transport.makeStore(); await store.refresh(); await store.refreshBots()
        let original = try XCTUnwrap(store.botCatalog?.bots.first); var value = BotProfileDraft(bot: original); value.policy = .bypass
        let pending = transport.hold("/v1/bots/bot_coder"), save = Task { await store.saveBotProfile(value, original: original, expectedPairingGeneration: store.pairingGeneration) }
        await fulfillment(of: [pending.requested], timeout: 2)
        pending.finish(["error": "Profile changed. Refresh and review."], status: 409)
        let result = await save.value; XCTAssertNil(result)
        let writes = transport.requests.filter { $0.method == "PATCH" }
        XCTAssertEqual(writes.count, 1); XCTAssertEqual(writes[0].jsonBody?["expectedUpdatedAt"] as? String, original.updatedAt)
        XCTAssertEqual(store.botCatalog?.bots.first?.policy, "manual"); XCTAssertNotNil(store.botProfileError)
        XCTAssertFalse(transport.requests.contains { $0.path.contains("approve") || $0.path.contains("messages") })
        var fresh = Self.bot; fresh["provider"] = "configured"; fresh["modelId"] = "bm_saved"; fresh["model"] = "provider/exact-model"; fresh["effort"] = "high"
        let restored = BotProfileDraft(bot: try decode(fresh, as: CompanionBot.self))
        XCTAssertEqual(restored.modelId, "bm_saved"); XCTAssertEqual(restored.model, "provider/exact-model"); XCTAssertEqual(restored.effort, "high")
    }

    func testNewConversationPolicyOverrideIsExplicitAndOldHostNeverReceivesIt() async throws {
        let transport = StoreTransport(); defer { transport.close() }
        var response = StoreTransport.detail(active: false); var chat = response["conversation"] as! [String: Any]; chat["mode"] = "bypass"; response["conversation"] = chat
        transport.respond { request in request.url!.path == "/v1/bots" ? Self.catalog : request.url!.path.hasSuffix("/conversations") && request.httpMethod == "POST" ? response : nil }
        let store = transport.makeStore(); await store.refresh(); await store.refreshBots(); let bot = try XCTUnwrap(store.botCatalog?.bots.first)
        let created = await store.newBotConversation(bot, policy: .bypass); XCTAssertTrue(created)
        XCTAssertEqual(transport.requests.first { $0.method == "POST" }?.body, ["policy": "bypass"]); XCTAssertEqual(store.currentConversation?.mode, "bypass")
        var old = Self.catalog; old["lifecycleSupported"] = false
        transport.respond { request in request.url!.path == "/v1/bots" ? old : nil }; await store.refreshBots()
        let count = transport.requests.filter { $0.method == "POST" }.count
        let denied = await store.newBotConversation(bot, policy: .plan); XCTAssertFalse(denied)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, count)
    }

    func testProfileMutationCannotBeForgottenWhilePending() async throws {
        let transport = StoreTransport(); defer { transport.close() }
        transport.respond { request in request.url!.path == "/v1/bots" ? Self.catalog : nil }
        let store = transport.makeStore(); await store.refresh(); await store.refreshBots(); let pending = transport.hold("/v1/bots")
        let save = Task { await store.saveBotProfile(self.draft(), original: nil, expectedPairingGeneration: store.pairingGeneration) }; await fulfillment(of: [pending.requested], timeout: 2)
        store.forgetMac(); XCTAssertTrue(store.isPaired); XCTAssertEqual(transport.deletedConnections, 0)
        pending.finish(saved(Self.bot)); _ = await save.value; XCTAssertFalse(store.savingBotProfile)
    }

    func testQueuedOldPairDraftCannotPostToNewPairWithMatchingCatalogIDs() async throws {
        let oldTransport = StoreTransport(), newTransport = StoreTransport()
        defer { oldTransport.close(); newTransport.close() }
        let oldStore = oldTransport.makeStore(), capturedPairing = oldStore.pairingGeneration
        newTransport.respond { request in request.url!.path == "/v1/bots" ? Self.catalog : nil }
        let newStore = newTransport.makeStore(); await newStore.refresh(); await newStore.refreshBots()
        let queuedDraft = draft()
        let queued = Task { await newStore.saveBotProfile(queuedDraft, original: nil, expectedPairingGeneration: capturedPairing) }
        let result = await queued.value
        XCTAssertNil(result)
        XCTAssertTrue(newStore.isPaired); XCTAssertNotEqual(newStore.pairingGeneration, capturedPairing)
        XCTAssertFalse(newTransport.requests.contains { $0.method != "GET" })
    }

    func testFailedFreshCatalogReadDoesNotReportReloadSuccessOrReplaceSnapshot() async throws {
        let transport = StoreTransport(); defer { transport.close() }
        transport.respond { request in request.url!.path == "/v1/bots" ? Self.catalog : nil }
        let store = transport.makeStore(); await store.refresh(); await store.refreshBots()
        let previous = store.botCatalog, pending = transport.hold("/v1/bots")
        let refreshing = Task { await store.refreshBots() }
        await fulfillment(of: [pending.requested], timeout: 2)
        pending.finish(["error": "Fixture offline"], status: 503)
        let refreshed = await refreshing.value
        XCTAssertFalse(refreshed); XCTAssertEqual(store.botCatalog, previous)
        XCTAssertFalse(store.botsMessage?.isEmpty ?? true)
    }

    func testAvatarStatesUseConversationApprovalAndResultsNotComputerPower() throws {
        var value = StoreTransport.detail(active: true, toolState: "proposed")
        let chat = try decode(value["conversation"]!, as: MacConversation.self), pending = try decode(value["pending"]!, as: [MacToolActivity].self)
        XCTAssertEqual(BotAvatarState.mood(conversation: chat, pending: pending), .needsApproval)
        XCTAssertEqual(BotAvatarState.mood(conversation: chat, pending: [], paused: true), .paused)
        value = StoreTransport.detail(active: true, toolState: "running")
        XCTAssertEqual(BotAvatarState.mood(conversation: try decode(value["conversation"]!, as: MacConversation.self), pending: []), .working)
        value = StoreTransport.detail(active: true); var raw = value["conversation"] as! [String: Any]; raw["messages"] = [["id": "reply", "role": "assistant", "content": "", "reasoning": "Checking", "streaming": true]]
        XCTAssertEqual(BotAvatarState.mood(conversation: try decode(raw, as: MacConversation.self), pending: []), .thinking)
        raw["active"] = false; raw["messages"] = [["id": "reply", "role": "assistant", "content": "Ready"]]
        XCTAssertEqual(BotAvatarState.mood(conversation: try decode(raw, as: MacConversation.self), pending: []), .done)
        raw["messages"] = [["id": "reply", "role": "assistant", "content": "", "error": "Failed"]]
        XCTAssertEqual(BotAvatarState.mood(conversation: try decode(raw, as: MacConversation.self), pending: []), .error)
        XCTAssertEqual(BotAvatarState.mood(conversation: nil, pending: []), .idle)
    }

    func testDisabledMotionIsStaticAndArrivalDoesNotFlourishForEveryToken() throws {
        for mood in BotMood.allCases {
            XCTAssertEqual(AvatarMotionSample.sample(mood: mood, time: 123.4, enabled: false), AvatarMotionSample())
        }
        XCTAssertFalse(KoalaAvatar(AvatarConfig()).animated, "Roster defaults use no frame clock.")
        XCTAssertNotEqual(AvatarMotionSample.sample(mood: .working, time: 1, enabled: true), AvatarMotionSample())
        var first = StoreTransport.detail(active: true)["conversation"] as! [String: Any]
        first["messages"] = [["id": "reply", "role": "assistant", "content": "A", "streaming": true]]
        let a = BotAvatarState.flourish(conversation: try decode(first, as: MacConversation.self))
        first["messages"] = [["id": "reply", "role": "assistant", "content": "AB", "streaming": true]]
        XCTAssertEqual(a, BotAvatarState.flourish(conversation: try decode(first, as: MacConversation.self)))
        first["active"] = false; first["messages"] = [["id": "reply", "role": "assistant", "content": "AB", "streaming": false]]
        XCTAssertNotEqual(a, BotAvatarState.flourish(conversation: try decode(first, as: MacConversation.self)))
    }
}


@MainActor
final class BotConnectorTests: XCTestCase {
    private let features: [String: Any] = ["catalog": true, "httpCreation": true, "teamAccess": true, "oauth": true]
    private func connector() -> [String: Any] {
        ["id": "mcpc_fixture", "name": "Project service", "transport": "http", "url": "https://example.invalid/mcp", "accountLabel": "Work", "authType": "bearer", "apiKeySet": true, "inventoryDigest": String(repeating: "a", count: 64), "botIds": ["bot_coder"], "teamIds": ["team_project"], "customInstructions": "Keep changes in this project.", "enabled": true, "enabledToolIds": ["tool_read"], "readOnlyToolIds": ["tool_read"], "status": "connected", "detail": "Ready", "tools": [["id": "tool_read", "name": "Read", "description": "Read", "readOnly": true], ["id": "tool_write", "name": "Write", "description": "Write", "readOnly": false]]]
    }
    private func decode<T: Decodable>(_ value: Any, as: T.Type) throws -> T { try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: value)) }

    func testConnectorDraftIsHTTPOnlyAndRetainsNoImplicitAccessOrProgramConfiguration() throws {
        var draft = BotConnectorDraft(); draft.name = "Work service"; draft.url = "https://example.invalid/mcp"; draft.authType = "bearer"; draft.apiKey = "synthetic-only"
        XCTAssertTrue(draft.isValid)
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as? [String: Any])
        XCTAssertEqual(Set(encoded.keys), ["name", "transport", "url", "accountLabel", "authType", "apiKey"])
        for invalid in ["https://user:secret@example.invalid/mcp", "https://example.invalid/mcp?key=x", "http://remote.invalid/mcp", "file:///tmp/program"] { draft.url = invalid; XCTAssertFalse(draft.isValid) }
        draft.url = "https://example.invalid/mcp"; draft.transport = "stdio"; XCTAssertFalse(draft.isValid)
        XCTAssertNil(BotConnectorDraft.authorizationURL("javascript:alert(1)")); XCTAssertNil(BotConnectorDraft.authorizationURL("https://user:secret@example.invalid/authorize"))
        XCTAssertNotNil(BotConnectorDraft.authorizationURL("https://example.invalid/authorize?state=synthetic"))
    }

    func testPhoneConnectorCreationNeedsCapabilityAndSendsOnlyHTTPSetup() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let row = connector(), flags = features
        var capable = false
        fixture.respond { request in
            if request.httpMethod == "POST" { return ["connection": row] }
            if request.url!.path == "/v1/bots/connections" { return ["connections": [row], "connectorFeatures": capable ? flags : [:]] }
            return nil
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        var draft = BotConnectorDraft(); draft.name = "Project service"; draft.url = "https://example.invalid/mcp"; draft.authType = "bearer"; draft.apiKey = "synthetic-only"
        await workspace.refreshConnections()
        let refused = await workspace.saveConnectorSetup(draft); XCTAssertFalse(refused); XCTAssertFalse(fixture.requests.contains { $0.method == "POST" })
        capable = true; await workspace.refreshConnections()
        let saved = await workspace.saveConnectorSetup(draft); XCTAssertTrue(saved)
        let body = try XCTUnwrap(fixture.requests.first { $0.method == "POST" }?.jsonBody)
        XCTAssertEqual(body["transport"] as? String, "http"); XCTAssertNil(body["teamIds"]); XCTAssertNil(body["command"]); XCTAssertNil(body["env"])
        XCTAssertEqual(workspace.connections?.connections.first?.accountLabel, "Work")
        XCTAssertTrue(fixture.requests.allSatisfy { $0.path == "/v1/bots/connections" })
    }

    func testPhoneEditingKeepsSavedKeyAndGrantsOutOfSetupRequest() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let row = connector(), flags = features
        fixture.respond { request in request.httpMethod == "PATCH" ? ["connection": row] : ["connections": [row], "connectorFeatures": flags] }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshConnections()
        let original = try decode(row, as: BotMCPConnection.self)
        var draft = BotConnectorDraft(connection: original); draft.name = "Renamed service"
        let saved = await workspace.saveConnectorSetup(draft, editing: original); XCTAssertTrue(saved)
        let body = try XCTUnwrap(fixture.requests.first { $0.method == "PATCH" }?.jsonBody)
        XCTAssertEqual(body["name"] as? String, "Renamed service"); XCTAssertEqual(body["authType"] as? String, "bearer"); XCTAssertEqual(body["expectedInventoryDigest"] as? String, original.inventoryDigest)
        for omitted in ["apiKey", "clearKey", "botIds", "teamIds", "enabledToolIds", "command", "env", "oauthClientId", "oauthClientSecret"] { XCTAssertNil(body[omitted]) }
    }

    func testConnectorRemovalOmitsDELETEBodyAndUsesBridgeDeletedProjection() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let row = connector(), flags = features
        fixture.respond { request in request.httpMethod == "DELETE" ? ["deleted": true] : ["connections": [row], "connectorFeatures": flags] }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshConnections()
        let original = try decode(row, as: BotMCPConnection.self)
        let removed = await workspace.removeConnector(original); XCTAssertTrue(removed)
        let request = try XCTUnwrap(fixture.requests.first { $0.method == "DELETE" })
        XCTAssertEqual(request.path, "/v1/bots/connections/mcpc_fixture"); XCTAssertNil(request.jsonBody)
    }

    func testSavedLongConnectorInstructionsAllowAccessAndUseEightThousandUTF16Limit() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        var value = connector(); value["customInstructions"] = String(repeating: "x", count: 5000)
        let row = value, flags = features
        fixture.respond { request in request.httpMethod == "PATCH" ? ["connection": row] : ["connections": [row], "connectorFeatures": flags] }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshConnections()
        let original = try decode(row, as: BotMCPConnection.self)
        let retained = await workspace.saveConnection(original, botIds: ["bot_coder"], toolIds: ["tool_read"], teamIds: ["team_project"], instructions: original.customInstructions)
        XCTAssertTrue(retained, "Existing long instructions must not block an access grant.")
        let boundary = await workspace.saveConnection(original, botIds: [], toolIds: [], teamIds: [], instructions: String(repeating: "x", count: 8000)); XCTAssertTrue(boundary)
        let tooLong = await workspace.saveConnection(original, botIds: [], toolIds: [], teamIds: [], instructions: String(repeating: "x", count: 8001)); XCTAssertFalse(tooLong)
        let patches = fixture.requests.filter { $0.method == "PATCH" }
        XCTAssertEqual(patches.count, 2); XCTAssertEqual(patches.compactMap { ($0.jsonBody?["customInstructions"] as? String)?.utf16.count }, [5000, 8000])
    }

    func testStaleConnectorSetupUsesCapturedInventoryAndDoesNotReplayOverNewSetup() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let old = connector(), flags = features
        var changed = old; changed["inventoryDigest"] = String(repeating: "b", count: 64); changed["url"] = "https://new.fixture.invalid/mcp"
        let latest = changed
        fixture.respond { request in request.url!.path == "/v1/bots/connections" ? ["connections": [latest], "connectorFeatures": flags] : nil }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshConnections()
        let captured = try decode(old, as: BotMCPConnection.self)
        var draft = BotConnectorDraft(connection: captured); draft.name = "Unsaved phone draft"
        let patch = fixture.hold("/v1/bots/connections/mcpc_fixture")
        let saving = Task { await workspace.saveConnectorSetup(draft, editing: captured) }
        await fulfillment(of: [patch.requested], timeout: 2)
        let body = try XCTUnwrap(fixture.requests.first { $0.method == "PATCH" }?.jsonBody)
        XCTAssertEqual(body["expectedInventoryDigest"] as? String, String(repeating: "a", count: 64)); XCTAssertEqual(body["url"] as? String, "https://example.invalid/mcp")
        patch.finish(["error": "The connector changed. Review the current setup."], status: 409)
        let saved = await saving.value; XCTAssertFalse(saved)
        XCTAssertEqual(workspace.connections?.connections.first?.url, "https://new.fixture.invalid/mcp")
        XCTAssertEqual(draft.name, "Unsaved phone draft"); XCTAssertEqual(fixture.requests.filter { $0.method == "PATCH" }.count, 1)
        XCTAssertNotNil(workspace.messages["connections"])
    }

    func testConnectorTeamGrantsUseInventoryCASAndNeverSendSecrets() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let row = connector(), flags = features
        fixture.respond { request in request.httpMethod == "PATCH" ? ["connection": row] : ["connections": [row], "connectorFeatures": flags] }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshConnections()
        let connection = try decode(row, as: BotMCPConnection.self)
        let saved = await workspace.saveConnection(connection, botIds: ["bot_coder"], toolIds: ["tool_read", "tool_write"], teamIds: ["team_project"], instructions: "Use this work account.")
        XCTAssertTrue(saved)
        let body = try XCTUnwrap(fixture.requests.first { $0.method == "PATCH" }?.jsonBody)
        XCTAssertEqual(Set(body.keys), ["botIds", "teamIds", "enabledToolIds", "readOnlyToolIds", "customInstructions", "expectedInventoryDigest"])
        XCTAssertEqual(body["expectedInventoryDigest"] as? String, String(repeating: "a", count: 64)); XCTAssertEqual(body["readOnlyToolIds"] as? [String], ["tool_read"])
        XCTAssertEqual(body["teamIds"] as? [String], ["team_project"]); XCTAssertNil(body["apiKey"])
        XCTAssertFalse(fixture.requests.contains { $0.path.contains("messages") || $0.path.contains("serving") })
    }

    func testConnectorAuthUsesExplicitScopedActionsAndRejectsProgramSetupOnPhone() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        var value = connector(); value["authType"] = "oauth"; value["auth"] = ["status": "waiting", "detail": "Finish on Mac", "authorizationURL": "https://example.invalid/authorize"]
        let row = value, flags = features
        fixture.respond { request in request.url!.path.hasSuffix("/auth") ? ["connection": row] : ["connections": [row], "connectorFeatures": flags] }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshConnections()
        let connection = try decode(row, as: BotMCPConnection.self)
        let started = await workspace.connectorAuthentication(connection, action: "start"); XCTAssertTrue(started)
        let polled = await workspace.connectorAuthentication(connection, action: "poll"); XCTAssertTrue(polled)
        let disconnected = await workspace.connectorAuthentication(connection, action: "disconnect"); XCTAssertTrue(disconnected)
        XCTAssertEqual(fixture.requests.filter { $0.path.hasSuffix("/auth") }.map(\.method), ["POST", "GET", "DELETE"])
        var program = connection; program.transport = "stdio"
        var draft = BotConnectorDraft(); draft.name = "Program"; draft.url = "https://example.invalid/mcp"
        let refused = await workspace.saveConnectorSetup(draft, editing: program); XCTAssertFalse(refused)
        XCTAssertFalse(fixture.requests.contains { $0.method == "PATCH" })
    }

    func testDiscoverPresetActionsNameAccountsAndKeepBearerServicesHonest() throws {
        let oauth = try decode(["id": "linear", "name": "Linear", "description": "Projects", "category": "Projects", "transport": "http", "url": "https://mcp.linear.app/mcp", "authTypes": ["oauth", "bearer"]], as: BotConnectorCatalogEntry.self)
        var bearer = oauth; bearer.id = "github"; bearer.name = "GitHub"; bearer.authTypes = ["bearer"]
        XCTAssertTrue(oauth.supportsSignIn); XCTAssertEqual(oauth.accountAction, "Connect")
        XCTAssertFalse(bearer.supportsSignIn); XCTAssertEqual(bearer.accountAction, "Add account")
        var first = try decode(connector(), as: BotMCPConnection.self); first.catalogId = "linear"; first.accountLabel = "PERSONAL"
        var second = first; second.id = "mcpc_second"; second.accountLabel = "Personal 2"
        XCTAssertEqual(oauth.nextAccountLabel(in: [first, second]), "Personal 3")
        XCTAssertEqual(bearer.nextAccountLabel(in: [first, second]), "Personal")
        var custom = oauth; custom.id = "custom-http"; XCTAssertFalse(custom.supportsSignIn)
    }

    func testDiscoverCreationReturnsExactAccountAndDoesNotStartAuthOrGrantAccess() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let flags = features
        let preset: [String: Any] = ["id": "linear", "name": "Linear", "description": "Projects", "category": "Projects", "transport": "http", "url": "https://mcp.linear.app/mcp", "authTypes": ["oauth", "bearer"]]
        var old = connector(); old["catalogId"] = "linear"; old["accountLabel"] = "Personal"
        var inserted = connector(); inserted["id"] = "mcpc_new_account"; inserted["catalogId"] = "linear"; inserted["accountLabel"] = "Personal 2"; inserted["authType"] = "oauth"
        let oldRow = old, newRow = inserted
        fixture.respond { request in
            if request.httpMethod == "POST" { return ["connection": newRow] }
            if request.url!.path.hasSuffix("/catalog") { return ["connectors": [preset], "connectorFeatures": flags] }
            return ["connections": [oldRow], "connectorFeatures": flags]
        }
        let owner = fixture.makeStore(), current = owner.botWorkspaceStore()
        await current.refreshConnections(); await current.refreshConnectorCatalog()
        let entry = try XCTUnwrap(current.connectorCatalog?.connectors.first)
        let result = await current.createConnectorAccount(entry)
        XCTAssertEqual(result?.id, "mcpc_new_account")
        let posts = fixture.requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts.count, 1); XCTAssertEqual(posts.first?.path, "/v1/bots/connections")
        let body = try XCTUnwrap(posts.first?.jsonBody)
        XCTAssertEqual(body["accountLabel"] as? String, "Personal 2"); XCTAssertEqual(body["authType"] as? String, "oauth")
        for absent in ["botIds", "teamIds", "enabledToolIds", "apiKey", "oauthClientId", "oauthClientSecret", "callbackTarget"] { XCTAssertNil(body[absent]) }
        var stale = entry; stale.url = "https://untrusted.fixture.invalid/mcp"
        let refused = await current.createConnectorAccount(stale); XCTAssertNil(refused)
        XCTAssertEqual(fixture.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testNativeAuthorizationRequiresExactTargetSingleStateAndHTTPS() throws {
        let state = String(repeating: "a", count: 64)
        var auth = BotConnectorAuth(status: "waiting", detail: "Sign in", authorizationURL: "https://auth.fixture.invalid/authorize?state=\(state)&redirect_uri=strata%3A%2F%2Fconnector-oauth%2Fcallback", callbackTarget: "iphone", redirectURL: BotConnectorOAuthRequest.redirect)
        let request = try XCTUnwrap(BotConnectorOAuthRequest(auth: auth))
        XCTAssertNotNil(request.validatedCallback(try XCTUnwrap(URL(string: "strata://connector-oauth/callback?state=\(state)&code=synthetic"))))
        for callback in ["strata://connector-oauth/callback?state=wrong&code=x", "strata://connector-oauth/callback?state=\(state)&state=\(state)&code=x", "strata://connector-oauth/other?state=\(state)", "strata://connector-oauth:443/callback?state=\(state)", "strata://user@connector-oauth/callback?state=\(state)", "strata://connector-oauth/callback?state=\(state)#fragment", "https://connector-oauth/callback?state=\(state)"] {
            XCTAssertNil(request.validatedCallback(try XCTUnwrap(URL(string: callback))), callback)
        }
        auth.redirectURL = "strata://connector-oauth/other"; XCTAssertNil(BotConnectorOAuthRequest(auth: auth))
        auth.redirectURL = BotConnectorOAuthRequest.redirect; auth.callbackTarget = "mac"; XCTAssertNil(BotConnectorOAuthRequest(auth: auth))
        auth.callbackTarget = "iphone"
        for invalidState in ["", String(repeating: "a", count: 63), String(repeating: "a", count: 65), String(repeating: "A", count: 64), String(repeating: "g", count: 64)] {
            var address = URLComponents(string: "https://auth.fixture.invalid/authorize")!
            address.queryItems = [URLQueryItem(name: "state", value: invalidState), URLQueryItem(name: "redirect_uri", value: BotConnectorOAuthRequest.redirect)]
            auth.authorizationURL = address.string
            XCTAssertNil(BotConnectorOAuthRequest(auth: auth))
        }
        for address in ["http://auth.fixture.invalid/authorize?state=x", "https://user:secret@auth.fixture.invalid/authorize?state=x", "https://auth.fixture.invalid/authorize?state=x&state=x", "https://auth.fixture.invalid/authorize?state=", "https://auth.fixture.invalid/authorize?state=x&redirect_uri=strata%3A%2F%2Fwrong%2Fcallback"] {
            auth.authorizationURL = address; XCTAssertNil(BotConnectorOAuthRequest(auth: auth))
        }
    }

    func testNativeStartIsCapabilityGatedCancelIsScopedAndMacFallbackUsesNoNativeTarget() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        var row = connector(); row["authType"] = "oauth"
        let account = row, flags = features
        var native = false
        fixture.respond { request in
            if request.httpMethod == "POST" { return ["connection": account] }
            return ["connections": [account], "connectorFeatures": flags.merging(["iphoneOAuth": native]) { _, new in new }]
        }
        let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore()
        await workspace.refreshConnections()
        let connection = try decode(account, as: BotMCPConnection.self)
        let refused = await workspace.connectorAuthentication(connection, action: "start", callbackTarget: "iphone"); XCTAssertFalse(refused)
        XCTAssertFalse(fixture.requests.contains { $0.method == "POST" })
        native = true; await workspace.refreshConnections()
        let started = await workspace.connectorAuthentication(connection, action: "start", callbackTarget: "iphone"); XCTAssertTrue(started)
        let missingState = await workspace.connectorAuthentication(connection, action: "cancel"); XCTAssertFalse(missingState)
        let cancelled = await workspace.connectorAuthentication(connection, action: "cancel", expectedState: String(repeating: "a", count: 64)); XCTAssertTrue(cancelled)
        let mac = await workspace.connectorAuthentication(connection, action: "start"); XCTAssertTrue(mac)
        let posts = fixture.requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts.map(\.path), ["/v1/bots/connections/mcpc_fixture/auth", "/v1/bots/connections/mcpc_fixture/auth/cancel", "/v1/bots/connections/mcpc_fixture/auth"])
        XCTAssertEqual(posts.first?.jsonBody?["callbackTarget"] as? String, "iphone")
        XCTAssertEqual(posts[1].jsonBody?["expectedState"] as? String, String(repeating: "a", count: 64)); XCTAssertEqual(posts[2].jsonBody?.count, 0)
        XCTAssertFalse(fixture.requests.contains { $0.method == "DELETE" })
    }

    func testReplacedPairingCannotReturnLateCreatedAccountOrCompleteAuthorization() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let row = connector(), flags = features
        fixture.respond { _ in ["connections": [row], "connectorFeatures": flags] }
        let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore()
        await workspace.refreshConnections()
        var draft = BotConnectorDraft(); draft.name = "Late account"; draft.url = "https://example.invalid/mcp"
        let held = fixture.hold("/v1/bots/connections")
        let creation = Task { await workspace.saveConnectorAccountSetup(draft) }
        await fulfillment(of: [held.requested], timeout: 2)
        owner.forgetMac(); XCTAssertFalse(owner.isPaired)
        held.finish(["connection": row])
        let result = await creation.value; XCTAssertNil(result)
        var oauth = try decode(row, as: BotMCPConnection.self); oauth.authType = "oauth"
        let completed = await workspace.connectorAuthentication(oauth, action: "complete", callbackURL: "strata://connector-oauth/callback?state=synthetic&code=synthetic")
        XCTAssertFalse(completed)
        XCTAssertFalse(fixture.requests.contains { $0.path.hasSuffix("/auth/complete") })
    }


    func testSignInAttemptRemainsLockedAfterBrowserClosesUntilHostCompletionFinishes() throws {
        var progress = BotConnectorSignInProgress()
        let attempt = try XCTUnwrap(progress.begin()), state = String(repeating: "a", count: 64)
        XCTAssertTrue(progress.bind(state, to: attempt))
        // The system browser can now be gone while the host's completion POST
        // or refresh is still held. A second tap must not start another flow.
        XCTAssertNil(progress.begin()); XCTAssertTrue(progress.isActive)
        XCTAssertTrue(progress.owns(attempt, state: state))
        XCTAssertFalse(progress.releaseFlow(String(repeating: "b", count: 64), from: attempt))
        XCTAssertTrue(progress.releaseFlow(state, from: attempt))
        XCTAssertNil(progress.begin(), "Releasing cleanup custody does not unlock the outer attempt early.")
        XCTAssertTrue(progress.finish(attempt)); XCTAssertFalse(progress.isActive)
        XCTAssertNotNil(progress.begin())
    }

    func testDisappearedSignInCannotClearCancelOrUnlockASuccessorAttempt() throws {
        var progress = BotConnectorSignInProgress()
        let first = try XCTUnwrap(progress.begin()), firstState = String(repeating: "a", count: 64)
        XCTAssertTrue(progress.bind(firstState, to: first))
        let capturedCleanup = progress.invalidate()
        XCTAssertEqual(capturedCleanup, firstState, "Disappearance captures this exact flow for server state-bound cleanup.")
        let second = try XCTUnwrap(progress.begin()), secondState = String(repeating: "b", count: 64)
        XCTAssertNotEqual(first, second); XCTAssertTrue(progress.bind(secondState, to: second))
        // A's late start, browser catch, completion and defer must all fail
        // their ownership check while B retains its cleanup state and lock.
        XCTAssertFalse(progress.isCurrent(first)); XCTAssertFalse(progress.owns(first, state: firstState))
        XCTAssertFalse(progress.bind(firstState, to: first))
        XCTAssertFalse(progress.releaseFlow(firstState, from: first))
        XCTAssertFalse(progress.finish(first))
        XCTAssertTrue(progress.owns(second, state: secondState)); XCTAssertEqual(progress.nativeState, secondState)
        XCTAssertNil(progress.begin())
        XCTAssertEqual(progress.invalidate(), secondState)
        XCTAssertFalse(progress.isCurrent(second))
    }


    func testCatalogSetupMetadataPreservesLegacyDefaultsAndExplainsManagedServices() throws {
        let legacy: [String: Any] = ["id": "linear", "name": "Linear", "description": "Projects", "category": "Projects", "transport": "http", "url": "https://mcp.linear.app/mcp", "authTypes": ["oauth"]]
        let entry = try decode(legacy, as: BotConnectorCatalogEntry.self)
        XCTAssertTrue(entry.isReady); XCTAssertNil(entry.phoneSignIn); XCTAssertEqual(entry.accountAction, "Connect")
        for state in ["configuration", "managed", "unavailable", "future-state"] {
            var raw = legacy; raw["setupState"] = state; raw["sourceURL"] = "https://github.com/example/config"; raw["phoneSignIn"] = false
            let service = try decode(raw, as: BotConnectorCatalogEntry.self)
            XCTAssertFalse(service.isReady); XCTAssertEqual(service.accountAction, "View setup")
            XCTAssertFalse(service.setupSummary.isEmpty); XCTAssertEqual(service.sourceURL, "https://github.com/example/config"); XCTAssertEqual(service.phoneSignIn, false)
        }
    }

    func testConfigurationManagedAndUnavailablePresetsCannotCreateAccountsOrStartSignIn() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let flags = features
        let catalog: [[String: Any]] = ["configuration", "managed", "unavailable"].map { state in
            ["id": "fixture-" + state, "name": "Service " + state, "description": "Review setup on Mac", "category": "Services", "transport": "http", "url": "https://service.fixture.invalid/mcp", "authTypes": ["oauth"], "setupState": state, "sourceURL": "https://github.com/example/config"]
        }
        fixture.respond { request in request.url!.path.hasSuffix("/catalog") ? ["connectors": catalog, "connectorFeatures": flags] : ["connections": [], "connectorFeatures": flags] }
        let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore()
        await workspace.refreshConnections(); await workspace.refreshConnectorCatalog()
        for entry in try XCTUnwrap(workspace.connectorCatalog?.connectors) {
            let direct = await workspace.createConnectorAccount(entry); XCTAssertNil(direct)
            let setup = await workspace.saveConnectorAccountSetup(BotConnectorDraft(entry: entry)); XCTAssertNil(setup)
        }
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        XCTAssertTrue(fixture.requests.allSatisfy { $0.path == "/v1/bots/connections" || $0.path == "/v1/bots/connectors/catalog" })
    }

    func testPresetPhoneSignInPolicyForcesMacAndUnknownPresetCannotRequestNativeCallback() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let flags = features.merging(["iphoneOAuth": true]) { _, new in new }
        var value = connector(); value["catalogId"] = "google"; value["authType"] = "oauth"
        let row = value
        let entries: [[String: Any]] = [
            ["id": "google", "name": "Google", "description": "Configured app", "category": "Services", "transport": "http", "url": "https://google.fixture.invalid/mcp", "authTypes": ["oauth"], "setupState": "ready", "phoneSignIn": false],
            ["id": "linear", "name": "Linear", "description": "Legacy preset", "category": "Projects", "transport": "http", "url": "https://mcp.linear.app/mcp", "authTypes": ["oauth"]],
        ]
        fixture.respond { request in
            if request.httpMethod == "POST" { return ["connection": row] }
            if request.url!.path.hasSuffix("/catalog") { return ["connectors": entries, "connectorFeatures": flags] }
            return ["connections": [row], "connectorFeatures": flags]
        }
        let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore()
        await workspace.refreshConnections(); await workspace.refreshConnectorCatalog()
        let google = try decode(row, as: BotMCPConnection.self)
        XCTAssertFalse(workspace.canUsePhoneSignIn(google))
        let refused = await workspace.connectorAuthentication(google, action: "start", callbackTarget: "iphone"); XCTAssertFalse(refused)
        var unknown = google; unknown.catalogId = "not-advertised"
        let unknownRefused = await workspace.connectorAuthentication(unknown, action: "start", callbackTarget: "iphone"); XCTAssertFalse(unknownRefused)
        let mac = await workspace.connectorAuthentication(google, action: "start"); XCTAssertTrue(mac)
        var legacy = google; legacy.catalogId = "linear"
        XCTAssertTrue(workspace.canUsePhoneSignIn(legacy))
        let native = await workspace.connectorAuthentication(legacy, action: "start", callbackTarget: "iphone"); XCTAssertTrue(native)
        let starts = fixture.requests.filter { $0.method == "POST" }
        XCTAssertEqual(starts.count, 2); XCTAssertEqual(starts[0].jsonBody?.count, 0)
        XCTAssertEqual(starts[1].jsonBody?["callbackTarget"] as? String, "iphone")
    }

}


extension StoreRaceTests {
    private func supervisionJSON(name: String = "Builder", state: String = "approval") -> [String: Any] {
        ["supported": true, "sessions": [["id": "s_supervision", "botId": "bot_fixture", "name": name, "title": "Review exact work", "state": state, "approvalCount": 1, "teamId": "team_fixture", "parentChatId": "s_parent", "computerName": "Saved Mac"]], "counts": ["waiting": 1, "working": 0, "completed": 0, "errors": 0], "hasMore": false]
    }
    func testSupervisionStatesKeepExactContextAndFilterCounts() throws {
        let snapshot = try JSONDecoder().decode(BotSupervisionSnapshot.self, from: JSONSerialization.data(withJSONObject: supervisionJSON()))
        let row = try XCTUnwrap(snapshot.sessions.first)
        XCTAssertEqual(row.id, "s_supervision"); XCTAssertEqual(row.botId, "bot_fixture")
        XCTAssertEqual(row.context, "Subagent · Saved Mac"); XCTAssertEqual(row.statusLabel, "1 approval waiting")
        XCTAssertTrue(BotSupervisionFilter.attention.includes(row)); XCTAssertFalse(BotSupervisionFilter.working.includes(row))
        XCTAssertEqual(BotSupervisionFilter.attention.count(snapshot.counts), 1)
        XCTAssertEqual(snapshot.headline, "1 conversation waiting for you")
        var personal = row; personal.parentChatId = nil; personal.teamId = nil; personal.computerName = nil
        XCTAssertEqual(personal.context, "Personal conversation")
        personal.teamId = "team_fixture"; XCTAssertEqual(personal.context, "Team conversation")
    }
    func testUnknownSupervisionStateCannotBecomeAnApprovalOrWorkingCard() throws {
        XCTAssertThrowsError(try JSONDecoder().decode(BotSupervisionSnapshot.self, from: JSONSerialization.data(withJSONObject: supervisionJSON(state: "future-state"))))
        for state in ["working", "thinking", "completed", "error"] {
            let value = try JSONDecoder().decode(BotSupervisionSnapshot.self, from: JSONSerialization.data(withJSONObject: supervisionJSON(state: state)))
            let row = try XCTUnwrap(value.sessions.first)
            XCTAssertEqual(row.isWorking, ["working", "thinking"].contains(state))
            XCTAssertEqual(row.needsAttention, state == "error")
            XCTAssertEqual(BotSupervisionFilter.completed.includes(row), state == "completed")
        }
    }
    func testSupervisionRefreshAfterPairingRevocationCannotPublishOldMacActivity() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore()
        let held = fixture.hold("/v1/bots/supervision")
        let refreshing = Task { await workspace.refreshSupervision() }
        await fulfillment(of: [held.requested], timeout: 2)
        owner.forgetMac(); held.finish(supervisionJSON())
        await refreshing.value
        XCTAssertNil(workspace.supervision); XCTAssertNil(workspace.messages["supervision"])
        XCTAssertFalse(workspace.loading.contains("supervision"))
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }
    func testOlderSupervisionPollCannotRestoreAnAlreadyClearedApproval() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore()
        let older = fixture.hold("/v1/bots/supervision")
        let first = Task { await workspace.refreshSupervision() }
        await fulfillment(of: [older.requested], timeout: 2)
        let newer = fixture.hold("/v1/bots/supervision")
        let second = Task { await workspace.refreshSupervision() }
        await fulfillment(of: [newer.requested], timeout: 2)
        newer.finish(supervisionJSON(name: "Current", state: "completed")); await second.value
        older.finish(supervisionJSON(name: "Old", state: "approval")); await first.value
        XCTAssertEqual(workspace.supervision?.sessions.first?.name, "Current")
        XCTAssertEqual(workspace.supervision?.sessions.first?.state, .completed)
        XCTAssertFalse(workspace.loading.contains("supervision"))
    }
}

extension BotWorkspaceTests {
    func testUnrestrictedTeamCapabilityDecodesZeroAndKeepsLegacyOptional() throws {
        var team = managedTeam(); var all = limits; all["maxParallel"] = 0; team["limits"] = all
        let modern = try decode(["teams": [team], "runs": [], "teamUnrestrictedSupported": true], as: BotTeamsSnapshot.self)
        XCTAssertTrue(modern.teamUnrestrictedSupported == true)
        XCTAssertEqual(modern.teams.first?.limits.maxParallel, 0)
        XCTAssertEqual(modern.teams.first?.limits.parallelLabel(), "All available teammates")
        let legacy = try decode(["teams": [managedTeam()], "runs": []], as: BotTeamsSnapshot.self)
        XCTAssertNil(legacy.teamUnrestrictedSupported)
        XCTAssertEqual(legacy.teams.first?.limits.maxParallel, 2)
        var positive = BotTeamLimits(); positive.maxParallel = 7
        XCTAssertEqual(positive.forHost(unrestrictedTeams: true).maxParallel, 0)
        XCTAssertEqual(positive.parallelLabel(unrestrictedTeams: true), "All available teammates")
        XCTAssertEqual(positive.forHost(unrestrictedTeams: false).maxParallel, 7)
        var zero = positive; zero.maxParallel = 0
        XCTAssertEqual(zero.forHost(unrestrictedTeams: false).maxParallel, 2)
    }
    func testUnrestrictedTeamsValidateLargeCurrentRosterAndBriefingWithoutRemovingBudgets() {
        let ids = (0..<15).map { "bot_\($0)" }
        var draft = BotTeamDraft(name: "Large team", memberIds: ids, coordinatorId: ids[0])
        draft.limits.maxParallel = 0
        draft.briefing = BotTeamBriefing(instructions: "Work together.", members: ids.map { BotTeamMemberBriefing(botId: $0, role: "Teammate") })
        XCTAssertTrue(BotWorkspaceStore.validTeamDraft(draft, unrestrictedTeams: true, availableMemberIds: Set(ids)))
        XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft), "Older hosts keep the legacy membership and parallel bounds.")
        XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft, unrestrictedTeams: true, availableMemberIds: Set(ids.dropLast())))
        draft.memberIds.append(ids[0]); XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft, unrestrictedTeams: true))
        draft.memberIds = ids; draft.briefing?.members.append(BotTeamMemberBriefing(botId: ids[0])); XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft, unrestrictedTeams: true))
        draft.briefing?.members.removeLast(); draft.limits.maxParallel = 64
        XCTAssertTrue(BotWorkspaceStore.validTeamDraft(draft, unrestrictedTeams: true), "A legacy positive value is accepted then canonicalized to all available.")
        draft.limits.maxParallel = -1; XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft, unrestrictedTeams: true))
        draft.limits.maxParallel = 0; draft.limits.maxTurns = 101; XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft, unrestrictedTeams: true))
        draft.limits.maxTurns = 24; draft.limits.maxHops = 33; XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft, unrestrictedTeams: true))
        draft.limits.maxHops = 8; draft.limits.maxDepth = 5; XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft, unrestrictedTeams: true))
        draft.limits.maxDepth = 2; draft.limits.maxDurationMs = 3_600_001; XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft, unrestrictedTeams: true))
    }
    func testLegacyTeamValidationRetainsTwelveAndPositiveParallelBounds() {
        var draft = sharedDraft(); draft.limits.maxParallel = 0
        XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft))
        draft.limits.maxParallel = 8; XCTAssertTrue(BotWorkspaceStore.validTeamDraft(draft))
        draft.limits.maxParallel = 9; XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft))
        draft.limits.maxParallel = 2; draft.memberIds = (0..<13).map { "bot_\($0)" }; draft.coordinatorId = "bot_0"
        XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft))
        draft.memberIds.removeLast(); XCTAssertTrue(BotWorkspaceStore.validTeamDraft(draft))
    }
    func testLargeTeamCreationRequiresCapabilityAndSendsEveryMemberWithCanonicalZero() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var supported = false
        let ids = (0..<15).map { "bot_\($0)" }
        var row = managedTeam(); row["memberIds"] = ids; row["coordinatorId"] = ids[0]
        fixture.respond { request in
            if request.httpMethod == "POST" { return ["team": row] }
            return ["teams": [], "runs": [], "teamUnrestrictedSupported": supported]
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshTeams()
        let draft = BotTeamDraft(name: "Large team", memberIds: ids, coordinatorId: ids[0])
        let legacyRejected = await workspace.createTeam(draft); XCTAssertFalse(legacyRejected)
        XCTAssertFalse(fixture.requests.contains { $0.method == "POST" })
        supported = true; await workspace.refreshTeams()
        let created = await workspace.createTeam(draft); XCTAssertTrue(created)
        let post = try XCTUnwrap(fixture.requests.first { $0.method == "POST" })
        XCTAssertEqual(post.jsonBody?["memberIds"] as? [String], ids)
        XCTAssertEqual((post.jsonBody?["limits"] as? [String: Int])?["maxParallel"], 0)
        XCTAssertFalse(fixture.requests.contains { $0.path.contains("/runs") || $0.path.contains("/computer") || $0.path.contains("/models") })
    }
    func testUnrestrictedTeamUpdateCanonicalizesLegacyPositiveAndRetainsOtherLimits() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let ids = ["bot_coder", "bot_reviewer"] + (0..<13).map { "bot_extra_\($0)" }
        fixture.respond { request in
            var row = self.managedTeam(revision: request.httpMethod == "PATCH" ? 2 : 1); row["memberIds"] = ids
            if request.httpMethod == "PATCH" { return ["team": row] }
            var value = self.settingsSnapshot(); value["teams"] = [row]; value["teamUnrestrictedSupported"] = true; return value
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshTeams()
        let original = try XCTUnwrap(workspace.teams?.teams.first)
        var draft = sharedDraft(); draft.memberIds = ids; draft.limits.maxParallel = 8; draft.limits.maxTurns = 40
        let saved = await workspace.updateTeam(original, draft: draft); XCTAssertTrue(saved)
        let patch = try XCTUnwrap(fixture.requests.first { $0.method == "PATCH" })
        XCTAssertEqual(patch.jsonBody?["memberIds"] as? [String], ids)
        XCTAssertEqual(workspace.teams?.teams.first?.memberIds, ids)
        XCTAssertEqual((patch.jsonBody?["limits"] as? [String: Int])?["maxParallel"], 0)
        XCTAssertEqual((patch.jsonBody?["limits"] as? [String: Int])?["maxTurns"], 40)
        XCTAssertEqual(patch.jsonBody?["expectedRevision"] as? Int, 1)
    }
}

extension BotWorkspaceTests {
    func testUnrestrictedChannelPreservesEveryExplicitRecipientAndRejectsNonmembers() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let ids = (0..<15).map { "bot_\($0)" }
        var row = managedTeam(); row["memberIds"] = ids; row["coordinatorId"] = ids[0]
        fixture.respond { request in
            if request.url!.path.hasSuffix("/channel") { return self.channelSnapshot([]) }
            if request.url!.path.hasSuffix("/messages") { return ["channel": self.channelSnapshot([self.channelEntry(1)])] }
            return ["teams": [row], "runs": [], "teamUnrestrictedSupported": true]
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshTeams(); await workspace.refreshChannel("team_fixture")
        let selected = try decode(row, as: BotTeam.self)
        let sent = await workspace.postTeamMessage(selected, draft: BotTeamChannelPost(message: "Hi everyone", requestId: "large_room", recipientIds: ids))
        XCTAssertTrue(sent)
        let post = try XCTUnwrap(fixture.requests.first { $0.method == "POST" })
        XCTAssertEqual(post.jsonBody?["recipientIds"] as? [String], ids)
        let outside = await workspace.postTeamMessage(selected, draft: BotTeamChannelPost(message: "Hello", requestId: "invalid_room", recipientIds: ["outside"]))
        XCTAssertFalse(outside); XCTAssertEqual(fixture.requests.filter { $0.method == "POST" }.count, 1)
    }
    func testTeamCreationRechecksCurrentSavedProfilesBeforeSending() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            if request.url!.path == "/v1/bots" {
                return ["bots": [["id": "bot_coder", "name": "Coder", "provider": "codex", "model": "fixture", "capabilities": "code", "policy": "manual", "execution": ["kind": "local"]]], "providers": [], "computers": []]
            }
            return ["teams": [], "runs": [], "teamUnrestrictedSupported": true]
        }
        let store = fixture.makeStore(); await store.refreshBots()
        let workspace = store.botWorkspaceStore(); await workspace.refreshTeams()
        let created = await workspace.createTeam(BotTeamDraft(name: "Missing profile", memberIds: ["bot_coder", "bot_removed"], coordinatorId: "bot_coder"))
        XCTAssertFalse(created); XCTAssertFalse(fixture.requests.contains { $0.method == "POST" })
    }
}

extension BotWorkspaceTests {
    func testLargeRosterOpeningRepliesAreSeparateFromWorkTurnCount() throws {
        var value = runRecord(); value["consumedTurns"] = 51; value["rosterFanoutTurns"] = 27
        let run = try decode(value, as: BotTeamRun.self)
        XCTAssertEqual(run.rosterFanoutTurns, 27); XCTAssertEqual(run.workTurns, 24)
        XCTAssertEqual(run.turnLabel(unrestrictedTeams: true), "24 work turns")
        XCTAssertEqual(run.turnLabel(unrestrictedTeams: false), "51 turns")
        let legacy = try decode(runRecord(), as: BotTeamRun.self)
        XCTAssertNil(legacy.rosterFanoutTurns); XCTAssertEqual(legacy.workTurns, legacy.consumedTurns)
        value["rosterFanoutTurns"] = 100; XCTAssertEqual(try decode(value, as: BotTeamRun.self).workTurns, 0)
        value["consumedTurns"] = Int.min; value["rosterFanoutTurns"] = Int.max
        XCTAssertEqual(try decode(value, as: BotTeamRun.self).workTurns, 0)
    }
}
