import XCTest
@testable import StrataMobile

@MainActor
final class ConnectionRoutingTests: XCTestCase {
    func testOldPairingDecodesAndEndpointsAreStrictAndBounded() throws {
        let f = RouteFixture(); defer { f.close() }
        let old = try JSONEncoder().encode(f.connection)
        let decoded = try JSONDecoder().decode(PairedConnection.self, from: old)
        XCTAssertNil(decoded.endpoints); XCTAssertNil(decoded.originalPairingURL); XCTAssertEqual(decoded.token, f.connection.token)
        for raw in ["http://mac.invalid:8787", "https://token@mac.invalid", "https://mac.invalid/v1/status", "https://mac.invalid?x=1", "https://mac.invalid/#x"] {
            XCTAssertThrowsError(try CompanionEndpoint(kind: .tailscale, url: URL(string: raw)!).validated())
        }
        XCTAssertThrowsError(try CompanionConnectionDetails(macName: "Fixture", endpoints: [.init(kind: .lan, url: f.a), .init(kind: .tailscale, url: f.a)]).validatedEndpoints())
        XCTAssertThrowsError(try CompanionConnectionDetails(macName: "Fixture", endpoints: Array(repeating: .init(kind: .lan, url: f.a), count: 9)).validatedEndpoints())
    }

    func testCrowdedDiscoveryKeepsTailnetBeforeOtherLanRoutes() throws {
        let f = RouteFixture(); defer { f.close() }
        let lans = (1...7).map { CompanionEndpoint(kind: .lan, url: URL(string: "https://192.168.1.\($0):8787")!) }
        let tail = CompanionEndpoint(kind: .tailscale, url: f.b)
        let merged = try CompanionEndpoint.merged(lans + [tail], keeping: .init(kind: .lan, url: f.a))
        XCTAssertEqual(merged.count, 8); XCTAssertEqual(merged[0].url, f.a); XCTAssertEqual(merged[1].url, f.b)
        let client = CompanionClient(baseURL: f.a, fingerprint: f.connection.fingerprint, endpoints: lans + [tail])
        XCTAssertEqual(client.baseURL, f.a)
    }

    func testManualAddressChecksBeforeBearerAndPreservesIdentityHistoryAndSharedClient() async throws {
        let f = RouteFixture(); defer { f.close() }; let store = f.store(); let generation = store.pairingGeneration
        await store.selectChat(.init(id: "saved-chat", title: "Saved"))
        let success = await store.updateMacAddress(f.b.absoluteString, kind: .tailscale)
        XCTAssertTrue(success); XCTAssertEqual(f.client.baseURL, f.b)
        XCTAssertEqual(store.connection?.token, f.connection.token); XCTAssertEqual(store.connection?.fingerprint, f.connection.fingerprint)
        XCTAssertEqual(store.pairingGeneration, generation); XCTAssertEqual(store.messages.first?.content, "Retained history"); XCTAssertEqual(store.currentChatId, "saved-chat")
        let probes = f.requests.filter { $0.url?.host == f.b.host }
        XCTAssertEqual(probes.map { $0.value(forHTTPHeaderField: "Authorization") }, [nil, "Bearer fixture-only-token"])
        XCTAssertEqual(probes.map(\.httpMethod), ["GET", "GET"])
        let _: CompanionStatus = try await f.client.perform("/v1/status")
        XCTAssertEqual(f.requests.last?.url?.host, f.b.host, "Existing computer/workspace holders keep the same client object.")
        XCTAssertEqual(f.saves.count, 1); XCTAssertTrue(store.connection?.endpoints?.contains(where: { $0.url == f.a }) == true)
        XCTAssertTrue(f.requests.allSatisfy { $0.httpMethod == "GET" })
        XCTAssertEqual(store.connection?.originalPairingURL, f.a)
        let returned = await store.updateMacAddress(f.a.absoluteString, kind: .lan)
        XCTAssertTrue(returned); XCTAssertEqual(store.connection?.originalPairingURL, f.a)
        XCTAssertEqual(store.messages.first?.content, "Retained history")
    }

