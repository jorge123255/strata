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

    func testEqualWorkspacePollsPublishOnlyLoadingTransitionsAndPreserveChangedAuthority() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        var teamRevision = 1, taskRevision = 1, includeMessage = false, activeRun = false
        var activityReason: String?
        var channelQueries: [String] = []
        fixture.respond { request in
            if request.url!.path == "/v1/bots/teams" {
                var team = self.team(enabled: true); team["revision"] = teamRevision
                return ["teams": [team], "runs": [], "teamWorkReviewSupported": true]
            }
            if request.url!.path == "/v1/bots/activity" {
                var value: [String: Any] = ["activity": [["id": "task_fixture", "type": "delivery", "teamId": "team_fixture", "runId": "run_fixture", "title": "Saved result", "state": "completed", "work": ["status": "ready_for_review", "revision": taskRevision, "evidence": [], "resultHistory": [], "reviewHistory": []]]], "teamWorkReviewSupported": true]
                if let activityReason { value["reason"] = activityReason }
                return value
            }
            if request.url!.path.hasSuffix("/channel") {
                let query = request.url!.query ?? ""; channelQueries.append(query)
                var value = self.channelSnapshot(query.isEmpty ? [self.channelEntry(1)] : includeMessage ? [self.channelEntry(2)] : [])
                value["nextSequence"] = includeMessage ? 2 : 1
                if activeRun { value["activeRuns"] = [self.runRecord()] }
                return value
            }
            return nil
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshTeams(); await workspace.refreshActivity(); await workspace.refreshChannel("team_fixture")
        var publications = 0, teamPublications = 0, activityPublications = 0, channelPublications = 0, messagePublications = 0
        let observation = workspace.objectWillChange.sink { publications += 1 }
        let teams = workspace.$teams.dropFirst().sink { _ in teamPublications += 1 }
        let activity = workspace.$activity.dropFirst().sink { _ in activityPublications += 1 }
        let channel = workspace.$channels.dropFirst().sink { _ in channelPublications += 1 }
        let messages = workspace.$messages.dropFirst().sink { _ in messagePublications += 1 }
        defer { observation.cancel(); teams.cancel(); activity.cancel(); channel.cancel(); messages.cancel() }
        await workspace.refreshTeams(); await workspace.refreshActivity(); await workspace.refreshChannel("team_fixture")
        XCTAssertEqual(publications, 6, "Only the three real loading start/end transitions remain observable.")
        XCTAssertEqual(teamPublications, 0); XCTAssertEqual(activityPublications, 0); XCTAssertEqual(channelPublications, 0); XCTAssertEqual(messagePublications, 0)
        XCTAssertEqual(workspace.channels["team_fixture"]?.messages.map(\.sequence), [1])
        XCTAssertEqual(channelQueries, ["", "after=1"])

        teamRevision = 2; taskRevision = 2; activeRun = true
        await workspace.refreshTeams(); await workspace.refreshActivity(); await workspace.refreshChannel("team_fixture")
        XCTAssertEqual(teamPublications, 1); XCTAssertEqual(activityPublications, 1); XCTAssertEqual(channelPublications, 1)
        XCTAssertEqual(workspace.teams?.teams.first?.revision, 2)
        XCTAssertEqual(workspace.activity.first?.work?.revision, 2)
        XCTAssertEqual(workspace.channels["team_fixture"]?.activeRuns.count, 1)
        includeMessage = true; await workspace.refreshChannel("team_fixture")
        XCTAssertEqual(workspace.channels["team_fixture"]?.messages.map(\.sequence), [1, 2])
        XCTAssertEqual(channelPublications, 2)
        includeMessage = false; await workspace.refreshChannel("team_fixture")
        XCTAssertEqual(channelQueries.last, "after=2", "Empty polls preserve the retained forward cursor.")
        XCTAssertEqual(workspace.channels["team_fixture"]?.messages.map(\.sequence), [1, 2])
        XCTAssertEqual(channelPublications, 2)

        activityReason = "Synthetic host temporarily unavailable"
        await workspace.refreshActivity(); await workspace.refreshActivity()
        XCTAssertEqual(messagePublications, 1, "An unchanged unavailable reason must not clear and republish itself on every poll.")
        XCTAssertEqual(workspace.activity.first?.work?.revision, 2)
        XCTAssertTrue(workspace.activityLoaded)
        activityReason = nil; await workspace.refreshActivity()
        XCTAssertEqual(messagePublications, 2, "A successful fresh snapshot must still clear stale-state guidance.")
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
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

    func testWorkModeDecodesOnlyKnownValuesAndLegacyDraftOmitsNewField() throws {
        var message = channelEntry(1); message["author"] = ["type": "user", "name": "You"]
        XCTAssertNil(try decode(message, as: BotTeamChannelMessage.self).workMode)
        message["workMode"] = "work"
        XCTAssertEqual(try decode(message, as: BotTeamChannelMessage.self).workMode, .work)
        message["workMode"] = "privileged"
        XCTAssertThrowsError(try decode(message, as: BotTeamChannelMessage.self))
        let old = BotTeamChannelPost(message: "Hello", requestId: "legacy_request")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(old)) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["message", "requestId"])
        var modern = old; modern.workMode = .chat
        let chat = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(modern)) as? [String: Any])
        XCTAssertEqual(chat["workMode"] as? String, "chat")
    }

    func testTeamWorkModeRequiresLiteralCapabilityAndPreservesTypedRetryAndTargeting() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        var capability: Bool? = nil
        fixture.respond { request in
            if request.url!.path.hasSuffix("/channel") { return self.channelSnapshot([self.channelEntry(1)]) }
            if request.url!.path.hasSuffix("/messages") { return ["channel": self.channelSnapshot([self.channelEntry(1), self.channelEntry(2)])] }
            if request.url!.path == "/v1/bots/teams" {
                var value: [String: Any] = ["teams": [self.team(enabled: true)], "runs": []]
                if let capability { value["teamCoordinatorWorkToolsSupported"] = capability }
                return value
            }
            return nil
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshTeams(); await workspace.refreshChannel("team_fixture")
        let selected = try decode(team(enabled: true), as: BotTeam.self)
        let work = BotTeamChannelPost(message: "Read the saved source", requestId: "request_work", recipientIds: ["bot_reviewer"], replyToId: "tm_1", workMode: .work)
        XCTAssertNil(workspace.teams?.teamCoordinatorWorkToolsSupported)
        let unsupportedWork = await workspace.postTeamMessage(selected, draft: work)
        let unsupportedChat = await workspace.postTeamMessage(selected, draft: BotTeamChannelPost(message: "Chat", requestId: "request_chat", workMode: .chat))
        XCTAssertFalse(unsupportedWork); XCTAssertFalse(unsupportedChat)
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        capability = true; await workspace.refreshTeams()
        let sent = await workspace.postTeamMessage(selected, draft: work)
        let retried = await workspace.postTeamMessage(selected, draft: work)
        XCTAssertTrue(sent); XCTAssertTrue(retried)
        let writes = fixture.requests.filter { $0.method == "POST" }
        XCTAssertEqual(writes.count, 2)
        XCTAssertEqual(writes.map { $0.jsonBody?["workMode"] as? String }, ["work", "work"])
        XCTAssertEqual(writes.map { $0.jsonBody?["requestId"] as? String }, ["request_work", "request_work"])
        XCTAssertEqual(writes.first?.jsonBody?["recipientIds"] as? [String], ["bot_reviewer"])
        XCTAssertEqual(writes.first?.jsonBody?["replyToId"] as? String, "tm_1")
        capability = false; await workspace.refreshTeams()
        let withdrawn = await workspace.postTeamMessage(selected, draft: work)
        XCTAssertFalse(withdrawn)
        XCTAssertEqual(fixture.requests.filter { $0.method == "POST" }.count, 2)
        XCTAssertNil(store.currentConversation)
        XCTAssertFalse(fixture.requests.contains { $0.path.hasSuffix("/runs") || $0.path.contains("/computer/") })
    }

    func testDurableTeamPlanIsExplicitWorkOnlyAndOldHostPayloadIsUnchanged() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        var supported = false
        var ackDefect: String?
        fixture.respond { request in
            if request.url!.path.hasSuffix("/channel") { return self.channelSnapshot([self.channelEntry(1)]) }
            if request.url!.path.hasSuffix("/messages") {
                var entry = self.channelEntry(2); entry["author"] = ["type": "user", "name": "You"]; entry["content"] = "Do the authorized work"; entry["runId"] = "plan_run"; entry["planId"] = "tp_00000000-0000-4000-8000-000000000001"; entry["workMode"] = ackDefect == "mode" ? "chat" : "work"
                if ackDefect == "reply" { entry["replyToId"] = "unrequested_reply" }
                if ackDefect == "recipients" { entry["recipientIds"] = ["bot_reviewer"] }
                return ["channel": self.channelSnapshot([self.channelEntry(1), entry]), "planId": "tp_00000000-0000-4000-8000-000000000001", "run": ["id": "plan_run", "teamId": "team_fixture", "rootChatId": "plan_chat", "rootBotId": "bot_builder", "state": "queued", "consumedTurns": 0, "planId": "tp_00000000-0000-4000-8000-000000000001"]]
            }
            if request.url!.path == "/v1/bots/teams" {
                var value: [String: Any] = ["teams": [self.team(enabled: true)], "runs": [], "teamCoordinatorWorkToolsSupported": true]
                if supported { value["teamWorkPlansSupported"] = true }
                return value
            }
            return nil
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshTeams(); await workspace.refreshChannel("team_fixture")
        let selected = try decode(team(enabled: true), as: BotTeam.self)
        let work = BotTeamChannelPost(message: "Do the authorized work", requestId: "plan_fixture", workMode: .work, durablePlan: true)
        let unsupported = await workspace.postTeamMessage(selected, draft: work)
        XCTAssertFalse(unsupported)
        supported = true; await workspace.refreshTeams()
        for mode in [BotTeamMessageWorkMode.chat, nil] {
            var invalid = work; invalid.workMode = mode
            let result = await workspace.postTeamMessage(selected, draft: invalid)
            XCTAssertFalse(result)
        }
        var invalid = work; invalid.durablePlan = false
        let falseFlag = await workspace.postTeamMessage(selected, draft: invalid)
        XCTAssertFalse(falseFlag)
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        let sent = await workspace.postTeamMessage(selected, draft: work)
        XCTAssertTrue(sent)
        let writes = fixture.requests.filter { $0.method == "POST" }
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes.first?.jsonBody?["durablePlan"] as? Bool, true)
        var old = work; old.durablePlan = nil
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(old)) as? [String: Any])
        XCTAssertNil(encoded["durablePlan"])
        for defect in ["mode", "reply", "recipients"] {
            ackDefect = defect
            let accepted = await workspace.postTeamMessage(selected, draft: work)
            XCTAssertFalse(accepted, "A different intake acknowledgement must not clear the request: " + defect)
        }
        XCTAssertEqual(fixture.requests.filter { $0.method == "POST" }.count, 4, "Each explicitly requested send happens once; acknowledgements never cause a retry.")
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
final class BotCreatedToolsTests: XCTestCase {
    private let path = "/v1/bots/tools"
    private func row(revision: Int = 1, digest: String = String(repeating: "a", count: 64), status: String = "draft", botIds: [String] = [], teamIds: [String] = []) -> [String: Any] {
        ["id": "tool_fixture", "name": "Workspace summary", "description": "Summarize the current workspace", "command": "python3 summary.py", "inputSchema": ["type": "object", "properties": ["format": ["type": "string", "enum": ["short", "full"]]], "required": ["format"], "additionalProperties": false], "timeoutSeconds": 30, "status": status, "revision": revision, "digest": digest, "botIds": botIds, "teamIds": teamIds, "provenance": ["botId": "bot_coder", "chatId": "s_fixture", "turnId": "turn_fixture"]]
    }
    private func snapshot(_ tool: [String: Any]? = nil) -> [String: Any] { ["tools": tool.map { [$0] } ?? [], "createdToolsSupported": true] }
    private func decode<T: Decodable>(_ value: Any, as: T.Type) throws -> T { try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: value)) }

    func testSchemaRoundTripRetainsBooleanNumericEnumsAndRejectsUnsupportedOrNestedInputs() throws {
        let schema: [String: Any] = ["type": "object", "properties": ["flag": ["type": "boolean", "enum": [true, false]], "limit": ["type": "integer", "minimum": 1, "maximum": 3, "enum": [1, 2, 3]], "title": ["type": "string", "maxLength": 120]], "required": ["flag"], "additionalProperties": false]
        let parsed = try decode(schema, as: BotToolJSON.self)
        XCTAssertTrue(BotCreatedToolDraft.isSupportedSchema(parsed))
        XCTAssertEqual(try decode(JSONSerialization.jsonObject(with: JSONEncoder().encode(parsed)), as: BotToolJSON.self), parsed)
        XCTAssertEqual(try decode(JSONSerialization.jsonObject(with: JSONEncoder().encode(parsed)), as: BotToolJSON.self).formatted, parsed.formatted)
        for invalid: [String: Any] in [
            ["type": "object", "properties": ["nested": ["type": "object"]], "required": [], "additionalProperties": false],
            ["type": "object", "properties": [:], "required": ["missing"], "additionalProperties": false],
            ["type": "object", "properties": [:], "required": [], "additionalProperties": true],
            ["type": "object", "properties": ["__proto__": ["type": "string"]], "required": [], "additionalProperties": false],
            ["type": "object", "properties": ["n": ["type": "integer", "enum": [1.5]]], "required": [], "additionalProperties": false],
            ["type": "object", "properties": [:], "required": [], "additionalProperties": false, "$ref": "elsewhere"]
        ] { XCTAssertFalse(BotCreatedToolDraft.isSupportedSchema(try decode(invalid, as: BotToolJSON.self))) }
    }

    func testDraftValidationRejectsOversizeFieldsInvalidTimeoutAndNulls() throws {
        var draft = BotCreatedToolDraft(tool: try decode(row(), as: BotCreatedTool.self))
        XCTAssertTrue(draft.isValid)
        draft.timeoutSeconds = 121; XCTAssertFalse(draft.isValid); draft.timeoutSeconds = 0; XCTAssertFalse(draft.isValid); draft.timeoutSeconds = 30
        draft.command = "bad\0command"; XCTAssertFalse(draft.isValid)
        draft.command = String(repeating: "x", count: 32_001); XCTAssertFalse(draft.isValid)
        draft.command = "echo ok"; draft.description = String(repeating: "😀", count: 1_001); XCTAssertFalse(draft.isValid)
    }

    func testSchemaValidationMatchesServerSafeIntegerTextAndEnumBoundaries() throws {
        func schema(_ property: [String: Any]) throws -> BotToolJSON {
            try decode(["type": "object", "properties": ["value": property], "required": [], "additionalProperties": false], as: BotToolJSON.self)
        }
        for invalid in [
            ["type": "integer", "minimum": 0.5], ["type": "integer", "maximum": -0.5],
            ["type": "integer", "minimum": -9_007_199_254_740_992], ["type": "integer", "maximum": 9_007_199_254_740_992],
            ["type": "integer", "enum": [9_007_199_254_740_992]], ["type": "integer", "enum": [-9_007_199_254_740_992]],
            ["type": "string", "maxLength": 64_001], ["type": "string", "maxLength": 0.5],
            ["type": "string", "enum": ["ok", "bad\0value"]]
        ] as [[String: Any]] { XCTAssertFalse(BotCreatedToolDraft.isSupportedSchema(try schema(invalid)), "\(invalid)") }
        for valid in [
            ["type": "integer", "minimum": -9_007_199_254_740_991, "maximum": 9_007_199_254_740_991, "enum": [-9_007_199_254_740_991, 0, 9_007_199_254_740_991]],
            ["type": "number", "minimum": -0.5, "maximum": 0.5, "enum": [0.25]],
            ["type": "string", "maxLength": 64_000, "enum": ["", "ok"]], ["type": "string", "maxLength": 0]
        ] as [[String: Any]] { XCTAssertTrue(BotCreatedToolDraft.isSupportedSchema(try schema(valid)), "\(valid)") }
    }

    func testReadOnlyCatalogReusesUnchangedStateAndDoesNotRunOrEnableTools() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; let response = snapshot(row())
        fixture.respond { _ in response }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshCreatedTools()
        var publications = 0; let observer = workspace.$createdTools.dropFirst().sink { _ in publications += 1 }; defer { observer.cancel() }
        await workspace.refreshCreatedTools()
        XCTAssertEqual(publications, 0); XCTAssertEqual(workspace.createdTools?.tools.first?.provenance?.botId, "bot_coder")
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" && $0.path == path })
    }

    func testCreatingDraftSendsDefinitionOnlyAndNeverAddsAccessOrRunsIt() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; let tool = row()
        fixture.respond { request in request.httpMethod == "POST" ? ["tool": tool] : self.snapshot(tool) }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshCreatedTools()
        let saved = await workspace.saveCreatedTool(BotCreatedToolDraft(tool: try decode(tool, as: BotCreatedTool.self)))
        XCTAssertTrue(saved)
        let writes = fixture.requests.filter { $0.method != "GET" }; XCTAssertEqual(writes.count, 1); XCTAssertEqual(writes.first?.path, path)
        XCTAssertEqual(Set(writes.first?.jsonBody?.keys.map { $0 } ?? []), ["name", "description", "command", "inputSchema", "timeoutSeconds"])
        XCTAssertEqual((writes.first?.jsonBody?["inputSchema"] as? [String: Any])?["additionalProperties"] as? Bool, false)
        XCTAssertNil(store.currentConversation)
    }

    func testEditAlwaysDraftsExactReviewedRevisionWithoutStatusEscalationOrExecution() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; let tool = row(status: "enabled")
        fixture.respond { request in request.httpMethod == "PATCH" ? ["tool": tool] : self.snapshot(tool) }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshCreatedTools()
        let reviewed = try XCTUnwrap(workspace.createdTools?.tools.first)
        var draft = BotCreatedToolDraft(tool: reviewed); draft.command = "python3 changed.py"
        let saved = await workspace.saveCreatedTool(draft, reviewing: reviewed); XCTAssertTrue(saved)
        let body = try XCTUnwrap(fixture.requests.first { $0.method == "PATCH" }?.jsonBody)
        XCTAssertEqual(body["status"] as? String, "draft"); XCTAssertEqual(body["expectedRevision"] as? Int, 1); XCTAssertEqual(body["expectedDigest"] as? String, reviewed.digest)
        XCTAssertNil(body["botIds"]); XCTAssertNil(body["teamIds"])
        XCTAssertTrue(fixture.requests.allSatisfy { $0.path == path || $0.path == path + "/tool_fixture" })
    }

    func testEnableConflictRefreshesCurrentVersionWithoutReplayingOrRunning() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var tool = row()
        fixture.respond { _ in self.snapshot(tool) }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshCreatedTools()
        let reviewed = try XCTUnwrap(workspace.createdTools?.tools.first), pending = fixture.hold(path + "/tool_fixture")
        let enabling = Task { await workspace.setCreatedToolEnabled(reviewed, enabled: true) }
        await fulfillment(of: [pending.requested], timeout: 2)
        let body = try XCTUnwrap(fixture.requests.first { $0.method == "PATCH" }?.jsonBody)
        XCTAssertEqual(Set(body.keys), ["status", "expectedRevision", "expectedDigest"]); XCTAssertEqual(body["status"] as? String, "enabled")
        tool = row(revision: 2, digest: String(repeating: "b", count: 64)); pending.finish(["error": "Tool changed. Review again."], status: 409)
        let enabled = await enabling.value; XCTAssertFalse(enabled); XCTAssertEqual(workspace.createdTools?.tools.first?.revision, 2)
        XCTAssertNotNil(workspace.messages["createdTools"]); XCTAssertEqual(fixture.requests.filter { $0.method != "GET" }.count, 1)
        let staleEnable = await workspace.setCreatedToolEnabled(reviewed, enabled: true); XCTAssertFalse(staleEnable)
        XCTAssertEqual(fixture.requests.filter { $0.method != "GET" }.count, 1)
    }

    func testBotAndTeamAssignmentMergePreservesOtherAccessAndHasExactReviewProof() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; let tool = row(status: "enabled", botIds: ["bot_existing"], teamIds: ["team_existing"])
        fixture.respond { request in request.httpMethod == "PATCH" ? ["tool": tool] : self.snapshot(tool) }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshCreatedTools()
        let reviewed = try XCTUnwrap(workspace.createdTools?.tools.first)
        let assigned = await workspace.assignCreatedTool(reviewed, botId: "bot_new", assigned: true); XCTAssertTrue(assigned)
        let body = try XCTUnwrap(fixture.requests.first { $0.method == "PATCH" }?.jsonBody)
        XCTAssertEqual(body["botIds"] as? [String], ["bot_existing", "bot_new"]); XCTAssertEqual(body["teamIds"] as? [String], ["team_existing"])
        XCTAssertEqual(body["expectedRevision"] as? Int, 1); XCTAssertEqual(body["expectedDigest"] as? String, reviewed.digest)
        let teamAssigned = await workspace.assignCreatedTool(reviewed, teamId: "team_new", assigned: true); XCTAssertTrue(teamAssigned)
        let teamBody = try XCTUnwrap(fixture.requests.last { $0.method == "PATCH" }?.jsonBody)
        XCTAssertEqual(teamBody["botIds"] as? [String], ["bot_existing"]); XCTAssertEqual(teamBody["teamIds"] as? [String], ["team_existing", "team_new"])
        XCTAssertTrue(fixture.requests.allSatisfy { $0.path == path || $0.path == path + "/tool_fixture" })
    }

    func testAssignmentRechecksDefinitionAndRefusesConcurrentEditWithoutWrite() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var response = snapshot(row(status: "enabled"))
        fixture.respond { _ in response }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshCreatedTools()
        let reviewed = try XCTUnwrap(workspace.createdTools?.tools.first)
        response = snapshot(row(revision: 2, digest: String(repeating: "c", count: 64)))
        let assigned = await workspace.assignCreatedTool(reviewed, teamId: "team_fixture", assigned: true)
        XCTAssertFalse(assigned); XCTAssertEqual(workspace.createdTools?.tools.first?.revision, 2); XCTAssertNotNil(workspace.messages["createdTools"])
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }

    func testDraftAccessCanBeRevokedWithoutEnablingButNewGrantIsRejected() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; let tool = row(botIds: ["bot_existing"])
        fixture.respond { request in request.httpMethod == "PATCH" ? ["tool": tool] : self.snapshot(tool) }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshCreatedTools()
        let reviewed = try XCTUnwrap(workspace.createdTools?.tools.first)
        let removed = await workspace.assignCreatedTool(reviewed, botId: "bot_existing", assigned: false); XCTAssertTrue(removed)
        let body = try XCTUnwrap(fixture.requests.first { $0.method == "PATCH" }?.jsonBody)
        XCTAssertEqual(body["botIds"] as? [String], []); XCTAssertNil(body["status"])
        let added = await workspace.assignCreatedTool(reviewed, botId: "bot_new", assigned: true); XCTAssertFalse(added)
        XCTAssertEqual(fixture.requests.filter { $0.method != "GET" }.count, 1)
    }

    func testRevokedPairingRejectsLateToolCreationAndDoesNotRefreshOrNavigate() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; let tool = row()
        fixture.respond { _ in self.snapshot(tool) }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshCreatedTools()
        let original = workspace.createdTools, pending = fixture.hold(path)
        let saving = Task { await workspace.saveCreatedTool(BotCreatedToolDraft(tool: try self.decode(tool, as: BotCreatedTool.self))) }
        await fulfillment(of: [pending.requested], timeout: 2)
        store.forgetMac(); pending.finish(["tool": row(revision: 2)]); let saved = try await saving.value
        XCTAssertFalse(saved); XCTAssertEqual(workspace.createdTools, original); XCTAssertFalse(store.isPaired); XCTAssertNil(store.currentConversation)
        XCTAssertEqual(fixture.requests.filter { $0.method == "GET" }.count, 1)
    }

    func testDeleteCarriesExactProofAndConflictRefreshesWithoutRetry() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var response = snapshot(row())
        fixture.respond { _ in response }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshCreatedTools()
        let tool = try XCTUnwrap(workspace.createdTools?.tools.first), pending = fixture.hold(path + "/tool_fixture")
        let removing = Task { await workspace.deleteCreatedTool(tool) }
        await fulfillment(of: [pending.requested], timeout: 2)
        let body = try XCTUnwrap(fixture.requests.first { $0.method == "DELETE" }?.jsonBody)
        XCTAssertEqual(Set(body.keys), ["expectedRevision", "expectedDigest"])
        XCTAssertEqual(body["expectedRevision"] as? Int, 1); XCTAssertEqual(body["expectedDigest"] as? String, tool.digest)
        response = snapshot(row(revision: 2)); pending.finish(["error": "Tool changed; review it again."], status: 409)
        let deleted = await removing.value; XCTAssertFalse(deleted); XCTAssertEqual(workspace.createdTools?.tools.first?.revision, 2)
        XCTAssertEqual(fixture.requests.filter { $0.method != "GET" }.count, 1)
        let stale = await workspace.deleteCreatedTool(tool); XCTAssertFalse(stale)
        XCTAssertEqual(fixture.requests.filter { $0.method != "GET" }.count, 1)
    }

    func testSuccessfulDeleteRefreshesCatalogWithoutSendingPrompt() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var removed = false
        fixture.respond { request in
            if request.httpMethod == "DELETE" { removed = true; return ["deleted": true] }
            return self.snapshot(removed ? nil : self.row())
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshCreatedTools()
        let tool = try XCTUnwrap(workspace.createdTools?.tools.first)
        let deleted = await workspace.deleteCreatedTool(tool); XCTAssertTrue(deleted); XCTAssertTrue(workspace.createdTools?.tools.isEmpty == true)
        XCTAssertEqual(fixture.requests.filter { $0.method != "GET" }.map(\.path), [path + "/tool_fixture"])
        XCTAssertNil(store.currentConversation)
    }

    func testInvalidOrUnsupportedToolMutationsCannotSendPrograms() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { _ in ["tools": [], "createdToolsSupported": false, "reason": "Update Strata on Mac"] }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshCreatedTools()
        let reviewed = try decode(row(), as: BotCreatedTool.self)
        let created = await workspace.saveCreatedTool(BotCreatedToolDraft(tool: reviewed))
        let enabled = await workspace.setCreatedToolEnabled(reviewed, enabled: true)
        let invalid = await workspace.assignCreatedTool(reviewed, botId: "../bot", assigned: true)
        XCTAssertFalse(created); XCTAssertFalse(enabled); XCTAssertFalse(invalid); XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
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

    func testConnectorAuthSuccessfulPollClearsTransientErrorOnlyForMatchingAccount() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        var value = connector(); value["authType"] = "oauth"; value["auth"] = ["status": "waiting", "detail": "Synthetic pending sign-in"]
        let initial = value, flags = features
        var reply = initial; reply["auth"] = ["status": "connected", "detail": "Synthetic sign-in accepted"]
        fixture.respond { request in request.url!.path.hasSuffix("/auth") ? ["connection": reply] : ["connections": [initial], "connectorFeatures": flags] }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshConnections()
        let connection = try decode(initial, as: BotMCPConnection.self)
        let path = "/v1/bots/connections/\(connection.id)/auth"
        let failure = fixture.hold(path)
        let first = Task { await workspace.connectorAuthentication(connection, action: "poll") }
        await fulfillment(of: [failure.requested], timeout: 2)
        failure.finish(["error": "Synthetic temporary sign-in status failure"], status: 503)
        let failed = await first.value; XCTAssertFalse(failed)
        XCTAssertNotNil(workspace.messages["connections"])
        fixture.release(path)

        let retried = await workspace.connectorAuthentication(connection, action: "poll")
        XCTAssertTrue(retried); XCTAssertNil(workspace.messages["connections"])
        XCTAssertEqual(workspace.connections?.connections.first?.auth?.status, "connected")
        var publications = 0
        let observation = workspace.objectWillChange.sink { publications += 1 }
        let repeated = await workspace.connectorAuthentication(connection, action: "poll")
        observation.cancel()
        XCTAssertTrue(repeated); XCTAssertEqual(publications, 2, "An unchanged successful poll only publishes its loading start/end.")

        reply["id"] = "mcpc_other_account"
        let mismatched = await workspace.connectorAuthentication(connection, action: "poll")
        XCTAssertFalse(mismatched); XCTAssertNotNil(workspace.messages["connections"])
        XCTAssertEqual(workspace.connections?.connections.first?.id, connection.id)
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" }, "Sign-in status retries never start authentication, grant access or run a model.")
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
    func testCompactTeamCardsKeepCompleteContentAndOnlyCollapseAssignmentsOrLongReports() throws {
        var value = channelEntry(1); value["kind"] = "assignment"; value["content"] = "First line\nPrivate test fixture tail"
        let assignment = try decode(value, as: BotTeamChannelMessage.self)
        XCTAssertTrue(assignment.usesCompactCard); XCTAssertEqual(assignment.compactPreview, "First line…")
        XCTAssertEqual(assignment.content, value["content"] as? String)
        XCTAssertTrue(assignment.content.contains("Private test fixture tail"))
        value["kind"] = "report"; value["content"] = String(repeating: "a", count: 1_800)
        XCTAssertFalse(try decode(value, as: BotTeamChannelMessage.self).usesCompactCard)
        value["content"] = String(repeating: "🧑🏽‍💻", count: 1_801)
        let report = try decode(value, as: BotTeamChannelMessage.self)
        XCTAssertTrue(report.usesCompactCard); XCTAssertEqual(report.compactPreview.count, 221)
        XCTAssertEqual(report.content.count, 1_801)
        value["kind"] = "message"
        XCTAssertFalse(try decode(value, as: BotTeamChannelMessage.self).usesCompactCard)
    }

    func testContinuousTeamCapabilityIsSeparateAndCanonicalizesEveryLimit() throws {
        let old = try decode(["teams": [], "runs": [], "teamUnrestrictedSupported": true], as: BotTeamsSnapshot.self)
        XCTAssertNil(old.teamContinuousSupported)
        let modern = try decode(["teams": [], "runs": [], "teamContinuousSupported": true], as: BotTeamsSnapshot.self)
        XCTAssertTrue(modern.teamContinuousSupported == true)
        for bad in ([1, "true", ["enabled": true]] as [Any]) {
            XCTAssertThrowsError(try decode(["teams": [], "runs": [], "teamContinuousSupported": bad], as: BotTeamsSnapshot.self))
        }
        XCTAssertEqual(BotTeamLimits().forHost(unrestrictedTeams: true, continuousTeams: true), .continuous)
        let intermediate = BotTeamLimits().forHost(unrestrictedTeams: true)
        XCTAssertEqual(intermediate.maxParallel, 0); XCTAssertEqual(intermediate.maxTurns, 24); XCTAssertEqual(intermediate.maxDurationMs, 600_000)
        XCTAssertEqual(BotTeamLimits.continuous.forHost(unrestrictedTeams: false), BotTeamLimits())
        var draft = sharedDraft(); draft.limits = .continuous
        XCTAssertTrue(BotWorkspaceStore.validTeamDraft(draft, continuousTeams: true))
        XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft, unrestrictedTeams: true))
        draft.limits.maxTurns = 24; XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft, continuousTeams: true))
        draft.limits = .continuous; draft.memberIds.append(draft.memberIds[0])
        XCTAssertFalse(BotWorkspaceStore.validTeamDraft(draft, continuousTeams: true))
    }

    func testContinuousTeamCreateAndEditSendAllZerosWhilePreservingInstructionsExecutionAndRevision() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var revision = 1
        fixture.respond { request in
            var row = self.managedTeam(revision: revision); row["limits"] = ["maxParallel": 0, "maxDepth": 0, "maxHops": 0, "maxTurns": 0, "maxDurationMs": 0]
            if request.httpMethod == "POST" || request.httpMethod == "PATCH" { revision += 1; row["revision"] = revision; return ["team": row] }
            var value = self.settingsSnapshot(); value["teams"] = [row]; value["teamContinuousSupported"] = true; value["teamInstructionsSupported"] = true; return value
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshTeams()
        XCTAssertTrue(workspace.continuousTeams); XCTAssertFalse(workspace.unrestrictedTeams)
        var draft = sharedDraft(); draft.briefing = BotTeamBriefing(instructions: "Keep progress public.", members: [])
        let created = await workspace.createTeam(draft); XCTAssertTrue(created)
        let existing = try XCTUnwrap(workspace.teams?.teams.first)
        let edited = await workspace.updateTeam(existing, draft: draft); XCTAssertTrue(edited)
        let mutations = fixture.requests.filter { $0.method == "POST" || $0.method == "PATCH" }
        XCTAssertEqual(mutations.count, 2)
        let zeros = ["maxParallel": 0, "maxDepth": 0, "maxHops": 0, "maxTurns": 0, "maxDurationMs": 0]
        for request in mutations {
            XCTAssertEqual(request.jsonBody?["limits"] as? [String: Int], zeros)
            XCTAssertEqual(request.jsonBody?["memberIds"] as? [String], draft.memberIds)
            XCTAssertEqual((request.jsonBody?["execution"] as? [String: String])?["workspace"], draft.execution?.workspace)
            XCTAssertEqual((request.jsonBody?["briefing"] as? [String: Any])?["instructions"] as? String, "Keep progress public.")
        }
        XCTAssertEqual(mutations.last?.jsonBody?["expectedRevision"] as? Int, existing.revision)
        XCTAssertFalse(fixture.requests.contains { $0.path.contains("/runs") || $0.path.contains("/computer") || $0.path.contains("/models") })
    }

    func testUnrestrictedAloneKeepsNumericWorkLimitsAndDoesNotSendContinuousZeros() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            if request.httpMethod == "POST" { return ["team": self.managedTeam()] }
            return ["teams": [], "runs": [], "teamUnrestrictedSupported": true]
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshTeams()
        XCTAssertFalse(workspace.continuousTeams)
        let rejected = await workspace.createTeam(BotTeamDraft(name: "Unsupported", memberIds: ["bot_coder", "bot_reviewer"], coordinatorId: "bot_coder", limits: .continuous))
        XCTAssertFalse(rejected); XCTAssertFalse(fixture.requests.contains { $0.method == "POST" })
        let saved = await workspace.createTeam(BotTeamDraft(name: "Intermediate", memberIds: ["bot_coder", "bot_reviewer"], coordinatorId: "bot_coder"))
        XCTAssertTrue(saved)
        let numeric = try XCTUnwrap(fixture.requests.first { $0.method == "POST" }?.jsonBody?["limits"] as? [String: Int])
        XCTAssertEqual(numeric["maxParallel"], 0); XCTAssertEqual(numeric["maxTurns"], 24); XCTAssertEqual(numeric["maxDurationMs"], 600_000)
    }

    func testContinuousRunKeepsActualUsageAndAvoidsZeroBudgetLabels() throws {
        var value = runRecord(); value["consumedTurns"] = 137; value["rosterFanoutTurns"] = 25
        let run = try decode(value, as: BotTeamRun.self)
        XCTAssertEqual(run.consumedTurns, 137); XCTAssertEqual(run.workTurns, 112)
        XCTAssertEqual(run.turnLabel(unrestrictedTeams: true, continuousTeams: true), "137 turns used")
        XCTAssertEqual(run.turnLabel(unrestrictedTeams: true), "112 work turns")
        value["consumedTurns"] = 0; value.removeValue(forKey: "rosterFanoutTurns")
        XCTAssertEqual(try decode(value, as: BotTeamRun.self).turnLabel(unrestrictedTeams: true, continuousTeams: true), "Until finished or stopped")
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

@MainActor
final class TeamWorkReviewTests: XCTestCase {
    private let path = "/v1/bots/teams/team_fixture/jobs/job_fixture"
    private func decode<T: Decodable>(_ value: [String: Any], as type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
    }
    private func task(status: String = "ready_for_review", revision: Int = 1, recovered: Bool = false) -> [String: Any] {
        var work: [String: Any] = ["status": status, "revision": revision, "summary": "Implemented the fix and checked the result.",
            "evidence": [["kind": "test", "label": "Focused checks", "detail": "8 checks passed. Owner review is still required."]],
            "resultHistory": [["id": "result_fixture", "summary": "Implemented the fix and checked the result.", "evidence": [["kind": "file", "label": "Changed file", "detail": "/workspace/Sources/Fix.swift"]], "submittedAt": "2026-10-21T01:00:00Z", "botId": "bot_coder"]], "reviewHistory": []]
        if recovered { work["recoveryJobId"] = "job_recovery" }
        return ["id": "job_fixture", "type": "assignment", "teamId": "team_fixture", "runId": "run_fixture", "botId": "bot_coder", "chatId": "s_fixture", "title": "Fix the issue", "state": "completed", "work": work]
    }
    private func plan(revision: Int = 1, canResume: Bool = true, expiresAt: String = "2099-10-21T01:00:00.000Z") -> [String: Any] {
        ["id": "plan_fixture", "jobId": "job_fixture", "sourceRunId": "run_fixture", "expectedRevision": revision,
         "expiresAt": expiresAt, "canResume": canResume, "botId": "bot_coder", "botName": "Coder", "provider": "codex", "model": "configured-model", "computerLabel": "Saved computer", "workspace": "/workspace/project with spaces", "summary": "Continue the selected unfinished assignment.", "steps": ["Read the retained result.", "Complete only the unfinished work."], "completedReports": [["jobId": "job_finished", "chatId": "s_completed", "summary": "Tests already passed for the other assignment."]]]
    }
    private func recoveryRun() -> [String: Any] {
        ["id": "run_recovery", "teamId": "team_fixture", "rootChatId": "s_recovery", "rootBotId": "bot_coder", "state": "queued", "consumedTurns": 0]
    }
    private func snapshot(_ task: [String: Any], supported: Bool = true) -> [String: Any] { ["activity": [task], "teamWorkReviewSupported": supported] }
    private var teams: [String: Any] { ["teams": [], "runs": [], "teamWorkReviewSupported": true] }

    func testTransportCompletedDoesNotImplyVerifiedAndOldHostsKeepOptionalWork() throws {
        var legacy = task(); legacy["work"] = nil
        XCTAssertNil(try decode(legacy, as: BotWorkspaceActivity.self).work)
        let submitted = try decode(task(), as: BotWorkspaceActivity.self)
        XCTAssertEqual(submitted.state, "completed")
        XCTAssertEqual(submitted.workStatusLabel, "Ready for review")
        XCTAssertTrue(submitted.work?.canReview == true)
        XCTAssertEqual(submitted.work?.evidence.first?.detail, "8 checks passed. Owner review is still required.")
        XCTAssertEqual(try decode(task(status: "verified"), as: BotWorkspaceActivity.self).workStatusLabel, "Verified")
        XCTAssertFalse(try decode(task(status: "verified"), as: BotWorkspaceActivity.self).work?.canReview == true)
        let old = try decode(["teams": [], "runs": []], as: BotTeamsSnapshot.self)
        XCTAssertNil(old.teamWorkReviewSupported)
        for bad: Any in [1, "true", [true]] {
            XCTAssertThrowsError(try decode(["teams": [], "runs": [], "teamWorkReviewSupported": bad], as: BotTeamsSnapshot.self))
        }
    }
    func testOpeningResultsAndRecoveryReadsOnlyAndKeepsExactContext() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in request.url!.path == self.path + "/recovery" ? ["plan": self.plan()] : self.snapshot(self.task(status: "interrupted")) }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshActivity()
        let item = try XCTUnwrap(workspace.activity.first)
        await workspace.refreshRecovery(item)
        let saved = try XCTUnwrap(workspace.recoveryPlans[item.id])
        XCTAssertEqual(saved.workspace, "/workspace/project with spaces")
        XCTAssertEqual(saved.completedReports.first?.chatId, "s_completed")
        XCTAssertFalse(saved.isExpired())
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        XCTAssertEqual(fixture.requests.map(\.path), ["/v1/bots/activity", path + "/recovery"])
    }
    func testMissingCapabilityRejectsReviewAndRecoveryWithoutRequests() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { _ in self.snapshot(self.task(), supported: false) }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshActivity()
        let item = try XCTUnwrap(workspace.activity.first), before = fixture.requests.count
        let reviewed = await workspace.reviewWork(item, decision: "accept")
        await workspace.refreshRecovery(item)
        XCTAssertFalse(reviewed); XCTAssertEqual(fixture.requests.count, before)
    }
    func testExplicitReviewBindsRevisionAndDoesNotResumeOrMessage() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var revision = 1
        fixture.respond { request in
            if request.url!.path == self.path + "/review" { revision = 2; return ["activity": self.task(status: "verified", revision: revision)] }
            if request.url!.path == "/v1/bots/teams" { return self.teams }
            return self.snapshot(self.task(status: revision == 1 ? "ready_for_review" : "verified", revision: revision))
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshActivity()
        let item = try XCTUnwrap(workspace.activity.first)
        let reviewed = await workspace.reviewWork(item, decision: "accept", note: "Checked the changed file and tests.")
        XCTAssertTrue(reviewed); XCTAssertEqual(workspace.activity.first?.work?.status, .verified)
        let writes = fixture.requests.filter { $0.method != "GET" }; XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes.first?.path, path + "/review")
        XCTAssertEqual(writes.first?.jsonBody?["expectedRevision"] as? Int, 1)
        XCTAssertEqual(writes.first?.jsonBody?["decision"] as? String, "accept")
        XCTAssertEqual(writes.first?.jsonBody?["note"] as? String, "Checked the changed file and tests.")
        let stale = await workspace.reviewWork(item, decision: "reject")
        XCTAssertFalse(stale); XCTAssertEqual(fixture.requests.filter { $0.method != "GET" }.count, 1)
    }
    func testSubmittedResultCannotBeReviewedWhileItsExecutionIsStillActive() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        var active = task(); active["state"] = "running"
        fixture.respond { _ in self.snapshot(active) }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshActivity()
        let item = try XCTUnwrap(workspace.activity.first)
        XCTAssertTrue(item.isExecutionActive)
        let accepted = await workspace.reviewWork(item, decision: "accept")
        let rejected = await workspace.reviewWork(item, decision: "reject")
        XCTAssertFalse(accepted); XCTAssertFalse(rejected)
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }
    func testRequestChangesRecordsFeedbackAndRetainsEvidenceWithoutRestarting() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var changed = false
        fixture.respond { request in
            if request.url!.path.hasSuffix("/review") { changed = true; return ["activity": self.task(status: "blocked", revision: 2)] }
            if request.url!.path == "/v1/bots/teams" { return self.teams }
            return self.snapshot(self.task(status: changed ? "blocked" : "ready_for_review", revision: changed ? 2 : 1))
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshActivity()
        let item = try XCTUnwrap(workspace.activity.first), evidence = item.work?.evidence
        let changedResult = await workspace.reviewWork(item, decision: "reject", note: "Please include the missing reproduction check.")
        XCTAssertTrue(changedResult); XCTAssertEqual(workspace.activity.first?.work?.status, .blocked)
        XCTAssertEqual(workspace.activity.first?.work?.evidence, evidence)
        let writes = fixture.requests.filter { $0.method != "GET" }; XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes[0].jsonBody?["decision"] as? String, "reject")
        XCTAssertFalse(fixture.requests.contains { $0.path.hasSuffix("/resume") || $0.path.hasSuffix("/messages") })
    }
    func testUnknownResumeResponseCanRetryOnlySamePlanAndIdempotencyWithoutAutoRetry() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            if request.url!.path.hasSuffix("/recovery") { return ["plan": self.plan()] }
            if request.url!.path == "/v1/bots/teams" { return self.teams }
            return self.snapshot(self.task(status: "interrupted"))
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshActivity()
        let item = try XCTUnwrap(workspace.activity.first); await workspace.refreshRecovery(item)
        let prepared = try XCTUnwrap(workspace.recoveryPlans[item.id]), pending = fixture.hold(path + "/resume")
        let first = Task { await workspace.resumeWork(item, plan: prepared, idempotencyKey: "stable_retry") }
        await fulfillment(of: [pending.requested], timeout: 2)
        pending.finish(["error": "The response is unavailable. Check the current task before retrying."], status: 503)
        let result = await first.value; XCTAssertNil(result)
        XCTAssertEqual(workspace.recoveryPlans[item.id], prepared)
        XCTAssertEqual(fixture.requests.filter { $0.method != "GET" }.count, 1)
        fixture.release(path + "/resume")
        let retry = fixture.hold(path + "/resume")
        let second = Task { await workspace.resumeWork(item, plan: prepared, idempotencyKey: "stable_retry") }
        await fulfillment(of: [retry.requested], timeout: 2)
        retry.finish(["error": "The task was already recovered. Refresh the task."], status: 409)
        _ = await second.value
        let writes = fixture.requests.filter { $0.method != "GET" }
        XCTAssertEqual(writes.count, 2)
        XCTAssertEqual(writes[0].jsonBody?["idempotencyKey"] as? String, writes[1].jsonBody?["idempotencyKey"] as? String)
        XCTAssertEqual(writes[0].jsonBody?["planId"] as? String, writes[1].jsonBody?["planId"] as? String)
        XCTAssertNil(workspace.recoveryPlans[item.id])
    }
    func testReviewRejectsForgedDecisionOversizeNoteAndUnknownTask() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { _ in self.snapshot(self.task()) }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshActivity()
        var item = try XCTUnwrap(workspace.activity.first)
        let badDecision = await workspace.reviewWork(item, decision: "autoverify")
        let tooLong = await workspace.reviewWork(item, decision: "reject", note: String(repeating: "😀", count: 1_251))
        let nullNote = await workspace.reviewWork(item, decision: "accept", note: "bad\0note")
        item.teamId = "../another"
        let otherTeam = await workspace.reviewWork(item, decision: "accept")
        XCTAssertFalse(badDecision); XCTAssertFalse(tooLong); XCTAssertFalse(nullNote); XCTAssertFalse(otherTeam)
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }
    func testStaleRecoveryPlanAndExpiredPlanCannotResume() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var response = plan(revision: 2)
        fixture.respond { request in request.url!.path.hasSuffix("/recovery") ? ["plan": response] : self.snapshot(self.task(status: "interrupted")) }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshActivity()
        let item = try XCTUnwrap(workspace.activity.first); await workspace.refreshRecovery(item)
        XCTAssertNil(workspace.recoveryPlans[item.id]); XCTAssertNotNil(workspace.messages[BotWorkspaceStore.workKey(item.id)])
        response = plan(expiresAt: "2000-01-01T00:00:00Z"); await workspace.refreshRecovery(item)
        let expired = try XCTUnwrap(workspace.recoveryPlans[item.id]); XCTAssertTrue(expired.isExpired())
        let resumed = await workspace.resumeWork(item, plan: expired, idempotencyKey: "phone_fixture")
        XCTAssertNil(resumed); XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        var invalid = expired; invalid.expiresAt = "malformed"; XCTAssertTrue(invalid.isExpired())
    }
    func testExplicitResumeUsesOnlySelectedTaskPlanAndStableIdempotency() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var recovered = false
        fixture.respond { request in
            if request.url!.path.hasSuffix("/recovery") { return ["plan": self.plan()] }
            if request.url!.path.hasSuffix("/resume") {
                recovered = true
                var continuation = self.task(status: "working"), work = continuation["work"] as! [String: Any]
                continuation["id"] = "job_recovery"; continuation["runId"] = "run_recovery"; continuation["chatId"] = "s_recovery"
                work["sourceJobId"] = "job_fixture"; continuation["work"] = work
                return ["run": self.recoveryRun(), "activity": continuation]
            }
            if request.url!.path == "/v1/bots/teams" { return self.teams }
            return self.snapshot(self.task(status: "interrupted", revision: recovered ? 2 : 1, recovered: recovered))
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshActivity()
        let item = try XCTUnwrap(workspace.activity.first); await workspace.refreshRecovery(item)
        let prepared = try XCTUnwrap(workspace.recoveryPlans[item.id])
        let resumed = await workspace.resumeWork(item, plan: prepared, idempotencyKey: "phone_recovery_fixture")
        XCTAssertEqual(resumed?.id, "run_recovery"); XCTAssertNil(workspace.recoveryPlans[item.id])
        let writes = fixture.requests.filter { $0.method != "GET" }; XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes.first?.path, path + "/resume")
        XCTAssertEqual(Set(writes.first?.jsonBody?.keys.map { $0 } ?? []), Set(["planId", "expectedRevision", "idempotencyKey"]))
        XCTAssertEqual(writes.first?.jsonBody?["planId"] as? String, "plan_fixture")
        XCTAssertEqual(writes.first?.jsonBody?["expectedRevision"] as? Int, 1)
        XCTAssertEqual(writes.first?.jsonBody?["idempotencyKey"] as? String, "phone_recovery_fixture")
        let repeated = await workspace.resumeWork(item, plan: prepared, idempotencyKey: "phone_recovery_fixture")
        XCTAssertNil(repeated); XCTAssertEqual(fixture.requests.filter { $0.method != "GET" }.count, 1)
    }
    func testConflictClearsPlanRefreshesReadOnlyAndDoesNotAutoRetry() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { request in
            if request.url!.path.hasSuffix("/recovery") { return ["plan": self.plan()] }
            if request.url!.path == "/v1/bots/teams" { return self.teams }
            return self.snapshot(self.task(status: "interrupted"))
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshActivity()
        let item = try XCTUnwrap(workspace.activity.first); await workspace.refreshRecovery(item)
        let prepared = try XCTUnwrap(workspace.recoveryPlans[item.id]), refused = fixture.hold(path + "/resume")
        let action = Task { await workspace.resumeWork(item, plan: prepared, idempotencyKey: "phone_conflict") }
        await fulfillment(of: [refused.requested], timeout: 2)
        refused.finish(["error": "The task changed. Prepare a fresh recovery plan."], status: 409)
        let result = await action.value
        XCTAssertNil(result); XCTAssertNil(workspace.recoveryPlans[item.id])
        XCTAssertTrue(workspace.messages[BotWorkspaceStore.workKey(item.id)]?.contains("changed") == true)
        XCTAssertEqual(fixture.requests.filter { $0.method != "GET" }.count, 1)
    }
    func testRevokedPairingCannotPublishLateRecoveryOrReview() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        fixture.respond { _ in self.snapshot(self.task(status: "interrupted")) }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(); await workspace.refreshActivity()
        let item = try XCTUnwrap(workspace.activity.first), pending = fixture.hold(path + "/recovery")
        let reading = Task { await workspace.refreshRecovery(item) }
        await fulfillment(of: [pending.requested], timeout: 2)
        store.forgetMac(); pending.finish(["plan": plan()]); await reading.value
        XCTAssertNil(workspace.recoveryPlans[item.id]); XCTAssertEqual(fixture.deletedConnections, 1)
        let rejected = await workspace.reviewWork(item, decision: "accept")
        XCTAssertFalse(rejected); XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }
}

