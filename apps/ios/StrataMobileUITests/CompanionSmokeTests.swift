import XCTest

/// These tests navigate the shipped UI. They do not replace the app's network or data store.
/// A saved simulator pairing is removed through the app's Forget this Mac flow before each test.
final class CompanionSmokeTests: XCTestCase {
    private var app: XCUIApplication!
    private var sensitivePairingVisible = false

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        try prepareUnpairedApp()
    }

    override func tearDownWithError() throws {
        if app != nil, (testRun?.failureCount ?? 0) > 0, !sensitivePairingVisible { attachScreenshot("Failure") }
        app?.terminate()
    }

    func testHomePairingAndUnpairedTabs() throws {
        XCTAssertTrue(app.buttons["pairMacButton"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["connectionStatus"].exists)
        attachScreenshot("Home — unpaired")

        openManualPairing()
        XCTAssertTrue(app.textFields["pairingAddressInput"].exists)
        XCTAssertTrue(app.textFields["pairingCodeInput"].exists)
        XCTAssertTrue(app.textFields["pairingFingerprintInput"].exists)
        let submit = app.buttons["confirmPairingButton"]
        reveal(submit)
        XCTAssertFalse(submit.isEnabled, "Pairing requires an address, a code, and the Mac certificate fingerprint.")
        attachScreenshot("Pairing — manual fields")
        app.buttons["dismissPairingButton"].tap()

        tapTab("Chat")
        XCTAssertTrue(app.staticTexts["An idea starts here"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.textFields["messageInput"].exists, "An unpaired phone cannot submit a chat request.")
        attachScreenshot("Chat — unpaired")

        tapTab("Models")
        XCTAssertTrue(app.staticTexts["Meet your models"].waitForExistence(timeout: 3))
        attachScreenshot("Models — unpaired")

        tapTab("Connection")
        XCTAssertTrue(app.buttons["connectionPairButton"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["disconnectMacButton"].exists)
        attachScreenshot("Connection — unpaired")

        app.buttons["connectionPairButton"].tap()
        XCTAssertTrue(app.buttons["scanPairingCodeButton"].waitForExistence(timeout: 3))
        app.buttons["dismissPairingButton"].tap()
    }

    func testManualPairingRejectsInsecureAddress() throws {
        openManualPairing()
        fillPairing(address: "http://192.0.2.1:9443", code: "123456", fingerprint: String(repeating: "a", count: 64))
        submitPairing()
        assertPairingErrorContains("HTTPS address")
        attachScreenshot("Pairing — insecure address rejected")
    }

    func testManualPairingRejectsMalformedFingerprint() throws {
        openManualPairing()
        fillPairing(address: "https://192.0.2.1:9443", code: "123456", fingerprint: "invalid")
        submitPairing()
        assertPairingErrorContains("64 hexadecimal characters")
        attachScreenshot("Pairing — invalid certificate fingerprint rejected")
    }

    func testManualPairingRejectsInvalidCode() throws {
        openManualPairing()
        fillPairing(address: "https://192.0.2.1:9443", code: "123", fingerprint: String(repeating: "a", count: 64))
        submitPairing()
        assertPairingErrorContains("six-digit pairing code")
        attachScreenshot("Pairing — invalid code rejected")
    }

    /// Optional live smoke test. Provide a fresh invitation through the test runner environment.
    /// The code is consumed by the real Mac bridge. No invitation is written into source files.
    func testLivePairChatAndReconnect() throws {
        guard let raw = ProcessInfo.processInfo.environment["STRATA_TEST_INVITATION"],
              let invitation = URLComponents(string: raw), invitation.scheme == "strata", invitation.host == "pair" else {
            throw XCTSkip("Set STRATA_TEST_INVITATION to a fresh Mac pairing invitation to run live pairing.")
        }
        func item(_ name: String) -> String? { invitation.queryItems?.first { $0.name == name }?.value }
        guard let address = item("url"), let code = item("code"), let fingerprint = item("fingerprint") else {
            throw XCTSkip("The live pairing invitation must contain url, code, and fingerprint fields.")
        }
        let interruptions = addUIInterruptionMonitor(withDescription: "Local network permission") { alert in
            if alert.buttons["Allow"].exists { alert.buttons["Allow"].tap(); return true }
            if alert.buttons["OK"].exists { alert.buttons["OK"].tap(); return true }
            return false
        }
        defer { removeUIInterruptionMonitor(interruptions) }
        openManualPairing()
        sensitivePairingVisible = true
        fillPairing(address: address, code: code, fingerprint: fingerprint)
        submitPairing()
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if system.alerts.buttons["Allow"].waitForExistence(timeout: 2) { system.alerts.buttons["Allow"].tap() }
        app.tap() // Allows XCTest's interruption monitor to handle a delayed permission sheet.
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["dismissPairingButton"])
        XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 25), .completed, "Successful pairing dismisses the real pairing form.")
        sensitivePairingVisible = false
        XCTAssertTrue(app.buttons["connectionStatus"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["connectionStatus"].label.localizedCaseInsensitiveContains("connected"))
        XCTAssertFalse(app.buttons["pairMacButton"].exists)
        attachScreenshot("Home — paired with live Mac")

        tapTab("Models")
        XCTAssertTrue(app.staticTexts["YOUR LIBRARY"].waitForExistence(timeout: 5))
        let apiModel = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "API model via Mac")).firstMatch
        XCTAssertTrue(apiModel.waitForExistence(timeout: 5), "The Mac's configured API models must appear in the actual library.")
        reveal(apiModel)
        attachScreenshot("Models — live Mac library")

        tapTab("Chat")
        app.buttons["newChatButton"].tap() // Live checks always create an isolated QA conversation.
        let input = app.descendants(matching: .any).matching(identifier: "messageInput").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        input.typeText("Reply with exactly STRATA_PHONE_OK")
        app.buttons["sendMessageButton"].tap()
        let reply = app.staticTexts.matching(identifier: "assistantMessage")
            .matching(NSPredicate(format: "label CONTAINS %@", "STRATA_PHONE_OK")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 90), "The real selected Mac model must return the requested marker.")
        attachScreenshot("Chat — real Mac model reply")

        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["connectionStatus"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["pairMacButton"].exists, "Pairing must persist through app relaunch.")
        tapTab("Chat")
        app.buttons["chatHistoryButton"].tap()
        let savedConversation = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Reply with exactly")).firstMatch
        XCTAssertTrue(savedConversation.waitForExistence(timeout: 10), "The Mac bridge must return the phone conversation after relaunch.")
        savedConversation.tap()
        let restoredReply = app.staticTexts.matching(identifier: "assistantMessage")
            .matching(NSPredicate(format: "label CONTAINS %@", "STRATA_PHONE_OK")).firstMatch
        XCTAssertTrue(restoredReply.waitForExistence(timeout: 10))
        attachScreenshot("Chat — conversation restored after relaunch")

        tapTab("Connection")
        XCTAssertTrue(app.buttons["refreshConnectionButton"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["disconnectMacButton"].exists)
        XCTAssertTrue(app.buttons["pairAgainButton"].exists)
        attachScreenshot("Connection — saved Mac pairing")
    }

    /// Runs through the real HTTPS bridge against an isolated, explicitly synthetic
    /// Mac conversation fixture. It never starts a model, browser, or Mac agent.
    @MainActor
    func testSharedMacHistoryLiveBrowserApprovalAndContinuation() async throws {
        guard let raw = ProcessInfo.processInfo.environment["STRATA_TEST_INVITATION"],
              let invitation = URLComponents(string: raw),
              let control = ProcessInfo.processInfo.environment["STRATA_SHARED_FIXTURE_CONTROL"],
              let controlURL = URL(string: control), controlURL.host == "127.0.0.1" else {
            throw XCTSkip("Provide an isolated shared-conversation fixture invitation and loopback control URL.")
        }
        func item(_ name: String) -> String? { invitation.queryItems?.first { $0.name == name }?.value }
        let address = try XCTUnwrap(item("url"))
        let code = try XCTUnwrap(item("code"))
        let fingerprint = try XCTUnwrap(item("fingerprint"))
        openManualPairing()
        sensitivePairingVisible = true
        fillPairing(address: address, code: code, fingerprint: fingerprint)
        submitPairing()
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["dismissPairingButton"])
        XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 25), .completed)
        sensitivePairingVisible = false
        tapTab("Chat")
        XCTAssertTrue(app.staticTexts["Earlier Mac history is available on the phone."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Ask before actions · Strata UI fixture"].exists)
        let thinking = app.buttons["thinkingDisclosure-fixture-assistant"]
        XCTAssertTrue(thinking.waitForExistence(timeout: 5))
        XCTAssertTrue(thinking.label.contains("Thought for 2s"))
        thinking.tap()
        let reasoning = app.staticTexts["thinkingContent-fixture-assistant"]
        XCTAssertTrue(reasoning.waitForExistence(timeout: 5))
        XCTAssertTrue(reasoning.label.contains("Inspect the existing conversation."))
        thinking.tap()
        let narrative = app.staticTexts.matching(identifier: "assistantMessage")
        XCTAssertEqual(narrative.count, 2, "Ordered narrative blocks must not be repeated as one aggregate answer.")
        let firstGroup = app.descendants(matching: .any).matching(identifier: "activityGroup-fixture-group-earlier").firstMatch
        let laterGroup = app.descendants(matching: .any).matching(identifier: "activityGroup-fixture-group-live").firstMatch
        XCTAssertTrue(firstGroup.exists); XCTAssertTrue(laterGroup.exists)
        XCTAssertLessThan(narrative.element(boundBy: 0).frame.minY, firstGroup.frame.minY)
        XCTAssertLessThan(firstGroup.frame.minY, narrative.element(boundBy: 1).frame.minY)
        XCTAssertLessThan(narrative.element(boundBy: 1).frame.minY, laterGroup.frame.minY)
        XCTAssertFalse(laterGroup.label.contains("Live activity"), "A saved unclosed group is not a live action.")
        attachScreenshot("Shared Mac — thinking and ordered progress")

        _ = try await fixtureControl(controlURL, action: "thinking")
        let preview = app.staticTexts["thinkingPreview-fixture-assistant"]
        XCTAssertTrue(preview.waitForExistence(timeout: 10))
        XCTAssertTrue(preview.label.contains("I am reviewing the Mac workspace."))
        XCTAssertEqual(thinking.value as? String, "Thinking live")
        attachScreenshot("Shared Mac — live thinking preview")

        _ = try await fixtureControl(controlURL, action: "progress")
        let recordedThinking = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Recorded thinking"), object: thinking)
        XCTAssertEqual(XCTWaiter.wait(for: [recordedThinking], timeout: 10), .completed)
        XCTAssertTrue(thinking.label.contains("Thought for 2s"), "Thinking must finish while the Mac continues its tool turn.")
        XCTAssertTrue(app.buttons["stopMessageButton"].exists)
        XCTAssertTrue(laterGroup.label.contains("Live activity"))

        _ = try await fixtureControl(controlURL, action: "browser")
        let browserGroup = app.buttons["activityGroup-fixture-group-live"]
        XCTAssertTrue(browserGroup.waitForExistence(timeout: 10)); reveal(browserGroup); browserGroup.tap()
        let target = app.staticTexts["browserActivityTarget"].firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 10), "A browser action initiated on the Mac fixture must appear without a phone message.")
        XCTAssertTrue(target.label.contains("https://example.com/research"))
        let activity = app.buttons["macActivity-browser-live"]
        XCTAssertEqual(app.buttons.matching(identifier: "macActivity-browser-live").count, 1, "A group member must not also appear as a flat duplicate action.")
        reveal(activity)
        activity.tap()
        XCTAssertTrue(app.staticTexts["macActivityResult"].waitForExistence(timeout: 3))
        attachScreenshot("Shared Mac — live browser activity")
        activity.tap() // Keep approvals compact and reachable while the fixture grows.

        _ = try await fixtureControl(controlURL, action: "allow")
        let allow = app.buttons["approveMacAction-helper-session:approve-action"]
        XCTAssertTrue(allow.waitForExistence(timeout: 10)); reveal(allow); allow.tap()
        let approved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: allow)
        XCTAssertEqual(XCTWaiter.wait(for: [approved], timeout: 10), .completed)

        _ = try await fixtureControl(controlURL, action: "deny")
        let deny = app.buttons["denyMacAction-helper-session:deny-action"]
        XCTAssertTrue(deny.waitForExistence(timeout: 10))
        app.scrollViews.firstMatch.swipeDown() // Read older history while the Mac is still working.
        let latest = app.buttons["followLatestMessagesButton"]
        XCTAssertTrue(latest.waitForExistence(timeout: 5), "Native history scrolling must pause following.")
        latest.tap()
        reveal(deny); deny.tap()
        let denied = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: deny)
        XCTAssertEqual(XCTWaiter.wait(for: [denied], timeout: 10), .completed)
        let approvalState = try await fixtureControl(controlURL, action: "state")
        let calls = try XCTUnwrap(approvalState["calls"] as? [[String: Any]])
        let decisions = calls.filter { ($0["path"] as? String)?.hasSuffix("/approval") == true }.compactMap { $0["body"] as? [String: String] }
        XCTAssertEqual(decisions.map { $0["toolId"] }, ["helper-session:approve-action", "helper-session:deny-action"])
        XCTAssertEqual(decisions.map { $0["decision"] }, ["approve", "deny"])
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.hasSuffix("/messages") == true }, "Viewing live Mac work must not send a new model message.")

        _ = try await fixtureControl(controlURL, action: "complete")
        let stoppedWorking = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["stopMessageButton"])
        XCTAssertEqual(XCTWaiter.wait(for: [stoppedWorking], timeout: 10), .completed)
        XCTAssertTrue(thinking.label.contains("Thought for 7s"))
        XCTAssertEqual(thinking.value as? String, "Recorded thinking")
        let input = app.descendants(matching: .any).matching(identifier: "messageInput").firstMatch
        input.tap(); input.typeText("Continue fixture Mac work")
        app.buttons["sendMessageButton"].tap()
        let continued = app.staticTexts.matching(identifier: "assistantMessage").matching(NSPredicate(format: "label CONTAINS %@", "SAME_MAC_SESSION_CONTINUED")).firstMatch
        XCTAssertTrue(continued.waitForExistence(timeout: 10))
        let stop = app.buttons["stopMessageButton"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5)); stop.tap()
        let stopFinished = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: stop)
        XCTAssertEqual(XCTWaiter.wait(for: [stopFinished], timeout: 10), .completed)
        attachScreenshot("Shared Mac — same conversation continued")

        app.terminate(); app.launch()
        tapTab("Chat")
        app.buttons["chatHistoryButton"].tap()
        let saved = app.buttons["macConversation-fixture-mac-research"]
        XCTAssertTrue(saved.waitForExistence(timeout: 10)); saved.tap()
        XCTAssertTrue(continued.waitForExistence(timeout: 10))
        XCTAssertTrue(thinking.label.contains("Thought for 7s"), "Recorded thinking must survive history reload.")
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "activityGroup-fixture-group-earlier").firstMatch.exists)
        attachScreenshot("Shared Mac — history after relaunch")
        let finalState = try await fixtureControl(controlURL, action: "state")
        let finalCalls = try XCTUnwrap(finalState["calls"] as? [[String: Any]])
        let messages = finalCalls.filter { ($0["path"] as? String)?.hasSuffix("/messages") == true }
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?["path"] as? String, "/api/companion/conversations/fixture-mac-research/messages")
        XCTAssertTrue(finalCalls.contains { ($0["path"] as? String) == "/api/companion/conversations/fixture-mac-research/stop" })
    }

    /// The real phone UI and TLS bridge share bot conversations with a synthetic
    /// host. Opening a bot, history or Thinking must never submit a model prompt.
    @MainActor
    func testBotsSharedHistoryThinkingAndNewConversation() async throws {
        guard let raw = ProcessInfo.processInfo.environment["STRATA_TEST_INVITATION"],
              let invitation = URLComponents(string: raw),
              let control = ProcessInfo.processInfo.environment["STRATA_SHARED_FIXTURE_CONTROL"],
              let controlURL = URL(string: control), controlURL.host == "127.0.0.1" else {
            throw XCTSkip("Provide an isolated Bots fixture invitation and loopback control URL.")
        }
        func item(_ name: String) -> String? { invitation.queryItems?.first { $0.name == name }?.value }
        openManualPairing(); sensitivePairingVisible = true
        fillPairing(address: try XCTUnwrap(item("url")), code: try XCTUnwrap(item("code")), fingerprint: try XCTUnwrap(item("fingerprint")))
        submitPairing()
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["dismissPairingButton"])
        XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 25), .completed)
        sensitivePairingVisible = false

        tapTab("Bots")
        let bot = app.buttons["botProfile-fixture-bot"]
        XCTAssertTrue(bot.waitForExistence(timeout: 10)); bot.tap()
        XCTAssertTrue(app.staticTexts["Code & computer"].waitForExistence(timeout: 5))
        let provider = app.descendants(matching: .any).matching(identifier: "botProviderDetail").firstMatch
        XCTAssertTrue(provider.exists); XCTAssertTrue(provider.label.contains("Codex"))
        let permissions = app.descendants(matching: .any).matching(identifier: "botPermissionsDetail").firstMatch
        XCTAssertTrue(permissions.exists); XCTAssertTrue(permissions.label.contains("Ask before actions"))
        attachScreenshot("Bots — saved provider computer and permissions")
        let history = app.buttons["botConversation-fixture-mac-research"]
        try tapWorkspace(history, performTap: false)
        guard history.exists, history.isHittable else { throw acceptanceError("The saved history row must be visible and reachable after scrolling.") }
        history.tap()
        guard app.staticTexts["Earlier Mac history is available on the phone."].waitForExistence(timeout: 10) else { throw acceptanceError("Opening the bot must show its saved Mac history.") }
        let thinking = app.buttons["thinkingDisclosure-fixture-assistant"]
        XCTAssertTrue(thinking.waitForExistence(timeout: 5)); thinking.tap()
        XCTAssertTrue(app.staticTexts["thinkingContent-fixture-assistant"].waitForExistence(timeout: 5))
        attachScreenshot("Bots — shared Mac history and recorded Thinking")
        let before = try await fixtureControl(controlURL, action: "state")
        let beforeCalls = try XCTUnwrap(before["calls"] as? [[String: Any]])
        XCTAssertFalse(beforeCalls.contains { ($0["method"] as? String) == "POST" }, "Opening bots and history must not start work.")

        tapTab("Bots")
        if app.buttons["botProfile-fixture-bot"].exists { app.buttons["botProfile-fixture-bot"].tap() }
        let create = app.buttons["newBotConversationButton"]
        try tapWorkspace(create)
        let computer = app.buttons["botComputerPicker"]
        XCTAssertTrue(computer.waitForExistence(timeout: 5)); computer.tap()
        let remoteComputer = app.buttons["Remote fixture computer"]
        XCTAssertTrue(remoteComputer.waitForExistence(timeout: 5)); remoteComputer.tap()
        let model = app.buttons["botModelPicker"]
        XCTAssertTrue(model.waitForExistence(timeout: 5)); model.tap()
        let configuredModel = app.buttons["Configured fixture · Fixture connection"]
        XCTAssertTrue(configuredModel.waitForExistence(timeout: 5)); configuredModel.tap()
        app.buttons["clearBotWorkspaceButton"].tap()
        let workspace = app.textFields["botWorkspaceInput"]
        workspace.tap(); workspace.typeText("/srv/fixture-project")
        let dismissKeyboard = app.buttons["dismissBotSetupKeyboardButton"]
        if dismissKeyboard.waitForExistence(timeout: 2) { dismissKeyboard.tap() }
        attachScreenshot("Bots — selected remote computer configured model and workspace")
        let confirm = app.buttons["confirmBotConversationButton"]
        reveal(confirm); confirm.tap()
        XCTAssertTrue(app.staticTexts["New Workspace companion conversation"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Configured fixture"].exists, "The chat shows its frozen selected model.")
        let input = app.descendants(matching: .any).matching(identifier: "messageInput").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap(); input.typeText("Continue bot fixture work")
        app.buttons["sendMessageButton"].tap()
        let reply = app.staticTexts.matching(identifier: "assistantMessage").matching(NSPredicate(format: "label CONTAINS %@", "BOT_SAME_SESSION_CONTINUED")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 10))
        let stop = app.buttons["stopMessageButton"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5)); stop.tap()
        let stopped = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: stop)
        XCTAssertEqual(XCTWaiter.wait(for: [stopped], timeout: 10), .completed)
        attachScreenshot("Bots — same conversation continued and stopped")

        app.terminate(); app.launch(); tapTab("Bots")
        let reopenedBot = app.buttons["botProfile-fixture-bot"]
        XCTAssertTrue(reopenedBot.waitForExistence(timeout: 10)); reopenedBot.tap()
        let saved = app.buttons["botConversation-fixture-bot-created"]
        // Native List materializes later rows as they scroll into view.
        try tapWorkspace(saved, performTap: false)
        guard saved.exists, saved.isHittable else { throw acceptanceError("The saved conversation must be visible and reachable after scrolling.") }
        saved.tap()
        XCTAssertTrue(reply.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["thinkingDisclosure-bot-assistant"].exists)
        attachScreenshot("Bots — shared history retained after relaunch")
        let after = try await fixtureControl(controlURL, action: "state")
        let calls = try XCTUnwrap(after["calls"] as? [[String: Any]])
        XCTAssertEqual(calls.filter { ($0["path"] as? String) == "/api/bots/fixture-bot/conversations" }.count, 1)
        XCTAssertEqual(calls.filter { ($0["path"] as? String)?.hasSuffix("/messages") == true }.count, 1)
        let creation = try XCTUnwrap(calls.first { ($0["path"] as? String) == "/api/bots/fixture-bot/conversations" })
        XCTAssertEqual(creation["body"] as? [String: String], ["computerId": "ssh_fixture", "modelId": "bm_fixture", "workspace": "/srv/fixture-project"])
    }

    @MainActor
    func testScopedHostFolderSettingsGrantAndRevokeWithoutStartingWork() async throws {
        let control = try pairWorkspaceFixture()
        try tapWorkspace(app.buttons["botProfile-fixture-bot"])
        try tapWorkspace(app.buttons["botHostFolderButton"])
        try require(app.switches["hostFolderEnabled"])
        let initial = try await fixtureControl(control, action: "state")
        XCTAssertTrue(try XCTUnwrap(initial["calls"] as? [[String: Any]]).allSatisfy { $0["method"] as? String == "GET" })
        app.switches["hostFolderEnabled"].coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.5)).tap()
        let path = app.textFields["hostFolderPath"]; try require(path); path.tap(); path.typeText("/srv/synthetic-project")
        app.swipeUp()
        attachScreenshot("Shared host folder — opt-in read-only directory")
        try tapWorkspace(app.buttons["saveHostFolderButton"])
        try require(app.buttons["botHostFolderButton"])
        try tapWorkspace(app.buttons["botHostFolderButton"])
        try require(app.textFields["hostFolderPath"])
        XCTAssertEqual(app.textFields["hostFolderPath"].value as? String, "/srv/synthetic-project")
        app.switches["hostFolderEnabled"].coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.5)).tap()
        try tapWorkspace(app.buttons["saveHostFolderButton"])
        try require(app.buttons["botHostFolderButton"])
        let state = try await fixtureControl(control, action: "state")
        let writes = try XCTUnwrap(state["calls"] as? [[String: Any]]).filter { $0["method"] as? String != "GET" }
        XCTAssertEqual(writes.count, 2)
        XCTAssertTrue(writes.allSatisfy { $0["path"] as? String == "/api/bots/fixture-bot/host-folder" && $0["method"] as? String == "PUT" })
        XCTAssertEqual(((writes[0]["body"] as? [String: Any])?["hostFolder"] as? [String: String])?["access"], "read")
        XCTAssertTrue((writes[1]["body"] as? [String: Any])?["hostFolder"] is NSNull)
        attachScreenshot("Shared host folder — access removed without starting a bot")
    }

    @MainActor
    func testDirectBotRosterChatProfileNewConversationAndRelaunch() async throws {
        let control = try pairWorkspaceFixture()
        try tapWorkspace(app.buttons["bot-fixture-bot"])
        try require(app.staticTexts["macConversationTitle"])
        XCTAssertEqual(app.staticTexts["macConversationTitle"].label, "Mac browser research")
        XCTAssertFalse(app.staticTexts["PRIVATE_TEAM_WORKER_MUST_NOT_OPEN_FROM_ROSTER"].exists)
        var state = try await fixtureControl(control, action: "state")
        XCTAssertTrue(try XCTUnwrap(state["calls"] as? [[String: Any]]).allSatisfy { $0["method"] as? String == "GET" })
        attachScreenshot("Bot roster tap — saved personal chat and Thinking without starting work")

        try tapWorkspace(app.buttons["chatBotProfileButton"])
        try require(app.buttons["newBotConversationButton"])
        try tapWorkspace(app.buttons["botConversation-fixture-mac-research"])
        try require(app.staticTexts["macConversationTitle"])
        try tapWorkspace(app.buttons["newChatButton"])
        try require(app.navigationBars["New conversation"])
        XCTAssertTrue(app.staticTexts["Workspace companion"].exists)
        app.buttons["Cancel"].tap()
        XCTAssertEqual(app.staticTexts["macConversationTitle"].label, "Mac browser research")

        tapTab("Bots")
        try tapWorkspace(app.buttons["bot-fixture-reviewer"])
        try require(app.staticTexts["macConversationTitle"])
        XCTAssertEqual(app.staticTexts["macConversationTitle"].label, "Review companion conversation")
        state = try await fixtureControl(control, action: "state")
        let blank = try XCTUnwrap(state["createdBotConversation"] as? [String: Any])
        XCTAssertEqual((blank["messages"] as? [Any])?.count, 0)
        XCTAssertEqual((blank["preferences"] as? [String: Any])?["botId"] as? String, "fixture-reviewer")
        var writes = try XCTUnwrap(state["calls"] as? [[String: Any]]).filter { $0["method"] as? String != "GET" }
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes.first?["path"] as? String, "/api/bots/fixture-reviewer/conversations")
        XCTAssertEqual(writes.first?["body"] as? [String: String], [:])
        attachScreenshot("First bot roster tap — one empty chat using saved bot settings")

        try tapWorkspace(app.buttons["newChatButton"])
        try require(app.navigationBars["New conversation"])
        XCTAssertTrue(app.staticTexts["Review companion"].exists)
        app.buttons["Cancel"].tap()
        try tapWorkspace(app.buttons["chatBotProfileButton"])
        try tapWorkspace(app.buttons["newBotConversationButton"])
        let createFromProfile = app.buttons["confirmBotConversationButton"]
        reveal(createFromProfile); try waitEnabled(createFromProfile); createFromProfile.tap()
        try require(app.staticTexts["macConversationTitle"])
        XCTAssertEqual(app.staticTexts["macConversationTitle"].label, "Review companion conversation")
        XCTAssertFalse(app.buttons["newBotConversationButton"].exists, "Creating from a pushed profile returns to the chat composer.")
        attachScreenshot("Bot profile — explicit new conversation returns to the composer")
        let input = app.descendants(matching: .any).matching(identifier: "messageInput").firstMatch
        try require(input); input.tap(); input.typeText("Continue the direct bot fixture")
        app.buttons["sendMessageButton"].tap()
        let reply = app.staticTexts.matching(identifier: "assistantMessage").matching(NSPredicate(format: "label CONTAINS %@", "BOT_SAME_SESSION_CONTINUED")).firstMatch
        try require(reply)
        try require(app.buttons["stopMessageButton"]); app.buttons["stopMessageButton"].tap()
        let stopped = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["stopMessageButton"])
        await fulfillment(of: [stopped], timeout: 10)
        attachScreenshot("Direct bot chat — explicit fixture message and shared reply")

        app.terminate(); app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]; app.launch(); tapTab("Bots")
        try tapWorkspace(app.buttons["botProfile-fixture-reviewer"])
        try tapWorkspace(app.buttons["newBotConversationButton"], performTap: false)
        attachScreenshot("Direct bot profile — accessibility XXXL and reachable secondary settings")
        app.navigationBars.buttons.firstMatch.tap()
        try tapWorkspace(app.buttons["bot-fixture-reviewer"])
        try require(reply)
        try require(app.buttons["chatBotProfileButton"]); XCTAssertTrue(app.buttons["chatBotProfileButton"].isHittable)
        attachScreenshot("Direct bot chat — accessibility XXXL retained history after relaunch")
        tapTab("Bots"); try tapWorkspace(app.buttons["featuredBotButton"]); try require(reply)
        state = try await fixtureControl(control, action: "state")
        writes = try XCTUnwrap(state["calls"] as? [[String: Any]]).filter { $0["method"] as? String != "GET" }
        XCTAssertEqual(writes.filter { ($0["path"] as? String)?.hasSuffix("/conversations") == true }.count, 2, "One roster-created blank plus one explicitly requested new conversation.")
        XCTAssertEqual(writes.filter { ($0["path"] as? String)?.hasSuffix("/messages") == true }.count, 1)
        XCTAssertEqual(writes.filter { ($0["path"] as? String)?.hasSuffix("/stop") == true }.count, 1)
        XCTAssertFalse(writes.contains { ($0["path"] as? String)?.contains("/computer/") == true || ($0["path"] as? String)?.contains("/approval") == true })
        app.launchArguments = []
    }

    @MainActor
    func testPhoneCreatesDevinBotWithHostModelsAndNoImplicitRun() async throws {
        let control = try pairWorkspaceFixture()
        try openCreateMenu(); try require(app.buttons["createBotButton"]); app.buttons["createBotButton"].tap()
        let name = app.textFields["profileBotNameInput"]; try require(name); name.tap(); name.typeText("Devin companion")
        if app.keyboards.firstMatch.exists { app.buttons["Done"].firstMatch.tap() }
        try tapWorkspace(app.buttons["profileBotProviderPicker"])
        let devin = app.buttons.matching(NSPredicate(format: "label == %@", "Devin CLI")).firstMatch
        try require(devin); devin.tap()
        try tapWorkspace(app.buttons["profileBotModelPicker"])
        let model = app.buttons.matching(NSPredicate(format: "label == %@", "Devin fixture model")).firstMatch
        try require(model); model.tap()
        let effort = app.buttons["profileBotEffortPicker"]; try require(effort)
        XCTAssertTrue((effort.value as? String ?? "").contains("Provider default"), "An empty host effort catalog retains the provider default.")
        attachScreenshot("Devin bot — models from host and provider default effort")
        try waitEnabled(app.buttons["saveBotProfileButton"]); app.buttons["saveBotProfileButton"].tap()
        let saved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: name)
        await fulfillment(of: [saved], timeout: 15)
        let state = try await fixtureControl(control, action: "state")
        let bot = try XCTUnwrap(((state["lifecycle"] as? [String: Any])?["bots"] as? [[String: Any]])?.first)
        XCTAssertEqual(bot["provider"] as? String, "devin"); XCTAssertEqual(bot["model"] as? String, "fixture-devin-model")
        XCTAssertTrue((bot["effort"] as? String ?? "").isEmpty); XCTAssertEqual(bot["policy"] as? String, "manual")
        let calls = try XCTUnwrap(state["calls"] as? [[String: Any]])
        XCTAssertTrue(calls.contains { ($0["path"] as? String) == "/api/bots/provider-models?provider=devin" })
        XCTAssertNil(state["createdBotConversation"] as? [String: Any])
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.hasSuffix("/messages") == true || ($0["path"] as? String)?.contains("/computer/") == true })
        let id = try XCTUnwrap(bot["id"] as? String)
        try tapWorkspace(app.buttons["bot-" + id])
        try require(app.staticTexts["macConversationTitle"])
        try require(app.descendants(matching: .any).matching(identifier: "messageInput").firstMatch)
        attachScreenshot("Devin bot — empty shared conversation ready for a message")
        tapTab("Bots"); try tapWorkspace(app.buttons["bot-" + id])
        try require(app.staticTexts["macConversationTitle"])
        let opened = try await fixtureControl(control, action: "state")
        let chat = try XCTUnwrap(opened["createdBotConversation"] as? [String: Any])
        let preferences = try XCTUnwrap(chat["preferences"] as? [String: Any])
        XCTAssertEqual(preferences["botId"] as? String, id); XCTAssertEqual(preferences["botModel"] as? String, "fixture-devin-model")
        XCTAssertEqual(chat["mode"] as? String, "manual"); XCTAssertTrue((chat["messages"] as? [[String: Any]] ?? []).isEmpty)
        let writes = try XCTUnwrap(opened["calls"] as? [[String: Any]]).filter { $0["method"] as? String != "GET" }
        XCTAssertEqual(writes.count, 2, "One profile save plus one roster-created empty conversation, reused on the next tap.")
        XCTAssertFalse(writes.contains { ($0["path"] as? String)?.hasSuffix("/messages") == true || ($0["path"] as? String)?.contains("/computer/") == true })
    }

    @MainActor
    func testPhoneBotCreationEditingCASAndApprovalModes() async throws {
        let control = try pairWorkspaceFixture()
        try openCreateMenu(); try require(app.buttons["createBotButton"]); app.buttons["createBotButton"].tap()
        attachScreenshot("Bots — photo-led character-first creation")
        let name = app.textFields["profileBotNameInput"]; try require(name); name.tap(); name.typeText("Phone Builder")
        if app.keyboards.firstMatch.exists { app.buttons["Done"].firstMatch.tap() }
        try tapWorkspace(app.buttons["avatar-shape-orb"])
        try tapWorkspace(app.buttons["avatar-color-violet"])
        attachScreenshot("Bots — original geometric character and shared color")
        try tapWorkspace(app.buttons["profileBotProviderPicker"])
        let configured = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "Configured models")).firstMatch; try require(configured); configured.tap()
        try tapWorkspace(app.buttons["profileBotConfiguredModelPicker"])
        let savedModel = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Configured fixture")).firstMatch; try require(savedModel); savedModel.tap()
        attachScreenshot("Bot creation — saved model and Ask default")
        try waitEnabled(app.buttons["saveBotProfileButton"]); app.buttons["saveBotProfileButton"].tap()
        let created = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: name)
        await fulfillment(of: [created], timeout: 15)
        var state = try await fixtureControl(control, action: "state")
        let first = try XCTUnwrap((state["lifecycle"] as? [String: Any])?["bots"] as? [[String: Any]]).first
        let id = try XCTUnwrap(first?["id"] as? String)
        XCTAssertEqual(first?["policy"] as? String, "manual"); XCTAssertEqual(first?["model"] as? String, "configured-model")
        XCTAssertEqual((first?["avatarConfig"] as? [String: String])?["shape"], "orb")
        XCTAssertNil(state["createdBotConversation"] as? [String: Any], "Saving a bot creates no conversation.")
        let calls = try XCTUnwrap(state["calls"] as? [[String: Any]])
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.hasSuffix("/messages") == true || ($0["path"] as? String)?.contains("/computer/") == true })
        app.terminate(); app.launch(); tapTab("Bots")
        try tapWorkspace(app.buttons["botProfile-" + id]); try require(app.buttons["editBotProfileButton"]); app.buttons["editBotProfileButton"].tap()
        try require(app.buttons["avatar-shape-orb"]); XCTAssertTrue(app.buttons["avatar-shape-orb"].isSelected)
        attachScreenshot("Bots — saved geometric character retained after relaunch")
        try tapWorkspace(app.buttons["avatar-character-fox"])
        try expandProfile("profileBotBehaviorDisclosure", revealing: app.buttons["profileBotPolicyPicker"])
        try tapWorkspace(app.buttons["profileBotPolicyPicker"]); app.buttons["Bypass approvals"].tap()
        try waitEnabled(app.buttons["saveBotProfileButton"]); app.buttons["saveBotProfileButton"].tap()
        try require(app.buttons["Use Bypass approvals"]); app.buttons["Use Bypass approvals"].tap()
        let saved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: name)
        await fulfillment(of: [saved], timeout: 15)
        state = try await fixtureControl(control, action: "state")
        XCTAssertEqual(((state["lifecycle"] as? [String: Any])?["bots"] as? [[String: Any]])?.first?["policy"] as? String, "bypass")
        let editedFace = ((state["lifecycle"] as? [String: Any])?["bots"] as? [[String: Any]])?.first?["avatarConfig"] as? [String: String]
        XCTAssertEqual(editedFace?["kind"], "fox"); XCTAssertNil(editedFace?["shape"], "Choosing an animal explicitly clears geometry.")
        XCTAssertEqual((state["conversation"] as? [String: Any])?["mode"] as? String, "manual")
        try require(app.buttons["editBotProfileButton"]); app.buttons["editBotProfileButton"].tap()
        _ = try await fixtureControl(control, action: "profile-change")
        try expandProfile("profileBotBehaviorDisclosure", revealing: app.buttons["profileBotPolicyPicker"])
        try tapWorkspace(app.buttons["profileBotPolicyPicker"]); app.buttons["Plan mode"].tap()
        try waitEnabled(app.buttons["saveBotProfileButton"]); app.buttons["saveBotProfileButton"].tap()
        try require(app.staticTexts["profileBotSaveError"])
        attachScreenshot("Bot editing — stale version requires review")
        try require(app.buttons["reloadBotProfileButton"]); app.buttons["reloadBotProfileButton"].tap()
        try XCTUnwrap(app.buttons.matching(identifier: "Reload latest bot").allElementsBoundByIndex.last(where: { $0.isHittable })).tap()
        let model = app.textFields["profileBotModelInput"]
        try expandProfile("profileBotAdvancedModelDisclosure", revealing: model)
        try tapWorkspace(model)
        XCTAssertEqual(model.value as? String, "Fixture model", "Reload must preserve the Mac's model, not clear it through a picker callback.")
        if app.keyboards.firstMatch.exists { app.buttons["Done"].firstMatch.tap() }
        try require(app.buttons["profileBotEffortPicker"])
        XCTAssertTrue((app.buttons["profileBotEffortPicker"].label + " " + (app.buttons["profileBotEffortPicker"].value as? String ?? "")).localizedCaseInsensitiveContains("high"))
        attachScreenshot("Bot editing — reloaded model and effort retained")
        try waitEnabled(app.buttons["saveBotProfileButton"]); app.buttons["saveBotProfileButton"].tap()
        let reloaded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: name)
        await fulfillment(of: [reloaded], timeout: 15)
        try tapWorkspace(app.buttons["newBotConversationButton"])
        try tapWorkspace(app.buttons["botConversationPolicyPicker"]); app.buttons["Bypass approvals"].tap()
        let confirm = app.buttons["confirmBotConversationButton"]
        reveal(confirm); try waitEnabled(confirm)
        attachScreenshot("Bot conversation — explicit Bypass choice before creation")
        confirm.tap()
        try require(app.buttons["Create with Bypass approvals"]); app.buttons["Create with Bypass approvals"].tap()
        try require(app.staticTexts["macConversationTitle"])
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Bypass approvals")).firstMatch.exists)
        state = try await fixtureControl(control, action: "state")
        XCTAssertEqual((state["createdBotConversation"] as? [String: Any])?["mode"] as? String, "bypass")
        XCTAssertEqual((state["conversation"] as? [String: Any])?["mode"] as? String, "manual")
        let writes = try XCTUnwrap(state["calls"] as? [[String: Any]]).filter { ($0["method"] as? String) != "GET" }
        XCTAssertFalse(writes.contains { ($0["path"] as? String)?.contains("/approval") == true || ($0["path"] as? String)?.hasSuffix("/messages") == true })
        attachScreenshot("Bot conversation — explicit frozen Bypass mode")
    }

    @MainActor
    func testPhotoLedBotsCreationAppearanceAndWorkspaceNavigation() async throws {
        let control = try pairWorkspaceFixture()
        for (style, large) in [("Dark", false), ("Light", false), ("Dark", true)] {
            app.terminate()
            _ = try await fixtureControl(control, action: style == "Dark" ? "appearance-dark" : "appearance-light")
            app.launchArguments = large ? ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] : []
            app.launch(); tapTab("Bots")
            try require(app.buttons["bot-fixture-bot"])
            let search = app.textFields["botRosterSearchInput"]
            try require(search); XCTAssertTrue(search.isHittable)
            if style == "Dark", !large {
                try tapWorkspace(app.buttons["featuredBotButton"])
                try require(app.staticTexts["macConversationTitle"])
                XCTAssertEqual(app.staticTexts["macConversationTitle"].label, "Mac browser research", "The decorated hero opens its exact saved personal conversation.")
                attachScreenshot("Warm bot hero — exact saved chat action")
                tapTab("Bots"); try require(app.navigationBars["Bots"])
            }
            attachScreenshot("Photo-led roster — " + style + (large ? " accessibility" : ""))
            if !large { for title in ["Activity", "Skills", "Connections", "Team"] { try selectWorkspace(title) } }
            try openCreateMenu(); try require(app.buttons["createBotButton"]); app.buttons["createBotButton"].tap()
            try require(app.textFields["profileBotNameInput"])
            attachScreenshot("Photo-led creation — " + style + (large ? " accessibility" : ""))
            try tapWorkspace(app.buttons["profileBotAvatarButton"])
            try require(app.navigationBars["Customize avatar"])
            attachScreenshot("Warm bot stage — Customize action — " + style + (large ? " accessibility" : ""))
            app.navigationBars["Customize avatar"].buttons["Done"].tap()
            try require(app.textFields["profileBotNameInput"])
            try tapWorkspace(app.buttons["avatar-shape-hexagon"])
            try tapWorkspace(app.buttons["avatarAppearanceDisclosure"])
            try tapWorkspace(app.buttons["avatar-eyes-round"])
            try tapWorkspace(app.buttons["profileBotProviderPicker"])
            let configured = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "Configured models")).firstMatch
            try require(configured); configured.tap()
            try tapWorkspace(app.buttons["profileBotConfiguredModelPicker"])
            let model = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Configured fixture / Qwen")).firstMatch
            try require(model); model.tap()
            let selectedValue = app.buttons["profileBotConfiguredModelPicker"].value as? String ?? ""
            guard selectedValue.contains("Configured fixture / Qwen"), selectedValue.contains("separate remote Strata computer") else { throw acceptanceError("The selected model must retain its full display name.") }
            attachScreenshot("Photo-led model card — " + style + (large ? " accessibility long name" : " long name"))
            let save = app.buttons["saveBotProfileButton"]
            try require(save); XCTAssertTrue(save.isHittable, "The primary action stays above the keyboard and safe area.")
            app.buttons["Cancel"].tap()
        }
        app.launchArguments = []
        let state = try await fixtureControl(control, action: "state")
        XCTAssertTrue(try XCTUnwrap(state["calls"] as? [[String: Any]]).allSatisfy { ($0["method"] as? String) == "GET" }, "Appearance, customization drafts and workspace navigation start no work.")
    }

    @MainActor
    func testBotAvatarStatesInteractionAndRosterFilters() async throws {
        let control = try pairWorkspaceFixture()
        attachScreenshot("Bots — photo-led spacious roster and persistent search")
        let search = app.textFields["botRosterSearchInput"]; try tapWorkspace(search); search.typeText("no matching bot")
        try require(app.staticTexts["botRosterFilteredEmpty"])
        search.tap(); search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "no matching bot".count))
        if app.keyboards.firstMatch.exists { app.buttons["Done"].firstMatch.exists ? app.buttons["Done"].firstMatch.tap() : app.keyboards.buttons["Search"].tap() }
        try tapWorkspace(app.buttons["botProfile-fixture-bot"])
        try tapWorkspace(app.buttons["botConversation-fixture-mac-research"])
        let face = app.buttons["animateBotAvatarButton"]; try require(face)
        _ = try await fixtureControl(control, action: "thinking")
        let thinking = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "Thinking"), object: face)
        await fulfillment(of: [thinking], timeout: 12)
        face.tap(); attachScreenshot("Bot avatar — live Thinking and tap interaction")
        _ = try await fixtureControl(control, action: "progress")
        _ = try await fixtureControl(control, action: "browser")
        let working = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "Working"), object: face)
        await fulfillment(of: [working], timeout: 12)
        tapTab("Bots")
        let backToRoster = app.navigationBars.buttons["Bots"].firstMatch
        if backToRoster.exists { backToRoster.tap() }
        try selectRosterFilter("Working"); try require(app.buttons["bot-fixture-bot"])
        XCTAssertFalse(app.buttons["bot-fixture-reviewer"].exists)
        attachScreenshot("Bot roster — actual active work filter")
        tapTab("Chat")
        _ = try await fixtureControl(control, action: "allow")
        let approval = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "Needs approval"), object: face)
        await fulfillment(of: [approval], timeout: 12)
        face.tap(); attachScreenshot("Bot avatar — pending approval remains explicit")
        var state = try await fixtureControl(control, action: "state")
        XCTAssertEqual((state["pending"] as? [Any])?.count, 1)
        XCTAssertFalse((state["calls"] as? [[String: Any]])?.contains { ($0["path"] as? String)?.hasSuffix("/approval") == true } == true)
        _ = try await fixtureControl(control, action: "approval-resolved")
        _ = try await fixtureControl(control, action: "complete")
        let done = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "Reply ready"), object: face)
        await fulfillment(of: [done], timeout: 12)
        _ = try await fixtureControl(control, action: "reply-error")
        let failed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "Error"), object: face)
        await fulfillment(of: [failed], timeout: 12)
        tapTab("Bots"); try selectRosterFilter("Needs attention"); try require(app.buttons["bot-fixture-bot"])
        attachScreenshot("Bot roster — needs-attention filter")
        state = try await fixtureControl(control, action: "state")
        XCTAssertTrue(try XCTUnwrap(state["calls"] as? [[String: Any]]).allSatisfy { ($0["method"] as? String) == "GET" }, "Viewing and animating avatars never sends a prompt or permission decision.")
    }

    @MainActor
    func testLiveBotSupervisionFiltersExactConversationAndLargeType() async throws {
        let control = try pairWorkspaceFixture()
        try require(app.buttons["botsActivityButton"]); app.buttons["botsActivityButton"].tap()
        try require(app.descendants(matching: .any).matching(identifier: "botSupervisionSummary").firstMatch)
        try tapWorkspace(app.buttons["botSupervisionFilter-Needs you"])
        try require(app.staticTexts["1 approval waiting"])
        XCTAssertFalse(app.staticTexts["Review in the shared computer"].exists)
        attachScreenshot("Bot supervision — approval attention")
        try tapWorkspace(app.buttons["Review approval"])
        try require(app.staticTexts["macConversationTitle"])
        XCTAssertEqual(app.staticTexts["macConversationTitle"].label, "Mac browser research")
        XCTAssertFalse(app.staticTexts["Review in the shared computer"].exists)
        attachScreenshot("Bot supervision — exact approval conversation")
        tapTab("Bots"); try require(app.buttons["botsActivityButton"]); app.buttons["botsActivityButton"].tap()
        try tapWorkspace(app.buttons["botSupervisionFilter-Working"])
        try require(app.staticTexts["Review in the shared computer"])
        XCTAssertTrue(app.staticTexts["Subagent · Remote fixture computer"].exists)
        attachScreenshot("Bot supervision — live subagent")
        _ = try await fixtureControl(control, action: "supervision-complete")
        try tapWorkspace(app.buttons["botSupervisionFilter-Needs you"])
        try require(app.descendants(matching: .any).matching(identifier: "botSupervisionEmpty").firstMatch)
        XCTAssertFalse(app.buttons["Review approval"].exists)
        attachScreenshot("Bot supervision — cleared approval")
        app.terminate()
        _ = try await fixtureControl(control, action: "appearance-dark")
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch(); tapTab("Bots")
        // The bottom menu exists before the cold-load catalog has finished.
        // Wait for the roster to settle before opening its native menu.
        try require(app.buttons["featuredBotButton"])
        try require(app.buttons["botsActivityButton"]); app.buttons["botsActivityButton"].tap()
        try tapWorkspace(app.buttons["botSupervisionFilter-Recently finished"])
        try tapWorkspace(app.staticTexts["Mac browser research"], performTap: false)
        try tapWorkspace(app.buttons["Open conversation"].firstMatch, performTap: false)
        attachScreenshot("Bot supervision — accessibility type in dark appearance")
        let state = try await fixtureControl(control, action: "state")
        let calls = try XCTUnwrap(state["calls"] as? [[String: Any]])
        XCTAssertTrue(calls.allSatisfy { ($0["method"] as? String) == "GET" }, "Supervision and review navigation must never send a prompt, approval, task or computer command.")
        XCTAssertGreaterThan(calls.filter { $0["path"] as? String == "/api/bots/supervision" }.count, 2)
        XCTAssertTrue(calls.contains { $0["path"] as? String == "/api/companion/conversations/fixture-mac-research" })
    }

    @MainActor
    private func pairWorkspaceFixture() throws -> URL {
        guard let raw = ProcessInfo.processInfo.environment["STRATA_TEST_INVITATION"],
              let invitation = URLComponents(string: raw),
              let control = ProcessInfo.processInfo.environment["STRATA_SHARED_FIXTURE_CONTROL"],
              let controlURL = URL(string: control), controlURL.host == "127.0.0.1" else { throw XCTSkip("Provide an isolated workspace fixture.") }
        func item(_ name: String) -> String? { invitation.queryItems?.first { $0.name == name }?.value }
        openManualPairing(); sensitivePairingVisible = true
        fillPairing(address: try XCTUnwrap(item("url")), code: try XCTUnwrap(item("code")), fingerprint: try XCTUnwrap(item("fingerprint")))
        submitPairing()
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["dismissPairingButton"])
        guard XCTWaiter.wait(for: [dismissed], timeout: 25) == .completed else { throw acceptanceError("Fixture pairing did not complete.") }
        sensitivePairingVisible = false
        tapTab("Bots")
        try require(app.buttons["botsWorkspaceMenuButton"])
        return controlURL
    }

    @MainActor
    func testFaceliftPrincipalScreensAndSharedHistory() async throws {
        let controlURL = try pairWorkspaceFixture()
        tapTab("Home")
        try require(app.buttons["startChatButton"])
        if app.scrollViews.firstMatch.exists { for _ in 0..<3 { app.scrollViews.firstMatch.swipeDown() } }
        attachScreenshot("Facelift — Home dashboard")
        let modelHeading = app.staticTexts["ACTIVE MODEL"]
        for _ in 0..<4 { if modelHeading.isHittable { break }; app.scrollViews.firstMatch.swipeUp() }
        attachScreenshot("Facelift — Home model status")
        tapTab("Models")
        try require(app.staticTexts["YOUR LIBRARY"])
        attachScreenshot("Facelift — Models and downloads")
        tapTab("Connection")
        try require(app.buttons["refreshConnectionButton"])
        attachScreenshot("Facelift — Paired connection")
        tapTab("Bots")
        try require(app.buttons["bot-fixture-bot"])
        attachScreenshot("Facelift — Bots and teams")
        for destination in ["Skills", "Connections", "Activity", "Team"] {
            try selectWorkspace(destination)
            if destination == "Skills" { try require(app.buttons["botSkill-library.review"]) }
            if destination == "Connections" { try require(app.buttons["botConnection-mcpc_fixture"]) }
            attachScreenshot("Facelift — " + destination)
        }
        let bot = app.buttons["botProfile-fixture-bot"]
        try tapWorkspace(bot)
        let conversation = app.buttons["botConversation-fixture-mac-research"]
        try tapWorkspace(conversation)
        let thinking = app.buttons["thinkingDisclosure-fixture-assistant"]
        // This opens at Latest. At large text the earlier Thinking header is
        // intentionally above the viewport; use actual older-history scrolling.
        for _ in 0..<8 {
            if thinking.exists, thinking.isHittable { break }
            app.scrollViews.firstMatch.swipeDown()
        }
        try require(thinking); thinking.tap()
        try require(app.staticTexts["thinkingContent-fixture-assistant"])
        attachScreenshot("Facelift — Shared chat and Thinking")
        let state = try await fixtureControl(controlURL, action: "state")
        let calls = try XCTUnwrap(state["calls"] as? [[String: Any]])
        XCTAssertFalse(calls.contains { ($0["method"] as? String ?? "GET") != "GET" }, "Appearance and navigation must not mutate the workspace or send a prompt.")
    }

    @MainActor
    func testHarnessReadinessDiagnosticsAndReviewWithoutExecutingWork() async throws {
        let control = try pairWorkspaceFixture()
        let initial = try await fixtureControl(control, action: "state"), initialHarness = try XCTUnwrap(initial["harness"] as? [String: Any])
        let actions = try XCTUnwrap(initialHarness["actions"] as? [[String: Any]])
        let local = try XCTUnwrap(actions.first { $0["origin"] as? String == "local" }), localId = try XCTUnwrap(local["id"] as? String)
        let remote = try XCTUnwrap(actions.first { $0["origin"] as? String == "ssh-worker" }), remoteId = try XCTUnwrap(remote["id"] as? String)
        _ = try await fixtureControl(control, action: "harness-failure")
        try selectWorkspace("Activity")
        try require(app.descendants(matching: .any).matching(identifier: "botSupervisionSummary").firstMatch)
        let initialFailure = app.descendants(matching: .any).matching(identifier: "harnessRecoveryInitialUnavailable").firstMatch
        try tapWorkspace(initialFailure, performTap: false)
        XCTAssertFalse(app.staticTexts["No interrupted actions need review in the retained journal."].exists)
        XCTAssertFalse(app.buttons["reviewHarnessAction-" + localId].exists)
        attachScreenshot("Harness — initial failure remains visible without claiming an empty journal")
        let refreshReceipts = app.buttons["refreshHarnessActionsButton"]
        try tapWorkspace(refreshReceipts, performTap: false); try waitEnabled(refreshReceipts)
        _ = try await fixtureControl(control, action: "harness-clear-failure")
        refreshReceipts.tap()
        let recovered = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: initialFailure)
        await fulfillment(of: [recovered], timeout: 12)
        try selectWorkspace("Skills"); try selectWorkspace("Activity")
        try require(app.descendants(matching: .any).matching(identifier: "botSupervisionSummary").firstMatch)
        try tapWorkspace(app.buttons["botSupervisionFilter-Needs you"])
        let diagnostics = app.descendants(matching: .any).matching(identifier: "botHarnessDetails-fixture-mac-research").firstMatch
        try require(diagnostics); try tapWorkspace(diagnostics)
        try tapWorkspace(app.staticTexts["Context compactions"], performTap: false)
        try require(app.staticTexts["Provider wait"])
        attachScreenshot("Harness — provider, approval and tool timing details")
        try tapWorkspace(app.buttons["Inspect conversation"].firstMatch)
        try require(app.staticTexts["macConversationTitle"])
        XCTAssertEqual(app.staticTexts["macConversationTitle"].label, "Mac browser research")
        tapTab("Bots"); try selectWorkspace("Activity")
        let before = try await fixtureControl(control, action: "state"), beforeCalls = try XCTUnwrap(before["calls"] as? [[String: Any]])
        XCTAssertTrue(beforeCalls.allSatisfy { $0["method"] as? String == "GET" })
        XCTAssertFalse(app.buttons["reviewHarnessAction-" + remoteId].exists, "SSH uncertainty remains read-only here.")
        let review = app.buttons["reviewHarnessAction-" + localId]
        try tapWorkspace(review)
        try require(app.buttons["I reviewed the conversation"]); app.buttons["I reviewed the conversation"].tap()
        let reviewed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: review)
        await fulfillment(of: [reviewed], timeout: 15)
        attachScreenshot("Harness — remote uncertainty remains after explicit local acknowledgement")
        _ = try await fixtureControl(control, action: "harness-unavailable")
        let warning = app.descendants(matching: .any).matching(identifier: "harnessRecoveryUnavailable").firstMatch
        XCTAssertTrue(warning.waitForExistence(timeout: 18))
        try tapWorkspace(warning, performTap: false)
        try tapWorkspace(app.descendants(matching: .any).matching(identifier: "harnessAction-" + remoteId).firstMatch, performTap: false)
        XCTAssertTrue(app.buttons["Inspect conversation"].exists, "Readable uncertainty remains available for inspection if another receipt is unavailable.")
        XCTAssertFalse(app.staticTexts["No interrupted actions need review in the retained journal."].exists)
        attachScreenshot("Harness — unavailable journal preserves readable uncertainty")
        try selectWorkspace("Skills")
        let library = app.segmentedControls["botCapabilitiesLibraryPicker"]; try require(library); library.buttons["Tools"].tap()
        let toolId = "tool_00000000-0000-4000-8000-000000000001"
        try tapWorkspace(app.buttons["botTool-" + toolId])
        func edit() throws { try tapWorkspace(app.buttons["reviewBotToolButton"]); try tapWorkspace(app.buttons["editBotToolButton"]) }
        func save() async throws {
            let button = app.buttons["saveBotToolButton"]; try waitEnabled(button); button.tap()
            let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: button)
            await fulfillment(of: [closed], timeout: 12)
        }
        try edit()
        try tapSwitch(app.switches["botToolPlatform-darwin"])
        let programs = app.descendants(matching: .any).matching(identifier: "botToolProgramsInput").firstMatch
        try tapWorkspace(programs); programs.typeText("node")
        let files = app.descendants(matching: .any).matching(identifier: "botToolFilesInput").firstMatch
        try tapWorkspace(files); files.typeText("package.json")
        attachScreenshot("Reusable tool — selected computer requirements")
        try await save()
        let savedState = try await fixtureControl(control, action: "state"), savedTools = try XCTUnwrap(savedState["createdTools"] as? [[String: Any]])
        let saved = try XCTUnwrap(savedTools.first { $0["id"] as? String == toolId }), requirements = try XCTUnwrap(saved["requirements"] as? [String: Any])
        XCTAssertEqual(requirements["platforms"] as? [String], ["darwin"]); XCTAssertEqual(requirements["executables"] as? [String], ["node"]); XCTAssertEqual(requirements["workspaceFiles"] as? [String], ["package.json"])
        XCTAssertEqual(saved["status"] as? String, "draft")
        try edit(); try tapWorkspace(app.buttons["clearBotToolRequirementsButton"]); try await save()
        let final = try await fixtureControl(control, action: "state"), finalCalls = try XCTUnwrap(final["calls"] as? [[String: Any]])
        let writes = finalCalls.filter { $0["method"] as? String != "GET" }
        XCTAssertEqual(writes.count, 3)
        let acknowledgement = try XCTUnwrap(writes.first { $0["path"] as? String == "/api/bots/harness/actions/" + localId + "/review" }), proof = try XCTUnwrap(acknowledgement["body"] as? [String: Any])
        XCTAssertEqual(Set(proof.keys), ["expectedRevision", "expectedProof", "decision"]); XCTAssertEqual(proof["expectedRevision"] as? Int, local["revision"] as? Int); XCTAssertEqual(proof["expectedProof"] as? String, local["proof"] as? String)
        let finalTools = try XCTUnwrap(final["createdTools"] as? [[String: Any]]), finalTool = try XCTUnwrap(finalTools.first { $0["id"] as? String == toolId })
        XCTAssertNil(finalTool["requirements"]); XCTAssertEqual(finalTool["revision"] as? Int, 3); XCTAssertEqual(finalTool["status"] as? String, "draft")
        XCTAssertEqual(final["harnessDispatches"] as? Int, 1, "Only the fixture's initial inert lost-result callback occurred; acknowledgement never dispatched work.")
        let finalHarness = try XCTUnwrap(final["harness"] as? [String: Any]), finalActions = try XCTUnwrap(finalHarness["actions"] as? [[String: Any]])
        XCTAssertEqual(finalActions.first { $0["id"] as? String == localId }?["state"] as? String, "reviewed")
        XCTAssertEqual(finalActions.first { $0["id"] as? String == remoteId }?["state"] as? String, "uncertain")
        XCTAssertFalse(finalCalls.contains { ($0["path"] as? String)?.hasSuffix("/messages") == true || ($0["path"] as? String)?.contains("/computer/") == true || ($0["path"] as? String)?.hasSuffix("/resume") == true })
        attachScreenshot("Reusable tool — cleared requirements retain the reviewed draft")
    }

    @MainActor
    func testCreatedToolDraftReviewBotAndTeamAccessWithoutExecution() async throws {
        let control = try pairWorkspaceFixture()
        try selectWorkspace("Skills")
        let library = app.segmentedControls["botCapabilitiesLibraryPicker"]
        try require(library); library.buttons["Tools"].tap()
        try tapWorkspace(app.buttons["botTool-tool_00000000-0000-4000-8000-000000000001"])
        try require(app.staticTexts["botToolReviewedCommand"])
        attachScreenshot("Reusable tool — command and input schema to review")
        try tapWorkspace(app.buttons["enableBotToolButton"], performTap: false)
        XCTAssertFalse(app.buttons["enableBotToolButton"].isEnabled)
        let bot = app.switches["toolBotAssignment-fixture-bot"]
        func reviewCurrent() throws {
            try tapWorkspace(app.buttons["reviewBotToolButton"])
        }
        try reviewCurrent()
        attachScreenshot("Reusable tool — reviewed definition ready to enable")
        try waitEnabled(app.buttons["enableBotToolButton"]); try tapWorkspace(app.buttons["enableBotToolButton"])
        let review = app.buttons["reviewBotToolButton"]; try require(review)
        try reviewCurrent(); try waitEnabled(bot); try tapSwitch(bot)
        let assignedBot = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == '1'"), object: bot)
        await fulfillment(of: [assignedBot], timeout: 10)
        try reviewCurrent()
        let team = app.switches["toolTeamAssignment-team_tool_fixture"]
        try waitEnabled(team); try tapSwitch(team)
        let assignedTeam = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == '1'"), object: team)
        await fulfillment(of: [assignedTeam], timeout: 10)
        attachScreenshot("Reusable tool — bot and team access on the phone")
        try reviewCurrent(); try tapWorkspace(app.buttons["editBotToolButton"])
        let command = app.textViews["botToolCommandInput"]; try require(command); try tapWorkspace(command)
        command.typeText(" --summary")
        try waitEnabled(app.buttons["saveBotToolButton"]); app.buttons["saveBotToolButton"].tap()
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["saveBotToolButton"])
        await fulfillment(of: [dismissed], timeout: 10)
        try require(app.buttons["enableBotToolButton"])
        XCTAssertEqual(app.buttons["enableBotToolButton"].label, "Enable reviewed tool", "Editing must return the tool to draft.")
        let state = try await fixtureControl(control, action: "state")
        let calls = try XCTUnwrap(state["calls"] as? [[String: Any]])
        let writes = calls.filter { $0["method"] as? String != "GET" }
        XCTAssertEqual(writes.count, 4)
        XCTAssertTrue(writes.allSatisfy { $0["path"] as? String == "/api/bots/tools/tool_00000000-0000-4000-8000-000000000001" && $0["method"] as? String == "PATCH" })
        let tools = try XCTUnwrap(state["createdTools"] as? [[String: Any]])
        let saved = try XCTUnwrap(tools.first { $0["id"] as? String == "tool_00000000-0000-4000-8000-000000000001" })
        XCTAssertEqual(saved["status"] as? String, "draft"); XCTAssertEqual(saved["revision"] as? Int, 5)
        XCTAssertTrue((saved["command"] as? String)?.contains("--summary") == true)
        XCTAssertEqual(saved["botIds"] as? [String], ["fixture-bot"]); XCTAssertEqual(saved["teamIds"] as? [String], ["team_tool_fixture"])
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.contains("/computer/") == true || ($0["path"] as? String)?.hasSuffix("/messages") == true })
        try reviewCurrent(); try tapWorkspace(app.buttons["deleteBotToolButton"])
        let confirm = app.buttons["Delete tool"].firstMatch
        try require(confirm); confirm.tap()
        try require(app.buttons["createBotToolButton"])
        XCTAssertFalse(app.buttons["botTool-tool_00000000-0000-4000-8000-000000000001"].exists)
        let final = try await fixtureControl(control, action: "state"), finalCalls = try XCTUnwrap(final["calls"] as? [[String: Any]])
        let deletion = try XCTUnwrap(finalCalls.first { $0["method"] as? String == "DELETE" })
        let proof = try XCTUnwrap(deletion["body"] as? [String: Any])
        XCTAssertEqual(proof["expectedRevision"] as? Int, 5); XCTAssertEqual(proof["expectedDigest"] as? String, saved["digest"] as? String)
        XCTAssertEqual(finalCalls.filter { $0["method"] as? String != "GET" }.count, 5)
        XCTAssertTrue(try XCTUnwrap(final["createdTools"] as? [[String: Any]]).isEmpty)
    }

    @MainActor
    func testReviewedSkillAssignmentAndWorkspaceNavigation() async throws {
        let controlURL = try pairWorkspaceFixture()
        try selectWorkspace("Skills")
        let create = app.buttons["createBotSkillButton"]
        try require(create); try waitEnabled(create); create.tap()
        app.textFields["botSkillNameInput"].tap(); app.textFields["botSkillNameInput"].typeText("Phone review skill")
        let body = app.textViews["botSkillBodyInput"]; body.tap(); body.typeText("Review the change and explain the result.")
        app.buttons["saveBotSkillButton"].tap()
        let skill = app.buttons["botSkill-skill_created"]
        try require(skill); try tapWorkspace(skill)
        let enable = app.buttons["enableBotSkillButton"]
        try require(enable); try waitEnabled(enable); try tapWorkspace(enable)
        let assign = app.switches["skillAssignment-fixture-bot"]
        try waitEnabled(assign); try tapSwitch(assign)
        let assigned = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == '1'"), object: assign)
        guard XCTWaiter.wait(for: [assigned], timeout: 10) == .completed else { throw acceptanceError("The skill assignment was not confirmed.") }
        attachScreenshot("Bots workspace — reviewed skill assigned")
        app.navigationBars.buttons.firstMatch.tap()
        try selectWorkspace("Connections")
        try require(app.buttons["botConnection-mcpc_fixture"])
        try selectWorkspace("Skills")
        try require(app.buttons["botSkill-skill_created"])
        attachScreenshot("Bots workspace — returning retains reviewed skills")
        let state = try await fixtureControl(controlURL, action: "state"), calls = try XCTUnwrap(state["calls"] as? [[String: Any]])
        XCTAssertTrue(calls.contains { $0["path"] as? String == "/api/bots/skills/assign" && $0["method"] as? String == "POST" })
        XCTAssertTrue(calls.contains { $0["path"] as? String == "/api/bots/connections" })
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.hasSuffix("/messages") == true })
    }

    @MainActor
    func testSavedConnectionCheckAndReviewedAccess() async throws {
        let controlURL = try pairWorkspaceFixture()
        try selectWorkspace("Connections")
        let connection = app.buttons["botConnection-mcpc_fixture"]
        try require(connection); try tapWorkspace(connection)
        let check = app.buttons["checkBotConnectionButton"]
        try require(check); check.tap()
        try require(app.buttons["Check saved connection"]); app.buttons["Check saved connection"].tap()
        let write = app.switches["connectionToolAccess-tool_write"]
        try require(write); try waitEnabled(write); try tapSwitch(write)
        try tapSwitch(app.switches["connectionBotAccess-fixture-reviewer"])
        try tapWorkspace(app.buttons["saveBotConnectionAccessButton"])
        try require(app.staticTexts["Access saved"])
        attachScreenshot("Bots workspace — saved MCP tool and bot access")
        let state = try await fixtureControl(controlURL, action: "state"), calls = try XCTUnwrap(state["calls"] as? [[String: Any]])
        XCTAssertTrue(calls.contains { $0["path"] as? String == "/api/bots/connections/mcpc_fixture/check" })
        let access = try XCTUnwrap(calls.first { $0["path"] as? String == "/api/bots/connections/mcpc_fixture" && $0["method"] as? String == "PATCH" }?["body"] as? [String: Any])
        XCTAssertEqual(access["readOnlyToolIds"] as? [String], ["tool_read"])
        XCTAssertTrue((access["enabledToolIds"] as? [String] ?? []).contains("tool_write"))
        XCTAssertTrue((access["botIds"] as? [String] ?? []).contains("fixture-reviewer"))
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.hasSuffix("/messages") == true })
    }

    @MainActor
    func testConnectorsHTTPSetupTeamAccessToolsAndPersistence() async throws {
        let control = try pairWorkspaceFixture()
        tapTab("Connectors")
        try tapWorkspace(app.buttons["connectorAdvancedOptions"])
        attachScreenshot("Connectors — expanded Advanced controls")
        // SwiftUI inherits the disclosure's test identifier onto its children.
        // Use the visible action's unique public label, as a person does.
        let customConnector = app.buttons.matching(NSPredicate(format: "label == %@", "Custom HTTP connector")).firstMatch
        if !customConnector.exists {
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.name = "Advanced connector accessibility hierarchy"
            hierarchy.lifetime = .keepAlways
            add(hierarchy)
        }
        try tapWorkspace(customConnector)
        let name = app.textFields["connectorNameInput"], url = app.textFields["connectorURLInput"]
        try require(name); name.tap(); name.typeText("Project service")
        let account = app.textFields["connectorAccountInput"]
        account.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        account.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 20))
        account.typeText("Work")
        url.tap(); url.typeText("https://connector.fixture.invalid/mcp")
        if app.keyboards.firstMatch.exists { app.buttons["dismissConnectorKeyboardButton"].tap() }
        let authPicker = app.buttons["connectorAuthPicker"]
        try waitEnabled(authPicker); authPicker.tap()
        let bearer = app.buttons["Bearer API key"]; try require(bearer); bearer.tap()
        let chosen = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "Bearer API key"), object: authPicker)
        guard XCTWaiter.wait(for: [chosen], timeout: 5) == .completed else { throw acceptanceError("Connector authentication selection did not reach Bearer API key. No setup was submitted.") }
        let key = app.secureTextFields["connectorKeyInput"]; try require(key); key.tap(); key.typeText("SYNTHETIC_CONNECTOR_KEY")
        try waitEnabled(app.buttons["saveBotConnectorSetupButton"]); app.buttons["saveBotConnectorSetupButton"].tap()
        let setupClosed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: name)
        XCTAssertEqual(XCTWaiter.wait(for: [setupClosed], timeout: 15), .completed)
        let initial = try await fixtureControl(control, action: "state"), data = try XCTUnwrap(initial["connectors"] as? [String: Any])
        let rows = try XCTUnwrap(data["connections"] as? [[String: Any]]), row = try XCTUnwrap(rows.first), id = try XCTUnwrap(row["id"] as? String)
        XCTAssertEqual(rows.count, 1); XCTAssertEqual(row["botIds"] as? [String], []); XCTAssertEqual(row["teamIds"] as? [String], []); XCTAssertEqual(row["enabledToolIds"] as? [String], [])
        XCTAssertTrue(row["apiKeySet"] as? Bool == true); XCTAssertFalse(String(describing: data).contains("SYNTHETIC_CONNECTOR_KEY"))
        attachScreenshot("Connectors — HTTP account added without implicit access")
        // Successful setup continues directly into the exact created account.
        try require(app.navigationBars["Project service"])
        let check = app.buttons["checkBotConnectionButton"]; try require(check); check.tap()
        try require(app.buttons["Check saved connector"]); app.buttons["Check saved connector"].tap()
        try require(app.staticTexts["Status, Connected"])
        let checked = try await fixtureControl(control, action: "state"), inventory = try XCTUnwrap((checked["connectors"] as? [String: Any])?["connections"] as? [[String: Any]])
        let tools = try XCTUnwrap(inventory.first?["tools"] as? [[String: Any]]), read = try XCTUnwrap(tools.first?["id"] as? String)
        XCTAssertEqual(inventory.first?["enabledToolIds"] as? [String], [], "Discovery never enables tools.")
        func setOn(_ element: XCUIElement) throws {
            try tapWorkspace(element, performTap: false)
            if element.value as? String == "1" { return }
            let target = element.switches.firstMatch.exists ? element.switches.firstMatch : element
            target.coordinate(withNormalizedOffset: CGVector(dx: 0.80, dy: 0.5)).tap()
            let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == '1'"), object: element)
            guard XCTWaiter.wait(for: [changed], timeout: 4) == .completed else { throw acceptanceError("Connector access switch did not turn on.") }
        }
        try setOn(app.switches["connectionBotAccess-fixture-bot"])
        try setOn(app.switches["connectionTeamAccess-team_connector_fixture"])
        let instructions = app.textViews["connectorInstructionsInput"]
        try tapWorkspace(instructions); instructions.typeText("Use this account for the project only.")
        if app.keyboards.firstMatch.exists { app.buttons["dismissConnectorKeyboardButton"].tap() }
        try setOn(app.switches["connectionToolAccess-" + read])
        try tapWorkspace(app.buttons["saveBotConnectionAccessButton"])
        try require(app.staticTexts["botConnectorAccessSaved"])
        attachScreenshot("Connectors — personal and team access with explicit tool opt-in")
        XCTAssertFalse(app.staticTexts["SYNTHETIC_CONNECTOR_KEY"].exists)
        app.terminate(); app.launch(); tapTab("Bots"); try selectWorkspace("Connectors")
        try tapWorkspace(app.buttons["botConnection-" + id])
        try tapWorkspace(app.buttons["editBotConnectorSetupButton"])
        let editName = app.textFields["connectorNameInput"]; try require(editName)
        editName.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap(); editName.typeText(" reviewed")
        XCTAssertFalse(app.secureTextFields["connectorKeyInput"].value as? String == "SYNTHETIC_CONNECTOR_KEY")
        app.buttons["saveBotConnectorSetupButton"].tap()
        let editClosed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: editName)
        XCTAssertEqual(XCTWaiter.wait(for: [editClosed], timeout: 15), .completed)
        try tapWorkspace(app.switches["connectionTeamAccess-team_connector_fixture"], performTap: false)
        XCTAssertEqual(app.switches["connectionTeamAccess-team_connector_fixture"].value as? String, "1")
        try tapWorkspace(instructions, performTap: false); XCTAssertEqual(instructions.value as? String, "Use this account for the project only.")
        try tapWorkspace(app.switches["connectionToolAccess-" + read], performTap: false)
        XCTAssertEqual(app.switches["connectionToolAccess-" + read].value as? String, "1")
        attachScreenshot("Connectors — shared access and instructions retained after relaunch")
        let final = try await fixtureControl(control, action: "state"), finalData = try XCTUnwrap(final["connectors"] as? [String: Any])
        let finalRows = try XCTUnwrap(finalData["connections"] as? [[String: Any]]), saved = try XCTUnwrap(finalRows.first)
        XCTAssertEqual(saved["name"] as? String, "Project service reviewed"); XCTAssertEqual(saved["accountLabel"] as? String, "Work"); XCTAssertEqual(saved["botIds"] as? [String], ["fixture-bot"])
        XCTAssertEqual(saved["teamIds"] as? [String], ["team_connector_fixture"]); XCTAssertEqual(saved["enabledToolIds"] as? [String], [read]); XCTAssertEqual(saved["readOnlyToolIds"] as? [String], [])
        XCTAssertEqual(final["connectorChecks"] as? Int, 1); XCTAssertEqual(final["connectorToolCalls"] as? Int, 0)
        XCTAssertFalse(String(describing: finalData).contains("SYNTHETIC_CONNECTOR_KEY"))
        let calls = try XCTUnwrap(final["calls"] as? [[String: Any]])
        XCTAssertEqual(calls.filter { $0["method"] as? String == "POST" && $0["path"] as? String == "/api/bots/connections" }.count, 1)
        let patches = calls.filter { $0["method"] as? String == "PATCH" }
        XCTAssertEqual(patches.count, 2)
        XCTAssertTrue(patches.allSatisfy { (($0["body"] as? [String: Any])?["expectedInventoryDigest"] as? String)?.count == 64 })
        XCTAssertTrue(calls.allSatisfy { $0["method"] as? String == "GET" || ($0["path"] as? String)?.hasPrefix("/api/bots/connections") == true })
        app.navigationBars.buttons.firstMatch.tap(); try selectWorkspace("Team")
        try tapWorkspace(app.buttons["botProfile-fixture-bot"])
        try tapWorkspace(app.buttons["botConnectorsButton"])
        try require(app.navigationBars["Connectors"])
        try tapWorkspace(app.buttons["botConnection-" + id])
        attachScreenshot("Connectors — bot profile shortcut opens its assigned account")
    }

    @MainActor
    func testConnectorAccountsDiscoverBearerSetupAndMacSignInFallback() async throws {
        let control = try pairWorkspaceFixture()
        tapTab("Connectors")
        try require(app.navigationBars["Connectors"])
        try tapWorkspace(app.buttons["Discover"])
        let github = app.buttons["addConnector-github"]
        try tapWorkspace(github)
        try require(app.navigationBars["Add GitHub account"])
        XCTAssertEqual(app.textFields["connectorNameInput"].value as? String, "GitHub", "The first sheet presentation must initialize from the selected service.")
        try require(app.secureTextFields["connectorKeyInput"])
        XCTAssertFalse(app.textFields["connectorURLInput"].exists, "Routine service setup hides transport and server details.")
        XCTAssertFalse(app.buttons["startConnectorSignInButton"].exists, "A bearer-only service must not promise browser login.")
        let account = app.textFields["connectorAccountInput"]
        try tapWorkspace(account); account.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 20)); account.typeText("Work")
        if app.keyboards.firstMatch.exists { app.buttons["dismissConnectorKeyboardButton"].tap() }
        let key = app.secureTextFields["connectorKeyInput"]; try tapWorkspace(key); key.typeText("SYNTHETIC_WORK_KEY")
        if app.keyboards.firstMatch.exists { app.buttons["dismissConnectorKeyboardButton"].tap() }
        try waitEnabled(app.buttons["saveBotConnectorSetupButton"]); app.buttons["saveBotConnectorSetupButton"].tap()
        try require(app.navigationBars["GitHub"])
        try require(app.staticTexts["Account, Work"])
        attachScreenshot("Connectors — named service account without technical setup")
        app.navigationBars.buttons.firstMatch.tap()
        try tapWorkspace(app.buttons["Discover"]); try tapWorkspace(app.buttons["addConnector-github"])
        let secondKey = app.secureTextFields["connectorKeyInput"]; try tapWorkspace(secondKey); secondKey.typeText("SYNTHETIC_PERSONAL_KEY")
        if app.keyboards.firstMatch.exists { app.buttons["dismissConnectorKeyboardButton"].tap() }
        app.buttons["saveBotConnectorSetupButton"].tap(); try require(app.navigationBars["GitHub"])
        try require(app.staticTexts["Account, Personal"])
        app.navigationBars.buttons.firstMatch.tap()
        try tapWorkspace(app.buttons["Discover"]); try tapWorkspace(app.buttons["addConnector-linear"])
        try require(app.navigationBars["Linear"])
        XCTAssertFalse(app.textFields["connectorNameInput"].exists, "Preset browser sign-in skips the server setup form.")
        try require(app.staticTexts["Status, Sign-in waiting"])
        try require(app.buttons["startConnectorSignInButton"])
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "finish sign-in there")).firstMatch.exists)
        attachScreenshot("Connectors — OAuth account continues directly to honest Mac fallback")
        let snapshot = try await fixtureControl(control, action: "state")
        let data = try XCTUnwrap(snapshot["connectors"] as? [String: Any]), rows = try XCTUnwrap(data["connections"] as? [[String: Any]])
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(Set(rows.filter { $0["catalogId"] as? String == "github" }.compactMap { $0["accountLabel"] as? String }), ["Work", "Personal"])
        XCTAssertTrue(rows.allSatisfy { ($0["botIds"] as? [String]) == [] && ($0["teamIds"] as? [String]) == [] && ($0["enabledToolIds"] as? [String]) == [] })
        XCTAssertFalse(String(describing: data).contains("SYNTHETIC_WORK_KEY")); XCTAssertFalse(String(describing: data).contains("SYNTHETIC_PERSONAL_KEY"))
        let calls = try XCTUnwrap(snapshot["calls"] as? [[String: Any]])
        let starts = calls.filter { ($0["path"] as? String)?.hasSuffix("/auth") == true && $0["method"] as? String == "POST" }
        XCTAssertEqual(starts.count, 1); XCTAssertEqual((starts.first?["body"] as? [String: Any])?.count, 0)
        XCTAssertEqual(calls.filter { $0["path"] as? String == "/api/bots/connections" && $0["method"] as? String == "POST" }.count, 3)
        XCTAssertEqual(snapshot["connectorChecks"] as? Int, 0); XCTAssertEqual(snapshot["connectorToolCalls"] as? Int, 0)
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.hasSuffix("/messages") == true })
        app.navigationBars.buttons.firstMatch.tap()
        try tapWorkspace(app.buttons["Discover"])
        let serviceSearch = app.searchFields.firstMatch
        // Search belongs to the navigation bar, outside the content viewport
        // enforced by tapWorkspace for list rows and form controls.
        try require(serviceSearch); serviceSearch.tap(); serviceSearch.typeText("Fixture managed connector")
        if app.keyboards.firstMatch.exists { app.keyboards.buttons["Search"].tap() }
        try tapWorkspace(app.buttons["addConnector-fixture-managed-service"])
        try require(app.navigationBars["Service setup"])
        XCTAssertFalse(app.textFields["connectorNameInput"].exists); XCTAssertFalse(app.buttons["startConnectorSignInButton"].exists)
        try require(app.buttons["connectorSetupSourceLink"])
        attachScreenshot("Connectors — managed catalog entry explains setup without creating an account")
        let setupState = try await fixtureControl(control, action: "state"), setupCalls = try XCTUnwrap(setupState["calls"] as? [[String: Any]])
        XCTAssertEqual(setupCalls.filter { $0["method"] as? String != "GET" }.count, calls.filter { $0["method"] as? String != "GET" }.count)
        XCTAssertEqual(((setupState["connectors"] as? [String: Any])?["connections"] as? [[String: Any]])?.count, 3)
        app.buttons["dismissConnectorServiceSetupButton"].tap()
        app.terminate(); app.launch(); tapTab("Connectors")
        let linear = try XCTUnwrap(rows.first { $0["catalogId"] as? String == "linear" }?["id"] as? String)
        try tapWorkspace(app.buttons["botConnection-" + linear]); try require(app.navigationBars["Linear"])
        try require(app.staticTexts["Status, Sign-in waiting"])
        attachScreenshot("Connectors — accounts remain discoverable after relaunch")
    }

    @MainActor
    func testNaturalTeamChannelPeersAssignmentsThinkingAndStop() async throws {
        let controlURL = try pairWorkspaceFixture()
        let team = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "team-")).firstMatch
        try require(team); try tapWorkspace(team)
        try require(app.buttons["teamChannelHeaderButton"])
        let input = app.descendants(matching: .any).matching(identifier: "botTeamTaskInput").firstMatch
        let send = app.buttons["startBotTeamTaskButton"]
        try tapWorkspace(input); input.typeText("Hi everyone")
        app.buttons["dismissBotTeamTaskKeyboardButton"].tap()
        try waitEnabled(send); send.tap()
        let builderHello = app.staticTexts["Hi everyone! I am Builder. Ready to help the team."]
        try require(builderHello)
        try tapWorkspace(app.staticTexts["Hi everyone! I am Reviewer. Ready to help the team."], performTap: false)
        XCTAssertTrue(app.buttons["teamChannelHeaderButton"].exists, "Sending stays in the shared room.")
        attachScreenshot("Team channel — named peers talking together")
        let state = try await fixtureControl(controlURL, action: "team-room-state")
        let channel = try XCTUnwrap(state["teamChannel"] as? [String: Any])
        let entries = try XCTUnwrap(channel["messages"] as? [[String: Any]])
        let peer = try XCTUnwrap(entries.first { ($0["author"] as? [String: Any])?["name"] as? String == "Reviewer" && ($0["content"] as? String)?.contains("Hi everyone") == true })
        let peerId = try XCTUnwrap(peer["id"] as? String)
        try tapWorkspace(app.buttons["teamMessageOptions-\(peerId)"]); try require(app.buttons["replyTeamMessage-\(peerId)"]); app.buttons["replyTeamMessage-\(peerId)"].tap()
        try require(app.staticTexts["teamReplyContext"])
        input.typeText("Who wants this task?")
        app.buttons["dismissBotTeamTaskKeyboardButton"].tap()
        try waitEnabled(send); send.tap()
        let report = app.staticTexts["The fixture task is complete. Coordinator, the checks passed."]
        try tapWorkspace(report, performTap: false)
        try tapWorkspace(app.staticTexts["Builder, your approach looks good. I can help with the checks."], performTap: false)
        if app.buttons["latestTeamMessagesButton"].exists { app.buttons["latestTeamMessagesButton"].tap() }
        try tapWorkspace(report, performTap: false)
        attachScreenshot("Team channel — bids ownership and public worker report")
        let reportState = try await fixtureControl(controlURL, action: "team-room-state")
        let reportEntries = try XCTUnwrap((reportState["teamChannel"] as? [String: Any])?["messages"] as? [[String: Any]])
        let reportId = try XCTUnwrap(reportEntries.first { $0["content"] as? String == "The fixture task is complete. Coordinator, the checks passed." }?["id"] as? String)
        try tapWorkspace(app.buttons["teamMessageOptions-\(reportId)"])
        let details = app.buttons.matching(NSPredicate(format: "label == %@", "Thinking & tools")).firstMatch
        try require(details); details.tap()
        let thinking = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "thinkingDisclosure-")).firstMatch
        try require(thinking); thinking.tap()
        XCTAssertTrue(app.tabBars.firstMatch.exists && app.tabBars.firstMatch.isHittable, "Opening shared Thinking restores global app navigation.")
        attachScreenshot("Team channel — explicit shared Thinking link")
        tapTab("Bots")
        try require(app.buttons["teamChannelHeaderButton"])
        try tapWorkspace(input); input.typeText("Hold this synthetic task")
        app.buttons["dismissBotTeamTaskKeyboardButton"].tap()
        try waitEnabled(send); send.tap()
        let ownMessage = app.staticTexts["Hold this synthetic task"]
        try require(ownMessage); XCTAssertTrue(ownMessage.isHittable, "An explicit send reveals the latest message without a helper scroll.")
        let stop = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "stopBotTeamRun-")).firstMatch
        try require(stop); try waitEnabled(stop); stop.tap()
        try require(app.buttons["Stop all team work"]); app.buttons["Stop all team work"].tap()
        try tapWorkspace(app.staticTexts["Stopped by you."], performTap: false)
        attachScreenshot("Team channel — explicit Stop keeps public history")
        app.terminate(); app.launch()
        tapTab("Bots")
        let restoredTeam = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "team-")).firstMatch
        try tapWorkspace(restoredTeam)
        try tapWorkspace(app.staticTexts["Stopped by you."], performTap: false)
        app.terminate()
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch(); tapTab("Bots")
        try tapWorkspace(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "team-")).firstMatch)
        try require(app.descendants(matching: .any).matching(identifier: "botTeamTaskInput").firstMatch)
        XCTAssertTrue(app.buttons["startBotTeamTaskButton"].isHittable)
        attachScreenshot("Team channel — accessibility text and reachable composer")
        let final = try await fixtureControl(controlURL, action: "team-room-state")
        let calls = try XCTUnwrap(final["calls"] as? [[String: Any]])
        let posts = calls.filter { ($0["path"] as? String)?.contains("/teams/") == true && ($0["path"] as? String)?.hasSuffix("/messages") == true && $0["method"] as? String == "POST" }
        XCTAssertEqual(posts.count, 3)
        XCTAssertEqual((posts[1]["body"] as? [String: Any])?["replyToId"] as? String, peerId)
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.hasSuffix("/runs") == true && $0["method"] as? String == "POST" })
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.contains("model-management") == true || ($0["path"] as? String)?.contains("/computer/") == true || ($0["path"] as? String)?.contains("/approval") == true })
        let finalChannel = try XCTUnwrap(final["teamChannel"] as? [String: Any])
        XCTAssertTrue((finalChannel["activeRuns"] as? [Any])?.isEmpty == true)
    }

    @MainActor
    func testTeamChannelNormalDarkAndLargeTypeLayout() async throws {
        let controlURL = try pairWorkspaceFixture()
        for (style, large) in [("Light", false), ("Dark", false), ("Dark", true)] {
            app.terminate()
            _ = try await fixtureControl(controlURL, action: style == "Dark" ? "appearance-dark" : "appearance-light")
            app.launchArguments = large ? ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] : []
            app.launch(); tapTab("Bots")
            try tapWorkspace(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "team-")).firstMatch)
            try tapWorkspace(app.staticTexts["Strata"], performTap: false)
            XCTAssertTrue(app.buttons["startBotTeamTaskButton"].isHittable)
            XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "botTeamTaskInput").firstMatch.isHittable)
            attachScreenshot("Team channel layout — " + style + (large ? " accessibility XXXL" : " normal"))
        }
        let state = try await fixtureControl(controlURL, action: "team-room-state")
        let calls = try XCTUnwrap(state["calls"] as? [[String: Any]])
        XCTAssertTrue(calls.allSatisfy { $0["method"] as? String == "GET" }, "Layout navigation starts no work.")
    }

    @MainActor
    func testGroupRosterAndRoomPhotoLayoutWithRealMenus() async throws {
        let controlURL = try pairWorkspaceFixture()
        let initial = try await fixtureControl(controlURL, action: "team-room-state")
        let teamId = try XCTUnwrap((initial["roomTeam"] as? [String: Any])?["id"] as? String)
        let emptyId = try XCTUnwrap((initial["roomEmptyTeam"] as? [String: Any])?["id"] as? String)
        let members = try XCTUnwrap((initial["roomTeam"] as? [String: Any])?["memberIds"] as? [String])
        try require(app.buttons["team-" + teamId]); try require(app.buttons["team-" + emptyId])
        try require(app.buttons["bot-" + members[1]])
        let preview = app.staticTexts["teamRosterPreview-" + teamId]
        try require(preview); XCTAssertEqual(preview.label, "Stopped by you.")
        XCTAssertFalse(app.segmentedControls["botsWorkspacePicker"].exists)
        XCTAssertFalse(app.segmentedControls["botRosterFilterPicker"].exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "[Strata team")).firstMatch.exists)
        attachScreenshot("Group chat — mixed bot and team roster with public preview")
        let beforePolling = try XCTUnwrap(initial["calls"] as? [[String: Any]]).filter { $0["path"] as? String == "/api/bots/teams" }.count
        try await Task.sleep(for: .seconds(6))
        let polled = try await fixtureControl(controlURL, action: "team-room-state")
        let polledCalls = try XCTUnwrap(polled["calls"] as? [[String: Any]])
        XCTAssertGreaterThan(polledCalls.filter { $0["path"] as? String == "/api/bots/teams" }.count, beforePolling)
        XCTAssertFalse(polledCalls.contains { ($0["path"] as? String)?.hasSuffix("/channel") == true }, "Roster previews use the Team list, without per-room reads.")
        try openCreateMenu(); try require(app.buttons["createBotButton"]); try require(app.buttons["createBotTeamButton"])
        app.buttons["createBotButton"].tap(); try require(app.textFields["profileBotNameInput"])
        attachScreenshot("Group chat roster — create bot remains a native action")
        app.buttons["Cancel"].tap()
        try openCreateMenu(); app.buttons["createBotTeamButton"].tap(); try require(app.textFields["botTeamNameInput"])
        attachScreenshot("Group chat roster — create team remains a native action")
        app.buttons["Cancel"].tap()
        try tapWorkspace(app.buttons["team-" + emptyId])
        try require(app.otherElements["teamChannelEmptyState"])
        XCTAssertFalse(app.tabBars.firstMatch.exists && app.tabBars.firstMatch.isHittable)
        attachScreenshot("Group chat — empty team canvas and pinned composer")
        app.navigationBars.buttons["Bots"].firstMatch.tap()
        try require(app.buttons["botsWorkspaceMenuButton"]); XCTAssertTrue(app.tabBars.firstMatch.isHittable)
        for (style, large) in [("Light", false), ("Dark", false), ("Dark", true)] {
            app.terminate()
            _ = try await fixtureControl(controlURL, action: style == "Dark" ? "appearance-dark" : "appearance-light")
            app.launchArguments = large ? ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] : []
            app.launch(); tapTab("Bots")
            try tapWorkspace(app.buttons["team-" + teamId])
            let header = app.buttons["teamChannelHeaderButton"]
            try require(header); XCTAssertTrue(header.label.contains("Engineering"))
            XCTAssertFalse(app.tabBars.firstMatch.exists && app.tabBars.firstMatch.isHittable)
            let send = app.buttons["startBotTeamTaskButton"]
            XCTAssertTrue(send.isHittable)
            let input = app.descendants(matching: .any).matching(identifier: "botTeamTaskInput").firstMatch
            XCTAssertTrue(input.isHittable); XCTAssertLessThanOrEqual(send.frame.maxY, app.windows.firstMatch.frame.maxY - 15)
            try tapWorkspace(app.staticTexts["Stopped by you."], performTap: false)
            app.scrollViews["teamChannelMessages"].swipeDown()
            try require(app.buttons["latestTeamMessagesButton"]); app.buttons["latestTeamMessagesButton"].tap()
            XCTAssertTrue(app.staticTexts["Stopped by you."].isHittable, "Latest returns to saved history without any incoming work.")
            attachScreenshot("Group chat — " + style + (large ? " accessibility XXXL" : " normal"))
            try openTeamDetails(); try tapWorkspace(app.buttons["botTeamSettingsDisclosure"])
            try tapWorkspace(app.buttons["toggleBotTeamEnabledButton"], performTap: false)
            try tapWorkspace(app.buttons["botTeamPreviousTasksDisclosure"])
            try tapWorkspace(app.staticTexts["Cancelled"], performTap: false)
            attachScreenshot("Group chat details — " + style + (large ? " accessibility XXXL" : " normal"))
            app.buttons["closeTeamDetailsButton"].tap()
            try require(app.buttons["teamComposerMenuButton"]); app.buttons["teamComposerMenuButton"].tap()
            try require(app.buttons["teamChannelRecipientPicker"]); app.buttons["teamChannelRecipientPicker"].tap()
            try require(app.buttons["Everyone"]); app.buttons["Everyone"].tap()
            try require(app.staticTexts["To Everyone"])
            app.navigationBars.buttons["Bots"].firstMatch.tap()
            try require(app.buttons["botsWorkspaceMenuButton"]); XCTAssertTrue(app.tabBars.firstMatch.isHittable)
        }
        tapTab("Home")
        let hidden = try await fixtureControl(controlURL, action: "team-room-state")
        let hiddenReads = try XCTUnwrap(hidden["calls"] as? [[String: Any]]).filter { $0["path"] as? String == "/api/bots/teams" }.count
        try await Task.sleep(for: .seconds(6))
        let final = try await fixtureControl(controlURL, action: "team-room-state")
        let finalCalls = try XCTUnwrap(final["calls"] as? [[String: Any]])
        XCTAssertEqual(finalCalls.filter { $0["path"] as? String == "/api/bots/teams" }.count, hiddenReads, "Hidden roster and room stop their Team polling.")
        XCTAssertTrue(finalCalls.allSatisfy { $0["method"] as? String == "GET" }, "Viewing rooms, previews, menus and details never executes work.")
    }

    @MainActor
    func testCompactTeamAssignmentsAndReportsExpandWithoutChangingHistory() async throws {
        let control = try pairWorkspaceFixture(), initial = try await fixtureControl(control, action: "state")
        _ = try await fixtureControl(control, action: "appearance-dark")
        let channel = try XCTUnwrap(initial["teamChannel"] as? [String: Any])
        let entries = try XCTUnwrap(channel["messages"] as? [[String: Any]])
        let assignment = try XCTUnwrap(entries.first { $0["kind"] as? String == "assignment" })
        let report = try XCTUnwrap(entries.first { $0["kind"] as? String == "report" && ($0["content"] as? String)?.contains("REPORT END MARKER") == true })
        let assignmentId = try XCTUnwrap(assignment["id"] as? String), reportId = try XCTUnwrap(report["id"] as? String)
        let teamId = try XCTUnwrap(channel["teamId"] as? String)
        try tapWorkspace(app.buttons["team-" + teamId])
        let assignmentButton = app.buttons["teamMessageDisclosure-" + assignmentId]
        let assignmentBody = app.staticTexts["teamMessageContent-" + assignmentId]
        try tapWorkspace(assignmentButton, performTap: false)
        XCTAssertFalse(assignmentBody.exists, "Assignments start compact, preserving the full prompt behind their disclosure.")
        assignmentButton.tap(); try require(assignmentBody)
        XCTAssertTrue(assignmentBody.label.contains("ASSIGNMENT END MARKER"))
        try tapWorkspace(assignmentButton); XCTAssertFalse(assignmentBody.exists)
        let reportButton = app.buttons["teamMessageDisclosure-" + reportId]
        let reportBody = app.staticTexts["teamMessageContent-" + reportId]
        try tapWorkspace(reportButton, performTap: false); XCTAssertFalse(reportBody.exists)
        attachScreenshot("Team room — compact assignments and report previews")
        reportButton.tap(); try require(reportBody)
        XCTAssertTrue(reportBody.label.contains("REPORT END MARKER"))
        let final = try await fixtureControl(control, action: "state")
        let finalEntries = try XCTUnwrap((final["teamChannel"] as? [String: Any])?["messages"] as? [[String: Any]])
        XCTAssertEqual(finalEntries.map { $0["content"] as? String }, entries.map { $0["content"] as? String })
        let calls = try XCTUnwrap(final["calls"] as? [[String: Any]])
        XCTAssertTrue(calls.allSatisfy { $0["method"] as? String == "GET" }, "Expanding saved room history does not send messages or start new work.")
    }

    @MainActor
    func testTeamWorkIntentRequiresExplicitSendAndKeepsChatCompatible() async throws {
        let control = try pairWorkspaceFixture()
        _ = try await fixtureControl(control, action: "appearance-dark")
        let initial = try await fixtureControl(control, action: "state")
        let team = try XCTUnwrap(initial["roomTeam"] as? [String: Any])
        let teamId = try XCTUnwrap(team["id"] as? String)
        try tapWorkspace(app.buttons["team-" + teamId])
        let picker = app.segmentedControls["teamMessageWorkModePicker"]
        try require(picker)
        XCTAssertTrue(picker.buttons["Chat"].isSelected)
        let opening = try await fixtureControl(control, action: "state")
        XCTAssertTrue(try XCTUnwrap(opening["calls"] as? [[String: Any]]).allSatisfy { $0["method"] as? String == "GET" })
        XCTAssertTrue(try XCTUnwrap(opening["roomTurns"] as? [[String: Any]]).isEmpty)
        picker.buttons["Work"].tap()
        XCTAssertEqual(app.staticTexts["teamMessageWorkModeExplanation"].label, "Coordinator and teammates can use their saved tools, approvals and selected team computer/folder.")
        let selected = try await fixtureControl(control, action: "state")
        XCTAssertTrue(try XCTUnwrap(selected["calls"] as? [[String: Any]]).allSatisfy { $0["method"] as? String == "GET" }, "Selecting Work does not send a prompt or start tools.")
        attachScreenshot("Team composer — explicit Work intent before Send")
        let input = app.descendants(matching: .any).matching(identifier: "botTeamTaskInput").firstMatch
        try tapWorkspace(input); input.typeText("Inspect the inert fixture source")
        try require(app.buttons["dismissBotTeamTaskKeyboardButton"]); app.buttons["dismissBotTeamTaskKeyboardButton"].tap()
        app.buttons["startBotTeamTaskButton"].tap()
        try require(app.staticTexts["Work fixture result: the coordinator received the explicit Work request."])
        XCTAssertTrue(picker.buttons["Chat"].isSelected, "A successful Work send returns the composer to Chat.")
        let workState = try await fixtureControl(control, action: "state")
        let workCalls = try XCTUnwrap(workState["calls"] as? [[String: Any]]).filter { $0["method"] as? String == "POST" }
        XCTAssertEqual(workCalls.count, 1)
        XCTAssertEqual((workCalls.first?["body"] as? [String: Any])?["workMode"] as? String, "work")
        let entries = try XCTUnwrap((workState["teamChannel"] as? [String: Any])?["messages"] as? [[String: Any]])
        let sent = try XCTUnwrap(entries.first { ($0["author"] as? [String: Any])?["type"] as? String == "user" })
        try require(app.descendants(matching: .any).matching(identifier: "teamMessageWorkRequest-" + (try XCTUnwrap(sent["id"] as? String))).firstMatch)
        let turns = try XCTUnwrap(workState["roomTurns"] as? [[String: Any]])
        XCTAssertEqual(turns.first?["mode"] as? String, "task")
        attachScreenshot("Team history — explicit Work request and retained result")
        picker.buttons["Work"].tap()
        app.buttons["teamComposerMenuButton"].tap()
        try require(app.buttons["draftTeamGreetingButton"]); app.buttons["draftTeamGreetingButton"].tap()
        XCTAssertTrue(picker.buttons["Chat"].isSelected, "Drafting a greeting resets Chat without sending anything.")
        let greetingDraft = try await fixtureControl(control, action: "state")
        XCTAssertEqual(try XCTUnwrap(greetingDraft["calls"] as? [[String: Any]]).filter { $0["method"] as? String == "POST" }.count, 1)
        if app.buttons["dismissBotTeamTaskKeyboardButton"].exists { app.buttons["dismissBotTeamTaskKeyboardButton"].tap() }
        app.buttons["startBotTeamTaskButton"].tap()
        try require(app.staticTexts["Chat fixture reply: the coordinator can talk without direct work tools."])
        let chatState = try await fixtureControl(control, action: "state")
        let chatCalls = try XCTUnwrap(chatState["calls"] as? [[String: Any]]).filter { $0["method"] as? String == "POST" }
        XCTAssertEqual(chatCalls.count, 2)
        XCTAssertEqual((chatCalls.last?["body"] as? [String: Any])?["workMode"] as? String, "chat")
        XCTAssertEqual((chatCalls.last?["body"] as? [String: Any])?["recipientIds"] as? [String], team["memberIds"] as? [String])
        _ = try await fixtureControl(control, action: "team-work-tools-unsupported")
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: picker)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 15), .completed)
        try tapWorkspace(input); input.typeText("Legacy host chat")
        app.buttons["dismissBotTeamTaskKeyboardButton"].tap(); app.buttons["startBotTeamTaskButton"].tap()
        try require(app.staticTexts["Legacy host chat"])
        // A cleared SwiftUI TextField exposes its placeholder separately from
        // its nil/empty value. Keep both checks so retained draft text fails.
        let emptyInput = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND (value == nil OR value == %@) AND placeholderValue == %@", "", "Message…"), object: input)
        XCTAssertEqual(XCTWaiter.wait(for: [emptyInput], timeout: 15), .completed)
        XCTAssertFalse(app.buttons["startBotTeamTaskButton"].isEnabled)
        XCTAssertFalse(picker.exists)
        let final = try await fixtureControl(control, action: "state")
        let calls = try XCTUnwrap(final["calls"] as? [[String: Any]])
        let posts = calls.filter { $0["method"] as? String == "POST" }
        XCTAssertEqual(posts.count, 3)
        XCTAssertNil((posts.last?["body"] as? [String: Any])?["workMode"], "Older hosts retain their original message payload.")
        XCTAssertTrue(posts.allSatisfy { ($0["path"] as? String)?.hasSuffix("/messages") == true })
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.contains("/computer/") == true })
    }

    @MainActor
    func testCurrentWorkOverviewKeepsActiveLegacyAndRequiresExplicitHistoryExpansion() async throws {
        let control = try pairWorkspaceFixture()
        _ = try await fixtureControl(control, action: "appearance-dark")
        let initial = try await fixtureControl(control, action: "state")
        let teamId = try XCTUnwrap((initial["roomTeam"] as? [String: Any])?["id"] as? String)
        try tapWorkspace(app.buttons["team-" + teamId])
        let chip = app.buttons["teamCurrentWorkButton"]; try require(chip)
        let countReady = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "2 need you, 2 working"), object: chip)
        XCTAssertEqual(XCTWaiter.wait(for: [countReady], timeout: 15), .completed)
        attachScreenshot("Team channel — current work at a glance")
        chip.tap(); try require(app.buttons["closeTeamDetailsButton"])
        XCTAssertFalse(app.staticTexts["Turn finished"].exists, "Earlier request history stays collapsed when opening Current work.")
        app.buttons["closeTeamDetailsButton"].tap()
        app.navigationBars.buttons["Bots"].firstMatch.tap()
        try selectWorkspace("Activity")
        try require(app.staticTexts["2 need you"]); try require(app.staticTexts["2 working"])
        let historical = "tj_00000000-0000-4000-8000-000000000005", verified = "tj_00000000-0000-4000-8000-000000000007"
        XCTAssertFalse(app.buttons["openTeamWork-" + historical].exists)
        XCTAssertFalse(app.buttons["openTeamWork-" + verified].exists)
        try tapWorkspace(app.descendants(matching: .any).matching(identifier: "teamWorkRequestedChanges-tj_00000000-0000-4000-8000-000000000001").firstMatch, performTap: false)
        XCTAssertTrue(app.staticTexts["Confirm that the existing iPhone pairing is retained."].exists)
        attachScreenshot("Current work — attention, owner and requested changes")
        try tapWorkspace(app.buttons["openTeamWork-tj_00000000-0000-4000-8000-000000000006"], performTap: false)
        XCTAssertTrue(app.staticTexts["Earlier task still running"].exists, "An explicitly old task stays current while it is active.")
        let history = app.buttons["teamWorkHistoryDisclosure"]; try tapWorkspace(history)
        XCTAssertEqual(history.value as? String, "Expanded")
        try tapWorkspace(app.buttons["openTeamWork-" + historical], performTap: false)
        try tapWorkspace(app.buttons["openTeamWork-" + verified], performTap: false)
        attachScreenshot("Task history — saved results are accessible after expansion")
        try tapWorkspace(app.buttons["earlierTeamActivityDisclosure"])
        try tapWorkspace(app.staticTexts["Turn finished"], performTap: false)
        // List virtualizes its earlier cells while the retained history is in
        // view. Return to the current-work section before expecting the new
        // empty-state cell from the next read-only fixture response.
        let top = app.staticTexts["What needs attention"]
        for _ in 0..<8 {
            if top.exists, top.isHittable { break }
            app.swipeDown()
        }
        try require(top); XCTAssertTrue(top.isHittable)
        _ = try await fixtureControl(control, action: "overview-history-only")
        let empty = app.staticTexts["teamCurrentWorkEmpty"]; try require(empty)
        try tapWorkspace(empty, performTap: false)
        XCTAssertEqual(empty.label, "No current tasks are tracked.")
        XCTAssertEqual(app.staticTexts["teamEarlierUnverifiedSummary"].label, "1 earlier turn has no verified result.")
        if history.value as? String == "Expanded" { try tapWorkspace(history) }
        XCTAssertEqual(history.value as? String, "Collapsed")
        try tapWorkspace(app.buttons["reviewEarlierTeamWorkButton"])
        XCTAssertEqual(history.value as? String, "Expanded")
        try tapWorkspace(app.buttons["openTeamWork-" + historical], performTap: false)
        try tapWorkspace(app.buttons["openTeamWork-" + verified], performTap: false)
        attachScreenshot("Earlier work — explicit review entry for unverified records")
        for _ in 0..<8 {
            if top.exists, top.isHittable { break }
            app.swipeDown()
        }
        try require(top)
        _ = try await fixtureControl(control, action: "overview-unavailable")
        let stale = app.staticTexts["Last known work"]; try require(stale)
        try tapWorkspace(stale, performTap: false)
        XCTAssertTrue(app.staticTexts["Refresh to check the current status."].exists)
        XCTAssertFalse(app.staticTexts["Your current team tasks are clear."].exists)
        attachScreenshot("Current work — last known status after a failed refresh")
        let state = try await fixtureControl(control, action: "state")
        let calls = try XCTUnwrap(state["calls"] as? [[String: Any]])
        XCTAssertTrue(calls.allSatisfy { $0["method"] as? String == "GET" }, "Overview and history are read-only. Nothing is verified, resumed or prompted by opening them.")
        let tasks = try XCTUnwrap(state["reviewTasks"] as? [[String: Any]])
        XCTAssertEqual(tasks.count, 7)
        XCTAssertEqual((tasks[0]["work"] as? [String: Any])?["status"] as? String, "ready_for_review")
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.hasSuffix("/resume") == true || ($0["path"] as? String)?.hasSuffix("/review") == true || ($0["path"] as? String)?.contains("/computer/") == true })
    }

    @MainActor
    func testSubmittedTaskReviewAndExplicitRecoveryWithoutReplayingFinishedWork() async throws {
        let control = try pairWorkspaceFixture()
        _ = try await fixtureControl(control, action: "appearance-dark")
        try selectWorkspace("Activity")
        try tapWorkspace(app.buttons["openTeamWork-tj_00000000-0000-4000-8000-000000000001"])
        try require(app.navigationBars["Task results"])
        let summary = app.staticTexts["teamWorkSummary"]; try require(summary)
        XCTAssertEqual(summary.label, "The parser fix is ready for your review.")
        let verify = app.buttons["verifyTeamWorkButton"]
        try tapWorkspace(verify, performTap: false)
        XCTAssertTrue(verify.isEnabled)
        let before = try await fixtureControl(control, action: "state")
        let initialCalls = try XCTUnwrap(before["calls"] as? [[String: Any]])
        XCTAssertTrue(initialCalls.allSatisfy { $0["method"] as? String == "GET" }, "Opening submitted evidence grants no completion or execution authority.")
        attachScreenshot("Submitted results — owner review and evidence")
        verify.tap()
        let verifyConfirmation = app.buttons.matching(identifier: "confirmTeamWorkReviewButton").firstMatch; try require(verifyConfirmation); verifyConfirmation.tap()
        let verified = app.staticTexts["Marked verified"]; try tapWorkspace(verified, performTap: false)
        XCTAssertFalse(app.buttons["verifyTeamWorkButton"].exists)
        attachScreenshot("Task result — explicitly verified by owner")
        app.buttons["closeTeamWorkReviewButton"].tap()
        try tapWorkspace(app.buttons["openTeamWork-tj_00000000-0000-4000-8000-000000000002"])
        try tapWorkspace(app.buttons["prepareTeamRecoveryButton"])
        let recoverySummary = app.staticTexts["teamRecoverySummary"]; try tapWorkspace(recoverySummary, performTap: false)
        XCTAssertEqual(recoverySummary.label, "Finish the renderer using the retained parser result.")
        try tapWorkspace(app.descendants(matching: .any).matching(identifier: "teamRecoveryWorkspace").firstMatch, performTap: false)
        let resume = app.buttons["resumeTeamWorkButton"]; try tapWorkspace(resume, performTap: false)
        XCTAssertTrue(resume.isEnabled)
        let prepared = try await fixtureControl(control, action: "state")
        let preparedCalls = try XCTUnwrap(prepared["calls"] as? [[String: Any]])
        XCTAssertEqual(preparedCalls.filter { $0["method"] as? String != "GET" }.count, 1, "Preparing recovery never queues a continuation.")
        XCTAssertTrue(preparedCalls.contains { ($0["path"] as? String)?.hasSuffix("/tj_00000000-0000-4000-8000-000000000002/recovery") == true && $0["method"] as? String == "GET" })
        attachScreenshot("Recovery plan — saved computer, working folder and completed teammate work")
        resume.tap()
        let resumeConfirmation = app.buttons.matching(identifier: "confirmTeamWorkResumeButton").firstMatch; try require(resumeConfirmation); resumeConfirmation.tap()
        let recovered = app.staticTexts["teamWorkAlreadyRecovered"]; try tapWorkspace(recovered, performTap: false)
        XCTAssertFalse(app.buttons["resumeTeamWorkButton"].exists)
        let final = try await fixtureControl(control, action: "state")
        let calls = try XCTUnwrap(final["calls"] as? [[String: Any]])
        let writes = calls.filter { $0["method"] as? String != "GET" }
        XCTAssertEqual(writes.count, 2)
        XCTAssertTrue(writes[0]["path"] as? String == "/api/bots/teams/" + (try XCTUnwrap((final["reviewTasks"] as? [[String: Any]])?.first?["teamId"] as? String)) + "/jobs/tj_00000000-0000-4000-8000-000000000001/review")
        XCTAssertTrue((writes[1]["path"] as? String)?.hasSuffix("/jobs/tj_00000000-0000-4000-8000-000000000002/resume") == true)
        let resumeBody = try XCTUnwrap(writes[1]["body"] as? [String: Any])
        XCTAssertEqual(Set(resumeBody.keys), Set(["planId", "expectedRevision", "idempotencyKey"]))
        XCTAssertEqual(resumeBody["expectedRevision"] as? Int, 1)
        XCTAssertFalse((resumeBody["idempotencyKey"] as? String ?? "").isEmpty)
        let savedTasks = try XCTUnwrap(final["reviewTasks"] as? [[String: Any]])
        XCTAssertEqual(savedTasks.count, 3)
        XCTAssertEqual((savedTasks[0]["work"] as? [String: Any])?["status"] as? String, "verified")
        XCTAssertEqual((savedTasks[2]["work"] as? [String: Any])?["sourceJobId"] as? String, "tj_00000000-0000-4000-8000-000000000002")
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.hasSuffix("/messages") == true || ($0["path"] as? String)?.contains("/computer/") == true })
        attachScreenshot("Recovery queued — original evidence and finished work retained")
    }

    @MainActor
    func testContinuousTeamWorkHasNoNumericStopLimits() async throws {
        let control = try pairWorkspaceFixture(), initial = try await fixtureControl(control, action: "state")
        let members = try XCTUnwrap(initial["roomMembers"] as? [[String: Any]])
        let ids = try members.map { try XCTUnwrap($0["id"] as? String) }
        XCTAssertGreaterThanOrEqual(ids.count, 2)
        try openCreateMenu(); try tapWorkspace(app.buttons["createBotTeamButton"])
        let name = app.textFields["botTeamNameInput"]; try require(name); name.tap(); name.typeText("Continuous studio")
        if app.keyboards.firstMatch.exists { app.buttons["dismissBotTeamNameKeyboardButton"].tap() }
        for id in ids { try tapSwitch(app.switches["teamMember-" + id]) }
        let continuous = app.descendants(matching: .any).matching(identifier: "teamContinuousWorkLabel").firstMatch
        try tapWorkspace(continuous, performTap: false)
        XCTAssertFalse(app.buttons["Work limits"].exists)
        XCTAssertEqual(app.steppers.count, 0)
        attachScreenshot("Continuous team work — until finished or stopped")
        let save = app.buttons["confirmBotTeamButton"]; try waitEnabled(save); save.tap()
        let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: name)
        XCTAssertEqual(XCTWaiter.wait(for: [closed], timeout: 15), .completed)
        let state = try await fixtureControl(control, action: "state")
        let calls = try XCTUnwrap(state["calls"] as? [[String: Any]])
        let posts = calls.filter { $0["path"] as? String == "/api/bots/teams" && $0["method"] as? String == "POST" }
        XCTAssertEqual(posts.count, 1)
        let body = try XCTUnwrap(posts.first?["body"] as? [String: Any])
        XCTAssertEqual(Set(body["memberIds"] as? [String] ?? []), Set(ids))
        let zeros = ["maxParallel": 0, "maxDepth": 0, "maxHops": 0, "maxTurns": 0, "maxDurationMs": 0]
        XCTAssertEqual(body["limits"] as? [String: Int], zeros)
        let teams = try XCTUnwrap((state["teamSettings"] as? [String: Any])?["teams"] as? [[String: Any]])
        let created = try XCTUnwrap(teams.first { $0["name"] as? String == "Continuous studio" })
        XCTAssertEqual(created["limits"] as? [String: Int], zeros)
        XCTAssertEqual(created["enabled"] as? Bool, false)
        XCTAssertTrue((state["roomTurns"] as? [Any])?.isEmpty == true)
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.hasSuffix("/runs") == true || ($0["path"] as? String)?.hasSuffix("/messages") == true || ($0["path"] as? String)?.contains("/computer/") == true })
    }

    @MainActor
    func testLargeTeamCreationUsesAllAvailableTeammates() async throws {
        let control = try pairWorkspaceFixture(), initial = try await fixtureControl(control, action: "state")
        let members = try XCTUnwrap(initial["roomMembers"] as? [[String: Any]])
        XCTAssertEqual(members.count, 15)
        let ids = try members.prefix(14).map { try XCTUnwrap($0["id"] as? String) }
        try openCreateMenu()
        try tapWorkspace(app.buttons["createBotTeamButton"])
        let name = app.textFields["botTeamNameInput"]; try require(name); name.tap(); name.typeText("Studio fourteen")
        if app.keyboards.firstMatch.exists { app.buttons["dismissBotTeamNameKeyboardButton"].tap() }
        for id in ids { try tapSwitch(app.switches["teamMember-" + id]) }
        try tapWorkspace(app.buttons["Work limits"])
        let unlimited = app.descendants(matching: .any).matching(identifier: "teamParallelAvailableLabel").firstMatch
        try tapWorkspace(unlimited, performTap: false)
        XCTAssertFalse(app.steppers["teamParallelLimitStepper"].exists)
        attachScreenshot("Team creation — fourteen members and all available parallel work")
        let save = app.buttons["confirmBotTeamButton"]; try waitEnabled(save); save.tap()
        let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: name)
        XCTAssertEqual(XCTWaiter.wait(for: [closed], timeout: 15), .completed)
        let state = try await fixtureControl(control, action: "state")
        let calls = try XCTUnwrap(state["calls"] as? [[String: Any]])
        let posts = calls.filter { $0["path"] as? String == "/api/bots/teams" && $0["method"] as? String == "POST" }
        XCTAssertEqual(posts.count, 1)
        let body = try XCTUnwrap(posts.first?["body"] as? [String: Any])
        let sent = try XCTUnwrap(body["memberIds"] as? [String])
        XCTAssertEqual(sent.count, 14); XCTAssertEqual(Set(sent), Set(ids))
        XCTAssertEqual((body["limits"] as? [String: Int])?["maxParallel"], 0)
        let teams = try XCTUnwrap((state["teamSettings"] as? [String: Any])?["teams"] as? [[String: Any]])
        let created = try XCTUnwrap(teams.first { $0["name"] as? String == "Studio fourteen" })
        XCTAssertEqual(Set(created["memberIds"] as? [String] ?? []), Set(ids))
        XCTAssertEqual((created["limits"] as? [String: Int])?["maxParallel"], 0)
        XCTAssertTrue((state["roomTurns"] as? [Any])?.isEmpty == true)
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.hasSuffix("/runs") == true || ($0["path"] as? String)?.hasSuffix("/messages") == true || ($0["path"] as? String)?.contains("/computer/") == true })
    }

    @MainActor
    func testTeamMembershipSharedComputerFoldersConflictAndPersistence() async throws {
        let control = try pairWorkspaceFixture(), initial = try await fixtureControl(control, action: "state")
        let team = try XCTUnwrap(initial["roomTeam"] as? [String: Any]), id = try XCTUnwrap(team["id"] as? String)
        let members = try XCTUnwrap(initial["roomMembers"] as? [[String: Any]])
        let owner = try XCTUnwrap(members[0]["id"] as? String), builder = try XCTUnwrap(members[1]["id"] as? String), reviewer = try XCTUnwrap(members[2]["id"] as? String)
        let helper = try XCTUnwrap((initial["roomExtraMember"] as? [String: Any])?["id"] as? String)
        let localFolder = try XCTUnwrap(initial["teamSettingsFolder"] as? String), otherFolder = try XCTUnwrap(initial["teamSettingsOtherFolder"] as? String)
        let channel = try XCTUnwrap(initial["teamChannel"] as? [String: Any]), initialMessages = try XCTUnwrap(channel["messages"] as? [[String: Any]])
        let originalMessageIds = initialMessages.compactMap { $0["id"] as? String }
        try tapWorkspace(app.buttons["team-" + id])
        func openEditor() throws {
            try openTeamDetails()
            if !app.buttons["editBotTeamButton"].exists { try tapWorkspace(app.buttons["botTeamSettingsDisclosure"]) }
            try tapWorkspace(app.buttons["editBotTeamButton"])
            try require(app.textFields["botTeamNameInput"])
        }
        func replaceFolder(_ value: String) throws {
            try tapWorkspace(app.buttons["clearTeamWorkingFolderButton"])
            let field = app.descendants(matching: .any).matching(identifier: "teamWorkingFolderInput").firstMatch
            try tapWorkspace(field); field.typeText(value)
            if app.keyboards.firstMatch.exists { app.buttons["dismissBotTeamNameKeyboardButton"].tap() }
        }
        func save() throws {
            let name = app.textFields["botTeamNameInput"]
            try waitEnabled(app.buttons["confirmBotTeamButton"]); app.buttons["confirmBotTeamButton"].tap()
            let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: name)
            guard XCTWaiter.wait(for: [closed], timeout: 15) == .completed else { throw acceptanceError("Team save did not finish.") }
        }
        try openEditor()
        try tapSwitch(app.switches["teamMember-" + helper]); try tapSwitch(app.switches["teamMember-" + reviewer])
        try tapWorkspace(app.buttons["teamCoordinatorPicker"]); try require(app.buttons["Builder"]); app.buttons["Builder"].tap()
        try tapWorkspace(app.buttons["teamExecutionPicker"]); app.buttons["Shared team computer"].tap()
        try tapWorkspace(app.buttons["teamComputerPicker"]); app.buttons["This Mac"].tap()
        try replaceFolder(localFolder)
        attachScreenshot("Team settings — edited members coordinator and shared Mac folder")
        try save()
        try tapWorkspace(app.descendants(matching: .any).matching(identifier: "teamSavedWorkingFolder").firstMatch, performTap: false)
        app.buttons["closeTeamDetailsButton"].tap()
        try tapWorkspace(app.staticTexts["Hi everyone! I am Reviewer. Ready to help the team."], performTap: false)
        app.terminate(); app.launch(); tapTab("Bots"); try tapWorkspace(app.buttons["team-" + id])
        try openEditor()
        XCTAssertEqual(app.switches["teamMember-" + helper].value as? String, "1")
        XCTAssertEqual(app.switches["teamMember-" + reviewer].value as? String, "0")
        try tapWorkspace(app.buttons["teamCoordinatorPicker"], performTap: false)
        XCTAssertTrue(app.buttons["teamCoordinatorPicker"].label.contains("Builder"))
        let folder = app.descendants(matching: .any).matching(identifier: "teamWorkingFolderInput").firstMatch
        try tapWorkspace(folder, performTap: false); XCTAssertEqual(folder.value as? String, localFolder)
        attachScreenshot("Team settings — roster and shared folder retained after relaunch")
        try replaceFolder(otherFolder)
        _ = try await fixtureControl(control, action: "team-settings-change")
        try require(app.staticTexts["teamEditConflictMessage"])
        XCTAssertEqual(folder.value as? String, otherFolder, "A remote change must not silently replace the unsaved folder.")
        XCTAssertFalse(app.buttons["confirmBotTeamButton"].isEnabled)
        attachScreenshot("Team settings — version conflict preserves the draft")
        app.buttons["reloadBotTeamButton"].tap()
        try XCTUnwrap(app.buttons.matching(identifier: "Reload latest team").allElementsBoundByIndex.last(where: { $0.isHittable })).tap()
        let reloaded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.staticTexts["teamEditConflictMessage"])
        XCTAssertEqual(XCTWaiter.wait(for: [reloaded], timeout: 5), .completed)
        try tapWorkspace(folder, performTap: false); XCTAssertEqual(folder.value as? String, localFolder)
        try tapWorkspace(app.buttons["teamComputerPicker"]); app.buttons["Coordinator’s computer"].tap()
        for _ in 0..<3 {
            app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.32)).press(forDuration: 0.02, thenDragTo: app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.73)))
        }
        try require(app.switches["teamMember-" + owner])
        XCTAssertFalse(app.switches["teamMember-" + owner].isEnabled, "The shared CUA owner must remain a member.")
        try replaceFolder("/outside")
        XCTAssertFalse(app.buttons["confirmBotTeamButton"].isEnabled)
        try replaceFolder("/workspace/team")
        attachScreenshot("Team settings — exact isolated guest and contained working folder")
        try save()
        try tapWorkspace(app.buttons["openTeamComputerButton"])
        try require(app.descendants(matching: .any).matching(identifier: "computerControlState").firstMatch)
        XCTAssertTrue(app.buttons["startBotComputerButton"].exists)
        attachScreenshot("Team settings — existing shared CUA guest opens view only")
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["closeTeamDetailsButton"].tap()
        try openEditor()
        try tapWorkspace(app.buttons["teamComputerPicker"]); app.buttons["Fixture SSH computer"].tap()
        let emptyFolder = app.descendants(matching: .any).matching(identifier: "teamWorkingFolderInput").firstMatch
        try tapWorkspace(emptyFolder); emptyFolder.typeText("/srv/team fixture")
        app.buttons["dismissBotTeamNameKeyboardButton"].tap()
        attachScreenshot("Team settings — configured SSH target and remote folder")
        try save(); app.buttons["closeTeamDetailsButton"].tap()
        try openEditor()
        _ = try await fixtureControl(control, action: "team-settings-active")
        try require(app.staticTexts["teamEditActiveWorkMessage"])
        XCTAssertFalse(app.buttons["confirmBotTeamButton"].isEnabled)
        attachScreenshot("Team settings — active work blocks changes without losing the draft")
        app.buttons["Cancel"].tap()
        try tapWorkspace(app.buttons["editBotTeamButton"], performTap: false); XCTAssertFalse(app.buttons["editBotTeamButton"].isEnabled)
        _ = try await fixtureControl(control, action: "team-settings-idle")
        try waitEnabled(app.buttons["editBotTeamButton"])
        app.buttons["closeTeamDetailsButton"].tap()
        app.terminate()
        _ = try await fixtureControl(control, action: "appearance-dark")
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch(); tapTab("Bots"); try tapWorkspace(app.buttons["team-" + id]); try openEditor()
        try tapWorkspace(app.buttons["teamComputerPicker"], performTap: false)
        attachScreenshot("Team settings — Dark accessibility XXXL and reachable Save")
        XCTAssertTrue(app.buttons["confirmBotTeamButton"].isHittable)
        app.buttons["Cancel"].tap(); app.buttons["closeTeamDetailsButton"].tap()
        let final = try await fixtureControl(control, action: "state")
        let settings = try XCTUnwrap(final["teamSettings"] as? [String: Any]), teams = try XCTUnwrap(settings["teams"] as? [[String: Any]])
        let saved = try XCTUnwrap(teams.first { $0["id"] as? String == id })
        XCTAssertEqual(Set(saved["memberIds"] as? [String] ?? []), Set([owner, builder, helper]))
        XCTAssertEqual(saved["coordinatorId"] as? String, builder)
        XCTAssertEqual((saved["execution"] as? [String: String])?["workspace"], "/srv/team fixture")
        let finalChannel = try XCTUnwrap(final["teamChannel"] as? [String: Any]), finalMessages = try XCTUnwrap(finalChannel["messages"] as? [[String: Any]])
        XCTAssertTrue(Set(originalMessageIds).isSubset(of: Set(finalMessages.compactMap { $0["id"] as? String })))
        XCTAssertTrue((finalChannel["activeRuns"] as? [Any])?.isEmpty == true)
        let calls = try XCTUnwrap(final["calls"] as? [[String: Any]])
        XCTAssertEqual(calls.filter { $0["method"] as? String == "PATCH" }.count, 3)
        XCTAssertTrue(calls.allSatisfy { $0["method"] as? String == "GET" || ($0["method"] as? String == "PATCH" && $0["path"] as? String == "/api/bots/teams/" + id) })
    }

    @MainActor
    func testTeamPublicInstructionsRolesPersistenceAndConflict() async throws {
        let control = try pairWorkspaceFixture(), initial = try await fixtureControl(control, action: "state")
        let original = try XCTUnwrap(initial["roomTeam"] as? [String: Any]), id = try XCTUnwrap(original["id"] as? String)
        let members = try XCTUnwrap(initial["roomMembers"] as? [[String: Any]])
        let builder = try XCTUnwrap(members[1]["id"] as? String), helper = try XCTUnwrap((initial["roomExtraMember"] as? [String: Any])?["id"] as? String)
        let initialChannel = try XCTUnwrap(initial["teamChannel"] as? [String: Any]), originalEntries = try XCTUnwrap(initialChannel["messages"] as? [[String: Any]])
        let originalIds = Set(originalEntries.compactMap { $0["id"] as? String })
        let initialSettings = try XCTUnwrap(initial["teamSettings"] as? [String: Any]), initialRuns = try XCTUnwrap(initialSettings["runs"] as? [[String: Any]])
        XCTAssertEqual(initialRuns.count, 1); XCTAssertTrue(initialRuns.allSatisfy { $0["state"] as? String == "completed" })
        XCTAssertFalse(originalEntries.contains { $0["state"] as? String == "error" })
        try tapWorkspace(app.buttons["team-" + id])
        func openEditor() throws {
            try openTeamDetails()
            if !app.buttons["editBotTeamButton"].exists { try tapWorkspace(app.buttons["botTeamSettingsDisclosure"]) }
            try tapWorkspace(app.buttons["editBotTeamButton"]); try require(app.textFields["botTeamNameInput"])
        }
        func showFromTop(_ element: XCUIElement) throws {
            for _ in 0..<7 {
                let name = app.textFields["botTeamNameInput"], nav = app.navigationBars.firstMatch
                if name.exists, name.isHittable, name.frame.midY > nav.frame.maxY { break }
                let window = app.windows.firstMatch, frame = window.frame, origin = window.coordinate(withNormalizedOffset: .zero)
                origin.withOffset(CGVector(dx: frame.width * 0.5, dy: frame.height * 0.30)).press(forDuration: 0.02, thenDragTo: origin.withOffset(CGVector(dx: frame.width * 0.5, dy: frame.height * 0.72)))
            }
            try tapWorkspace(element, performTap: false)
        }
        func setMember(_ botId: String, included: Bool) throws {
            let element = app.switches["teamMember-" + botId], desired = included ? "1" : "0"
            try showFromTop(element)
            let evidence = XCTAttachment(string: app.debugDescription)
            evidence.name = "Member switch AX tree before change"; evidence.lifetime = .keepAlways; add(evidence)
            for _ in 0..<2 {
                if element.value as? String == desired { return }
                let target = element.switches.firstMatch.exists ? element.switches.firstMatch : element
                target.coordinate(withNormalizedOffset: CGVector(dx: 0.80, dy: 0.5)).tap()
                let changed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in element.value as? String == desired }, object: nil)
                if XCTWaiter.wait(for: [changed], timeout: 3) == .completed { return }
            }
            guard element.value as? String == desired else { throw acceptanceError("The member switch did not reach its requested state. No settings were saved.") }
        }
        func dismissKeyboard() { if app.keyboards.firstMatch.exists { app.buttons["dismissBotTeamNameKeyboardButton"].tap() } }
        let instructions = app.descendants(matching: .any).matching(identifier: "botTeamInstructionsInput").firstMatch
        let role = app.textFields["teamMemberRole-" + builder]
        let memberInstructions = app.descendants(matching: .any).matching(identifier: "teamMemberInstructions-" + builder).firstMatch
        let sharedText = "Keep the team channel informed and review work together.", memberText = "Implement assigned work and report the result here."
        try openEditor(); try tapWorkspace(instructions); instructions.typeText(sharedText); dismissKeyboard()
        try setMember(helper, included: true)
        try tapWorkspace(app.descendants(matching: .any).matching(identifier: "teamMemberBriefing-" + builder).firstMatch)
        try tapWorkspace(role); role.typeText("Developer"); dismissKeyboard()
        try tapWorkspace(memberInstructions); memberInstructions.typeText(memberText); dismissKeyboard()
        attachScreenshot("Public team instructions — shared guidance and Developer role")
        try showFromTop(app.switches["teamMember-" + helper])
        XCTAssertEqual(app.switches["teamMember-" + helper].value as? String, "1", "Verify the requested membership before saving.")
        try waitEnabled(app.buttons["confirmBotTeamButton"]); app.buttons["confirmBotTeamButton"].tap()
        let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.textFields["botTeamNameInput"])
        XCTAssertEqual(XCTWaiter.wait(for: [closed], timeout: 15), .completed)
        app.buttons["closeTeamDetailsButton"].tap()
        app.terminate(); app.launch(); tapTab("Bots"); try tapWorkspace(app.buttons["team-" + id]); try openEditor()
        try showFromTop(instructions); XCTAssertEqual(instructions.value as? String, sharedText)
        try showFromTop(app.switches["teamMember-" + helper]); XCTAssertEqual(app.switches["teamMember-" + helper].value as? String, "1")
        try tapWorkspace(app.descendants(matching: .any).matching(identifier: "teamMemberBriefing-" + builder).firstMatch)
        try tapWorkspace(role, performTap: false); XCTAssertEqual(role.value as? String, "Developer")
        XCTAssertEqual(memberInstructions.value as? String, memberText)
        attachScreenshot("Public team instructions — member and roles retained after relaunch")
        app.buttons["Cancel"].tap(); app.buttons["closeTeamDetailsButton"].tap(); try openEditor()
        try showFromTop(instructions); instructions.tap(); instructions.typeText(" Draft for review."); dismissKeyboard()
        let heldDraft = instructions.value as? String
        _ = try await fixtureControl(control, action: "team-settings-change")
        try require(app.staticTexts["teamEditConflictMessage"])
        XCTAssertEqual(instructions.value as? String, heldDraft); XCTAssertFalse(app.buttons["confirmBotTeamButton"].isEnabled)
        attachScreenshot("Public team instructions — conflict keeps the unsaved draft")
        app.buttons["reloadBotTeamButton"].tap()
        try XCTUnwrap(app.buttons.matching(identifier: "Reload latest team").allElementsBoundByIndex.last(where: { $0.isHittable })).tap()
        let reloaded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.staticTexts["teamEditConflictMessage"])
        XCTAssertEqual(XCTWaiter.wait(for: [reloaded], timeout: 8), .completed)
        try showFromTop(instructions); XCTAssertEqual(instructions.value as? String, sharedText)
        _ = try await fixtureControl(control, action: "appearance-dark")
        attachScreenshot("Public team instructions — latest shared settings in Dark mode")
        app.buttons["Cancel"].tap(); app.buttons["closeTeamDetailsButton"].tap()
        let final = try await fixtureControl(control, action: "state"), settings = try XCTUnwrap(final["teamSettings"] as? [String: Any])
        let teams = try XCTUnwrap(settings["teams"] as? [[String: Any]]), saved = try XCTUnwrap(teams.first { $0["id"] as? String == id })
        XCTAssertEqual(Set(saved["memberIds"] as? [String] ?? []), Set(members.compactMap { $0["id"] as? String } + [helper]))
        let briefing = try XCTUnwrap(saved["briefing"] as? [String: Any]); XCTAssertEqual(briefing["instructions"] as? String, sharedText)
        XCTAssertEqual(briefing["members"] as? [[String: String]], [["botId": builder, "role": "Developer", "instructions": memberText]])
        let finalChannel = try XCTUnwrap(final["teamChannel"] as? [String: Any]), entries = try XCTUnwrap(finalChannel["messages"] as? [[String: Any]])
        XCTAssertTrue(originalIds.isSubset(of: Set(entries.compactMap { $0["id"] as? String })))
        XCTAssertTrue((finalChannel["activeRuns"] as? [Any])?.isEmpty == true); XCTAssertFalse(entries.contains { $0["state"] as? String == "error" })
        let calls = try XCTUnwrap(final["calls"] as? [[String: Any]])
        XCTAssertEqual(calls.filter { $0["method"] as? String == "PATCH" }.count, 1)
        XCTAssertTrue(calls.allSatisfy { $0["method"] as? String == "GET" || $0["method"] as? String == "PATCH" && $0["path"] as? String == "/api/bots/teams/" + id })
    }

    @MainActor
    func testTeamExplicitTaskSharedThinkingStopAndActivity() async throws {
        let controlURL = try pairWorkspaceFixture()
        try openCreateMenu()
        let create = app.buttons["createBotTeamButton"]
        try require(create); try waitEnabled(create); try tapWorkspace(create)
        let name = app.textFields["botTeamNameInput"]; try require(name)
        attachScreenshot("Bots workspace — native team creation form")
        name.tap(); name.typeText("Phone review team")
        app.buttons["dismissBotTeamNameKeyboardButton"].tap()
        try tapSwitch(app.switches["teamMember-fixture-bot"])
        try tapSwitch(app.switches["teamMember-fixture-reviewer"])
        try waitEnabled(app.buttons["confirmBotTeamButton"]); app.buttons["confirmBotTeamButton"].tap()
        let team = app.buttons["team-team_fixture"]
        try require(team); try tapWorkspace(team)
        try openTeamDetails()
        try tapWorkspace(app.buttons["botTeamSettingsDisclosure"])
        let enabled = app.buttons["toggleBotTeamEnabledButton"]
        try tapWorkspace(enabled, performTap: false); try waitEnabled(enabled); enabled.tap()
        app.buttons["closeTeamDetailsButton"].tap()
        let input = app.descendants(matching: .any).matching(identifier: "botTeamTaskInput").firstMatch
        try tapWorkspace(input); input.typeText("Review this synthetic workspace")
        app.buttons["dismissBotTeamTaskKeyboardButton"].tap()
        let start = app.buttons["startBotTeamTaskButton"]
        try waitEnabled(start); try tapWorkspace(start)
        try openTeamDetails()
        try tapWorkspace(app.buttons["Open task conversation"])
        let thinking = app.buttons["thinkingDisclosure-team-assistant"]
        try require(thinking); thinking.tap()
        try require(app.staticTexts["thinkingContent-team-assistant"])
        attachScreenshot("Bots workspace — coordinator shared history and Thinking")
        tapTab("Bots")
        let stop = app.buttons["stopBotTeamRun-run_fixture"]
        try require(stop)
        _ = try await fixtureControl(controlURL, action: "team-progress")
        try openTeamDetails(); try tapWorkspace(app.staticTexts["7 turns"], performTap: false); app.buttons["closeTeamDetailsButton"].tap()
        try waitEnabled(stop); stop.tap()
        try require(app.buttons["Stop all team work"]); app.buttons["Stop all team work"].tap()
        try openTeamDetails(); try tapWorkspace(app.buttons["botTeamPreviousTasksDisclosure"])
        try tapWorkspace(app.staticTexts["Cancelled"], performTap: false)
        app.buttons["closeTeamDetailsButton"].tap()
        app.navigationBars.buttons.firstMatch.tap()
        try selectWorkspace("Activity")
        try require(app.staticTexts["Reviewer subagent"])
        XCTAssertTrue(app.staticTexts["Coordinator message"].exists)
        attachScreenshot("Bots workspace — durable messages and subagents")
        let state = try await fixtureControl(controlURL, action: "state"), calls = try XCTUnwrap(state["calls"] as? [[String: Any]])
        let creations = calls.filter { $0["path"] as? String == "/api/bots/teams" && $0["method"] as? String == "POST" }
        XCTAssertEqual(creations.count, 1); XCTAssertEqual((creations.first?["body"] as? [String: Any])?["enabled"] as? Bool, false)
        XCTAssertEqual(calls.filter { $0["path"] as? String == "/api/bots/teams/team_fixture/runs" && $0["method"] as? String == "POST" }.count, 1)
        XCTAssertTrue(calls.contains { $0["path"] as? String == "/api/bots/teams/team_fixture/runs/run_fixture/stop" })
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.hasSuffix("/messages") == true }, "Only the explicit team task sends a prompt.")
    }

    private func acceptanceError(_ message: String) -> NSError { NSError(domain: "StrataUIAcceptance", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    private func require(_ element: XCUIElement) throws {
        guard element.waitForExistence(timeout: 10) else { throw acceptanceError("A required workspace control did not appear.") }
    }
    private func selectWorkspace(_ requested: String) throws {
        let title = requested == "Connections" ? "Connectors" : requested
        if title == "Activity" {
            let activity = app.buttons["botsActivityButton"]
            try require(activity); XCTAssertTrue(activity.isHittable); activity.tap()
            try require(app.navigationBars["Activity"])
            return
        }
        let menu = app.buttons["botsWorkspaceMenuButton"]
        try require(menu); menu.tap()
        let button = app.buttons["botsWorkspaceDestination-" + title]
        try require(button); button.tap()
        let navigation = app.navigationBars[title == "Team" ? "Bots" : title]
        if title == "Team", !navigation.waitForExistence(timeout: 2), button.exists, button.isHittable {
            // iOS26's native Menu can keep this last visible row open after
            // semantic tap. Use its observed visible row once, then still
            // require the real destination; do not bypass application state.
            attachScreenshot("Native Bots and teams menu — before bounded visible-row retry")
            button.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
        try require(navigation)
    }
    private func selectRosterFilter(_ title: String) throws {
        let menu = app.buttons["botsWorkspaceMenuButton"]
        try require(menu); menu.tap()
        let filter = app.buttons["botRosterFilter-" + title]
        try require(filter); filter.tap()
    }
    private func openCreateMenu() throws {
        try require(app.buttons["createBotMenuButton"]); app.buttons["createBotMenuButton"].tap()
    }
    private func openTeamDetails() throws {
        try require(app.buttons["teamChannelHeaderButton"]); app.buttons["teamChannelHeaderButton"].tap()
        try require(app.buttons["closeTeamDetailsButton"])
    }
    private func waitEnabled(_ element: XCUIElement) throws {
        try require(element)
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: element)
        guard XCTWaiter.wait(for: [ready], timeout: 15) == .completed else { throw acceptanceError("A required workspace control did not become enabled.") }
    }

    private func expandProfile(_ identifier: String, revealing target: XCUIElement) throws {
        if target.exists { return }
        let control = app.descendants(matching: .any).matching(identifier: identifier).firstMatch
        try tapWorkspace(control)
        try require(target)
    }

    private func tapSwitch(_ element: XCUIElement) throws { try tapWorkspace(element, horizontal: 0.93) }

    private func tapWorkspace(_ element: XCUIElement, horizontal: CGFloat? = nil, performTap: Bool = true) throws {
        for _ in 0..<12 {
            let window = app.windows.firstMatch.frame
            let navigation = app.navigationBars.firstMatch
            let top = max(window.minY + 60, navigation.exists ? navigation.frame.maxY + 8 : window.minY + 60)
            var bottom = window.maxY - 24
            let taskReviewSheet = app.buttons["closeTeamWorkReviewButton"].exists || ["teamWorkflowsView", "teamWorkflowEditor", "teamWorkflowDetailView"].contains { app.descendants(matching: .any).matching(identifier: $0).firstMatch.exists }
            if !taskReviewSheet, app.tabBars.firstMatch.exists { bottom = min(bottom, app.tabBars.firstMatch.frame.minY - 18) }
            if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY - 12) }
            let teamFooter = app.otherElements["teamEditorFooter"]
            if teamFooter.exists { bottom = min(bottom, teamFooter.frame.minY - 12) }
            // The persistent roster controls sit above the tab bar. Swiping
            // from that overlay cannot move the underlying list.
            let targetIdentifier = element.exists ? element.identifier : ""
            let rosterMenu = app.buttons["botsWorkspaceMenuButton"]
            if !taskReviewSheet, rosterMenu.exists, !["botRosterSearchInput", "botsWorkspaceMenuButton"].contains(targetIdentifier) {
                bottom = min(bottom, rosterMenu.frame.minY - 12)
            }
            let teamInput = app.descendants(matching: .any).matching(identifier: "botTeamTaskInput").firstMatch
            if !taskReviewSheet, !app.buttons["closeTeamDetailsButton"].exists, !app.buttons["confirmBotTeamButton"].exists, teamInput.exists, !["botTeamTaskInput", "startBotTeamTaskButton", "teamChannelRecipientPicker", "teamComposerMenuButton"].contains(targetIdentifier) {
                bottom = min(bottom, teamInput.frame.minY - 54)
            }
            let frame = element.exists ? element.frame : .zero, y = frame.midY
            if element.exists, element.isHittable, frame.width > 0, y > top, y < bottom {
                if performTap {
                    if let horizontal { element.coordinate(withNormalizedOffset: CGVector(dx: horizontal, dy: 0.5)).tap() }
                    else { element.tap() }
                }
                return
            }
            // SwiftUI List may not expose a hittable scroll container on this
            // iOS release. Drag within the actual content viewport, never the
            // floating tab bar or a switch whose center is outside that viewport.
            let origin = app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
            let upper = origin.withOffset(CGVector(dx: window.width * 0.5, dy: top - window.minY + 75))
            let lower = origin.withOffset(CGVector(dx: window.width * 0.5, dy: bottom - window.minY - 45))
            if element.exists, frame.height > 0, y <= top { upper.press(forDuration: 0.02, thenDragTo: lower) }
            else { lower.press(forDuration: 0.02, thenDragTo: upper) }
        }
        throw NSError(domain: "StrataUIAcceptance", code: 2, userInfo: [NSLocalizedDescriptionKey: "The workspace control must be visible above the tab bar and keyboard."])
    }

    @MainActor
    func testActualSampleAvatarAndIsolatedComputerControl() async throws {
        guard let raw = ProcessInfo.processInfo.environment["STRATA_TEST_INVITATION"],
              let invitation = URLComponents(string: raw),
              let control = ProcessInfo.processInfo.environment["STRATA_SHARED_FIXTURE_CONTROL"],
              let controlURL = URL(string: control), controlURL.host == "127.0.0.1" else {
            throw XCTSkip("Provide an isolated computer fixture invitation and loopback control URL.")
        }
        func item(_ name: String) -> String? { invitation.queryItems?.first { $0.name == name }?.value }
        openManualPairing(); sensitivePairingVisible = true
        fillPairing(address: try XCTUnwrap(item("url")), code: try XCTUnwrap(item("code")), fingerprint: try XCTUnwrap(item("fingerprint")))
        submitPairing()
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["dismissPairingButton"])
        XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 25), .completed)
        sensitivePairingVisible = false
        tapTab("Bots")
        let bot = app.buttons["botProfile-fixture-bot"]
        XCTAssertTrue(bot.waitForExistence(timeout: 10)); bot.tap()
        let customize = app.buttons["customizeBotAvatarButton"]
        XCTAssertTrue(customize.waitForExistence(timeout: 5)); customize.tap()
        try tapWorkspace(app.buttons["avatar-character-robot"])
        XCTAssertTrue(app.buttons["Robot"].isSelected)
        attachScreenshot("Bots — robot character with shared palette and expressions")
        try tapWorkspace(app.buttons["avatar-character-cat"])
        XCTAssertTrue(app.buttons["Cat"].isSelected)
        try tapWorkspace(app.buttons["avatar-character-fox"]); try tapWorkspace(app.buttons["avatar-color-orange"]); try tapWorkspace(app.buttons["avatar-eyes-round"]); try tapWorkspace(app.buttons["avatar-ears-small"])
        XCTAssertTrue(app.buttons["Fox"].isSelected)
        attachScreenshot("Bots — fox character and native customization")
        app.buttons["saveBotAvatarButton"].tap()
        let firstSave = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["saveBotAvatarButton"])
        XCTAssertEqual(XCTWaiter.wait(for: [firstSave], timeout: 10), .completed)
        let foxState = try await fixtureControl(controlURL, action: "state")
        XCTAssertEqual(foxState["botFace"] as? [String: String], ["kind": "fox", "color": "orange", "eyes": "round", "ears": "small"])
        XCTAssertTrue(customize.waitForExistence(timeout: 5)); customize.tap()
        XCTAssertTrue(app.buttons["Fox"].isSelected)
        try tapWorkspace(app.buttons["avatar-character-koala"])
        try tapWorkspace(app.buttons["avatar-color-violet"]); try tapWorkspace(app.buttons["avatar-eyes-happy"]); try tapWorkspace(app.buttons["avatar-ears-small"])
        attachScreenshot("Bots — actual sample koala color eyes and ears picker")
        app.buttons["saveBotAvatarButton"].tap()
        let saved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["saveBotAvatarButton"])
        XCTAssertEqual(XCTWaiter.wait(for: [saved], timeout: 10), .completed)
        let faceState = try await fixtureControl(controlURL, action: "state")
        XCTAssertEqual(faceState["botFace"] as? [String: String], ["color": "violet", "eyes": "happy", "ears": "small"])
        let newConversation = app.buttons["newBotConversationButton"]
        reveal(newConversation); newConversation.tap()
        let isolatedWorkspace = app.textFields["botWorkspaceInput"]
        XCTAssertTrue(isolatedWorkspace.waitForExistence(timeout: 5))
        XCTAssertEqual(isolatedWorkspace.value as? String, "/workspace")
        XCTAssertFalse(isolatedWorkspace.isEnabled)
        XCTAssertFalse(app.buttons["clearBotWorkspaceButton"].exists)
        app.buttons["Cancel"].tap()
        let view = app.buttons["botComputerViewButton"]
        XCTAssertTrue(view.waitForExistence(timeout: 5)); reveal(view); view.tap()
        let start = app.buttons["startBotComputerButton"]
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        let initial = try await fixtureControl(controlURL, action: "state")
        XCTAssertEqual(initial["computerRunning"] as? Bool, false)
        XCTAssertEqual(initial["computerControlled"] as? Bool, false)
        start.tap()
        let takeover = app.buttons["takeOverComputerButton"]
        XCTAssertTrue(takeover.waitForExistence(timeout: 10))
        attachScreenshot("Bots — view only isolated computer snapshots")
        takeover.tap()
        let confirmed = app.buttons["Stop bots and take over"]
        XCTAssertTrue(confirmed.waitForExistence(timeout: 5)); confirmed.tap()
        let release = app.buttons["releaseComputerControlButton"]
        XCTAssertTrue(release.waitForExistence(timeout: 10))
        let canvas = app.descendants(matching: .any).matching(identifier: "botComputerCanvas").firstMatch
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let typeField = app.descendants(matching: .any).matching(identifier: "computerTypeField").firstMatch
        reveal(typeField); typeField.tap(); typeField.typeText("Fixture computer text")
        app.buttons["computerTypeButton"].tap()
        let key = app.buttons["computerKey-Enter"]
        reveal(key); key.tap()
        attachScreenshot("Bots — explicit computer takeover with native controls")
        reveal(release); release.tap()
        XCTAssertTrue(takeover.waitForExistence(timeout: 10))
        let released = try await fixtureControl(controlURL, action: "state")
        XCTAssertEqual(released["computerControlled"] as? Bool, false)
        // Leaving while holding a second grant must release it without a resume.
        takeover.tap(); app.buttons["Stop bots and take over"].tap()
        XCTAssertTrue(release.waitForExistence(timeout: 10))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        try await Task.sleep(for: .seconds(1))
        let viewAgain = app.buttons["botComputerViewButton"]
        XCTAssertTrue(viewAgain.waitForExistence(timeout: 5)); viewAgain.tap()
        XCTAssertTrue(takeover.waitForExistence(timeout: 10)); takeover.tap()
        app.buttons["Stop bots and take over"].tap()
        XCTAssertTrue(release.waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home)
        try await Task.sleep(for: .seconds(1))
        let backgrounded = try await fixtureControl(controlURL, action: "state")
        XCTAssertEqual(backgrounded["computerControlled"] as? Bool, false)
        app.activate()
        XCTAssertTrue(takeover.waitForExistence(timeout: 10))
        let stopComputer = app.buttons["stopBotComputerButton"]
        reveal(stopComputer); stopComputer.tap()
        app.buttons["Stop computer"].tap()
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        attachScreenshot("Bots — isolated computer explicitly stopped")
        let after = try await fixtureControl(controlURL, action: "state")
        XCTAssertEqual(after["computerControlled"] as? Bool, false)
        let calls = try XCTUnwrap(after["calls"] as? [[String: Any]])
        let inputs = calls.filter { ($0["path"] as? String)?.hasSuffix("/computer/control") == true }
        XCTAssertEqual(inputs.count, 3)
        let clicked = try XCTUnwrap(inputs[0]["body"] as? [String: Any])
        XCTAssertEqual(try XCTUnwrap(clicked["x"] as? Double), 320, accuracy: 1)
        XCTAssertEqual(try XCTUnwrap(clicked["y"] as? Double), 200, accuracy: 1)
        XCTAssertEqual((inputs[1]["body"] as? [String: Any])?["text"] as? String, "Fixture computer text")
        XCTAssertEqual((inputs[2]["body"] as? [String: Any])?["key"] as? String, "Enter")
        XCTAssertEqual(calls.filter { ($0["path"] as? String)?.hasSuffix("/computer/release") == true }.count, 3)
        XCTAssertEqual(calls.filter { ($0["path"] as? String)?.hasSuffix("/computer/stop") == true }.count, 1)
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.hasSuffix("/messages") == true }, "Computer viewing and input must never create a model prompt.")
    }

    /// Uses a real TLS bridge with synthetic catalog/jobs. No model files, real
    /// Strata computers, or physical phones are controlled by this fixture.
    @MainActor
    func testModelDownloadReviewProgressCancelRetryAndTargetSelection() async throws {
        guard let raw = ProcessInfo.processInfo.environment["STRATA_TEST_INVITATION"],
              let invitation = URLComponents(string: raw),
              let control = ProcessInfo.processInfo.environment["STRATA_MODEL_MANAGEMENT_FIXTURE_CONTROL"],
              let controlURL = URL(string: control), controlURL.host == "127.0.0.1" else {
            throw XCTSkip("Provide an isolated model-management fixture invitation and loopback control URL.")
        }
        func item(_ name: String) -> String? { invitation.queryItems?.first { $0.name == name }?.value }
        openManualPairing()
        sensitivePairingVisible = true
        fillPairing(address: try XCTUnwrap(item("url")), code: try XCTUnwrap(item("code")), fingerprint: try XCTUnwrap(item("fingerprint")))
        submitPairing()
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["dismissPairingButton"])
        XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 25), .completed)
        sensitivePairingVisible = false
        tapTab("Models")
        let review = app.buttons["reviewModelDownload-catalog-native"]
        try requireModelElement(review)
        reveal(review); review.tap()
        let vision = app.switches["modelDownloadVisionToggle"]
        try requireModelElement(vision)
        XCTAssertTrue(app.staticTexts["Fixture Mac"].exists)
        XCTAssertTrue(app.staticTexts["12 GB"].exists)
        XCTAssertTrue(app.staticTexts["100 GB"].exists)
        XCTAssertTrue(app.staticTexts["14 GB"].exists)
        attachScreenshot("Model downloads — review size storage and destination")
        vision.tap()
        let visionOff = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "0"), object: vision)
        await fulfillment(of: [visionOff], timeout: 10)
        _ = try XCTUnwrap((vision.value as? String) == "0" ? true : nil, "Picture reading must update the plan.")
        var snapshot = try await fixtureControl(controlURL, action: "state")
        XCTAssertEqual(snapshot["downloadCount"] as? Int, 0, "Reviewing or changing vision must not start a download.")
        var calls = try XCTUnwrap(snapshot["calls"] as? [[String: Any]])
        let planRequest = try XCTUnwrap(calls.last(where: { ($0["path"] as? String)?.hasSuffix("/plan") == true }))
        XCTAssertEqual((planRequest["body"] as? [String: Any])?["readPictures"] as? Bool, false)
        let confirm = app.buttons["confirmModelDownloadButton"]
        reveal(confirm)
        XCTAssertTrue(app.staticTexts["Running native models will be unloaded before preparing files."].exists)
        XCTAssertTrue(app.staticTexts["The engine may be downloaded or updated."].exists)
        XCTAssertTrue(app.staticTexts["The model will not be loaded automatically."].exists)
        confirm.tap()
        let stopFirst = app.buttons["cancelModelDownload-fixture-download-1"]
        try requireModelElement(stopFirst)
        _ = try await fixtureControl(controlURL, action: "download-progress")
        try requireModelElement(app.staticTexts["Downloading picture reader"])
        reveal(stopFirst)
        attachScreenshot("Model downloads — live stage progress and Stop")
        stopFirst.tap()
        let retryFirst = app.buttons["retryModelDownload-fixture-download-1"]
        try requireModelElement(retryFirst)
        reveal(retryFirst); retryFirst.tap()
        try requireModelElement(confirm)
        snapshot = try await fixtureControl(controlURL, action: "state")
        XCTAssertEqual(snapshot["downloadCount"] as? Int, 1, "Retry first opens a new review.")
        XCTAssertGreaterThan(try XCTUnwrap(snapshot["planCount"] as? Int), 2)
        reveal(confirm); confirm.tap()
        try requireModelElement(app.buttons["cancelModelDownload-fixture-download-2"])
        _ = try await fixtureControl(controlURL, action: "download-error")
        let retryFailed = app.buttons["retryModelDownload-fixture-download-2"]
        try requireModelElement(retryFailed)
        revealModelControl(retryFailed); retryFailed.tap()
        try requireModelElement(confirm)
        snapshot = try await fixtureControl(controlURL, action: "state")
        XCTAssertEqual(snapshot["downloadCount"] as? Int, 2, "A failed download also needs another explicit confirmation.")
        app.buttons["dismissModelDownloadReview"].tap()

        let picker = app.buttons["modelDownloadTargetPicker"]
        revealModelControl(picker); picker.tap()
        let remote = app.buttons["Remote Strata"]
        try requireModelElement(remote, timeout: 5); remote.tap()
        try requireModelElement(review); reveal(review); review.tap()
        try requireModelElement(confirm)
        XCTAssertTrue(app.staticTexts["Remote Strata"].exists, "The review must name the selected remote computer.")
        reveal(confirm); confirm.tap()
        try requireModelElement(app.buttons["cancelModelDownload-fixture-download-3"])
        _ = try await fixtureControl(controlURL, action: "download-complete")
        try requireModelElement(app.staticTexts["Ready on computer"])
        snapshot = try await fixtureControl(controlURL, action: "state")
        calls = try XCTUnwrap(snapshot["calls"] as? [[String: Any]])
        let starts = calls.filter { ($0["path"] as? String)?.hasSuffix("/downloads") == true }
        XCTAssertEqual(starts.count, 3)
        XCTAssertEqual(starts.last?["path"] as? String, "/api/model-management/targets/remote-aaaaaaaaaaaaaaaaaaaaaaaa/downloads")
        XCTAssertEqual(Set((starts.last?["body"] as? [String: Any])?.keys.map { $0 } ?? []), ["planId"])
        attachScreenshot("Model downloads — remote computer complete")

        app.terminate(); app.launch(); tapTab("Models")
        try requireModelElement(app.buttons["retryModelDownload-fixture-download-2"])
        _ = try await fixtureControl(controlURL, action: "management-unsupported")
        try requireModelElement(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Update Strata")).firstMatch, timeout: 12)
        XCTAssertTrue(app.staticTexts["YOUR LIBRARY"].exists, "An older Mac keeps its existing model library usable.")
    }

    /// Read-only acceptance against the user's running Mac. This test pairs,
    /// reads existing history, and reconnects; it sends no model message or action.
    @MainActor
    func testLiveMacReadOnlyHistoryAndSavedPairing() throws {
        guard let raw = ProcessInfo.processInfo.environment["STRATA_READONLY_INVITATION"],
              let invitation = URLComponents(string: raw), invitation.scheme == "strata", invitation.host == "pair" else {
            throw XCTSkip("Provide a fresh real Mac invitation for read-only history acceptance.")
        }
        func item(_ name: String) -> String? { invitation.queryItems?.first { $0.name == name }?.value }
        let address = try XCTUnwrap(item("url"))
        let code = try XCTUnwrap(item("code"))
        let fingerprint = try XCTUnwrap(item("fingerprint"))
        openManualPairing()
        sensitivePairingVisible = true
        fillPairing(address: address, code: code, fingerprint: fingerprint)
        submitPairing()
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["dismissPairingButton"])
        XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 30), .completed)
        sensitivePairingVisible = false
        XCTAssertTrue(app.buttons["connectionStatus"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["connectionStatus"].label.localizedCaseInsensitiveContains("connected"))
        tapTab("Chat")
        let title = app.staticTexts["macConversationTitle"]
        XCTAssertTrue(title.waitForExistence(timeout: 15), "The real Mac's selected or active conversation must open.")
        XCTAssertFalse(title.label.isEmpty)
        XCTAssertTrue(app.staticTexts.matching(identifier: "assistantMessage").firstMatch.waitForExistence(timeout: 15), "Read the existing Mac history without creating a message.")
        attachScreenshot("Live Mac — read-only existing history")

        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["connectionStatus"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["pairMacButton"].exists, "The real Mac pairing must survive relaunch.")
        tapTab("Chat")
        XCTAssertTrue(app.staticTexts["macConversationTitle"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts.matching(identifier: "assistantMessage").firstMatch.waitForExistence(timeout: 15))
        attachScreenshot("Live Mac — saved read-only pairing")
    }

    /// Real pinned TLS bridge and durable notification policy; all model and
    /// message producers are inert fixture state. Uses only a scratch simulator.
    @MainActor
    func testNotificationPreferencesPrivateInboxRoutingMuteAndRelaunch() async throws {
        guard let raw = ProcessInfo.processInfo.environment["STRATA_TEST_INVITATION"], let invitation = URLComponents(string: raw),
              let control = ProcessInfo.processInfo.environment["STRATA_SHARED_FIXTURE_CONTROL"], let controlURL = URL(string: control), controlURL.host == "127.0.0.1" else { throw XCTSkip("Provide an isolated notification fixture.") }
        func selectTab(_ name: String) async throws {
            let tab = app.tabBars.buttons[name]
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                guard tab.exists, tab.isHittable else { return false }
                let frame = tab.frame, window = self.app.windows.firstMatch.frame
                return frame.width > 1 && frame.height > 1 && window.contains(CGPoint(x: frame.midX, y: frame.midY))
            }, object: nil)
            await fulfillment(of: [ready], timeout: 10)
            guard tab.exists, tab.isHittable, tab.frame.width > 1 else { throw acceptanceError("The notification destination tab must be visible and hittable.") }
            tab.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
        func item(_ name: String) -> String { invitation.queryItems!.first { $0.name == name }!.value! }
        openManualPairing(); sensitivePairingVisible = true
        fillPairing(address: item("url"), code: item("code"), fingerprint: item("fingerprint")); submitPairing()
        let paired = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["dismissPairingButton"])
        await fulfillment(of: [paired], timeout: 20); sensitivePairingVisible = false
        try await selectTab("Connection")
        reveal(app.buttons["connectionNotificationsButton"]); app.buttons["connectionNotificationsButton"].tap()
        app.buttons["notificationSettingsButton"].tap()
        let enabled = app.switches["notificationsEnabledToggle"]
        XCTAssertTrue(enabled.waitForExistence(timeout: 5)); XCTAssertEqual(enabled.value as? String, "0")
        try tapSwitch(enabled)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 4) { allow.tap() }
        let enabledSaved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == '1'"), object: enabled)
        await fulfillment(of: [enabledSaved], timeout: 10)
        XCTAssertTrue(app.staticTexts["notificationDeliveryStatus"].label.contains("while Strata is open"))
        try tapSwitch(app.switches["notificationSoundToggle"])
        let soundSaved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == '0'"), object: app.switches["notificationSoundToggle"])
        await fulfillment(of: [soundSaved], timeout: 10)
        attachScreenshot("Notifications — private opt-in settings and honest delivery status")
        app.navigationBars.buttons["Notifications"].tap()
        XCTAssertTrue(app.otherElements["notificationInboxEmpty"].exists || app.staticTexts["You’re all caught up"].exists)
        _ = try await fixtureControl(controlURL, action: "notification-reply")
        let reply = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'notification-' AND label CONTAINS 'New reply'")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'PRIVATE_NOTIFICATION_PREVIEW'")).firstMatch.exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'PRIVATE_THINKING'")).firstMatch.exists)
        attachScreenshot("Notifications — private inbox update")
        reply.tap()
        XCTAssertTrue(app.staticTexts["macConversationTitle"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["macConversationTitle"].label, "Mac browser research")
        app.buttons["chatNotificationOptionsButton"].tap()
        app.buttons["muteNotification-chat:fixture-mac-research"].tap()
        _ = try await fixtureControl(controlURL, action: "notification-team")
        try await selectTab("Bots")
        try require(app.buttons["notificationInboxButton"]); app.buttons["notificationInboxButton"].tap()
        let team = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'notification-' AND label CONTAINS 'Team update'")).firstMatch
        XCTAssertTrue(team.waitForExistence(timeout: 10))
        team.tap()
        XCTAssertTrue(app.buttons["teamChannelHeaderButton"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Hello from the notification team."].waitForExistence(timeout: 10))
        attachScreenshot("Notifications — tap opens the exact team")
        app.buttons["teamOptionsButton"].tap(); app.buttons["muteNotification-team:team_notification"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        try await selectTab("Connection")
        reveal(app.buttons["connectionNotificationsButton"]); app.buttons["connectionNotificationsButton"].tap()
        app.buttons["notificationSettingsButton"].tap()
        XCTAssertTrue(app.buttons["unmuteNotification-chat:fixture-mac-research"].waitForExistence(timeout: 5))
        reveal(app.buttons["unmuteNotification-team:team_notification"]); XCTAssertTrue(app.buttons["unmuteNotification-team:team_notification"].exists)
        app.terminate(); app.launch()
        try await selectTab("Connection")
        reveal(app.buttons["connectionNotificationsButton"]); app.buttons["connectionNotificationsButton"].tap()
        app.buttons["notificationSettingsButton"].tap()
        XCTAssertTrue(app.buttons["unmuteNotification-chat:fixture-mac-research"].waitForExistence(timeout: 10))
        reveal(app.buttons["unmuteNotification-team:team_notification"]); XCTAssertTrue(app.buttons["unmuteNotification-team:team_notification"].exists)
        XCTAssertEqual(app.switches["notificationSoundToggle"].value as? String, "0")
        attachScreenshot("Notifications — preferences and mutes survive relaunch")
        try tapSwitch(app.switches["notificationsEnabledToggle"])
        let disabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == '0'"), object: app.switches["notificationsEnabledToggle"])
        await fulfillment(of: [disabled], timeout: 10)
        let snapshot = try await fixtureControl(controlURL, action: "state")
        let calls = try XCTUnwrap(snapshot["calls"] as? [[String: Any]])
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.contains("/approval") == true }, "Notifications only navigate; they cannot approve tools.")
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.hasSuffix("/messages") == true }, "Opening a notification never prompts a bot.")
    }

    private func fixtureControl(_ baseURL: URL, action: String) async throws -> [String: Any] {
        var request = URLRequest(url: baseURL.appendingPathComponent(action))
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func prepareUnpairedApp() throws {
        if app.buttons["pairMacButton"].waitForExistence(timeout: 3) { return }
        // Recover a previous simulator run using the same controls a person uses offline.
        let alert = app.alerts.firstMatch
        if alert.exists, alert.buttons["OK"].exists { alert.buttons["OK"].tap() }
        tapTab("Connection")
        let forget = app.buttons["forgetMacButton"]
        XCTAssertTrue(forget.waitForExistence(timeout: 5), "The app must show its unpaired Home or its paired connection recovery controls.")
        reveal(forget)
        forget.tap()
        let sheetConfirm = app.sheets.buttons["Forget this Mac"].firstMatch
        let alertConfirm = app.alerts.buttons["Forget this Mac"].firstMatch
        if sheetConfirm.waitForExistence(timeout: 2) { sheetConfirm.tap() }
        else if alertConfirm.exists { alertConfirm.tap() }
        else {
            let confirms = app.buttons.matching(NSPredicate(format: "label == %@", "Forget this Mac"))
            XCTAssertGreaterThan(confirms.count, 1, "Forget requires an explicit confirmation.")
            confirms.element(boundBy: confirms.count - 1).tap()
        }
        XCTAssertTrue(app.buttons["connectionPairButton"].waitForExistence(timeout: 5))
        tapTab("Home")
        XCTAssertTrue(app.buttons["pairMacButton"].waitForExistence(timeout: 5))
    }

    private func openManualPairing() {
        app.buttons["pairMacButton"].tap()
        XCTAssertTrue(app.buttons["scanPairingCodeButton"].waitForExistence(timeout: 5))
        let manual = app.buttons["manualPairingButton"]
        reveal(manual)
        manual.tap()
        XCTAssertTrue(app.textFields["pairingAddressInput"].waitForExistence(timeout: 3))
    }

    private func fillPairing(address: String, code: String, fingerprint: String) {
        enter(address, into: "pairingAddressInput")
        enter(code, into: "pairingCodeInput")
        enter(fingerprint, into: "pairingFingerprintInput")
    }

    private func enter(_ text: String, into identifier: String) {
        let field = app.textFields[identifier]
        reveal(field)
        field.tap()
        field.typeText(text)
        let done = app.buttons["dismissPairingKeyboardButton"]
        if done.waitForExistence(timeout: 2) { done.tap() }
    }

    private func submitPairing() {
        let submit = app.buttons["confirmPairingButton"]
        reveal(submit)
        XCTAssertTrue(submit.isEnabled)
        submit.tap()
    }

    private func assertPairingErrorContains(_ text: String) {
        let error = app.staticTexts["pairingError"]
        XCTAssertTrue(error.waitForExistence(timeout: 5))
        XCTAssertTrue(error.label.contains(text), "The app should explain which pairing detail is invalid.")
        reveal(error)
        XCTAssertTrue(app.buttons["dismissPairingButton"].exists, "Invalid details must leave the pairing flow recoverable.")
    }

    private func tapTab(_ name: String) {
        let settingsDone = app.buttons["dismissMacSettingsButton"]
        if settingsDone.exists { settingsDone.tap() }
        if name == "Connection" {
            let connectors = app.tabBars.buttons["Connectors"]
            XCTAssertTrue(connectors.waitForExistence(timeout: 5)); connectors.tap()
            let settings = app.buttons["connectorMacSettingsButton"]
            XCTAssertTrue(settings.waitForExistence(timeout: 5)); settings.tap()
            return
        }
        let button = app.tabBars.buttons[name]
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        button.tap()
    }

    private func reveal(_ element: XCUIElement) {
        for _ in 0..<5 {
            if element.isHittable { return }
            if app.scrollViews.firstMatch.exists { app.scrollViews.firstMatch.swipeUp() }
            else if app.collectionViews.firstMatch.exists { app.collectionViews.firstMatch.swipeUp() }
            else { app.swipeUp() }
        }
        XCTAssertTrue(element.isHittable, "The control must be reachable by scrolling.")
    }

    private func revealModelControl(_ element: XCUIElement) {
        for _ in 0..<5 {
            if element.isHittable { return }
            app.scrollViews.firstMatch.swipeDown()
        }
        reveal(element)
    }

    private func requireModelElement(_ element: XCUIElement, timeout: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line) throws {
        _ = try XCTUnwrap(element.waitForExistence(timeout: timeout) ? element : nil,
                          "The expected model-download control was not available.", file: file, line: line)
    }

    private func attachScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

/// Explicit opt-in acceptance for an already paired device. This class never
/// opens pairing, forgets a Mac, creates a conversation or submits a prompt.
final class ExistingPairingComputerAcceptanceTests: XCTestCase {
    private var app: XCUIApplication!
    private var botID = ""

    override func setUpWithError() throws {
        guard ProcessInfo.processInfo.environment["STRATA_EXISTING_PAIRING_COMPUTER_TEST"] == "1",
              let selected = ProcessInfo.processInfo.environment["STRATA_EXISTING_PAIRING_BOT_ID"],
              selected.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else {
            throw XCTSkip("Explicit existing-pairing computer acceptance is disabled.")
        }
        continueAfterFailure = false
        botID = selected
        app = XCUIApplication()
        app.launch()
    }

    @MainActor
    func testExistingPairingCanControlPreparedTestGuestAndRelease() throws {
        let botsTab = app.tabBars.buttons["Bots"]
        XCTAssertTrue(botsTab.waitForExistence(timeout: 15)); botsTab.tap()
        let bot = app.buttons["bot-\(botID)"]
        XCTAssertTrue(bot.waitForExistence(timeout: 15), "The prepared TEST bot must be visible through the existing Mac pairing.")
        reveal(bot); bot.tap()
        let view = app.buttons["botComputerViewButton"]
        XCTAssertTrue(view.waitForExistence(timeout: 10)); reveal(view); view.tap()
        let takeover = app.buttons["takeOverComputerButton"]
        XCTAssertTrue(takeover.waitForExistence(timeout: 20), "The TEST guest must already be running; this acceptance never starts it.")
        screenshot("iPhone — existing pairing views the real TEST computer")
        reveal(takeover); takeover.tap()
        let confirm = app.buttons["Stop bots and take over"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5)); confirm.tap()
        let release = app.buttons["releaseComputerControlButton"]
        XCTAssertTrue(release.waitForExistence(timeout: 15))
        defer {
            if release.exists { reveal(release); if release.isHittable { release.tap() } }
        }
        let canvas = app.descendants(matching: .any).matching(identifier: "botComputerCanvas").firstMatch
        reveal(canvas)
        // The runtime acceptance fixture is a real 1280×800 guest HTML page.
        // Its harmless input spans x64…1216, y336…426; account for letterboxing.
        let frame = canvas.frame, scale = min(frame.width / 1280, frame.height / 800)
        let dx = (frame.width - 1280 * scale) / 2 + 300 * scale
        let dy = (frame.height - 800 * scale) / 2 + 380 * scale
        canvas.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: dx, dy: dy)).tap()
        let field = app.descendants(matching: .any).matching(identifier: "computerTypeField").firstMatch
        let inputReady = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: field)
        XCTAssertEqual(XCTWaiter.wait(for: [inputReady], timeout: 15), .completed,
                       "The previous real computer action must finish before focusing its text field.")
        reveal(field); field.tap(); field.typeText("IPHONE-CUA-READY-20261020")
        let type = app.buttons["computerTypeButton"]
        XCTAssertTrue(type.isEnabled); type.tap()
        let sent = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let value = field.value as? String ?? ""
            return value.isEmpty || value == "Text for the computer"
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [sent], timeout: 15), .completed)
        let enter = app.buttons["computerKey-Enter"]
        reveal(enter)
        let keyReady = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: enter)
        XCTAssertEqual(XCTWaiter.wait(for: [keyReady], timeout: 10), .completed); enter.tap()
        // A response acknowledgement alone is not input proof. The parent
        // acceptance also requires guest screenshot/readback of this marker.
        let refresh = app.buttons["Refresh computer view"]
        reveal(refresh)
        let refreshed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: refresh)
        XCTAssertEqual(XCTWaiter.wait(for: [refreshed], timeout: 10), .completed); refresh.tap()
        reveal(canvas); screenshot("iPhone — real TEST guest after explicit click type and key")
        reveal(release); release.tap()
        XCTAssertTrue(takeover.waitForExistence(timeout: 15))
        XCTAssertFalse(release.exists)
        screenshot("iPhone — real TEST computer control released")
    }

    private func reveal(_ element: XCUIElement) {
        for _ in 0..<7 {
            if element.isHittable { return }
            if app.scrollViews.firstMatch.exists { app.scrollViews.firstMatch.swipeUp() }
            else if app.collectionViews.firstMatch.exists { app.collectionViews.firstMatch.swipeUp() }
            else { app.swipeUp() }
        }
        if !element.isHittable, app.scrollViews.firstMatch.exists {
            for _ in 0..<7 { if element.isHittable { return }; app.scrollViews.firstMatch.swipeDown() }
        }
        XCTAssertTrue(element.isHittable, "The existing-pairing test control must be reachable.")
    }

    private func screenshot(_ name: String) {
        let image = XCTAttachment(screenshot: app.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
    }
}

