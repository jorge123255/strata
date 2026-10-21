import XCTest
import UserNotifications
@testable import StrataMobile

@MainActor
final class NotificationsTests: XCTestCase {
    private func event(_ sequence: Int = 2, id: String = "event-2", type: String = "chat", destination: String = "chat_1", kind: String = "reply") -> CompanionNotificationEvent {
        CompanionNotificationEvent(id: id, sequence: sequence, kind: kind, createdAt: "2026-10-21T04:00:00Z", title: "Bot replied", body: "Open Strata to read the reply.", destination: .init(type: type, id: destination))
    }
    private func feed(_ cursor: Int, events: [CompanionNotificationEvent] = [], journal: String = "journal-one", baseline: Bool? = nil, settings: CompanionNotificationSettings = .init()) -> CompanionNotificationFeed {
        CompanionNotificationFeed(supported: true, journalId: journal, cursor: cursor, nextCursor: cursor, hasMore: false, baseline: baseline, events: events, settings: settings, push: .init(configured: false, detail: "Not configured"))
    }
    func testBaselineAndJournalResetNeverReplayHistory() {
        var ledger = CompanionNotificationLedger()
        XCTAssertTrue(ledger.consume(feed(10, events: [event(10)])).isEmpty)
        XCTAssertEqual(ledger.cursor, 10)
        XCTAssertTrue(ledger.consume(feed(11, events: [event(11)], journal: "different-mac")).isEmpty)
        XCTAssertEqual(ledger.journalId, "different-mac")
        XCTAssertTrue(ledger.consume(feed(12, events: [event(12)], journal: "different-mac", baseline: true)).isEmpty)
    }
    func testCursorDuplicatesMalformedAndOutOfWindowEventsAreDiscarded() {
        var ledger = CompanionNotificationLedger()
        _ = ledger.consume(feed(1))
        let first = event()
        XCTAssertEqual(ledger.consume(feed(2, events: [first])).map(\.id), [first.id])
        XCTAssertTrue(ledger.consume(feed(3, events: [event(3, id: first.id), event(4, id: "future"), event(3, id: "bad", type: "shell")])).isEmpty)
        XCTAssertEqual(ledger.cursor, 3)
        XCTAssertTrue(ledger.consume(feed(2, events: [first])).isEmpty)
        XCTAssertEqual(ledger.cursor, 3)
    }
    func testExplicitResetPrimesInsteadOfReplayingMissedBackgroundMessages() {
        var ledger = CompanionNotificationLedger()
        _ = ledger.consume(feed(1)); ledger.reset()
        XCTAssertNil(ledger.cursor)
        XCTAssertTrue(ledger.consume(feed(40, events: [event(40)])).isEmpty)
    }
    func testCategoriesMutedDestinationsAndInvalidIdentifiers() {
        var settings = CompanionNotificationSettings(); settings.enabled = true
        XCTAssertTrue(settings.allows(event()))
        settings.replies = false; XCTAssertFalse(settings.allows(event()))
        settings.replies = true; settings.muted = ["team:team_1"]
        XCTAssertFalse(settings.allows(event(type: "team", destination: "team_1", kind: "team_message")))
        XCTAssertTrue(settings.allows(event(type: "chat", destination: "team_1")))
        XCTAssertFalse(settings.allows(event(destination: "../other")))
        settings.work = false; XCTAssertFalse(settings.allows(event(kind: "failed")))
        settings.approvals = false; XCTAssertFalse(settings.allows(event(kind: "approval")))
    }
    func testFeedUsesTypedQueryAndNeverSendsPairingTokenToAnotherOrigin() async throws {
        let transport = NotificationTransport(); defer { transport.close() }
        transport.respond = { request in
            XCTAssertEqual(request.url?.host, transport.host)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            XCTAssertEqual(query.first { $0.name == "journalId" }?.value, "journal & one")
            XCTAssertEqual(query.first { $0.name == "after" }?.value, "7")
            return self.json(cursor: 7)
        }
        _ = try await transport.client.notificationFeed(after: 7, journalId: "journal & one")
        XCTAssertEqual(transport.requests.count, 1)
    }
    func testServiceFocusInboxOrderingDedupAndJournalScopedTap() async throws {
        let transport = NotificationTransport(); defer { transport.close() }
        let suite = "strata-notification-test-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!; defer { defaults.removePersistentDomain(forName: suite) }
        var alerts: [String] = []
        let notifications = CompanionNotifications(defaults: defaults, deliver: { alerts.append($0.id) })
        notifications.bind(client: transport.client, connection: transport.connection, pairingGeneration: transport.generation)
        notifications.active = true; notifications.focus(.init(type: "chat", id: "chat_1"))
        var current = json(cursor: 1)
        transport.respond = { _ in current }
        await notifications.refresh()
        current = json(cursor: 3, rows: [event(2, id: "focused"), event(3, id: "team-public", type: "team", destination: "team_1", kind: "team_message")])
        await notifications.refresh()
        XCTAssertEqual(notifications.events.map(\.id), ["team-public", "focused"])
        XCTAssertEqual(alerts, ["team-public"])
        XCTAssertEqual(notifications.unreadCount, 1)
        await notifications.refresh(); XCTAssertEqual(alerts.count, 1)
        notifications.receiveTap(["journalId": "old-mac", "eventId": "team-public", "destination": ["type": "team", "id": "team_1"]])
        XCTAssertNil(notifications.route)
        notifications.receiveTap(["journalId": "journal-one", "eventId": "team-public", "destination": ["type": "team", "id": "team_1"]])
        XCTAssertEqual(notifications.route?.destination, .init(type: "team", id: "team_1"))
        XCTAssertEqual(notifications.route?.pairingGeneration, transport.generation)
        XCTAssertEqual(notifications.unreadCount, 0)
        XCTAssertTrue(notifications.presentation(for: ["journalId": "old-mac", "destination": ["type": "chat", "id": "chat_1"]]).isEmpty)
    }
    func testLateFeedFromForgottenMacCannotPublishInboxSettingsOrRoute() async throws {
        let transport = NotificationTransport(); defer { transport.close() }
        let requested = expectation(description: "held notification feed")
        var pending: NotificationURLProtocol?
        transport.hold = { request in pending = request; requested.fulfill() }
        let service = CompanionNotifications(defaults: UserDefaults(suiteName: UUID().uuidString)!, deliver: { _ in XCTFail("Late alert") })
        service.bind(client: transport.client, connection: transport.connection, pairingGeneration: transport.generation)
        let task = Task { await service.refresh() }
        await fulfillment(of: [requested], timeout: 2)
        service.bind(client: nil, connection: nil, pairingGeneration: UUID())
        pending?.finish(json(cursor: 2, rows: [event()]))
        await task.value
        XCTAssertTrue(service.events.isEmpty); XCTAssertFalse(service.settings.enabled); XCTAssertNil(service.route)
    }
    func testMutedEventIsNotAddedOrDeliveredAndDefaultIsOptIn() async throws {
        let transport = NotificationTransport(); defer { transport.close() }
        var count = 0
        let service = CompanionNotifications(defaults: UserDefaults(suiteName: UUID().uuidString)!, deliver: { _ in count += 1 })
        service.bind(client: transport.client, connection: transport.connection, pairingGeneration: transport.generation)
        XCTAssertFalse(service.settings.enabled)
        transport.respond = { _ in self.json(cursor: 1, muted: ["chat:chat_1"]) }; await service.refresh()
        transport.respond = { _ in self.json(cursor: 2, rows: [self.event()], muted: ["chat:chat_1"]) }; await service.refresh()
        XCTAssertTrue(service.events.isEmpty); XCTAssertEqual(count, 0)
    }
    func testPreferenceResponseFromForgottenMacCannotEnableNotifications() async throws {
        let transport = NotificationTransport(); defer { transport.close() }
        let requested = expectation(description: "held preference save")
        var pending: NotificationURLProtocol?
        transport.hold = { pending = $0; requested.fulfill() }
        let service = CompanionNotifications(defaults: UserDefaults(suiteName: UUID().uuidString)!)
        service.bind(client: transport.client, connection: transport.connection, pairingGeneration: transport.generation)
        var settings = CompanionNotificationSettings(); settings.enabled = true
        let saving = Task { await service.save(settings) }
        await fulfillment(of: [requested], timeout: 2)
        service.bind(client: nil, connection: nil, pairingGeneration: UUID())
        pending?.finish(json(cursor: 0))
        await saving.value
        XCTAssertFalse(service.settings.enabled); XCTAssertFalse(service.saving); XCTAssertNil(service.route)
    }
    func testFeedStartedBeforeMuteCannotRestoreOldSettingsOrDeliver() async throws {
        let transport = NotificationTransport(); defer { transport.close() }
        var alerts = 0
        let service = CompanionNotifications(defaults: UserDefaults(suiteName: UUID().uuidString)!, deliver: { _ in alerts += 1 })
        service.bind(client: transport.client, connection: transport.connection, pairingGeneration: transport.generation)
        transport.respond = { _ in self.json(cursor: 1) }; await service.refresh()
        let requested = expectation(description: "feed started before explicit mute")
        var pending: NotificationURLProtocol?
        transport.hold = { request in
            if request.request.url!.path == "/v1/notifications" { pending = request; requested.fulfill() }
            else { request.finish(self.json(cursor: 1, muted: ["chat:chat_1"])) }
        }
        let refreshing = Task { await service.refresh() }
        await fulfillment(of: [requested], timeout: 2)
        await service.setMuted(.init(type: "chat", id: "chat_1"), muted: true)
        pending?.finish(json(cursor: 2, rows: [event()]))
        await refreshing.value
        XCTAssertTrue(service.isMuted(.init(type: "chat", id: "chat_1")))
        XCTAssertTrue(service.events.isEmpty); XCTAssertEqual(alerts, 0)
    }
    func testRestoredInboxIsDiscardedWhenSamePairedMacReplacesJournal() async throws {
        let transport = NotificationTransport(); defer { transport.close() }
        let suite = "strata-notification-journal-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!; defer { defaults.removePersistentDomain(forName: suite) }
        let first = CompanionNotifications(defaults: defaults, deliver: { _ in })
        first.bind(client: transport.client, connection: transport.connection, pairingGeneration: transport.generation)
        transport.respond = { _ in self.json(cursor: 1) }; await first.refresh()
        transport.respond = { _ in self.json(cursor: 2, rows: [self.event()]) }; await first.refresh()
        first.markAllRead()
        let restored = CompanionNotifications(defaults: defaults, deliver: { _ in XCTFail("Journal reset replayed an alert") })
        restored.bind(client: transport.client, connection: transport.connection, pairingGeneration: transport.generation)
        XCTAssertEqual(restored.events.count, 1); XCTAssertFalse(restored.canOpenInbox)
        var replaced = json(cursor: 0); replaced["journalId"] = "replacement-journal"; replaced["baseline"] = true
        transport.respond = { _ in replaced }; await restored.refresh()
        XCTAssertTrue(restored.events.isEmpty); XCTAssertTrue(restored.readIds.isEmpty)
        XCTAssertEqual(restored.verifiedJournalId, "replacement-journal")
        restored.open(event()); XCTAssertNil(restored.route)
    }
    func testFailedAppleAttemptCanRetryWithBackoffOrNextResumeAndIgnoresOldAttempt() throws {
        var registration = CompanionNotificationRegistration()
        let now = Date(timeIntervalSince1970: 1_000)
        let first = try XCTUnwrap(registration.begin(now: now))
        XCTAssertFalse(registration.fail(UUID(), now: now)); XCTAssertTrue(registration.requested)
        XCTAssertTrue(registration.fail(first, now: now)); XCTAssertFalse(registration.requested)
        XCTAssertNil(registration.begin(now: now.addingTimeInterval(1)))
        registration.resume()
        let second = try XCTUnwrap(registration.begin(now: now.addingTimeInterval(2)))
        XCTAssertNotEqual(first, second); XCTAssertFalse(registration.fail(first, now: now))
        registration.reset()
        XCTAssertFalse(registration.fail(second, now: now)); XCTAssertFalse(registration.requested)
        XCTAssertNotNil(registration.begin(now: now))
    }
    func testDuplicateNativeCallbacksAndAPNsBeforeLocalFeedPresentOnlyOnce() async throws {
        let transport = NotificationTransport(); defer { transport.close() }
        var local = 0
        let service = CompanionNotifications(defaults: UserDefaults(suiteName: UUID().uuidString)!, deliver: { _ in local += 1 })
        service.bind(client: transport.client, connection: transport.connection, pairingGeneration: transport.generation)
        transport.respond = { _ in self.json(cursor: 1) }; await service.refresh()
        let payload: [AnyHashable: Any] = ["journalId": "journal-one", "eventId": "native-one", "destination": ["type": "chat", "id": "chat_1"]]
        XCTAssertTrue(service.presentation(for: payload).contains(.banner))
        XCTAssertTrue(service.presentation(for: payload).isEmpty)
        transport.respond = { _ in self.json(cursor: 2, rows: [self.event(id: "native-one")]) }; await service.refresh()
        XCTAssertEqual(local, 0); XCTAssertEqual(service.events.count, 1)
    }
    func testFirstLocalCallbackIsAllowedButLaterNativeDuplicateAndRestoredCallbackAreQuiet() async throws {
        let transport = NotificationTransport(); defer { transport.close() }
        let suite = "strata-notification-presented-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!; defer { defaults.removePersistentDomain(forName: suite) }
        var local = 0
        let service = CompanionNotifications(defaults: defaults, deliver: { _ in local += 1 })
        service.bind(client: transport.client, connection: transport.connection, pairingGeneration: transport.generation)
        transport.respond = { _ in self.json(cursor: 1) }; await service.refresh()
        transport.respond = { _ in self.json(cursor: 2, rows: [self.event(id: "local-one")]) }; await service.refresh()
        let payload: [AnyHashable: Any] = ["journalId": "journal-one", "eventId": "local-one", "destination": ["type": "chat", "id": "chat_1"]]
        XCTAssertEqual(local, 1); XCTAssertTrue(service.presentation(for: payload).contains(.banner))
        XCTAssertTrue(service.presentation(for: payload).isEmpty)
        let restored = CompanionNotifications(defaults: defaults, deliver: { _ in XCTFail("Restored alert replayed") })
        restored.bind(client: transport.client, connection: transport.connection, pairingGeneration: transport.generation)
        transport.respond = { _ in self.json(cursor: 2) }; await restored.refresh()
        XCTAssertTrue(restored.presentation(for: payload).isEmpty)
    }
    func testRebindAndDisableClearOldGlobalAppleAttemptSoReenableIsNotBlocked() async throws {
        let transport = NotificationTransport(); defer { transport.close() }
        let service = CompanionNotifications(defaults: UserDefaults(suiteName: UUID().uuidString)!)
        let oldOwner = StrataNotificationDelegate.owner, oldAttempt = StrataNotificationDelegate.attempt
        defer { StrataNotificationDelegate.owner = oldOwner; StrataNotificationDelegate.attempt = oldAttempt }
        StrataNotificationDelegate.owner = service
        service.bind(client: transport.client, connection: transport.connection, pairingGeneration: transport.generation)
        let staleId = UUID()
        StrataNotificationDelegate.attempt = .init(id: staleId, pairingGeneration: transport.generation)
        service.bind(client: nil, connection: nil, pairingGeneration: UUID())
        XCTAssertNil(StrataNotificationDelegate.attempt)
        service.registrationFailed(attemptId: staleId, expectedPairingGeneration: transport.generation)
        XCTAssertNil(service.registrationFailure)
        let replacement = UUID()
        service.bind(client: transport.client, connection: transport.connection, pairingGeneration: replacement)
        StrataNotificationDelegate.attempt = .init(id: UUID(), pairingGeneration: replacement)
        var disabled = json(cursor: 0)
        var disabledSettings = disabled["settings"] as! [String: Any]; disabledSettings["enabled"] = false; disabled["settings"] = disabledSettings
        transport.respond = { _ in disabled }
        await service.save(CompanionNotificationSettings())
        XCTAssertNil(StrataNotificationDelegate.attempt); XCTAssertFalse(service.settings.enabled)
        transport.respond = { _ in self.json(cursor: 0) }
        var enabled = CompanionNotificationSettings(); enabled.enabled = true
        await service.save(enabled)
        XCTAssertTrue(service.settings.enabled); XCTAssertNil(StrataNotificationDelegate.attempt)
    }
    func testEnableWritePrimesItsReturnedBaselineBeforeTheFirstNewReply() async throws {
        let transport = NotificationTransport(); defer { transport.close() }
        let service = CompanionNotifications(defaults: UserDefaults(suiteName: UUID().uuidString)!, deliver: { _ in })
        service.bind(client: transport.client, connection: transport.connection, pairingGeneration: transport.generation)
        transport.respond = { request in
            if request.httpMethod == "POST" { var baseline = self.json(cursor: 0); baseline["baseline"] = true; return baseline }
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            if query?.first(where: { $0.name == "after" })?.value == "0" { return self.json(cursor: 1, rows: [self.event(1, id: "first-new-reply")]) }
            var missed = self.json(cursor: 1); missed["baseline"] = true; return missed
        }
        let requested = expectation(description: "old foreground read started before permission")
        var pending: NotificationURLProtocol?
        transport.hold = { request in
            if request.request.httpMethod == "GET" { pending = request; requested.fulfill() }
            else { var baseline = self.json(cursor: 0); baseline["baseline"] = true; request.finish(baseline) }
        }
        let oldRead = Task { await service.refresh() }
        await fulfillment(of: [requested], timeout: 2)
        var enabled = CompanionNotificationSettings(); enabled.enabled = true
        await service.save(enabled)
        pending?.finishError(URLError(.cancelled))
        await oldRead.value
        transport.hold = nil
        await service.refresh()
        XCTAssertEqual(service.events.map(\.id), ["first-new-reply"])
    }
    func testRetainedOrdinaryBuildDoesNotClaimBackgroundPush() {
        #if !STRATA_PUSH
        let service = CompanionNotifications(defaults: UserDefaults(suiteName: UUID().uuidString)!)
        XCTAssertFalse(service.supportsPush)
        XCTAssertTrue(service.deliveryDescription.contains("while Strata is open"))
        #endif
    }
    private func json(cursor: Int, rows: [CompanionNotificationEvent] = [], muted: [String] = []) -> [String: Any] {
        let data = try! JSONEncoder().encode(rows)
        return ["supported": true, "journalId": "journal-one", "cursor": cursor, "nextCursor": cursor, "hasMore": false, "events": try! JSONSerialization.jsonObject(with: data),
                "settings": ["enabled": true, "replies": true, "teams": true, "work": true, "approvals": true, "previews": false, "sound": false, "muted": muted], "push": ["configured": false, "detail": "Not configured"]]
    }
}