    func testFailedSecureSaveKeepsOldRoutePairingAndHistory() async throws {
        let f = RouteFixture(); defer { f.close() }; f.saveFails = true
        let store = f.store(); await store.selectChat(.init(id: "saved-chat", title: "Saved"))
        let success = await store.updateMacAddress(f.b.absoluteString, kind: .tailscale)
        XCTAssertFalse(success); XCTAssertEqual(store.connection, f.connection); XCTAssertEqual(f.client.baseURL, f.a)
        XCTAssertEqual(store.messages.first?.content, "Retained history"); XCTAssertTrue(store.macAddressError?.contains("previous address") == true)
    }

    func testForgetDuringNoBearerPreflightPreventsAuthenticationAndCommit() async throws {
        let f = RouteFixture(); defer { f.close() }; let hold = RouteHold()
        f.handle = { request, proto in if request.url?.host == f.b.host { hold.receive(proto); return true }; return false }
        let store = f.store(); let operation = Task { await store.updateMacAddress(f.b.absoluteString, kind: .tailscale) }
        await fulfillment(of: [hold.started], timeout: 2)
        store.forgetMac(); hold.finish(["error": "pair first"], status: 401)
        let success = await operation.value
        XCTAssertFalse(success); XCTAssertFalse(store.isPaired); XCTAssertTrue(f.saves.isEmpty)
        XCTAssertTrue(f.requests.filter { $0.url?.host == f.b.host }.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == nil })
    }

    func testCancelledAddressCheckCannotSaveLateResult() async throws {
        let f = RouteFixture(); defer { f.close() }; let hold = RouteHold()
        f.handle = { request, proto in if request.url?.host == f.b.host { hold.receive(proto); return true }; return false }
        let store = f.store(); let operation = Task { await store.updateMacAddress(f.b.absoluteString, kind: .tailscale) }
        await fulfillment(of: [hold.started], timeout: 2)
        store.cancelMacAddressUpdate(); hold.finish(["error": "pair first"], status: 401)
        let success = await operation.value
        XCTAssertFalse(success); XCTAssertEqual(store.connection, f.connection); XCTAssertEqual(f.client.baseURL, f.a)
        XCTAssertTrue(f.saves.isEmpty); XCTAssertEqual(f.requests.filter { $0.url?.host == f.b.host }.count, 1)
    }

    func testAuthenticatedStatusFailureDoesNotSaveNewAddress() async {
        let f = RouteFixture(); defer { f.close() }
        f.handle = { request, proto in
            if request.url?.host == f.b.host, request.value(forHTTPHeaderField: "Authorization") != nil { proto.finish(["error": "Pairing revoked"], status: 401); return true }; return false
        }
        let store = f.store(); let success = await store.updateMacAddress(f.b.absoluteString, kind: .tailscale)
        XCTAssertFalse(success); XCTAssertEqual(store.connection, f.connection); XCTAssertTrue(f.saves.isEmpty); XCTAssertEqual(f.client.baseURL, f.a)
    }

    func testGetFallbackRemembersWorkingRouteWithoutUnauthenticatedPolling() async throws {
        let f = RouteFixture(alternatives: true); defer { f.close() }
        f.handle = { request, proto in if request.url?.host == f.a.host { proto.fail(.timedOut); return true }; return false }
        let _: CompanionStatus = try await f.client.perform("/v1/status"); XCTAssertEqual(f.client.baseURL, f.b)
        let _: CompanionStatus = try await f.client.perform("/v1/status")
        XCTAssertEqual(f.requests.map { $0.url?.host }, [f.a.host, f.b.host, f.b.host])
        XCTAssertTrue(f.requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-only-token" }); XCTAssertEqual(f.requests.first?.timeoutInterval, 4)
        do { try await f.client.discard("/v1/model-management/targets/local", method: "GET") } catch { }
        XCTAssertEqual(f.requests.last?.timeoutInterval, 180, "Remote model management retains its existing long read timeout.")
    }

    func testFallbackAndMutationPreserveEscapedPathSegments() async throws {
        let f = RouteFixture(alternatives: true); defer { f.close() }
        f.handle = { request, proto in
            if request.url?.host == f.a.host, request.httpMethod == "GET" { proto.fail(.timedOut); return true }
            proto.finish(RouteFixture.status); return true
        }
        let expectedRead = try XCTUnwrap(URLComponents(url: f.client.request("/v1/models/org%2Fmodel%252Fname").url!, resolvingAgainstBaseURL: false)?.percentEncodedPath)
        let _: CompanionStatus = try await f.client.perform("/v1/models/org%2Fmodel%252Fname")
        XCTAssertEqual(f.requests.count, 2)
        XCTAssertTrue(f.requests.allSatisfy { URLComponents(url: $0.url!, resolvingAgainstBaseURL: false)?.percentEncodedPath == expectedRead })
        let expectedWrite = try XCTUnwrap(URLComponents(url: f.client.request("/v1/models/org%2Fmodel%252Fname/load", method: "POST").url!, resolvingAgainstBaseURL: false)?.percentEncodedPath)
        try await f.client.discard("/v1/models/org%2Fmodel%252Fname/load")
        XCTAssertEqual(URLComponents(url: f.requests.last!.url!, resolvingAgainstBaseURL: false)?.percentEncodedPath, expectedWrite)
        XCTAssertEqual(f.requests.last?.url?.host, f.b.host)
    }

    func testNoPostPutDeleteOrStreamReplayAfterLostResponse() async throws {
        for method in ["POST", "PUT", "DELETE"] {
            let f = RouteFixture(alternatives: true); defer { f.close() }
            f.handle = { _, proto in proto.fail(.networkConnectionLost); return true }
            do { try await f.client.discard("/v1/session", method: method); XCTFail("Lost mutation must fail") } catch { }
            XCTAssertEqual(f.requests.count, 1, method); XCTAssertEqual(f.requests.first?.url?.host, f.a.host)
        }
        let f = RouteFixture(alternatives: true); defer { f.close() }; f.handle = { _, proto in proto.fail(.networkConnectionLost); return true }
        do { try await f.client.stream(message: "Synthetic only", chatId: nil, onFrame: { _ in }); XCTFail("Lost stream must fail") } catch { }
        XCTAssertEqual(f.requests.count, 1); XCTAssertEqual(f.requests.first?.httpMethod, "POST")
    }

    func testPinOrTlsFailureDoesNotSelectAlternateAddress() async throws {
        let f = RouteFixture(alternatives: true); defer { f.close() }; f.handle = { _, proto in proto.fail(.secureConnectionFailed); return true }
        do { let _: CompanionStatus = try await f.client.perform("/v1/status"); XCTFail("TLS must fail") } catch { }
        XCTAssertEqual(f.requests.count, 1); XCTAssertEqual(f.client.baseURL, f.a)
    }

    func testStaleGetCannotReplaceManuallyCommittedRoute() async throws {
        let f = RouteFixture(alternatives: true); defer { f.close() }; let hold = RouteHold()
        f.handle = { request, proto in if request.url?.host == f.a.host, request.url?.path == "/v1/slow" { hold.receive(proto); return true }; return false }
        let store = f.store(); let old = Task { let _: CompanionStatus = try await f.client.perform("/v1/slow") }
        await fulfillment(of: [hold.started], timeout: 2)
        let success = await store.updateMacAddress(f.b.absoluteString, kind: .tailscale); XCTAssertTrue(success)
        hold.finish(RouteFixture.status); try await old.value
        XCTAssertEqual(f.client.baseURL, f.b); XCTAssertEqual(store.connection?.baseURL, f.b)
    }

    func testStaleRefreshErrorCannotMarkVerifiedNewAddressUnavailable() async throws {
        let f = RouteFixture(); defer { f.close() }; let hold = RouteHold()
        f.handle = { request, proto in if request.url?.host == f.a.host, request.url?.path == "/v1/status" { hold.receive(proto); return true }; return false }
        let store = f.store(); let refresh = Task { await store.refresh() }
        await fulfillment(of: [hold.started], timeout: 2)
        let success = await store.updateMacAddress(f.b.absoluteString, kind: .tailscale); XCTAssertTrue(success)
        hold.fail(.timedOut); await refresh.value
        XCTAssertEqual(store.status?.hostConnected, true); XCTAssertEqual(store.connectedAddress, f.b); XCTAssertNil(store.error)
    }

    func testStaleConversationRefreshErrorCannotClearVerifiedAddress() async throws {
        let f = RouteFixture(); defer { f.close() }; let store = f.store()
        let summary = try JSONDecoder().decode(MacConversationSummary.self, from: JSONSerialization.data(withJSONObject: ["id": "saved-conversation", "title": "Saved", "active": false, "updatedAt": 12345]))
        await store.selectConversation(summary)
        let hold = RouteHold(); f.handle = { request, proto in if request.url?.host == f.a.host, request.url?.path == "/v1/conversations/saved-conversation" { hold.receive(proto); return true }; return false }
        let refresh = Task { await store.refreshCurrentConversation() }; await fulfillment(of: [hold.started], timeout: 2)
        let success = await store.updateMacAddress(f.b.absoluteString, kind: .tailscale); XCTAssertTrue(success)
        hold.fail(.timedOut); await refresh.value
        XCTAssertEqual(store.status?.hostConnected, true); XCTAssertEqual(store.connectedAddress, f.b)
        XCTAssertEqual(store.currentConversation?.messages.first?.content, "Retained Mac history")
    }

    func testStaleDiscoveryCannotOverwriteManualSelection() async throws {
        let f = RouteFixture(); defer { f.close() }; let hold = RouteHold()
        f.handle = { request, proto in if request.url?.path == "/v1/connection" { hold.receive(proto); return true }; return false }
        let store = f.store(); let refresh = Task { await store.refresh() }; await fulfillment(of: [hold.started], timeout: 2)
        let success = await store.updateMacAddress(f.b.absoluteString, kind: .tailscale); XCTAssertTrue(success)
        hold.finish(["macName": "Fixture", "endpoints": [["kind": "lan", "url": "https://stale.invalid:8787"]]])
        await refresh.value
        XCTAssertEqual(store.connection?.baseURL, f.b); XCTAssertEqual(f.client.baseURL, f.b); XCTAssertEqual(f.saves.count, 1)
        XCTAssertFalse(store.connection?.endpoints?.contains { $0.url.host == "stale.invalid" } == true)
    }

    func testManualChangeExcludesExistingAndNewSharedClientMutations() async throws {
        let f = RouteFixture(); defer { f.close() }; let hold = RouteHold()
        f.handle = { request, proto in if request.httpMethod == "POST" { hold.receive(proto); return true }; return false }
        let mutation = Task { try await f.client.discard("/v1/bots/computer/control") }; await fulfillment(of: [hold.started], timeout: 2)
        let store = f.store(); let success = await store.updateMacAddress(f.b.absoluteString, kind: .tailscale)
        XCTAssertFalse(success); XCTAssertFalse(f.requests.contains { $0.url?.host == f.b.host })
        hold.finish(["ok": true]); try await mutation.value
        try f.client.beginAddressUpdate(); defer { f.client.endAddressUpdate() }; let count = f.requests.count
        do { try await f.client.discard("/v1/session", method: "DELETE"); XCTFail("No dispatch during address transaction") } catch { }
        XCTAssertEqual(f.requests.count, count)
    }

    func testDiscoveryLearnsOnceAndLegacyOrInvalidHostDoesNotClearPairing() async throws {
        let f = RouteFixture(); defer { f.close() }
        f.handle = { request, proto in if request.url?.path == "/v1/connection" { proto.finish(["macName": "Fixture", "endpoints": [["kind": "tailscale", "url": f.b.absoluteString]]]); return true }; return false }
        let store = f.store(); await store.refresh(); await store.refresh()
        XCTAssertTrue(store.connection?.endpoints?.contains { $0.url == f.b } == true); XCTAssertEqual(f.requests.filter { $0.url?.path == "/v1/connection" }.count, 1); XCTAssertEqual(f.saves.count, 1)
        for invalid in [false, true] {
            let other = RouteFixture(alternatives: true); defer { other.close() }
            if invalid { other.handle = { request, proto in if request.url?.path == "/v1/connection" { proto.finish(["macName": "Fixture", "endpoints": [["kind": "tailscale", "url": "http://unsafe.invalid"]]]); return true }; return false } }
            let legacy = other.store(); let saved = legacy.connection; await legacy.refresh()
            XCTAssertEqual(legacy.connection, saved); XCTAssertEqual(legacy.status?.hostConnected, true); XCTAssertTrue(other.saves.isEmpty)
        }
    }
}

