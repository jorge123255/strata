import XCTest
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
        let sending = Task { await store.sendMessage("Synthetic fixture") }
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
}

/// Delayed responses exercise the real HTTP decoding path without a live bridge,
/// simulator changes, or access to the app's saved Keychain entry.
private final class StoreTransport {
    static let status: [String: Any] = ["macName": "Fixture Mac", "hostConnected": true, "engineState": "idle", "activeRequests": 0]
    let host = "fixture-\(UUID().uuidString.lowercased()).invalid"
    private let lock = NSLock()
    private var held: [String: HeldStoreResponse] = [:]
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

    func receive(_ request: StoreURLProtocol) {
        let path = request.request.url!.path
        lock.lock(); let response = held[path]; lock.unlock()
        if let response { response.receive(request); return }
        switch path {
        case "/v1/status": request.finishJSON(Self.status)
        case "/v1/models": request.finishJSON(["models": []])
        case "/v1/chats": request.finishJSON(["chats": []])
        default: request.finishJSON(["error": "Unexpected fixture request"], status: 404)
        }
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
    func finish(_ json: [String: Any]) {
        lock.lock(); let request = self.request; self.request = nil; lock.unlock()
        request?.finishJSON(json)
    }
    func finishSSE(_ value: String) {
        lock.lock(); let request = self.request; self.request = nil; lock.unlock()
        request?.finish(Data(value.utf8), contentType: "text/event-stream")
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