@MainActor
final class TeamWorkOverviewTests: XCTestCase {
    private func task(_ id: String, status: String = "blocked", state: String = "completed", legacy: Any? = nil, recovery: String? = nil, updatedAt: Any? = nil) throws -> BotWorkspaceActivity {
        var work: [String: Any] = ["status": status, "revision": 1, "evidence": [], "resultHistory": [], "reviewHistory": []]
        if let legacy { work["legacy"] = legacy }
        if let recovery { work["recoveryJobId"] = recovery }
        var row: [String: Any] = ["id": id, "teamId": "team_fixture", "runId": "run_fixture", "type": "delivery", "title": id, "state": state, "work": work]
        if let updatedAt { row["updatedAt"] = updatedAt }
        return try JSONDecoder().decode(BotWorkspaceActivity.self, from: JSONSerialization.data(withJSONObject: row))
    }
    func testActivityInitialFailureDoesNotClaimEmptyAndAcceptedSuccessAloneSetsLoaded() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        let first = fixture.hold("/v1/bots/activity")
        let failed = Task { await workspace.refreshActivity() }
        await fulfillment(of: [first.requested], timeout: 2)
        first.finish(["error": "Activity is unavailable."], status: 503)
        await failed.value
        XCTAssertFalse(workspace.activityLoaded); XCTAssertNotNil(workspace.messages["activity"])
        fixture.release("/v1/bots/activity")
        fixture.respond { _ in ["activity": [], "teamWorkReviewSupported": true] }
        await workspace.refreshActivity()
        XCTAssertTrue(workspace.activityLoaded); XCTAssertTrue(workspace.activity.isEmpty); XCTAssertNil(workspace.messages["activity"])
        let next = fixture.hold("/v1/bots/activity")
        let laterFailure = Task { await workspace.refreshActivity() }
        await fulfillment(of: [next.requested], timeout: 2)
        next.finish(["error": "Refresh failed."], status: 503)
        await laterFailure.value
        XCTAssertTrue(workspace.activityLoaded); XCTAssertNotNil(workspace.messages["activity"])
    }
    func testReasonRepliesRemainUnavailableAndCannotEraseEarlierAcceptedRows() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var mode = 0
        fixture.respond { _ in
            if mode != 1 { return ["activity": [], "reason": "Update Strata to show current work.", "teamWorkReviewSupported": true] }
            return ["activity": [["id": "row_saved", "teamId": "team_fixture", "runId": "run_fixture", "type": "run", "title": "Saved activity", "state": "completed"]], "teamWorkReviewSupported": true]
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        await workspace.refreshActivity(); XCTAssertFalse(workspace.activityLoaded)
        mode = 1; await workspace.refreshActivity()
        XCTAssertTrue(workspace.activityLoaded); XCTAssertEqual(workspace.activity.first?.id, "row_saved")
        mode = 2; await workspace.refreshActivity()
        XCTAssertTrue(workspace.activityLoaded); XCTAssertEqual(workspace.activity.first?.id, "row_saved")
        XCTAssertNotNil(workspace.messages["activity"])
    }
    func testLateActivityAfterRevocationCannotPublishSuccessfulLoadedState() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore(), pending = fixture.hold("/v1/bots/activity")
        let reading = Task { await workspace.refreshActivity() }
        await fulfillment(of: [pending.requested], timeout: 2)
        store.forgetMac(); pending.finish(["activity": [], "teamWorkReviewSupported": true]); await reading.value
        XCTAssertFalse(workspace.activityLoaded); XCTAssertFalse(workspace.activityWorkReviewSupported)
        XCTAssertTrue(workspace.activity.isEmpty)
    }
    func testOnlyExplicitTerminalLegacyAndVerifiedMoveToHistory() throws {
        let modernMissingMetadata = try task("modern"), explicitModern = try task("explicit", legacy: false)
        let legacy = try task("historical", legacy: true), verified = try task("verified", status: "verified")
        XCTAssertNil(modernMissingMetadata.work?.summary)
        XCTAssertTrue(modernMissingMetadata.work?.evidence.isEmpty == true)
        XCTAssertTrue(modernMissingMetadata.isCurrentWork); XCTAssertTrue(explicitModern.isCurrentWork)
        XCTAssertFalse(legacy.isCurrentWork); XCTAssertFalse(verified.isCurrentWork)
        XCTAssertEqual(legacy.workStatusLabel, "Earlier turn")
        let view = BotTeamWorkOverview([legacy, verified, modernMissingMetadata, explicitModern])
        XCTAssertEqual(view.current.map(\.id), ["modern", "explicit"])
        XCTAssertEqual(view.history.map(\.id), ["historical", "verified"])
        XCTAssertEqual(view.attentionCount, 2)
        for malformed: Any in ["true", 1, [true]] { XCTAssertThrowsError(try task("bad", legacy: malformed)) }
    }
    func testReadyForReviewCannotBeHiddenByContradictoryLegacyOrRecoveryMetadata() throws {
        let ready = try task("ready", status: "ready_for_review", legacy: true, recovery: "recovery_job")
        XCTAssertTrue(ready.isCurrentWork); XCTAssertTrue(ready.needsOwnerAttention)
        XCTAssertEqual(ready.workStatusLabel, "Ready for review")
        let activeReady = try task("active_ready", status: "ready_for_review", state: "running", legacy: true, recovery: "recovery_job")
        XCTAssertTrue(activeReady.isCurrentWork); XCTAssertTrue(activeReady.isWorkingNow)
        XCTAssertFalse(activeReady.needsOwnerAttention); XCTAssertEqual(activeReady.workStatusLabel, "Working")
        XCTAssertEqual(BotTeamWorkOverview([ready, activeReady]).attentionCount, 1)
        let working = try task("working", status: "working", state: "completed", legacy: true)
        XCTAssertTrue(working.isCurrentWork); XCTAssertTrue(working.isWorkingNow)
        XCTAssertFalse(working.isClosedLegacyWork); XCTAssertEqual(working.workStatusLabel, "Working")
    }
    func testEveryActiveOrCleanupStateRemainsCurrentEvenLegacyOrVerified() throws {
        for state in ["queued", "running", "stopping", "cleanup_pending"] {
            for status in ["working", "blocked", "verified"] {
                let row = try task("active_" + state, status: status, state: state, legacy: true)
                XCTAssertTrue(row.isExecutionActive); XCTAssertTrue(row.isCurrentWork)
                XCTAssertTrue(row.isWorkingNow); XCTAssertFalse(row.needsOwnerAttention)
                XCTAssertEqual(BotTeamWorkOverview([row]).history.count, 0)
            }
        }
    }
    func testAttentionThenWorkingThenOtherCurrentPreservesStableOrderAndUsesRealDates() throws {
        let oldAttention = try task("older_attention", updatedAt: "2026-10-21T01:00:00Z")
        let newAttention = try task("newer_attention", status: "ready_for_review", updatedAt: "2026-10-21T02:00:00Z")
        let work = try task("working", status: "working", state: "running", updatedAt: "2026-10-21T03:00:00Z")
        let continued = try task("continued", recovery: "recovery_job", updatedAt: "2026-10-21T04:00:00Z")
        let view = BotTeamWorkOverview([continued, work, oldAttention, newAttention])
        XCTAssertEqual(view.current.map(\.id), ["newer_attention", "older_attention", "working", "continued"])
        XCTAssertEqual(view.attentionCount, 2); XCTAssertEqual(view.workingCount, 1)
        XCTAssertEqual(continued.workStatusLabel, "Continuation created")
        XCTAssertTrue(continued.isCurrentWork); XCTAssertFalse(continued.needsOwnerAttention)
        let undated = try task("undated")
        XCTAssertEqual(BotTeamWorkOverview([undated, oldAttention, newAttention]).current.map(\.id), ["newer_attention", "older_attention", "undated"])
        XCTAssertEqual(BotTeamWorkOverview([try task("first"), try task("second")]).current.map(\.id), ["first", "second"])
    }
    func testEarlierUnverifiedCountDoesNotHideFollowUpOrPromoteHistoryIntoCurrentWork() throws {
        let earlier = try (0..<32).map { index in try task("earlier_\(index)", status: index == 0 ? "interrupted" : "blocked", legacy: true) }
        let view = BotTeamWorkOverview(earlier + [try task("verified", status: "verified")])
        XCTAssertEqual(view.attentionCount, 0); XCTAssertEqual(view.workingCount, 0)
        XCTAssertTrue(view.current.isEmpty); XCTAssertEqual(view.history.count, 33)
        XCTAssertEqual(view.earlierUnverifiedCount, 32)
        XCTAssertEqual(view.earlierUnverifiedSummary, "32 earlier turns have no verified result.")
        let single = BotTeamWorkOverview([try task("earlier", legacy: true)])
        XCTAssertEqual(single.earlierUnverifiedSummary, "1 earlier turn has no verified result.")
        let current = BotTeamWorkOverview([try task("modern", status: "blocked"), try task("active", status: "working", state: "running", legacy: true)])
        XCTAssertEqual(current.earlierUnverifiedCount, 0)
        XCTAssertEqual(current.current.count, 2)
    }
    func testRequestTransportCompletionDoesNotClaimTaskVerification() throws {
        let payload: [String: Any] = ["id": "run_fixture", "teamId": "team_fixture", "rootChatId": "s_fixture", "rootBotId": "bot_fixture", "state": "completed", "consumedTurns": 1]
        let run = try JSONDecoder().decode(BotTeamRun.self, from: JSONSerialization.data(withJSONObject: payload))
        XCTAssertEqual(run.requestStateLabel(workReviewSupported: true), "Turn finished")
        XCTAssertEqual(run.requestStateLabel(workReviewSupported: false), "Completed")
        XCTAssertFalse(run.isActive)
    }
    func testEvidenceCountsLatestRequestedChangesAndTimestampRemainSeparateFromStatus() throws {
        var row = try task("notes", updatedAt: 1_792_540_800_000)
        row.work?.evidence = [BotTeamEvidence(kind: "file", label: "Source", detail: "/workspace/main.swift"), BotTeamEvidence(kind: "test", label: "Checks", detail: "8 checks passed"), BotTeamEvidence(kind: "test", label: "Regression", detail: "2 checks passed")]
        row.work?.reviewHistory = [BotTeamOwnerReview(decision: "reject", note: "Keep the existing pairing.", reviewedAt: .iso8601("2026-10-21T00:00:00Z"), resultId: "result_one")]
        XCTAssertEqual(row.work?.evidenceSummary, "1 file · 2 test results")
        XCTAssertEqual(row.work?.latestRequestedChanges, "Keep the existing pairing.")
        XCTAssertNotNil(row.latestWorkDate)
        row.work?.reviewHistory.append(BotTeamOwnerReview(decision: "accept", reviewedAt: .iso8601("2026-10-21T01:00:00Z"), resultId: "result_one"))
        XCTAssertNil(row.work?.latestRequestedChanges)
        XCTAssertEqual(row.work?.status, .blocked, "Metadata does not rewrite the host's current state.")
    }
}