private final class RouteFixture {
    static let status: [String: Any] = ["macName": "Fixture", "hostConnected": true, "engineState": "idle", "activeRequests": 0]
    let a: URL, b: URL; let connection: PairedConnection; let client: CompanionClient; private let session: URLSession
    private let lock = NSLock(); private var recorded: [URLRequest] = []
    var requests: [URLRequest] { lock.withLock { recorded } }
    var handle: ((URLRequest, RouteProtocol) -> Bool)?; var saves: [PairedConnection] = []; var saveFails = false
    init(alternatives: Bool = false) {
        let id = UUID().uuidString.lowercased(); a = URL(string: "https://lan-\(id).invalid:8787")!; b = URL(string: "https://tail-\(id).invalid:8787")!
        connection = PairedConnection(baseURL: a, macName: "Fixture", fingerprint: String(repeating: "a", count: 64), token: "fixture-only-token", endpoints: alternatives ? [.init(kind: .lan, url: a), .init(kind: .tailscale, url: b)] : nil)
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [RouteProtocol.self]; session = URLSession(configuration: configuration)
        client = CompanionClient(baseURL: a, fingerprint: connection.fingerprint, token: connection.token, endpoints: connection.endpoints ?? [], session: session)
        RouteProtocol.register(self, hosts: [a.host!, b.host!])
    }
    @MainActor func store() -> CompanionStore {
        CompanionStore(connection: connection, client: client, saveConnection: { [self] value in if saveFails { throw CompanionError.keychain(-1) }; saves.append(value) }, deleteConnection: {})
    }
    func receive(_ proto: RouteProtocol) {
        lock.withLock { recorded.append(proto.request) }; if handle?(proto.request, proto) == true { return }
        switch proto.request.url!.path {
        case "/v1/status": if proto.request.value(forHTTPHeaderField: "Authorization") == nil { proto.finish(["error": "Pair first"], status: 401) } else { proto.finish(Self.status) }
        case "/v1/models": proto.finish(["models": []])
        case "/v1/chats": proto.finish(["chats": []])
        case "/v1/conversations": proto.finish(["conversations": []])
        case "/v1/conversations/saved-conversation": proto.finish(["conversation": ["id": "saved-conversation", "title": "Saved", "active": false, "mode": "manual", "workspace": "/fixture", "messages": [["id": "saved-message", "role": "assistant", "content": "Retained Mac history"]]], "pending": []])
        case "/v1/chats/saved-chat": proto.finish(["messages": [["id": "old", "role": "assistant", "content": "Retained history"]]])
        default: proto.finish(["error": "Unavailable on old host"], status: 404)
        }
    }
    func close() { RouteProtocol.unregister([a.host!, b.host!]); session.invalidateAndCancel() }
}
private final class RouteHold {
    let started = XCTestExpectation(description: "Held request reached fixture"); private let lock = NSLock(); private var proto: RouteProtocol?
    func receive(_ proto: RouteProtocol) { lock.withLock { self.proto = proto }; started.fulfill() }
    func fail(_ code: URLError.Code) { let request = lock.withLock { () -> RouteProtocol? in defer { proto = nil }; return proto }; request?.fail(code) }
    func finish(_ json: [String: Any], status: Int = 200) { let request = lock.withLock { () -> RouteProtocol? in defer { proto = nil }; return proto }; request?.finish(json, status: status) }
}
private final class RouteProtocol: URLProtocol {
    private static let lock = NSLock(); private static var fixtures: [String: RouteFixture] = [:]
    static func register(_ fixture: RouteFixture, hosts: [String]) { lock.withLock { for host in hosts { fixtures[host] = fixture } } }
    static func unregister(_ hosts: [String]) { lock.withLock { for host in hosts { fixtures.removeValue(forKey: host) } } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.lock.withLock { Self.fixtures[request.url!.host!] }?.receive(self) }
    override func stopLoading() { }
    func finish(_ json: [String: Any], status: Int = 200) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["content-type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: json)); client?.urlProtocolDidFinishLoading(self)
    }
    func fail(_ code: URLError.Code) { client?.urlProtocol(self, didFailWithError: URLError(code)) }
}

