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
        let button = app.tabBars.buttons[name]
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        button.tap()
    }

    private func reveal(_ element: XCUIElement) {
        for _ in 0..<5 {
            if element.isHittable { return }
            app.scrollViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(element.isHittable, "The control must be reachable by scrolling.")
    }

    private func attachScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