@MainActor
final class BotHarnessClientTests: XCTestCase {
    private let path = "/v1/bots/harness/actions"
    private func row(state: String = "uncertain", revision: Int = 2, origin: String = "local", readOnly: Bool = false, proof: String = String(repeating: "a", count: 64)) -> [String: Any] {
        ["id": "ba_" + String(repeating: "1", count: 64), "chatId": "s_fixture", "toolName": "run_command", "state": state, "revision": revision, "proof": proof, "origin": origin, "readOnly": readOnly]
    }
    private func snapshot(_ action: [String: Any], available: Bool = true) -> [String: Any] { ["available": available, "actions": [action], "counts": ["uncertain": 1], "hasMore": false] }
    private func decode<T: Decodable>(_ value: Any, as: T.Type) throws -> T { try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: value)) }

    func testActionReviewabilityRequiresValidProofAndLocalMutableOrigin() throws {
        XCTAssertTrue(try decode(row(), as: BotHarnessAction.self).canReview)
        for changed in [row(state: "pending"), row(revision: 0), row(origin: "ssh-worker", readOnly: true), row(origin: "future"), row(readOnly: true), row(proof: "not-a-proof")] {
            XCTAssertFalse(try decode(changed, as: BotHarnessAction.self).canReview)
        }
    }
    func testRealJournalEpochTimestampAndLegacyStringDecodeWithoutLosingReviewProof() throws {
        for timestamp in [1_792_621_234_567.0, "2026-10-22T03:00:00Z"] as [Any] {
            let action = try decode(row().merging(["startedAt": timestamp, "updatedAt": timestamp]) { _, new in new }, as: BotHarnessAction.self)
            XCTAssertTrue(action.canReview); XCTAssertNotNil(action.updatedAt?.date)
        }
    }
    func testLateReceiptPollAfterPairingRevocationCannotPublishOldJournal() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore()
        let held = fixture.hold(path), refresh = Task { await workspace.refreshHarnessActions(force: true) }
        await fulfillment(of: [held.requested], timeout: 2); owner.forgetMac(); held.finish(snapshot(row())); await refresh.value
        XCTAssertNil(workspace.harnessActions); XCTAssertNil(workspace.messages["harnessActions"]); XCTAssertFalse(workspace.loading.contains("harnessActions"))
    }
    func testAcknowledgementThatClaimsAutomaticRetryOrResumeIsRejected() async throws {
        for changed in ["resumed", "retried"] {
            let fixture = StoreTransport(); defer { fixture.close() }
            fixture.respond { request in
                if request.httpMethod != "POST" { return self.snapshot(self.row()) }
                var result: [String: Any] = ["acknowledged": true, "action": self.row(state: "reviewed", revision: 3, proof: String(repeating: "b", count: 64)), "resumed": false, "retried": false]; result[changed] = true; return result
            }
            let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore(); await workspace.refreshHarnessActions()
            let action = try XCTUnwrap(workspace.harnessActions?.actions.first), accepted = await workspace.reviewHarnessAction(action)
            XCTAssertFalse(accepted); XCTAssertEqual(fixture.requests.filter { $0.method != "GET" }.count, 1); XCTAssertNotNil(workspace.messages["harnessActions"])
        }
    }
    func testDiagnosticsValidateBoundedValuesAndKeepProviderTimingHonest() throws {
        let value: [String: Any] = ["phase": "model", "elapsedMs": 4200, "firstOutputMs": 1200, "timings": ["startingMs": 200, "modelMs": 3000, "approvalMs": 500, "toolMs": 400, "cleanupMs": 100], "toolCalls": 2, "toolErrors": 1, "contextCompactions": 1]
        let decoded = try decode(value, as: BotHarnessDiagnostics.self)
        XCTAssertTrue(decoded.isValid); XCTAssertEqual(decoded.label, "Waiting for provider"); XCTAssertEqual(BotHarnessDiagnostics.seconds(decoded.elapsedMs), "4.2s")
        for patch in [["phase": "future"], ["elapsedMs": -1], ["toolCalls": 604_800_001]] as [[String: Any]] {
            XCTAssertFalse(try decode(value.merging(patch) { _, new in new }, as: BotHarnessDiagnostics.self).isValid)
        }
    }
    func testInitialReceiptFailureRemainsUnavailableUntilExplicitReadOnlyRefreshSucceeds() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore()
        let held = fixture.hold(path), refreshing = Task { await workspace.refreshHarnessActions(force: true) }
        await fulfillment(of: [held.requested], timeout: 2); held.finish(["error": "Receipts unavailable"], status: 503); await refreshing.value
        XCTAssertNil(workspace.harnessActions); XCTAssertNotNil(workspace.messages["harnessActions"])
        fixture.release(path)
        fixture.respond { _ in self.snapshot(self.row()) }; await workspace.refreshHarnessActions(force: true)
        XCTAssertTrue(workspace.harnessActions?.available == true); XCTAssertNil(workspace.messages["harnessActions"]); XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }
    func testReceiptPollingCoalescesUnchangedPublicationsAndOnlyForceBypassesItsReadThrottle() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; fixture.respond { _ in self.snapshot(self.row()) }
        let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore(); await workspace.refreshHarnessActions()
        var publications = 0; let observer = workspace.$harnessActions.dropFirst().sink { _ in publications += 1 }; defer { observer.cancel() }
        await workspace.refreshHarnessActions(); await workspace.refreshHarnessActions(force: true)
        XCTAssertEqual(fixture.requests.count, 2); XCTAssertEqual(publications, 0); XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }
    func testExactAcknowledgementSendsOnlyProofThenRefreshesWithoutRetryResumeOrNavigation() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var reviewed = false
        fixture.respond { request in
            if request.httpMethod == "POST" { reviewed = true; return ["acknowledged": true, "action": self.row(state: "reviewed", revision: 3, proof: String(repeating: "b", count: 64)), "resumed": false, "retried": false] }
            return self.snapshot(self.row(state: reviewed ? "reviewed" : "uncertain", revision: reviewed ? 3 : 2))
        }
        let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore(); await workspace.refreshHarnessActions()
        let action = try XCTUnwrap(workspace.harnessActions?.actions.first)
        let accepted = await workspace.reviewHarnessAction(action); XCTAssertTrue(accepted)
        let writes = fixture.requests.filter { $0.method != "GET" }; XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes.first?.path, path + "/" + action.id + "/review")
        XCTAssertEqual(Set(writes.first?.jsonBody?.keys.map { $0 } ?? []), ["expectedRevision", "expectedProof", "decision"])
        XCTAssertEqual(writes.first?.jsonBody?["expectedProof"] as? String, action.proof); XCTAssertEqual(writes.first?.jsonBody?["expectedRevision"] as? Int, 2)
        XCTAssertEqual(writes.first?.jsonBody?["decision"] as? String, "acknowledge"); XCTAssertEqual(workspace.harnessActions?.actions.first?.state, "reviewed"); XCTAssertNil(owner.currentConversation)
        let duplicate = await workspace.reviewHarnessAction(action); XCTAssertFalse(duplicate); XCTAssertEqual(fixture.requests.filter { $0.method != "GET" }.count, 1)
    }
    func testReadOnlyRemoteReceiptAndUnavailableOldHostCannotBeAcknowledged() async throws {
        for response in [snapshot(row(origin: "ssh-worker", readOnly: true)), snapshot(row(), available: false)] {
            let fixture = StoreTransport(); defer { fixture.close() }; fixture.respond { _ in response }
            let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore(); await workspace.refreshHarnessActions()
            let action = try XCTUnwrap(workspace.harnessActions?.actions.first), accepted = await workspace.reviewHarnessAction(action)
            XCTAssertFalse(accepted); XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        }
    }
    func testStaleReviewProofAndConflictRefreshNeverReplayTheAcknowledgement() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var response = snapshot(row())
        fixture.respond { _ in response }; let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore(); await workspace.refreshHarnessActions()
        let old = try XCTUnwrap(workspace.harnessActions?.actions.first), pending = fixture.hold(path + "/" + old.id + "/review")
        let reviewing = Task { await workspace.reviewHarnessAction(old) }; await fulfillment(of: [pending.requested], timeout: 2)
        response = snapshot(row(revision: 3, proof: String(repeating: "b", count: 64))); pending.finish(["error": "Refresh the receipt"], status: 409)
        let accepted = await reviewing.value; XCTAssertFalse(accepted); XCTAssertEqual(workspace.harnessActions?.actions.first?.revision, 3); XCTAssertNotNil(workspace.messages["harnessActions"])
        let stale = await workspace.reviewHarnessAction(old); XCTAssertFalse(stale); XCTAssertEqual(fixture.requests.filter { $0.method != "GET" }.count, 1)
    }
    func testUnexpectedAckIdentityOriginRevisionOrReplayCannotBeReportedAsAccepted() async throws {
        for patch in [["revision": 2], ["origin": "ssh-worker", "readOnly": true], ["proof": "invalid"], ["proof": String(repeating: "a", count: 64)], ["chatId": "another_chat"]] as [[String: Any]] {
            let fixture = StoreTransport(); defer { fixture.close() }
            fixture.respond { request in request.httpMethod == "POST" ? ["acknowledged": true, "action": self.row(state: "reviewed", revision: 3, proof: String(repeating: "b", count: 64)).merging(patch) { _, new in new }, "resumed": false, "retried": false] : self.snapshot(self.row()) }
            let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore(); await workspace.refreshHarnessActions()
            let action = try XCTUnwrap(workspace.harnessActions?.actions.first), accepted = await workspace.reviewHarnessAction(action)
            XCTAssertFalse(accepted); XCTAssertNotNil(workspace.messages["harnessActions"]); XCTAssertEqual(fixture.requests.filter { $0.method != "GET" }.count, 1)
        }
    }
    func testPairingRevocationDiscardsLateReceiptAndLateAckWithoutPublishingOrRefreshing() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; fixture.respond { _ in self.snapshot(self.row()) }
        let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore(); await workspace.refreshHarnessActions()
        let action = try XCTUnwrap(workspace.harnessActions?.actions.first), pending = fixture.hold(path + "/" + action.id + "/review")
        let reviewing = Task { await workspace.reviewHarnessAction(action) }; await fulfillment(of: [pending.requested], timeout: 2)
        owner.forgetMac(); pending.finish(["acknowledged": true, "action": row(state: "reviewed", revision: 3, proof: String(repeating: "b", count: 64)), "resumed": false, "retried": false])
        let accepted = await reviewing.value; XCTAssertFalse(accepted); XCTAssertEqual(workspace.harnessActions?.actions.first?.state, "uncertain"); XCTAssertEqual(fixture.requests.filter { $0.method == "GET" }.count, 1); XCTAssertNil(workspace.messages["harnessActions"])
    }
    func testOlderForcedReceiptPollCannotReplaceNewerReceiptProof() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore()
        let first = fixture.hold(path), one = Task { await workspace.refreshHarnessActions(force: true) }; await fulfillment(of: [first.requested], timeout: 2)
        let second = fixture.hold(path), two = Task { await workspace.refreshHarnessActions(force: true) }; await fulfillment(of: [second.requested], timeout: 2)
        second.finish(snapshot(row(state: "reviewed", revision: 3, proof: String(repeating: "b", count: 64)))); await two.value
        first.finish(snapshot(row())); await one.value
        XCTAssertEqual(workspace.harnessActions?.actions.first?.state, "reviewed"); XCTAssertEqual(workspace.harnessActions?.actions.first?.revision, 3)
    }
}