@MainActor
final class ConnectionRoutingTLSTests: XCTestCase {
    /// Runs only against the disposable loopback TLS servers started by the
    /// explicit route fixture. It never reads a real saved pairing or Keychain.
    func testRealPinnedPreflightDifferentCertificateAndRedirectRefusal() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let raw = environment["STRATA_ROUTING_TLS"] ?? environment["TEST_RUNNER_STRATA_ROUTING_TLS"], let data = raw.data(using: .utf8),
              let config = try JSONSerialization.jsonObject(with: data) as? [String: String], let invitationText = config["invitation"] else {
            throw XCTSkip("Requires isolated loopback route TLS fixture")
        }
        let invitation = try PairingInvitation.parse(invitationText)
        let primary = try PairingInvitation.validatedURL(invitation.url)
        let alias = try XCTUnwrap(config["alias"].flatMap(URL.init(string:)))
        let wrong = try XCTUnwrap(config["wrong"].flatMap(URL.init(string:)))
        let redirect = try XCTUnwrap(config["redirect"].flatMap(URL.init(string:)))
        let control = try XCTUnwrap(config["control"].flatMap(URL.init(string:)))
        for url in [primary, alias, wrong, redirect, control] { XCTAssertEqual(url.host, "127.0.0.1"); XCTAssertNotNil(url.port) }
        struct Pair: Decodable { var token: String; var macName: String }
        let pairing = CompanionClient(baseURL: primary, fingerprint: invitation.fingerprint)
        let result: Pair = try await pairing.perform("/v1/pair", method: "POST", body: ["code": invitation.code, "deviceName": "Isolated routing unit fixture"])
        let client = CompanionClient(baseURL: primary, fingerprint: invitation.fingerprint, token: result.token)
        let checked = try await client.preflightAddress(alias)
        let status = try await client.status(at: checked); XCTAssertTrue(status.hostConnected)
        do { _ = try await client.preflightAddress(wrong); XCTFail("Different certificate must fail before HTTP") } catch { XCTAssertTrue(error is URLError) }
        let incorrect = CompanionClient(baseURL: alias, fingerprint: String(repeating: "0", count: 64), token: "must-never-reach-http")
        do { let _: CompanionStatus = try await incorrect.perform("/v1/status"); XCTFail("Wrong pin must fail") } catch { XCTAssertTrue(error is URLError) }
        do { _ = try await client.preflightAddress(redirect); XCTFail("Redirect preflight must fail") } catch { }
        let redirectClient = CompanionClient(baseURL: redirect, fingerprint: invitation.fingerprint, token: result.token)
        do { let _: CompanionStatus = try await redirectClient.perform("/v1/status"); XCTFail("Authenticated redirect must not follow") }
        catch let error as CompanionHTTPError { XCTAssertEqual(error.statusCode, 302) }
        let (stateData, _) = try await URLSession.shared.data(from: control.appendingPathComponent("state"))
        let state = try XCTUnwrap(JSONSerialization.jsonObject(with: stateData) as? [String: Any])
        let requests = try XCTUnwrap(state["routeRequests"] as? [[String: Any]])
        XCTAssertEqual(requests.filter { $0["server"] as? String == "wrong" }.count, 0)
        let aliasRequests = requests.filter { $0["server"] as? String == "alias" }
        XCTAssertEqual(aliasRequests.count, 2, "No redirected or wrong-pin request may reach the alias HTTP handler")
        XCTAssertEqual(aliasRequests.map { $0["bearer"] as? Bool }, [false, true])
        XCTAssertEqual(requests.filter { $0["server"] as? String == "redirect" }.count, 2)
    }
}