extension CompanionSmokeTests {
    @MainActor
    func testTeamWorkflowRolesEvidenceOwnerReviewAndExplicitContinuation() async throws {
        let control = try pairWorkspaceFixture()
        let teamID = "team_00000000-0000-4000-8000-000000000034"
        let workflowID = "wf_00000000-0000-4000-8000-000000000034"
        _ = try await fixtureControl(control, action: "workflow-failure")
        try tapWorkspace(app.buttons["team-" + teamID])
        try openTeamDetails()
        try tapWorkspace(app.buttons["teamWorkflowsLink"])
        try require(app.navigationBars["Plan & verify"])
        let error = app.descendants(matching: .any).matching(identifier: "botWorkspaceMessage-workflows-" + teamID).firstMatch
        try require(error)
        XCTAssertFalse(app.buttons["newTeamWorkflowButton"].isEnabled)
        attachScreenshot("Workflow — first load failure stays visible")
        let before = try await fixtureControl(control, action: "state")
        XCTAssertTrue((before["calls"] as? [[String: Any]])?.allSatisfy { $0["method"] as? String == "GET" } == true)
        _ = try await fixtureControl(control, action: "workflow-clear-failure")
        app.buttons["refreshTeamWorkflowsButton"].tap()
        try waitEnabled(app.buttons["newTeamWorkflowButton"])
        try tapWorkspace(app.buttons["newTeamWorkflowButton"])
        let goal = app.descendants(matching: .any).matching(identifier: "workflowGoalInput").firstMatch
        try tapWorkspace(goal); goal.typeText("Build a polished workflow fixture")
        let criteria = app.descendants(matching: .any).matching(identifier: "workflowCriteriaInput").firstMatch
        try tapWorkspace(criteria); criteria.typeText("The saved result can be inspected\nThe evaluator is independent")
        if app.keyboards.firstMatch.exists, app.buttons["Done"].exists { app.buttons["Done"].tap() }
        try tapWorkspace(app.buttons["workflowEvaluatorPicker"], performTap: false)
        XCTAssertFalse(app.staticTexts["workflowEvaluatorConflict"].exists)
        attachScreenshot("Workflow — clear goal, criteria and saved roles")
        let start = app.buttons["startTeamWorkflowButton"]
        try tapWorkspace(start, performTap: false); try waitEnabled(start); start.tap()
        try require(app.navigationBars["Workflow"])
        try tapWorkspace(app.staticTexts["workflowPhase"], performTap: false)
        XCTAssertTrue(app.staticTexts["workflowPhase"].label.contains("Ready for your review"))
        XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "workflowOwnerAccepted").firstMatch.exists)
        try tapWorkspace(app.descendants(matching: .any).matching(identifier: "workflowIndependentEvaluator").firstMatch, performTap: false)
        let evaluatorChat = app.buttons.matching(identifier: "workflowStepChat-ws_00000000-0000-4000-8000-000000000003").firstMatch
        try tapWorkspace(evaluatorChat)
        try require(app.staticTexts["Earlier Mac history is available on the phone."])
        let thinking = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "thinkingDisclosure-")).firstMatch
        try require(thinking); thinking.tap()
        try require(app.staticTexts["thinkingContent-fixture-assistant"])
        attachScreenshot("Workflow — exact saved stage conversation and Thinking")
        tapTab("Bots")
        if !app.buttons["teamChannelHeaderButton"].waitForExistence(timeout: 2) { try tapWorkspace(app.buttons["team-" + teamID]) }
        try openTeamDetails(); try tapWorkspace(app.buttons["teamWorkflowsLink"])
        try tapWorkspace(app.buttons["workflow-" + workflowID])
        try tapWorkspace(app.buttons["acceptTeamWorkflowButton"], performTap: false)
        attachScreenshot("Workflow — evaluator findings and owner review remain separate")
        let created = try await fixtureControl(control, action: "state")
        let createdCalls = try XCTUnwrap(created["calls"] as? [[String: Any]])
        XCTAssertEqual(createdCalls.filter { $0["method"] as? String != "GET" }.count, 1)
        let createdRecord = try XCTUnwrap(created["workflowRecord"] as? [String: Any])
        XCTAssertNotEqual(createdRecord["builderId"] as? String, createdRecord["evaluatorId"] as? String)
        XCTAssertEqual(createdRecord["phase"] as? String, "awaiting_review")
        app.buttons["acceptTeamWorkflowButton"].tap()
        try require(app.buttons.matching(identifier: "confirmTeamWorkflowActionButton").firstMatch); app.buttons.matching(identifier: "confirmTeamWorkflowActionButton").firstMatch.tap()
        try tapWorkspace(app.staticTexts["You accepted this result."], performTap: false)
        attachScreenshot("Workflow — acceptance confirmed by the saved host result")
        _ = try await fixtureControl(control, action: "workflow-interrupt")
        app.buttons["refreshTeamWorkflowButton"].tap()
        let resume = app.buttons["resumeTeamWorkflowButton"]
        try tapWorkspace(resume, performTap: false); XCTAssertFalse(resume.isEnabled)
        try tapSwitch(app.switches["workflowInspectedToggle"])
        try tapWorkspace(resume, performTap: false); XCTAssertTrue(resume.isEnabled)
        attachScreenshot("Workflow — explicit inspection before continuation")
        resume.tap()
        try require(app.buttons.matching(identifier: "confirmTeamWorkflowActionButton").firstMatch); app.buttons.matching(identifier: "confirmTeamWorkflowActionButton").firstMatch.tap()
        let stop = app.buttons["stopTeamWorkflowButton"]
        try tapWorkspace(stop, performTap: false); try waitEnabled(stop); stop.tap()
        try require(app.buttons.matching(identifier: "confirmTeamWorkflowActionButton").firstMatch); app.buttons.matching(identifier: "confirmTeamWorkflowActionButton").firstMatch.tap()
        for _ in 0..<8 { if app.staticTexts["workflowPhase"].isHittable { break }; app.swipeDown() }
        try tapWorkspace(app.staticTexts["workflowPhase"], performTap: false)
        XCTAssertTrue(app.staticTexts["workflowPhase"].label.contains("Stopped"))
        try tapWorkspace(resume, performTap: false); XCTAssertFalse(resume.isEnabled)
        let final = try await fixtureControl(control, action: "state")
        let calls = try XCTUnwrap(final["calls"] as? [[String: Any]])
        let writes = calls.filter { $0["method"] as? String != "GET" }
        XCTAssertEqual(writes.count, 4)
        XCTAssertEqual(writes.compactMap { $0["path"] as? String }, ["/api/bots/teams/\(teamID)/workflows", "/api/bots/teams/\(teamID)/workflows/\(workflowID)/review", "/api/bots/teams/\(teamID)/workflows/\(workflowID)/resume", "/api/bots/teams/\(teamID)/workflows/\(workflowID)/stop"])
        let resumeBody = try XCTUnwrap(writes[2]["body"] as? [String: Any])
        XCTAssertEqual(resumeBody["inspected"] as? Bool, true)
        XCTAssertEqual((resumeBody["expectedProof"] as? String)?.count, 64)
        XCTAssertFalse(calls.contains { ($0["path"] as? String)?.contains("/computer/") == true || ($0["path"] as? String)?.contains("/connections/") == true || ($0["path"] as? String)?.contains("/models/") == true || ($0["path"] as? String)?.hasSuffix("/messages") == true })
        _ = try await fixtureControl(control, action: "workflow-unsupported")
        app.buttons["refreshTeamWorkflowButton"].tap()
        try tapWorkspace(resume, performTap: false); XCTAssertFalse(resume.isEnabled)
        attachScreenshot("Workflow — stopped work retained with read-only capability fallback")
    }
}