extension BotCreatedToolsTests {
    func testRequirementsMatchDeclarativeBackendBoundsAndRejectUnknownOrNullFields() throws {
        let valid: [String: Any] = ["platforms": ["darwin", "linux", "win32"], "executables": ["python3", "clang++", "app.exe"], "workspaceFiles": ["nested/it's $(safe) `data`.txt", String(repeating: "🦊", count: 120)]]
        XCTAssertTrue(try decode(valid, as: BotToolRequirements.self).isValid)
        for invalid in [["probe": "touch BAD"], ["executables": NSNull()], ["platforms": ["macos"]], ["platforms": ["linux", "linux"]], ["executables": ["node --version"]], ["executables": ["/bin/sh"]], ["executables": ["node\n"]], ["executables": (0..<17).map { "x\($0)" }], ["workspaceFiles": ["../private"]], ["workspaceFiles": ["a//b"]], ["workspaceFiles": ["C:foo"]], ["workspaceFiles": ["a\\b"]], ["workspaceFiles": ["a\nb"]], ["workspaceFiles": [String(repeating: "🦊", count: 121)]]] as [[String: Any]] {
            XCTAssertThrowsError(try decode(invalid, as: BotToolRequirements.self), "\(invalid)")
        }
    }
    func testRequirementsEditAndClearUseReviewedProofAndAlwaysDraftWithoutExecuting() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; var tool = row(status: "enabled"); tool["requirements"] = ["executables": ["node"]]
        fixture.respond { request in request.httpMethod == "PATCH" ? ["tool": tool] : self.snapshot(tool).merging(["createdToolReadinessSupported": true]) { _, new in new } }
        let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore(); await workspace.refreshCreatedTools()
        let reviewed = try XCTUnwrap(workspace.createdTools?.tools.first); var draft = BotCreatedToolDraft(tool: reviewed); draft.requirements = BotToolRequirements()
        let saved = await workspace.saveCreatedTool(draft, reviewing: reviewed); XCTAssertTrue(saved)
        let body = try XCTUnwrap(fixture.requests.first { $0.method == "PATCH" }?.jsonBody), requirements = try XCTUnwrap(body["requirements"] as? [String: Any])
        XCTAssertEqual(body["expectedDigest"] as? String, reviewed.digest); XCTAssertEqual(body["expectedRevision"] as? Int, reviewed.revision); XCTAssertEqual(body["status"] as? String, "draft")
        XCTAssertEqual(requirements["platforms"] as? [String], []); XCTAssertEqual(requirements["executables"] as? [String], []); XCTAssertEqual(requirements["workspaceFiles"] as? [String], []); XCTAssertNil(body["botIds"]); XCTAssertNil(owner.currentConversation)
    }
    func testOldHostAcceptsLegacyDraftButCannotReceiveRequirementsFields() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }; let tool = row()
        fixture.respond { request in request.httpMethod == "POST" ? ["tool": tool] : self.snapshot(tool) }
        let owner = fixture.makeStore(), workspace = owner.botWorkspaceStore(); await workspace.refreshCreatedTools()
        var draft = BotCreatedToolDraft(tool: try decode(tool, as: BotCreatedTool.self)); draft.requirements = BotToolRequirements(executables: ["node"])
        let unsupported = await workspace.saveCreatedTool(draft); XCTAssertFalse(unsupported); XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        await workspace.refreshCreatedTools(); draft.requirements = nil
        let legacy = await workspace.saveCreatedTool(draft); XCTAssertTrue(legacy); XCTAssertNil(fixture.requests.first { $0.method == "POST" }?.jsonBody?["requirements"])
    }
}