private final class NotificationTransport {
    let host = "notifications-" + UUID().uuidString.lowercased() + ".invalid"
    let generation = UUID()
    var respond: ((URLRequest) -> [String: Any])?
    var hold: ((NotificationURLProtocol) -> Void)?
    var requests: [URLRequest] = []
    lazy var connection = PairedConnection(baseURL: URL(string: "https://" + host)!, macName: "Fixture", fingerprint: String(repeating: "a", count: 64), token: "test-token")
    lazy var session: URLSession = { let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [NotificationURLProtocol.self]; return URLSession(configuration: config) }()
    lazy var client = CompanionClient(baseURL: connection.baseURL, fingerprint: connection.fingerprint, token: connection.token, session: session)
    init() { NotificationURLProtocol.install(self) }
    func receive(_ request: NotificationURLProtocol) {
        requests.append(request.request)
        if let hold { hold(request) } else if let respond { request.finish(respond(request.request)) } else { request.finish([:]) }
    }
    func close() { session.invalidateAndCancel(); NotificationURLProtocol.remove(host) }
}
private final class NotificationURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var transports: [String: NotificationTransport] = [:]
    static func install(_ transport: NotificationTransport) { lock.lock(); defer { lock.unlock() }; transports[transport.host] = transport }
    static func remove(_ host: String) { lock.lock(); defer { lock.unlock() }; transports[host] = nil }
    override class func canInit(with request: URLRequest) -> Bool { lock.lock(); defer { lock.unlock() }; return transports[request.url?.host ?? ""] != nil }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.lock.lock(); let transport = Self.transports[request.url!.host!]; Self.lock.unlock(); transport?.receive(self) }
    override func stopLoading() { }
    func finishError(_ error: Error) { client?.urlProtocol(self, didFailWithError: error) }
    func finish(_ body: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: body)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
}
