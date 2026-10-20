import Foundation
import Testing
@testable import CuaBotsCore

private final class MockHTTP: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (Int, [String: Any]))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw StrataError("Missing fixture") }
            let (status, object) = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: object))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() { }
}
@Suite(.serialized) @MainActor struct HostAdapterTests {
    func body(_ request: URLRequest) throws -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream { stream.open(); defer { stream.close() }; var buffer = [UInt8](repeating: 0, count: 4096); while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count < 0 { throw stream.streamError ?? StrataError("Fixture body read failed") }; if count == 0 { break }; data.append(buffer, count: count) } }
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }
    func engine(_ handler: @escaping (URLRequest) throws -> (Int, [String: Any]), origin: String = "http://127.0.0.1:49991") -> StrataEngine {
        MockHTTP.handler = handler; let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [MockHTTP.self]
        return StrataEngine(origin: URL(string: origin)!, session: URLSession(configuration: config))
    }
    let bot: [String: Any] = ["id": "bot-server-uuid", "name": "Ada", "provider": "kimi", "computerMode": "cua", "execution": ["kind": "ssh", "host": "configured-alias", "user": "any-user"], "avatarConfig": ["color": "violet", "eyes": "plus", "ears": "round"], "createdAt": "2026-10-20T12:00:00.000Z"]
    func conversation(_ id: String = "chat-server-uuid") -> [String: Any] { ["id": id, "title": "Shared work", "updatedAt": "2026-10-20T12:01:00.000Z", "preferences": ["botId": "bot-server-uuid"], "active": true] }
    @Test func originAndHostErrorsFailClosed() async throws {
        var calls = 0
        let remote = engine({ _ in calls += 1; return (200, [:]) }, origin: "https://remote.example")
        await #expect(throws: StrataError.self) { _ = try await remote.request("/api/bots") }
        #expect(calls == 0)
        let local = engine { request in #expect(request.value(forHTTPHeaderField: "Origin") == "http://127.0.0.1:49991"); return (409, ["error": "Wait for this bot to stop."]) }
        do { _ = try await local.request("/api/bots"); Issue.record("Expected host rejection") } catch { #expect(error.localizedDescription == "Wait for this bot to stop.") }
        await #expect(throws: StrataError.self) { _ = try await local.request("https://elsewhere.example/api/bots") }
    }
    @Test func sharedHistoryThinkingToolsAndApprovalsRetainServerIdentity() async throws {
        var requests: [String] = []
        let client = engine { request in
            requests.append(request.httpMethod! + " " + request.url!.path)
            switch request.url!.path {
            case "/api/bots": return (200, ["bots": [bot], "models": [["id": "maya", "connectionId": "maya-only", "connectionName": "Maya", "name": "Maya-S24", "model": "maya", "available": true], ["id": "strata", "connectionId": "strata-only", "connectionName": "Strata", "name": "Coder", "model": "coder", "available": true]]])
            case "/api/companion/conversations": return (200, ["conversations": [conversation()]])
            case "/api/companion/conversations/chat-server-uuid":
                var chat = conversation(); chat["messages"] = [["id": "u1", "role": "user", "content": "Continue on iPhone", "at": "2026-10-20T12:00:00.000Z"], ["id": "a1", "role": "assistant", "content": "I can continue here.", "reasoning": "User-visible provider thinking", "at": "2026-10-20T12:01:00.000Z", "tools": [["id": "t1", "name": "browser_open", "state": "done", "result": "Opened the sandbox browser"]]]]
                return (200, ["conversation": chat, "pending": [["id": "pending-1", "name": "run_command", "preview": "Allow tests?"]]])
            case "/api/companion/conversations/chat-server-uuid/approval": return (200, [:])
            default: throw StrataError("Unexpected fixture path")
            }
        }
        let store = BotStore(engine: client); try await store.refresh(); try await store.refreshConversation("bot-server-uuid")
        #expect(store.bots.first?.id == "bot-server-uuid"); #expect(store.bots.first?.harness == .kimi); #expect(store.bots.first?.avatar.eyes == .plus)
        #expect(store.models.map(\.connectionID) == ["maya-only", "strata-only"])
        #expect(store.selectedChats["bot-server-uuid"] == "chat-server-uuid")
        let first = store.messages(for: "bot-server-uuid")
        #expect(first.contains { $0.id == "a1:thinking" && $0.text == "User-visible provider thinking" && $0.kind == .thinking })
        #expect(first.contains { $0.id == "a1:tool:t1" && $0.kind == .activity })
        try await store.refreshConversation("bot-server-uuid"); #expect(store.messages(for: "bot-server-uuid") == first)
        await store.decide("pending-1", approve: true); #expect(requests.contains("POST /api/companion/conversations/chat-server-uuid/approval"))
        #expect(!requests.contains { $0.contains("/messages") || $0.contains("/computer/start") })
    }
    @Test func profileCreationDoesNotGenerateIntroOrStartComputer() async throws {
        var paths: [String] = []
        let client = engine { request in
            paths.append(request.httpMethod! + " " + request.url!.path)
            if request.url!.path == "/api/bots" && request.httpMethod == "POST" { return (201, ["bot": bot]) }
            if request.url!.path == "/api/bots" { return (200, ["bots": [bot]]) }
            return (200, ["conversations": []])
        }
        let store = BotStore(engine: client); let id = try await store.create(["name": "Ada"])
        #expect(id == "bot-server-uuid"); #expect(paths == ["POST /api/bots", "GET /api/bots", "GET /api/companion/conversations"])
    }
    @Test func actualAvatarConfigRoundTripsAndProvidersCoverAllConnections() throws {
        #expect(Harness.allCases.map(\.rawValue) == ["claude", "codex", "grok", "kimi", "ollama", "configured"])
        for color in BotColor.allCases { for eyes in EyeStyle.allCases { for ears in EarShape.allCases {
            let config = AvatarConfig(color: color, eyes: eyes, ears: ears)
            #expect(try JSONDecoder().decode(AvatarConfig.self, from: JSONEncoder().encode(config)) == config)
        } } }
    }
    @Test func pauseResumePersistWithoutStartingAnyConversation() async throws {
        var paused = false, bodies: [[String: Any]] = [], paths: [String] = []
        let client = engine { request in
            paths.append(request.url!.path)
            if request.url!.path.hasSuffix("/pause") { let value = try body(request); bodies.append(value); paused = value["paused"] as? Bool ?? false; return (200, [:]) }
            if request.url!.path == "/api/bots" { var row = bot; row["paused"] = paused; return (200, ["bots": [row]]) }
            return (200, ["conversations": []])
        }
        let store = BotStore(engine: client); try await store.refresh(); await store.pause("bot-server-uuid")
        #expect(store.bots.first?.isPaused == true); await store.resume("bot-server-uuid"); #expect(store.bots.first?.isPaused == false)
        #expect(bodies.map { $0["paused"] as? Bool } == [true, false]); #expect(!paths.contains { $0.hasSuffix("/messages") || $0.contains("/computer/start") })
    }
    @Test func newConversationSendsOpaqueSelectionsAndDoesNotSendPrompt() async throws {
        var bodies: [[String: Any]] = [], paths: [String] = []
        let client = engine { request in
            paths.append(request.url!.path)
            if request.url!.path == "/api/bots/bot-server-uuid/conversations" { bodies.append(try body(request)); return (201, ["conversation": conversation()]) }
            if request.url!.path == "/api/bots" { return (200, ["bots": [bot]]) }
            if request.url!.path == "/api/companion/conversations" { return (200, ["conversations": [conversation()]]) }
            return (200, ["conversation": conversation(), "pending": []])
        }
        let store = BotStore(engine: client)
        _ = try await store.newConversation("bot-server-uuid", selection: ["computerId": "ssh-opaque", "modelId": "maya-opaque", "workspace": "/workspace"])
        #expect(bodies.first?["computerId"] as? String == "ssh-opaque"); #expect(bodies.first?["modelId"] as? String == "maya-opaque")
        #expect(bodies.first?["apiKey"] == nil); #expect(!paths.contains { $0.hasSuffix("/messages") })
    }
    @Test func weeklySchedulesTranslateCalendarSundayOneToHostSundayZero() {
        let sunday = BotStore.scheduleObject(.weekly(weekday: 1, hour: 9, minute: 15))
        let saturday = BotStore.scheduleObject(.weekly(weekday: 7, hour: 9, minute: 15))
        #expect(sunday["weekday"] as? Int == 0); #expect(saturday["weekday"] as? Int == 6)
        #expect(BotStore.schedule(["kind": "weekly", "weekday": 0, "hour": 9, "minute": 15]) == .weekly(weekday: 1, hour: 9, minute: 15))
    }
    @Test func slowOldConversationCannotOverwriteNewSelectionOrApprovals() async throws {
        var oldResponse: CheckedContinuation<[String: Any], Error>?
        let response: (String) -> [String: Any] = { id in ["conversation": ["id": id, "preferences": ["botId": "bot-server-uuid"], "updatedAt": "2026-10-20T12:00:00Z", "messages": [["id": id + "-message", "role": "assistant", "content": id, "at": "2026-10-20T12:00:00Z"]]], "pending": id == "A" ? [["id": "approval-A", "name": "old action"]] : []] }
        let client = StrataEngine(origin: URL(string: "http://127.0.0.1:49991"), transport: { path, _, _ in
            if path.hasSuffix("/A") { return try await withCheckedThrowingContinuation { oldResponse = $0 } }
            return response("B")
        })
        let store = BotStore(engine: client); store.selectedChats["bot-server-uuid"] = "A"
        let old = Task { try await store.refreshConversation("bot-server-uuid") }
        while oldResponse == nil { await Task.yield() }
        store.chooseChat("bot-server-uuid", "B"); try await store.refreshConversation("bot-server-uuid")
        oldResponse?.resume(returning: response("A")); try await old.value
        #expect(store.selectedChats["bot-server-uuid"] == "B")
        #expect(store.messages(for: "bot-server-uuid").map(\.text) == ["B"])
        #expect(store.pendingApprovals().isEmpty)
    }
    @Test func delayedNewChatCannotStealAChosenExistingConversation() async throws {
        var creation: CheckedContinuation<[String: Any], Error>?
        let client = StrataEngine(origin: URL(string: "http://127.0.0.1:49991"), transport: { path, method, _ in
            if path.hasSuffix("/bot-server-uuid/conversations"), method == "POST" { return try await withCheckedThrowingContinuation { creation = $0 } }
            if path == "/api/bots" { return ["bots": [bot]] }
            if path == "/api/companion/conversations" { return ["conversations": [conversation("B"), conversation("NEW")]] }
            return ["conversation": conversation("B"), "pending": []]
        })
        let store = BotStore(engine: client); store.selectedChats["bot-server-uuid"] = "A"
        let creating = Task { try await store.newConversation("bot-server-uuid") }
        while creation == nil { await Task.yield() }
        store.chooseChat("bot-server-uuid", "B")
        creation?.resume(returning: ["conversation": conversation("NEW")]); _ = try await creating.value
        #expect(store.selectedChats["bot-server-uuid"] == "B")
    }
    @Test func closingViewerReleasesLateTakeoverGrant() async throws {
        var grant: CheckedContinuation<[String: Any], Error>?
        var released: [String] = []
        let client = StrataEngine(origin: URL(string: "http://127.0.0.1:49991"), transport: { path, _, body in
            if path.hasSuffix("/takeover") { return try await withCheckedThrowingContinuation { grant = $0 } }
            if path.hasSuffix("/release") { released.append(body?["leaseToken"] as? String ?? "missing"); return ["released": true] }
            return ["running": true, "control": ["owned": false]]
        })
        var bot = Bot(name: "Ada"); bot.id = "bot-server-uuid"
        let session = ComputerSession(engine: client, bot: bot, chatID: "chat-server-uuid")
        session.observe(); let takeover = Task { await session.action("takeover") }
        while grant == nil { await Task.yield() }
        session.unobserve()
        grant?.resume(returning: ["running": true, "leaseToken": "late-grant", "control": ["owned": true]])
        await takeover.value
        #expect(released.contains("late-grant")); #expect(session.owned == false)
    }
    @Test func staleCatalogCannotRemoveNewerSelectionFromPicker() async throws {
        var delayed: CheckedContinuation<[String: Any], Error>?
        var delay = false
        let row: (String) -> [String: Any] = { id in ["id": id, "title": id, "active": false, "updatedAt": "2026-10-20T12:00:00Z", "preferences": ["botId": "bot-server-uuid"]] }
        let client = StrataEngine(origin: URL(string: "http://127.0.0.1:49991"), transport: { path, _, _ in
            if path == "/api/bots" { return ["bots": [bot]] }
            if path == "/api/companion/conversations" { if delay { return try await withCheckedThrowingContinuation { delayed = $0 } }; return ["conversations": [row("A"), row("B")]] }
            return ["conversation": row(path.hasSuffix("/B") ? "B" : "A"), "pending": []]
        })
        let store = BotStore(engine: client); try await store.refresh(); delay = true
        let refresh = Task { try await store.refresh() }; while delayed == nil { await Task.yield() }
        store.chooseChat("bot-server-uuid", "B")
        delayed?.resume(returning: ["conversations": [row("A")]]); try await refresh.value
        #expect(store.selectedChats["bot-server-uuid"] == "B")
        #expect(store.conversations["bot-server-uuid"]?.contains(where: { $0.id == "B" }) == true)
    }
    @Test func staleComputerPollCannotEraseCompletedTakeoverToken() async throws {
        var poll: CheckedContinuation<[String: Any], Error>?
        var delivered = false, inputToken: String?
        let client = StrataEngine(origin: URL(string: "http://127.0.0.1:49991"), transport: { path, method, body in
            if method == "GET" { let result = try await withCheckedThrowingContinuation { poll = $0 }; delivered = true; return result }
            if path.hasSuffix("/takeover") { return ["running": true, "leaseToken": "current-grant", "control": ["owned": true]] }
            if path.hasSuffix("/control") { inputToken = body?["leaseToken"] as? String; return ["running": true, "control": ["owned": true]] }
            return ["released": true]
        })
        var bot = Bot(name: "Ada"); bot.id = "bot-server-uuid"
        let session = ComputerSession(engine: client, bot: bot, chatID: "chat-server-uuid")
        session.observe(); while poll == nil { await Task.yield() }
        await session.action("takeover"); #expect(session.owned == true)
        poll?.resume(returning: ["running": true, "control": ["owned": false]])
        while !delivered { await Task.yield() }; for _ in 0..<10 { await Task.yield() }
        #expect(session.owned == true)
        await session.input("key", values: ["key": "Enter"]); #expect(inputToken == "current-grant")
        session.unobserve()
    }
    @Test func selectedConversationUsesFrozenComputerModelAndWorkspaceAcrossProfileEdits() async throws {
        var current = bot
        current["computerMode"] = "host"; current["provider"] = "ollama"; current["model"] = "current-profile-model"
        current["workspace"] = "/current-profile-folder"; current["execution"] = ["kind": "local"]
        let row: (String) -> [String: Any] = { id in
            ["id": id, "title": id, "active": false, "updatedAt": "2026-10-20T12:00:00Z", "workspace": id == "CUA" ? "/workspace" : "/frozen-host-folder", "preferences": ["botId": "bot-server-uuid", "botComputerMode": id == "CUA" ? "cua" : "host", "botComputer": id == "CUA" ? "Original computer label" : "Overridden computer label", "botModel": id == "CUA" ? "Maya · Maya-S24" : "Strata separate · Coder"]]
        }
        var requests: [String] = []
        let client = StrataEngine(origin: URL(string: "http://127.0.0.1:49991"), transport: { path, method, _ in
            requests.append(method + " " + path)
            if path == "/api/bots" { return ["bots": [current]] }
            if path == "/api/companion/conversations" { return ["conversations": [row("CUA"), row("HOST")]] }
            return ["conversation": row(path.hasSuffix("/CUA") ? "CUA" : "HOST"), "pending": []]
        })
        let store = BotStore(engine: client); try await store.refresh()
        #expect(store.bot("bot-server-uuid")?.spaceID == nil)
        #expect(store.bot("bot-server-uuid")?.harness == .ollama)
        #expect(store.viewBot("bot-server-uuid")?.spaceID == "bot-server-uuid")
        #expect(store.viewContext(for: "bot-server-uuid").computerName == "Original computer label")
        #expect(store.viewContext(for: "bot-server-uuid").modelName == "Maya · Maya-S24")
        #expect(store.viewContext(for: "bot-server-uuid").workspace == "/workspace")
        current["computerMode"] = "cua"; current["provider"] = "codex"
        store.selectedChats["bot-server-uuid"] = "HOST"; try await store.refresh(); try await store.refreshConversation("bot-server-uuid")
        #expect(store.bot("bot-server-uuid")?.spaceID == "bot-server-uuid")
        #expect(store.bot("bot-server-uuid")?.harness == .codex)
        #expect(store.viewBot("bot-server-uuid")?.spaceID == nil)
        #expect(store.viewContext(for: "bot-server-uuid").computerName == "Overridden computer label")
        #expect(store.viewContext(for: "bot-server-uuid").modelName == "Strata separate · Coder")
        #expect(store.viewContext(for: "bot-server-uuid").workspace == "/frozen-host-folder")
        #expect(store.profile("bot-server-uuid")["workspace"] as? String == "/current-profile-folder")
        store.selectedChats["bot-server-uuid"] = "not-yet-loaded"
        #expect(store.viewContext(for: "bot-server-uuid").computerMode == nil)
        #expect(store.viewBot("bot-server-uuid")?.spaceID == nil)
        #expect(store.viewContext(for: "bot-server-uuid").modelName == "Conversation model")
        store.selectedChats.removeValue(forKey: "bot-server-uuid")
        #expect(store.viewContext(for: "bot-server-uuid").chatID == nil)
        #expect(store.viewBot("bot-server-uuid")?.spaceID == "bot-server-uuid")
        #expect(store.viewContext(for: "bot-server-uuid").modelName == "Codex · current-profile-model")
        #expect(requests.allSatisfy { $0.hasPrefix("GET ") })
    }
}