@MainActor
final class TeamWorkflowTests: XCTestCase {
    private var retainedStore: CompanionStore?
    private let teamID = "team_workflow_fixture"
    private let workflowID = "wf_00000000-0000-4000-8000-000000000001"
    private let criterionID = "wc_00000000-0000-4000-8000-000000000001"
    private var listPath: String { "/v1/bots/teams/\(teamID)/workflows" }
    private var detailPath: String { listPath + "/" + workflowID }
    private func teamSnapshot(capability: Bool? = true) -> [String: Any] {
        var value: [String: Any] = ["teams": [["id": teamID, "name": "Workflow team", "memberIds": ["bot_builder", "bot_evaluator"], "coordinatorId": "bot_builder", "enabled": true, "limits": ["maxParallel": 0, "maxDepth": 0, "maxHops": 0, "maxTurns": 0, "maxDurationMs": 0]]], "runs": []]
        if let capability { value["teamWorkflowsSupported"] = capability }
        return value
    }
    private func workflow(phase: String = "awaiting_review", revision: Int = 1, proof: String? = nil) -> [String: Any] {
        ["id": workflowID, "teamId": teamID, "goal": "Improve the fixture", "plannerId": "bot_builder", "builderId": "bot_builder", "evaluatorId": "bot_evaluator",
         "criteria": [["id": criterionID, "text": "The meaningful checks pass"]], "phase": phase, "revision": revision, "proof": proof ?? String(repeating: revision == 1 ? "a" : "b", count: 64), "round": 1,
         "summary": "The evaluator inspected the result.", "createdAt": "2026-10-22T00:00:00Z", "updatedAt": "2026-10-22T00:00:01Z",
         "steps": [["id": "ws_00000000-0000-4000-8000-000000000001", "phase": "evaluating", "botId": "bot_evaluator", "chatId": "saved_step_chat", "state": "completed", "summary": "Built the requested change.", "evidence": [["kind": "test", "label": "Fixture check", "detail": "Saved evidence, no command was run by this unit test."]]]],
         "checks": [["criterionId": criterionID, "passed": true, "detail": "The evaluator checked this criterion."]], "canResume": ["blocked", "interrupted", "stopped"].contains(phase), "totalSteps": 1, "stepsTruncated": false]
    }
    private func list(_ rows: [[String: Any]], available: Bool = true) -> [String: Any] { ["teamWorkflowsSupported": true, "available": available, "workflows": rows, "hasMore": false] }
    private func decode(_ value: [String: Any]) throws -> BotTeamWorkflow { try JSONDecoder().decode(BotTeamWorkflow.self, from: JSONSerialization.data(withJSONObject: value)) }
    private func draft() -> BotTeamWorkflowDraft { BotTeamWorkflowDraft(requestId: "request_fixture", goal: "Improve the fixture", plannerId: "bot_builder", builderId: "bot_builder", evaluatorId: "bot_evaluator", criteria: ["The meaningful checks pass"]) }
    private func loaded(_ fixture: StoreTransport, row: [String: Any]? = nil, capability: Bool? = true) async -> (CompanionStore, BotWorkspaceStore) {
        fixture.respond { request in
            if request.url!.path == "/v1/bots/teams" { return self.teamSnapshot(capability: capability) }
            if request.url!.path == self.listPath { return self.list([row ?? self.workflow()]) }
            if request.url!.path == self.detailPath { return ["workflow": row ?? self.workflow()] }
            return nil
        }
        let store = fixture.makeStore(), workspace = store.botWorkspaceStore()
        retainedStore = store
        await workspace.refreshTeams(); await workspace.refreshWorkflows(teamID)
        return (store, workspace)
    }
    func testWorkflowModelSeparatesEvaluatorPassFromOwnerAcceptance() throws {
        let ready = try decode(workflow()); XCTAssertTrue(ready.hasValidProof); XCTAssertTrue(ready.canReview)
        XCTAssertTrue(ready.checks.first?.passed == true); XCTAssertEqual(ready.phase.label, "Ready for your review")
        let accepted = try decode(workflow(phase: "completed", revision: 2)); XCTAssertEqual(accepted.phase.label, "Accepted by you"); XCTAssertFalse(accepted.canReview)
        let interrupted = try decode(workflow(phase: "interrupted")); XCTAssertTrue(interrupted.canContinue); XCTAssertFalse(interrupted.canStop)
        let active = try decode(workflow(phase: "repairing")); XCTAssertTrue(active.canStop); XCTAssertFalse(active.canContinue)
    }
    func testInvalidProofRolesUnknownCriteriaAndStepIdentitiesHaveNoAuthority() throws {
        for key in ["proof", "evaluatorId", "criteria", "checks", "steps", "totalSteps"] {
            var row = workflow()
            switch key {
            case "proof": row[key] = "not-a-proof"
            case "evaluatorId": row[key] = "bot_builder"
            case "criteria": row[key] = []
            case "checks": row[key] = [["criterionId": "outside", "passed": true, "detail": "unrelated"]]
            case "steps": row[key] = [["id": "../outside", "phase": "building", "botId": "bot_builder", "state": "completed"]]
            default: row[key] = 0
            }
            XCTAssertFalse(try decode(row).hasValidProof, key)
        }
    }
    func testDraftRequiresSavedDistinctEvaluatorAndUTF16BoundsWithoutRoundLimits() {
        let members = ["bot_builder", "bot_evaluator"]
        var value = draft(); XCTAssertTrue(value.isValid(memberIds: members))
        value.evaluatorId = value.builderId; XCTAssertFalse(value.isValid(memberIds: members))
        value = draft(); value.plannerId = "outside"; XCTAssertFalse(value.isValid(memberIds: members))
        value = draft(); value.criteria = []; XCTAssertFalse(value.isValid(memberIds: members))
        value = draft(); value.criteria = Array(repeating: "Check", count: 17); XCTAssertFalse(value.isValid(memberIds: members))
        value = draft(); value.criteria = [String(repeating: "😀", count: 501)]; XCTAssertFalse(value.isValid(memberIds: members))
        value = draft(); value.goal = String(repeating: "😀", count: 8_001); XCTAssertFalse(value.isValid(memberIds: members))
        value = draft(); value.criteria = ["unsafe\0criterion"]; XCTAssertFalse(value.isValid(memberIds: members))
        XCTAssertEqual(BotTeamWorkflowDraft.criteria(from: " First check \n\n Second check\r\n"), ["First check", "Second check"])
    }
    func testOlderHostDoesNotReceiveWorkflowRequestsOrMutation() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let (_, workspace) = await loaded(fixture, capability: nil)
        XCTAssertFalse(workspace.workflowsSupported); XCTAssertNil(workspace.workflows[teamID])
        let created = await workspace.createWorkflow(teamId: teamID, draft: draft()); XCTAssertNil(created)
        XCTAssertEqual(fixture.requests.map(\.path), ["/v1/bots/teams"])
    }
    func testUnavailableCapabilityAndInvalidRowsKeepMutationDisabled() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let (_, workspace) = await loaded(fixture)
        fixture.respond { request in request.url!.path == self.listPath ? self.list([], available: false) : nil }
        await workspace.refreshWorkflows(teamID)
        let created = await workspace.createWorkflow(teamId: teamID, draft: draft()); XCTAssertNil(created)
        XCTAssertNotNil(workspace.messages[BotWorkspaceStore.workflowsKey(teamID)])
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }
    func testCreationUsesOnlySavedRolesGoalCriteriaAndStableRequestID() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let (_, workspace) = await loaded(fixture)
        var createdRow = workflow(phase: "planning"); createdRow["id"] = "wf_00000000-0000-4000-8000-000000000002"
        fixture.respond { request in
            if request.url!.path == self.listPath, request.httpMethod == "POST" { return ["workflow": createdRow] }
            if request.url!.path == self.listPath { return self.list([createdRow]) }
            return nil
        }
        let created = await workspace.createWorkflow(teamId: teamID, draft: draft())
        XCTAssertEqual(created?.phase, .planning)
        let post = try XCTUnwrap(fixture.requests.first { $0.method == "POST" })
        XCTAssertEqual(Set(post.jsonBody!.keys), ["requestId", "goal", "plannerId", "builderId", "evaluatorId", "criteria"])
        XCTAssertEqual(post.jsonBody?["requestId"] as? String, "request_fixture")
        XCTAssertEqual(post.jsonBody?["criteria"] as? [String], ["The meaningful checks pass"])
        XCTAssertFalse(fixture.requests.contains { $0.path.contains("/models") || $0.path.contains("/connections") || $0.path.contains("/computer") })
    }
    func testResumeRequiresInspectionAndExactCurrentProof() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let (_, workspace) = await loaded(fixture, row: workflow(phase: "interrupted"))
        let current = try XCTUnwrap(workspace.workflow(workflowID, teamId: teamID))
        let uninspected = await workspace.changeWorkflow(current, action: "resume", requestId: "resume_fixture"); XCTAssertFalse(uninspected)
        var stale = current; stale.proof = String(repeating: "c", count: 64)
        let staleResult = await workspace.changeWorkflow(stale, action: "resume", requestId: "resume_fixture", inspected: true); XCTAssertFalse(staleResult)
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        fixture.respond { request in ["workflow": self.workflow(phase: "building", revision: 3)] }
        let resumed = await workspace.changeWorkflow(current, action: "resume", requestId: "resume_fixture", inspected: true); XCTAssertTrue(resumed)
        let post = try XCTUnwrap(fixture.requests.first { $0.method == "POST" })
        XCTAssertEqual(post.path, detailPath + "/resume"); XCTAssertEqual(post.jsonBody?["expectedRevision"] as? Int, 1)
        XCTAssertEqual(post.jsonBody?["expectedProof"] as? String, current.proof); XCTAssertEqual(post.jsonBody?["inspected"] as? Bool, true)
        XCTAssertEqual(post.jsonBody?["requestId"] as? String, "resume_fixture")
        XCTAssertEqual(Set(post.jsonBody!.keys), ["expectedRevision", "expectedProof", "requestId", "inspected"])
    }
    func testOwnerAcceptanceWaitsForExactAcknowledgedCompletedRevision() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let (_, workspace) = await loaded(fixture); let original = try XCTUnwrap(workspace.workflow(workflowID, teamId: teamID))
        let held = fixture.hold(detailPath + "/review")
        let reviewing = Task { await workspace.changeWorkflow(original, action: "review", decision: "accept", note: "Reviewed the evidence") }
        await fulfillment(of: [held.requested], timeout: 2)
        XCTAssertEqual(workspace.workflow(workflowID, teamId: teamID)?.phase, .awaitingReview)
        fixture.respond { _ in ["workflow": self.workflow(phase: "completed", revision: 4)] }
        held.finish(["workflow": workflow(phase: "completed", revision: 4)])
        let confirmed = await reviewing.value; XCTAssertTrue(confirmed); XCTAssertEqual(workspace.workflow(workflowID, teamId: teamID)?.phase, .completed)
        let post = try XCTUnwrap(fixture.requests.first { $0.method == "POST" })
        XCTAssertEqual(post.jsonBody?["expectedProof"] as? String, original.proof); XCTAssertEqual(post.jsonBody?["decision"] as? String, "accept")
        XCTAssertEqual(Set(post.jsonBody!.keys), ["expectedRevision", "expectedProof", "decision", "note"])
    }
    func testSameProofWrongRevisionOrWrongIdentityCannotConfirmAcceptance() async throws {
        for defect in ["proof", "revision", "id", "phase"] {
            let fixture = StoreTransport(); defer { fixture.close() }
            let (_, workspace) = await loaded(fixture); let original = try XCTUnwrap(workspace.workflow(workflowID, teamId: teamID))
            var response = workflow(phase: "completed", revision: 2)
            if defect == "proof" { response["proof"] = original.proof }
            if defect == "revision" { response["revision"] = 1 }
            if defect == "id" { response["id"] = "wf_00000000-0000-4000-8000-000000000099" }
            if defect == "phase" { response["phase"] = "awaiting_review" }
            fixture.respond { _ in ["workflow": response] }
            let accepted = await workspace.changeWorkflow(original, action: "review", decision: "accept"); XCTAssertFalse(accepted, defect)
            XCTAssertEqual(workspace.workflow(workflowID, teamId: teamID)?.phase, .awaitingReview, defect)
            XCTAssertNotNil(workspace.messages[BotWorkspaceStore.workflowKey(workflowID)])
        }
    }
    func testChangesRequestedAreEvaluatorRepairsNotOwnerCompletion() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let (_, workspace) = await loaded(fixture); let original = try XCTUnwrap(workspace.workflow(workflowID, teamId: teamID))
        fixture.respond { _ in ["workflow": self.workflow(phase: "repairing", revision: 2)] }
        let changed = await workspace.changeWorkflow(original, action: "review", decision: "changes_requested", note: "Please verify the second case")
        XCTAssertTrue(changed); XCTAssertEqual(workspace.workflow(workflowID, teamId: teamID)?.phase, .repairing)
    }
    func testConflictRefreshesReadOnlyAndNeverReplaysResume() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let (_, workspace) = await loaded(fixture, row: workflow(phase: "interrupted")); let original = try XCTUnwrap(workspace.workflow(workflowID, teamId: teamID))
        let held = fixture.hold(detailPath + "/resume")
        let resuming = Task { await workspace.changeWorkflow(original, action: "resume", requestId: "stable_resume", inspected: true) }
        await fulfillment(of: [held.requested], timeout: 2)
        fixture.respond { _ in ["workflow": self.workflow(phase: "building", revision: 2)] }
        held.finish(["error": "Workflow changed"], status: 409)
        let confirmed = await resuming.value; XCTAssertFalse(confirmed)
        XCTAssertEqual(fixture.requests.filter { $0.method == "POST" }.count, 1)
        XCTAssertEqual(fixture.requests.last?.path, detailPath); XCTAssertEqual(fixture.requests.last?.method, "GET")
        XCTAssertEqual(workspace.workflow(workflowID, teamId: teamID)?.phase, .building)
        XCTAssertNotNil(workspace.messages[BotWorkspaceStore.workflowKey(workflowID)])
    }
    func testLateDetailAndMutationCannotPublishAfterPairingIsForgotten() async throws {
        for mutation in [false, true] {
            let fixture = StoreTransport(); defer { fixture.close() }
            let (store, workspace) = await loaded(fixture)
            let original = try XCTUnwrap(workspace.workflow(workflowID, teamId: teamID))
            let held = fixture.hold(detailPath + (mutation ? "/review" : ""))
            let operation = Task { if mutation { _ = await workspace.changeWorkflow(original, action: "review", decision: "accept") } else { await workspace.refreshWorkflow(self.workflowID, teamId: self.teamID) } }
            await fulfillment(of: [held.requested], timeout: 2)
            store.forgetMac(); held.finish(["workflow": workflow(phase: "completed", revision: 2)])
            await operation.value
            XCTAssertEqual(workspace.workflow(workflowID, teamId: teamID)?.phase, .awaitingReview)
            XCTAssertFalse(store.isPaired); XCTAssertNil(workspace.messages[BotWorkspaceStore.workflowKey(workflowID)])
        }
    }
    func testNewerMutationInvalidatesAnOlderListResponse() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let (_, workspace) = await loaded(fixture); let original = try XCTUnwrap(workspace.workflow(workflowID, teamId: teamID))
        let old = fixture.hold(listPath); let refreshing = Task { await workspace.refreshWorkflows(self.teamID) }
        await fulfillment(of: [old.requested], timeout: 2); fixture.release(listPath)
        fixture.respond { request in
            if request.url!.path == self.listPath { return self.list([self.workflow(phase: "completed", revision: 2)]) }
            return ["workflow": self.workflow(phase: "completed", revision: 2)]
        }
        let accepted = await workspace.changeWorkflow(original, action: "review", decision: "accept"); XCTAssertTrue(accepted)
        old.finish(list([workflow()])); await refreshing.value
        XCTAssertEqual(workspace.workflow(workflowID, teamId: teamID)?.phase, .completed)
        XCTAssertEqual(workspace.workflow(workflowID, teamId: teamID)?.revision, 2)
    }
}

final class TeamMessageFollowTests: XCTestCase {
    func testIncomingRepliesFollowWhileAtBottomAndContentGrowthDoesNotUnpin() {
        var state = BotTeamMessageFollowState()
        XCTAssertTrue(state.messagesChanged(to: 10)); XCTAssertEqual(state.unreadCount, 0)
        state.viewportChanged(nearBottom: false, userInitiated: false)
        XCTAssertTrue(state.messagesChanged(to: 11)); XCTAssertTrue(state.followingLatest)
        XCTAssertEqual(state.acknowledgedSequence, 11); XCTAssertEqual(state.unreadCount, 0)
    }
    func testReadingEarlierMessagesKeepsPositionAndAccumulatesUnreadUpdates() {
        var state = BotTeamMessageFollowState()
        _ = state.messagesChanged(to: 10)
        state.viewportChanged(nearBottom: false, userInitiated: true)
        XCTAssertFalse(state.messagesChanged(to: 13)); XCTAssertEqual(state.unreadCount, 3)
        XCTAssertFalse(state.messagesChanged(to: 13), "Older pagination does not jump to the latest row.")
        XCTAssertEqual(state.unreadCount, 3); XCTAssertEqual(state.acknowledgedSequence, 10)
        state.markLatestRead(); XCTAssertTrue(state.followingLatest); XCTAssertEqual(state.unreadCount, 0)
    }
    func testReturningToBottomAcknowledgesAndResetTimelineCannotInheritUnread() {
        var state = BotTeamMessageFollowState()
        _ = state.messagesChanged(to: 10); state.viewportChanged(nearBottom: false, userInitiated: true)
        _ = state.messagesChanged(to: 12); state.viewportChanged(nearBottom: true, userInitiated: true)
        XCTAssertEqual(state.unreadCount, 0); XCTAssertTrue(state.followingLatest)
        state.viewportChanged(nearBottom: false, userInitiated: true)
        XCTAssertTrue(state.messagesChanged(to: 2)); XCTAssertEqual(state.acknowledgedSequence, 2)
        XCTAssertEqual(state.unreadCount, 0)
    }
}

extension TeamWorkflowTests {
    func testWorkflowWorkVisibilitySeparatesStagesAttentionAndSavedHistory() throws {
        let phases = ["planning", "building", "evaluating", "repairing", "stopping", "awaiting_review", "blocked", "interrupted", "stopped", "completed"]
        let rows = try phases.enumerated().map { index, phase in
            var row = workflow(phase: phase)
            row["id"] = String(format: "wf_00000000-0000-4000-8000-%012d", index + 1)
            return try decode(row)
        }
        let overview = BotTeamWorkflowWorkOverview(rows, teamId: teamID)
        XCTAssertEqual(overview.working.count, 5)
        XCTAssertEqual(overview.attention.count, 3)
        XCTAssertEqual(overview.history.count, 2)
        XCTAssertEqual(overview.summary, "5 working · 3 need you")
        XCTAssertTrue(overview.history.contains { $0.phase == .stopped && $0.canContinue })
    }
    func testWorkflowAttentionMatchesOnlyItsExactCurrentConversationRoleAndTeam() throws {
        var row = try decode(workflow(phase: "building"))
        row.steps[0].phase = .building; row.steps[0].botId = row.builderId; row.steps[0].state = .running
        for defect in ["none", "chat", "bot", "team"] {
            let value: [String: Any] = ["id": defect == "chat" ? "other_chat" : "saved_step_chat", "botId": defect == "bot" ? "other_bot" : row.builderId,
                "teamId": defect == "team" ? "other_team" : teamID, "name": "Builder", "title": "Current stage", "state": "approval", "approvalCount": 1]
            let session = try JSONDecoder().decode(BotSupervisionSession.self, from: JSONSerialization.data(withJSONObject: value))
            let overview = BotTeamWorkflowWorkOverview([row], teamId: teamID, supervision: [session])
            XCTAssertEqual(overview.attention.count, defect == "none" ? 1 : 0, defect)
            XCTAssertEqual(overview.working.count, defect == "none" ? 0 : 1, defect)
            XCTAssertEqual(overview.statusLabel(row), defect == "none" ? "1 approval waiting" : "Building", defect)
        }
    }
    func testWorkflowCleanupBlockerNeedsOwnerAndForeignOrInvalidRowsDoNotCount() throws {
        var stopping = try decode(workflow(phase: "stopping")); stopping.blockedReason = "Cleanup could not be confirmed"
        var foreign = stopping; foreign.teamId = "other_team"
        var invalid = stopping; invalid.proof = "invalid"
        let overview = BotTeamWorkflowWorkOverview([stopping, foreign, invalid], teamId: teamID)
        XCTAssertEqual(overview.attention.count, 1); XCTAssertTrue(overview.working.isEmpty)
    }
    func testWorkflowAttentionIgnoresFinishedStageAndZeroPendingApprovals() throws {
        for defect in ["completedApproval", "completedError", "zeroApprovals", "liveApproval", "liveError"] {
            var row = try decode(workflow(phase: "building"))
            row.steps[0].phase = .building; row.steps[0].botId = row.builderId
            row.steps[0].state = defect.hasPrefix("completed") ? .completed : .running
            let session: [String: Any] = ["id": "saved_step_chat", "botId": row.builderId, "teamId": teamID, "name": "Builder", "title": "Current stage",
                "state": defect.hasSuffix("Error") ? "error" : "approval", "approvalCount": defect == "zeroApprovals" ? 0 : 1]
            let decoded = try JSONDecoder().decode(BotSupervisionSession.self, from: JSONSerialization.data(withJSONObject: session))
            let overview = BotTeamWorkflowWorkOverview([row], teamId: teamID, supervision: [decoded])
            XCTAssertEqual(overview.attention.count, defect.hasPrefix("live") ? 1 : 0, defect)
            XCTAssertEqual(overview.working.count, defect.hasPrefix("live") ? 0 : 1, defect)
        }
    }
    func testSavedChecksDuringRepairsAreNotCurrentEvaluationOrOwnerAcceptance() throws {
        for phase in ["planning", "building", "repairing", "evaluating", "blocked", "interrupted", "stopped"] {
            let row = try decode(workflow(phase: phase))
            XCTAssertFalse(row.showsCurrentEvaluation, phase); XCTAssertFalse(row.canReview, phase)
            XCTAssertTrue(row.checks.first?.passed == true, "Previous finding stays inspectable.")
        }
        XCTAssertTrue(try decode(workflow()).showsCurrentEvaluation)
        XCTAssertTrue(try decode(workflow(phase: "completed")).showsCurrentEvaluation)
    }

    func testWorkflowRequiresCompleteIndependentFinalEvaluationAndBoundedEvidence() throws {
        var valid = workflow(); valid["round"] = 100_000
        XCTAssertTrue(try decode(valid).hasValidProof, "Rounds are observed progress, never a product stop limit.")
        for defect in ["stageRole", "lastStage", "failedCheck", "missingCheck", "evidenceCount", "evidenceDetail", "plan", "timestamp"] {
            var row = workflow()
            var steps = try XCTUnwrap(row["steps"] as? [[String: Any]])
            switch defect {
            case "stageRole": steps[0]["botId"] = "bot_builder"; row["steps"] = steps
            case "lastStage": steps[0]["state"] = "running"; row["steps"] = steps
            case "failedCheck": row["checks"] = [["criterionId": criterionID, "passed": false, "detail": "Unfinished"]]
            case "missingCheck": row["checks"] = []
            case "evidenceCount": steps[0]["evidence"] = Array(repeating: ["kind": "note", "label": "Note", "detail": "Details"], count: 5); row["steps"] = steps
            case "evidenceDetail": steps[0]["evidence"] = [["kind": "note", "label": "Note", "detail": String(repeating: "x", count: 1_001)]]; row["steps"] = steps
            case "plan": row["plan"] = ["summary": "Plan", "items": []]
            default: row["updatedAt"] = 12345
            }
            XCTAssertFalse(try decode(row).hasValidProof, defect)
        }
        let stopped = try decode(workflow(phase: "stopped")); XCTAssertTrue(stopped.canContinue); XCTAssertFalse(stopped.canStop)
        let stopping = try decode(workflow(phase: "stopping")); XCTAssertFalse(stopping.canContinue); XCTAssertTrue(stopping.canStop)
    }
    func testDisabledTeamCanAcceptOrStopButCannotStartRepairOrResume() async throws {
        for action in ["accept", "stop", "changes_requested", "resume"] {
            let fixture = StoreTransport(); defer { fixture.close() }
            let phase = action == "stop" ? "building" : action == "resume" ? "stopped" : "awaiting_review"
            let (_, workspace) = await loaded(fixture, row: workflow(phase: phase))
            let original = try XCTUnwrap(workspace.workflow(workflowID, teamId: teamID))
            var disabled = teamSnapshot(); var rows = try XCTUnwrap(disabled["teams"] as? [[String: Any]]); rows[0]["enabled"] = false; disabled["teams"] = rows
            fixture.respond { request in
                if request.url!.path == "/v1/bots/teams" { return disabled }
                return ["workflow": self.workflow(phase: action == "stop" ? "stopping" : "completed", revision: 2)]
            }
            await workspace.refreshTeams()
            let changed = await workspace.changeWorkflow(original, action: action == "stop" ? "stop" : action == "resume" ? "resume" : "review", requestId: "explicit_resume", decision: action, inspected: true)
            XCTAssertEqual(changed, ["accept", "stop"].contains(action), action)
            XCTAssertEqual(fixture.requests.filter { $0.method == "POST" }.count, ["accept", "stop"].contains(action) ? 1 : 0, action)
        }
    }
    func testCancellationDoesNotPublishLateWorkflowDetails() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let (_, workspace) = await loaded(fixture)
        let held = fixture.hold(detailPath)
        let reading = Task { await workspace.refreshWorkflow(self.workflowID, teamId: self.teamID) }
        await fulfillment(of: [held.requested], timeout: 2)
        reading.cancel(); held.finish(["workflow": workflow(phase: "completed", revision: 2)])
        await reading.value
        XCTAssertEqual(workspace.workflow(workflowID, teamId: teamID)?.phase, .awaitingReview)
        XCTAssertNil(workspace.messages[BotWorkspaceStore.workflowKey(workflowID)])
    }
}

extension TeamWorkflowTests {
    func testSameCheckpointTracksLiveContinuationAvailabilityWithoutBecomingStale() async throws {
        let fixture = StoreTransport(); defer { fixture.close() }
        let (_, workspace) = await loaded(fixture, row: workflow(phase: "interrupted"))
        let original = try XCTUnwrap(workspace.workflow(workflowID, teamId: teamID))
        var projected = workflow(phase: "interrupted"); projected["canResume"] = false; projected["blockedReason"] = "The saved computer is temporarily unavailable."
        fixture.respond { request in request.url!.path == self.listPath ? self.list([projected]) : ["workflow": projected] }
        await workspace.refreshWorkflows(teamID)
        let unavailable = try XCTUnwrap(workspace.workflow(workflowID, teamId: teamID))
        XCTAssertFalse(unavailable.canContinue); XCTAssertEqual(unavailable.proof, original.proof); XCTAssertEqual(unavailable.revision, original.revision)
        XCTAssertNil(workspace.messages[BotWorkspaceStore.workflowsKey(teamID)])
        projected = workflow(phase: "interrupted")
        await workspace.refreshWorkflow(workflowID, teamId: teamID)
        XCTAssertTrue(workspace.workflow(workflowID, teamId: teamID)?.canContinue == true)
        XCTAssertNil(workspace.messages[BotWorkspaceStore.workflowKey(workflowID)])
        XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
    }
    func testSameRevisionProofOrCheckpointChangesStayReadOnlyAndRejected() async throws {
        for defect in ["proof", "goal", "summary", "plan", "steps"] {
            let fixture = StoreTransport(); defer { fixture.close() }
            let (_, workspace) = await loaded(fixture, row: workflow(phase: "interrupted"))
            let original = try XCTUnwrap(workspace.workflow(workflowID, teamId: teamID))
            var changed = workflow(phase: "interrupted")
            switch defect {
            case "proof": changed["proof"] = String(repeating: "c", count: 64)
            case "goal": changed["goal"] = "Another task"
            case "summary": changed["summary"] = "A different result"
            case "plan": changed["plan"] = ["summary": "Changed plan", "items": ["Changed step"]]
            default: changed["steps"] = []; changed["totalSteps"] = 0
            }
            fixture.respond { request in request.url!.path == self.listPath ? self.list([changed]) : ["workflow": changed] }
            await workspace.refreshWorkflow(workflowID, teamId: teamID)
            XCTAssertEqual(workspace.workflow(workflowID, teamId: teamID), original, defect)
            XCTAssertNotNil(workspace.messages[BotWorkspaceStore.workflowKey(workflowID)], defect)
            XCTAssertTrue(fixture.requests.allSatisfy { $0.method == "GET" })
        }
    }
}

extension TeamWorkflowTests {
    func testRoleReadinessExplainsPausedBotsAndAllowsPlanOnlyForPlanner() throws {
        func bot(_ id: String, policy: String = "manual", paused: Bool = false) throws -> CompanionBot {
            let row: [String: Any] = ["id": id, "name": id, "provider": "codex", "model": "Fixture model", "capabilities": "code", "policy": policy, "execution": ["kind": "local"], "paused": paused]
            return try JSONDecoder().decode(CompanionBot.self, from: JSONSerialization.data(withJSONObject: row))
        }
        var value = draft(); value.plannerId = "bot_planner"
        let ready = try [bot("bot_planner", policy: "plan"), bot("bot_builder"), bot("bot_evaluator")]
        XCTAssertTrue(value.roleReadinessNotices(in: ready).isEmpty)
        var unavailable = ready; unavailable[1].policy = "plan"; unavailable[2].paused = true
        let before = unavailable
        let notices = value.roleReadinessNotices(in: unavailable)
        XCTAssertEqual(notices.count, 2)
        XCTAssertTrue(notices.contains { $0.hasPrefix("Builder:") && $0.contains("Plan mode") })
        XCTAssertTrue(notices.contains { $0.hasPrefix("Evaluator:") && $0.contains("paused") })
        XCTAssertEqual(unavailable, before, "Explaining a saved policy never changes it or grants tool access.")
        XCTAssertTrue(value.roleReadinessNotices(in: []).allSatisfy { $0.contains("unavailable") })
    }
}

@MainActor
final class TeamWorkPlanTests: XCTestCase {
    private var retainedStore: CompanionStore?
    private let teamID = "team_plan_fixture"
    private let planID = "tp_00000000-0000-4000-8000-000000000001"
    private let taskID = "tpt_00000000-0000-4000-8000-000000000001"
    private let criterionID = "tpc_00000000-0000-4000-8000-000000000001"
    private var listPath: String { "/v1/bots/teams/\(teamID)/plans" }
    private var detailPath: String { listPath + "/" + planID }
    private func teams(capability: Bool? = true, enabled: Bool = true) -> [String: Any] {
        var result: [String: Any] = ["teams": [["id": teamID, "name": "Plan fixture", "memberIds": ["builder", "reviewer"], "coordinatorId": "builder", "enabled": enabled, "limits": ["maxParallel": 0, "maxDepth": 0, "maxHops": 0, "maxTurns": 0, "maxDurationMs": 0]]], "runs": []]
        if let capability { result["teamWorkPlansSupported"] = capability }
        return result
    }
    private func task(id: String? = nil, key: String = "build", kind: String = "work", state: String = "ready_for_review") -> [String: Any] {
        ["id": id ?? taskID, "key": key, "title": "Implement the requested fixture", "instructions": "Inspect and change only the authorized fixture.", "ownerId": kind == "review" ? "reviewer" : "builder", "collaboratorIds": [], "dependsOn": [], "kind": kind,
         "criteria": [["id": criterionID, "text": "Meaningful fixture checks pass"]], "state": state,
         "evidence": [["kind": "test", "label": "Fixture-only evidence", "detail": "No real model or command ran in this test."]],
         "checks": kind == "review" ? [["criterionId": criterionID, "passed": true, "detail": "Independently inspected fixture result."]] : []]
    }
    private func plan(phase: String = "awaiting_review", revision: Int = 1) -> [String: Any] {
        ["id": planID, "teamId": teamID, "parentRunId": "plan_run", "sourceMessageId": "source_message", "goal": "Improve only the authorized fixture", "coordinatorId": "builder", "memberIds": ["builder", "reviewer"], "phase": phase,
         "revision": revision, "proof": String(repeating: revision == 1 ? "a" : revision == 2 ? "b" : "c", count: 64), "createdAt": "2026-10-22T00:00:00Z", "updatedAt": "2026-10-22T00:00:01Z", "summary": "A reported result awaits the owner.",
         "participation": [["botId": "builder", "role": "Builder", "reason": "Owns the concrete change"], ["botId": "reviewer", "role": "Reviewer", "reason": "Checks the result independently"]],
         "tasks": [task()], "counts": ["pending": 0, "queued": 0, "running": 0, "working": 0, "ready_for_review": 1, "blocked": 0, "interrupted": 0, "stopped": 0], "totalTasks": 1, "tasksOffset": 0, "tasksTruncated": false,
         "attempts": [["id": "tpa_00000000-0000-4000-8000-000000000001", "kind": "synthesis", "botId": "builder", "state": "completed"]], "totalAttempts": 1, "attemptsTruncated": false, "canResume": ["blocked", "interrupted", "stopped"].contains(phase)]
    }
    private func list(_ rows: [[String: Any]], available: Bool = true, hasMore: Bool = false) -> [String: Any] { ["teamWorkPlansSupported": true, "available": available, "plans": rows, "hasMore": hasMore, "nextBeforePlanId": hasMore ? (rows.last?["id"] ?? NSNull()) : NSNull()] }
    private func decode(_ value: [String: Any]) throws -> BotTeamWorkPlan { try JSONDecoder().decode(BotTeamWorkPlan.self, from: JSONSerialization.data(withJSONObject: value)) }
    private func loaded(_ fixture: StoreTransport, row: [String: Any]? = nil, capability: Bool? = true) async -> (CompanionStore, BotWorkspaceStore) {
        fixture.respond { request in
            if request.url!.path == "/v1/bots/teams" { return self.teams(capability: capability) }
            if request.url!.path == self.listPath { return self.list([row ?? self.plan()]) }
            if request.url!.path == self.detailPath { return ["plan": row ?? self.plan()] }
            return nil
        }
        let store = fixture.makeStore(); retainedStore = store
        let workspace = store.botWorkspaceStore(); await workspace.refreshTeams(); await workspace.refreshWorkPlans(teamID)
        return (store, workspace)
    }
    func testReportedResultAndEvaluatorChecksDoNotInventOwnerAcceptance() throws {
        let pending = try decode(plan()); XCTAssertTrue(pending.hasValidProof); XCTAssertTrue(pending.canReview); XCTAssertEqual(pending.phase.label, "Ready for your review")
        let accepted = try decode(plan(phase: "completed", revision: 2)); XCTAssertTrue(accepted.hasValidProof); XCTAssertFalse(accepted.canReview); XCTAssertEqual(accepted.phase.label, "Accepted by you")
        let blocked = try decode(plan(phase: "blocked")); XCTAssertTrue(blocked.canContinue); XCTAssertFalse(blocked.canStop)
    }
    func testMalformedIdentityProofCountsEvidenceAndReviewCannotGrantAuthority() throws {
        for defect in ["id", "proof", "counts", "owner", "review", "dependency", "evidence", "criteria", "participation", "pagination"] {
            var row = plan(); var task = self.task()
            switch defect {
            case "id": row["id"] = "tplan_00000000-0000-4000-8000-000000000001"
            case "proof": row["proof"] = String(repeating: "z", count: 64)
            case "counts": row["totalTasks"] = 2
            case "owner": task["ownerId"] = "outside_team"
            case "review": task = self.task(kind: "review"); task["checks"] = []
            case "dependency": task["dependsOn"] = ["build"]
            case "evidence": task["evidence"] = [["kind": "link", "label": "Secret", "detail": "https://token@invalid.example"]]
            case "criteria": task["criteria"] = [["id": "outside", "text": "Claim"]]
            case "participation": row["participation"] = []
            default: row["nextTaskOffset"] = 0
            }
            row["tasks"] = [task]
            XCTAssertFalse(try decode(row).hasValidProof, defect)
        }
    }
    func testOlderHostReceivesNoPlanRequestsOrMutation() async throws {
        let f = StoreTransport(); defer { f.close() }
        let (_, workspace) = await loaded(f, capability: nil)
        await workspace.refreshWorkPlan(planID, teamId: teamID)
        let changed = await workspace.changeWorkPlan(try decode(plan()), action: "review", decision: "accept", inspected: true)
        XCTAssertFalse(changed); XCTAssertNil(workspace.workPlans[teamID]); XCTAssertEqual(f.requests.map(\.path), ["/v1/bots/teams"])
    }
    func testUnavailableEmptyAndPartialSnapshotsRemainDistinct() async throws {
        let f = StoreTransport(); defer { f.close() }; let (_, w) = await loaded(f)
        f.respond { _ in self.list([], available: false) }; await w.refreshWorkPlans(teamID)
        XCTAssertFalse(w.workPlans[teamID]!.isAvailable); XCTAssertNotNil(w.messages[BotWorkspaceStore.workPlansKey(teamID)])
        f.respond { _ in self.list([self.plan()], hasMore: true) }; await w.refreshWorkPlans(teamID)
        XCTAssertTrue(w.workPlans[teamID]!.hasMore); XCTAssertNil(w.messages[BotWorkspaceStore.workPlansKey(teamID)])
    }
    func testTaskPagesPreserveExactRowsAndRevisionChangeClearsOldPages() async throws {
        var first = plan(phase: "running"); first["totalTasks"] = 2; first["tasksTruncated"] = true; first["nextTaskOffset"] = 1
        first["counts"] = ["pending": 0, "queued": 0, "running": 0, "working": 0, "ready_for_review": 2, "blocked": 0, "interrupted": 0, "stopped": 0]
        let f = StoreTransport(); defer { f.close() }; let (_, w) = await loaded(f, row: first)
        var second = first; second["tasksOffset"] = 1; second.removeValue(forKey: "nextTaskOffset"); second["tasks"] = [task(id: "tpt_00000000-0000-4000-8000-000000000002", key: "check")]
        var query: String?
        f.respond { request in query = request.url?.query; return ["plan": second] }; await w.refreshWorkPlan(planID, teamId: teamID, taskOffset: 1)
        XCTAssertEqual(query, "taskOffset=1")
        XCTAssertEqual(w.workPlanTasks(planID, teamId: teamID).map(\.key), ["build", "check"])
        XCTAssertNil(w.nextWorkPlanTaskOffset(planID, teamId: teamID))
        XCTAssertEqual(f.requests.last?.path, detailPath)
        var newer = first; newer["revision"] = 2; newer["proof"] = String(repeating: "b", count: 64)
        f.respond { _ in ["plan": newer] }; await w.refreshWorkPlan(planID, teamId: teamID)
        XCTAssertEqual(w.workPlanTasks(planID, teamId: teamID).map(\.key), ["build"])
        XCTAssertNil(w.messages[BotWorkspaceStore.workPlanKey(planID)])
    }
    func testSameCheckpointAvailabilityChangesDoNotStickOrAuthorizeResume() async throws {
        let f = StoreTransport(); defer { f.close() }; let (_, w) = await loaded(f, row: plan(phase: "blocked"))
        let original = try XCTUnwrap(w.workPlan(planID, teamId: teamID))
        var unavailable = plan(phase: "blocked"); unavailable["canResume"] = false; unavailable["blockedReason"] = "Saved computer unavailable"
        f.respond { _ in self.list([unavailable]) }; await w.refreshWorkPlans(teamID)
        XCTAssertFalse(w.workPlan(planID, teamId: teamID)!.canContinue)
        let resumed = await w.changeWorkPlan(original, action: "resume", requestId: "resume_fixture", inspected: true)
        XCTAssertFalse(resumed); XCTAssertTrue(f.requests.allSatisfy { $0.method == "GET" })
        f.respond { _ in self.list([self.plan(phase: "blocked")]) }; await w.refreshWorkPlans(teamID)
        XCTAssertTrue(w.workPlan(planID, teamId: teamID)!.canContinue)
        var forged = plan(phase: "blocked"); forged["proof"] = String(repeating: "c", count: 64)
        f.respond { _ in self.list([forged]) }; await w.refreshWorkPlans(teamID)
        XCTAssertNotNil(w.messages[BotWorkspaceStore.workPlansKey(teamID)])
    }
    func testReviewNeedsInspectionAndExactFreshAcknowledgement() async throws {
        let f = StoreTransport(); defer { f.close() }; let (_, w) = await loaded(f)
        let original = try XCTUnwrap(w.workPlan(planID, teamId: teamID))
        let uninspected = await w.changeWorkPlan(original, action: "review", decision: "accept")
        XCTAssertFalse(uninspected); XCTAssertTrue(f.requests.allSatisfy { $0.method == "GET" })
        let hold = f.hold(detailPath + "/review")
        let reviewing = Task { await w.changeWorkPlan(original, action: "review", decision: "accept", inspected: true) }
        await fulfillment(of: [hold.requested], timeout: 2)
        XCTAssertEqual(w.workPlan(planID, teamId: teamID)?.phase, .awaitingReview)
        hold.finish(["plan": plan(phase: "completed", revision: 3)])
        let accepted = await reviewing.value; XCTAssertTrue(accepted); XCTAssertEqual(w.workPlan(planID, teamId: teamID)?.phase, .completed)
        let post = try XCTUnwrap(f.requests.first { $0.method == "POST" })
        XCTAssertEqual(post.jsonBody?["expectedProof"] as? String, original.proof); XCTAssertEqual(Set(post.jsonBody!.keys), ["expectedRevision", "expectedProof", "decision"])
    }
    func testWrongProofScopeAndPhaseCannotConfirmOwnerReview() async throws {
        for defect in ["proof", "revision", "teamId", "goal", "parentRunId", "sourceMessageId", "phase"] {
            let f = StoreTransport(); defer { f.close() }; let (_, w) = await loaded(f)
            let original = try XCTUnwrap(w.workPlan(planID, teamId: teamID)); var response = plan(phase: "completed", revision: 2)
            switch defect { case "proof": response[defect] = original.proof; case "revision": response[defect] = 1; case "phase": response[defect] = "awaiting_review"; default: response[defect] = "different" }
            f.respond { _ in ["plan": response] }
            let result = await w.changeWorkPlan(original, action: "review", decision: "accept", inspected: true)
            XCTAssertFalse(result, defect); XCTAssertEqual(w.workPlan(planID, teamId: teamID)?.phase, .awaitingReview, defect)
            XCTAssertEqual(f.requests.filter { $0.method == "POST" }.count, 1, defect)
        }
    }
    func testLostStopResponseIsNotAutomaticallyRetried() async throws {
        let f = StoreTransport(); defer { f.close() }; let (_, w) = await loaded(f, row: plan(phase: "running"))
        let original = try XCTUnwrap(w.workPlan(planID, teamId: teamID)); f.respond { _ in nil }
        let result = await w.changeWorkPlan(original, action: "stop")
        XCTAssertFalse(result); XCTAssertEqual(f.requests.filter { $0.method == "POST" }.count, 1); XCTAssertEqual(w.workPlan(planID, teamId: teamID)?.phase, .running)
    }
    func testLatePlanReadAndReviewCannotPublishAfterForget() async throws {
        let f = StoreTransport(); defer { f.close() }; let (store, w) = await loaded(f)
        let hold = f.hold(detailPath + "/review"), original = try XCTUnwrap(w.workPlan(planID, teamId: teamID))
        let operation = Task { await w.changeWorkPlan(original, action: "review", decision: "accept", inspected: true) }
        await fulfillment(of: [hold.requested], timeout: 2); store.forgetMac()
        hold.finish(["plan": plan(phase: "completed", revision: 2)])
        let result = await operation.value; XCTAssertFalse(result); XCTAssertEqual(w.workPlan(planID, teamId: teamID)?.phase, .awaitingReview)
        XCTAssertFalse(store.isPaired)
    }
    func testUnfinishedTasksCanResumeWhileSiblingsRemainInMotion() async throws {
        var row = plan(phase: "running"); row["canResume"] = true
        row["tasks"] = [task(state: "blocked")]
        row["counts"] = ["pending": 0, "queued": 0, "running": 0, "working": 0, "ready_for_review": 0, "blocked": 1, "interrupted": 0, "stopped": 0]
        let f = StoreTransport(); defer { f.close() }; let (_, w) = await loaded(f, row: row)
        let original = try XCTUnwrap(w.workPlan(planID, teamId: teamID)); XCTAssertTrue(original.canContinue)
        let uninspected = await w.changeWorkPlan(original, action: "resume", requestId: "resume_explicit")
        XCTAssertFalse(uninspected); XCTAssertTrue(f.requests.allSatisfy { $0.method == "GET" })
        f.respond { _ in ["plan": self.plan(phase: "running", revision: 2)] }
        let resumed = await w.changeWorkPlan(original, action: "resume", requestId: "resume_explicit", inspected: true)
        XCTAssertTrue(resumed)
        let resumedRow = try XCTUnwrap(w.workPlan(planID, teamId: teamID))
        f.respond { _ in ["plan": self.plan(phase: "stopped", revision: 3)] }
        let stopped = await w.changeWorkPlan(resumedRow, action: "stop")
        XCTAssertTrue(stopped)
        let writes = f.requests.filter { $0.method == "POST" }
        XCTAssertEqual(writes.map(\.path), [detailPath + "/resume", detailPath + "/stop"])
        XCTAssertEqual(writes.first?.jsonBody?["requestId"] as? String, "resume_explicit")
        XCTAssertEqual(writes.first?.jsonBody?["inspected"] as? Bool, true)
    }

    func testLatePlanGetCannotReplaceSavedCheckpointAfterForget() async throws {
        let f = StoreTransport(); defer { f.close() }; let (store, w) = await loaded(f)
        let hold = f.hold(detailPath)
        let operation = Task { await w.refreshWorkPlan(planID, teamId: teamID) }
        await fulfillment(of: [hold.requested], timeout: 2); store.forgetMac()
        hold.finish(["plan": plan(phase: "completed", revision: 2)]); await operation.value
        XCTAssertFalse(store.isPaired); XCTAssertEqual(w.workPlan(planID, teamId: teamID)?.phase, .awaitingReview)
    }

    func testHigherRevisionCannotChangeOriginalPlanOrTaskScope() async throws {
        for defect in ["goal", "parentRunId", "sourceMessageId", "createdAt", "coordinatorId", "memberIds", "ownerId", "criteria", "instructions", "workspaceKey", "collaboratorIds", "dependsOn"] {
            let f = StoreTransport(); defer { f.close() }; let (_, w) = await loaded(f)
            var row = plan(revision: 2); var changedTask = task()
            switch defect {
            case "createdAt": row[defect] = "2026-10-21T00:00:00Z"
            case "coordinatorId": row[defect] = "reviewer"; row["attempts"] = [["id": "tpa_00000000-0000-4000-8000-000000000001", "kind": "synthesis", "botId": "reviewer", "state": "completed"]]
            case "memberIds": row[defect] = ["builder", "different"]; row["participation"] = [["botId": "builder", "role": "Builder", "reason": "Builds"], ["botId": "different", "role": "Reviewer", "reason": "Reviews"]]
            case "ownerId": changedTask[defect] = "reviewer"
            case "criteria": changedTask[defect] = [["id": criterionID, "text": "A different success criterion"]]
            case "instructions": changedTask[defect] = "Different instructions"
            case "workspaceKey": changedTask[defect] = "different_workspace"
            case "collaboratorIds": changedTask[defect] = ["reviewer"]
            case "dependsOn": changedTask[defect] = ["other_task"]
            default: row[defect] = defect == "goal" ? "Different owner scope" : "different_scope"
            }
            row["tasks"] = [changedTask]
            XCTAssertTrue(try decode(row).hasValidProof, defect)
            f.respond { _ in self.list([row]) }; await w.refreshWorkPlans(teamID)
            XCTAssertEqual(w.workPlan(planID, teamId: teamID)?.revision, 1, defect)
            XCTAssertNotNil(w.messages[BotWorkspaceStore.workPlansKey(teamID)], defect)
        }
    }
    func testEarlierPlanCursorLoadsSavedAttentionWithoutArbitraryQueryForwarding() async throws {
        let f = StoreTransport(); defer { f.close() }; let (_, w) = await loaded(f)
        f.respond { _ in self.list([self.plan()], hasMore: true) }; await w.refreshWorkPlans(teamID)
        var older = plan(phase: "blocked"); older["id"] = "tp_00000000-0000-4000-8000-000000000099"; older["parentRunId"] = "older_run"; older["sourceMessageId"] = "older_message"
        var query: String?
        f.respond { request in query = request.url?.query; return self.list([older]) }
        await w.refreshWorkPlans(teamID, beforePlanId: planID)
        XCTAssertEqual(query, "beforePlanId=" + planID)
        XCTAssertEqual(w.workPlans[teamID]?.plans.count, 2)
        XCTAssertEqual(w.workPlans[teamID]?.plans.last?.phase, .blocked)
        XCTAssertFalse(w.workPlans[teamID]!.hasMore)
        let count = f.requests.count; await w.refreshWorkPlans(teamID, beforePlanId: "../../other")
        XCTAssertEqual(f.requests.count, count)
    }

    func testBudgetedPreviewsKeepTaskAuthorityAndProgressExact() throws {
        let original = try decode(plan())
        for limit in [80, 200, 500] {
            var full = original, clipped = original
            full.tasks[0].instructions = String(repeating: "x", count: 900)
            clipped.tasks[0].instructions = String(full.tasks[0].instructions.prefix(limit)); clipped.tasks[0].instructionsTruncated = true
            full.tasks[0].summary = String(repeating: "s", count: 900); clipped.tasks[0].summary = String(repeating: "s", count: limit)
            full.tasks[0].nextStep = String(repeating: "n", count: 900); clipped.tasks[0].nextStep = String(repeating: "n", count: limit)
            full.tasks[0].checks = [.init(criterionId: criterionID, passed: true, detail: String(repeating: "c", count: 900))]
            clipped.tasks[0].checks = [.init(criterionId: criterionID, passed: true, detail: String(repeating: "c", count: limit))]
            full.tasks[0].evidence![0].detail = String(repeating: "e", count: 900); clipped.tasks[0].evidence![0].detail = String(repeating: "e", count: limit)
            full.participation[0].reason = String(repeating: "r", count: 900); clipped.participation[0].reason = String(repeating: "r", count: limit)
            full.attempts[0].summary = String(repeating: "a", count: 900); clipped.attempts[0].summary = String(repeating: "a", count: limit)
            XCTAssertTrue(full.hasValidProof); XCTAssertTrue(clipped.hasValidProof)
            XCTAssertTrue(full.hasSameCheckpoint(as: clipped)); XCTAssertTrue(clipped.hasSameCheckpoint(as: full))
            XCTAssertTrue(full.tasks[0].hasSameDefinition(as: clipped.tasks[0]))
            var bad = clipped; bad.tasks[0].instructionsTruncated = nil
            XCTAssertFalse(full.hasSameScope(as: bad), "A shorter instruction without the core's explicit preview flag is not interchangeable.")
            bad = clipped; bad.tasks[0].ownerId = "reviewer"; XCTAssertFalse(full.hasSameCheckpoint(as: bad))
            bad = clipped; bad.tasks[0].state = .blocked; XCTAssertFalse(full.hasSameCheckpoint(as: bad))
            bad = clipped; bad.tasks[0].checks![0].passed = false; XCTAssertFalse(full.hasSameCheckpoint(as: bad))
            bad = clipped; bad.tasks[0].criteria[0].text = "Different criterion"; XCTAssertFalse(full.hasSameCheckpoint(as: bad))
            bad = clipped; bad.participation[0].role = "Different role"; XCTAssertFalse(full.hasSameCheckpoint(as: bad))
            bad = clipped; bad.tasks[0].summary = String(repeating: "z", count: limit); XCTAssertFalse(full.hasSameCheckpoint(as: bad))
            bad = clipped; bad.tasks[0].summary = String(repeating: "s", count: limit - 1); XCTAssertFalse(full.hasSameCheckpoint(as: bad))
            full.tasks[0].evidence = [.init(kind: "link", label: "Exact target", detail: "https://example.invalid/" + String(repeating: "x", count: 600))]
            clipped.tasks[0].evidence = [.init(kind: "link", label: "Exact target", detail: String(full.tasks[0].evidence![0].detail.prefix(limit)))]
            XCTAssertFalse(full.hasSameCheckpoint(as: clipped), "URLs must never be treated as shortened reports.")
        }
        var full = original, clipped = original
        full.tasks[0].instructions = String(repeating: "x", count: 79) + "😀" + String(repeating: "x", count: 100)
        clipped.tasks[0].instructions = String(repeating: "x", count: 79); clipped.tasks[0].instructionsTruncated = true
        XCTAssertTrue(full.tasks[0].hasSameDefinition(as: clipped.tasks[0]), "The JS core drops a trailing high surrogate at an exact UTF-16 budget.")
        full.tasks[0].instructions = String(repeating: "x", count: 181)
        XCTAssertFalse(full.tasks[0].hasSameDefinition(as: clipped.tasks[0]), "An arbitrary one-character-short prefix is not a surrogate clip.")
        full.tasks[0].instructions = clipped.tasks[0].instructions
        XCTAssertFalse(full.tasks[0].hasSameDefinition(as: clipped.tasks[0]), "An unchanged instruction cannot silently change from complete to truncated.")
    }

    func testActualCoreEscapeHeavyPagesExpandPreviewsWithoutDuplicatingOrChangingWork() async throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../host/tests/fixtures/team-plan-preview-pages.json").standardizedFileURL
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let front = try XCTUnwrap(fixture["front"] as? [String: Any]), later = try XCTUnwrap(fixture["later"] as? [String: Any])
        let first = try decode(front), second = try decode(later)
        XCTAssertTrue(first.hasValidProof); XCTAssertTrue(second.hasValidProof)
        XCTAssertEqual(first.revision, second.revision); XCTAssertEqual(first.proof, second.proof)
        XCTAssertEqual(first.tasks.first { $0.id == second.tasks[0].id }?.instructions.utf16.count, 500)
        XCTAssertEqual(second.tasks[0].instructions.utf16.count, 1_000)
        XCTAssertTrue(first.hasSameCheckpoint(as: second)); XCTAssertTrue(second.hasSameCheckpoint(as: first))
        let path = "/v1/bots/teams/\(first.teamId)/plans", detail = path + "/" + first.id
        let f = StoreTransport(); defer { f.close() }
        f.respond { request in
            if request.url?.path == "/v1/bots/teams" {
                return ["teamWorkPlansSupported": true, "runs": [], "teams": [["id": first.teamId, "name": "Real core preview fixture", "enabled": true, "coordinatorId": first.coordinatorId, "memberIds": first.memberIds, "limits": ["maxParallel": 0, "maxDepth": 0, "maxHops": 0, "maxTurns": 0, "maxDurationMs": 0]]]]
            }
            if request.url?.path == path { return self.list([front]) }
            if request.url?.path == detail { return ["plan": later] }
            return nil
        }
        let store = f.makeStore(); retainedStore = store
        let w = store.botWorkspaceStore(); await w.refreshTeams(); await w.refreshWorkPlans(first.teamId)
        await w.refreshWorkPlan(first.id, teamId: first.teamId, taskOffset: second.tasksOffset)
        XCTAssertNil(w.messages[BotWorkspaceStore.workPlanKey(first.id)])
        XCTAssertEqual(w.workPlanTasks(first.id, teamId: first.teamId).map(\.id), first.tasks.map(\.id))
        XCTAssertEqual(w.workPlanTasks(first.id, teamId: first.teamId).count, first.totalTasks)
        XCTAssertNil(w.nextWorkPlanTaskOffset(first.id, teamId: first.teamId))
        await w.refreshWorkPlans(first.teamId)
        XCTAssertNil(w.messages[BotWorkspaceStore.workPlansKey(first.teamId)])
        for defect in ["state", "criterion", "owner", "role", "position"] {
            var forged = later; var tasks = try XCTUnwrap(later["tasks"] as? [[String: Any]])
            switch defect {
            case "state": tasks[0]["state"] = "blocked"
            case "owner": tasks[0]["ownerId"] = first.coordinatorId
            case "criterion": var criteria = try XCTUnwrap(tasks[0]["criteria"] as? [[String: Any]]); criteria[0]["text"] = "Changed owner criterion"; tasks[0]["criteria"] = criteria
            case "role": var people = try XCTUnwrap(later["participation"] as? [[String: Any]]); people[0]["role"] = "Changed role"; forged["participation"] = people
            default: tasks.reverse()
            }
            forged["tasks"] = tasks
            f.respond { _ in ["plan": forged] }; await w.refreshWorkPlan(first.id, teamId: first.teamId, taskOffset: second.tasksOffset)
            XCTAssertNotNil(w.messages[BotWorkspaceStore.workPlanKey(first.id)], defect)
            XCTAssertEqual(w.workPlanTasks(first.id, teamId: first.teamId).map(\.id), first.tasks.map(\.id), defect)
        }
        var newer = front; newer["revision"] = first.revision + 1; newer["proof"] = String(repeating: first.proof.first == "a" ? "b" : "a", count: 64)
        f.respond { _ in self.list([newer]) }; await w.refreshWorkPlans(first.teamId)
        XCTAssertEqual(w.workPlan(first.id, teamId: first.teamId)?.revision, first.revision + 1)
        XCTAssertNil(w.messages[BotWorkspaceStore.workPlansKey(first.teamId)])
        XCTAssertTrue(f.requests.allSatisfy { $0.method == "GET" }, "The real projections never authorize a mutation or replay.")
    }

}
