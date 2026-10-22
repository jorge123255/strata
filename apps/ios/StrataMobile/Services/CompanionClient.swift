import Foundation
import Security
import CryptoKit

final class PinnedSessionDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
    let fingerprint: String
    init(fingerprint: String) { self.fingerprint = fingerprint }

    static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let certificates = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let certificate = certificates.first,
              Self.digest(SecCertificateCopyData(certificate) as Data) == fingerprint else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        // The exact certificate was supplied out of band by the Mac's QR code.
        // Only this leaf is trusted; arbitrary self-signed certificates are refused.
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // A redirect must never move a pairing code or bearer token to another server.
        completionHandler(nil)
    }
}

struct VerifiedCompanionEndpoint {
    fileprivate let url: URL
    fileprivate let clientID: UUID
}

final class CompanionClient: @unchecked Sendable {
    private let routeLock = NSLock()
    private var activeURL: URL
    private var routes: [URL]
    private var routeEpoch = 0
    private var mutations = 0
    private var addressUpdate = false
    private let clientID = UUID()
    var baseURL: URL { routeLock.withLock { activeURL } }
    let token: String?
    private let session: URLSession

    init(baseURL: URL, fingerprint: String, token: String? = nil, endpoints: [CompanionEndpoint] = [], session: URLSession? = nil) {
        let primary = (try? CompanionEndpoint(kind: .lan, url: baseURL).validated().url) ?? baseURL
        self.activeURL = primary; self.routes = [primary]; self.token = token
        if let checked = try? CompanionEndpoint.merged(endpoints, keeping: .init(kind: .lan, url: primary)) { self.routes = checked.map(\.url) }
        if let session { self.session = session; return }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 600
        config.httpCookieStorage = nil
        config.urlCache = nil
        self.session = URLSession(configuration: config, delegate: PinnedSessionDelegate(fingerprint: fingerprint), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    func updateEndpoints(_ endpoints: [CompanionEndpoint], preferred: URL? = nil) {
        routeLock.withLock {
            let selected = (preferred.flatMap { try? CompanionEndpoint(kind: .lan, url: $0).validated().url }) ?? activeURL
            guard let next = try? CompanionEndpoint.merged(endpoints, keeping: .init(kind: .lan, url: selected)) else { return }
            routes = next.map(\.url); activeURL = selected; routeEpoch += 1
        }
    }

    /// This request contains no pairing code or bearer. The ordinary pinned
    /// session must accept the original certificate, and redirects remain off.
    func preflightAddress(_ address: URL) async throws -> VerifiedCompanionEndpoint {
        let checked = try PairingInvitation.validatedURL(address.absoluteString)
        var request = URLRequest(url: checked.appendingPathComponent("v1/status"))
        request.httpMethod = "GET"; request.timeoutInterval = 4
        let (_, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse, http.statusCode == 401 else {
            throw CompanionError.server("This address did not answer as your paired Strata Mac. The saved pairing was kept.")
        }
        return VerifiedCompanionEndpoint(url: checked, clientID: clientID)
    }

    func status(at endpoint: VerifiedCompanionEndpoint) async throws -> CompanionStatus {
        guard endpoint.clientID == clientID else { throw CompanionError.server("Check this address again with the current pairing.") }
        var req = try rebound(request("/v1/status"), to: endpoint.url)
        req.timeoutInterval = 4
        let (data, response) = try await session.data(for: req)
        try Task.checkCancellation(); try Self.check(response, data: data)
        return try JSONDecoder().decode(CompanionStatus.self, from: data)
    }

    private func rebound(_ request: URLRequest, to origin: URL) throws -> URLRequest {
        _ = try PairingInvitation.validatedURL(origin.absoluteString)
        guard let original = request.url, var destination = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              let path = URLComponents(url: original, resolvingAgainstBaseURL: false) else { throw CompanionError.server("Invalid companion address.") }
        destination.percentEncodedPath = path.percentEncodedPath; destination.percentEncodedQuery = path.percentEncodedQuery
        guard let url = destination.url else { throw CompanionError.server("Invalid companion request.") }
        var result = request; result.url = url; return result
    }

    /// Serializes manual address changes against all clients sharing this
    /// transport, including computer/workspace mutations outside the dashboard.
    func beginAddressUpdate() throws {
        try routeLock.withLock {
            guard !addressUpdate, mutations == 0 else { throw CompanionError.server("Wait for the current request before changing the Mac address.") }
            addressUpdate = true
        }
    }
    func endAddressUpdate() { routeLock.withLock { addressUpdate = false } }

    private func beginMutation() throws {
        try routeLock.withLock {
            guard !addressUpdate else { throw CompanionError.server("Wait for the Mac address check to finish before sending this request.") }
            mutations += 1
        }
    }
    private func endMutation() { routeLock.withLock { mutations -= 1 } }

    private static func isTransportFailure(_ error: Error) -> Bool {
        guard let error = error as? URLError else { return false }
        return [.cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .networkConnectionLost, .timedOut, .notConnectedToInternet].contains(error.code)
    }

    private func data(for original: URLRequest) async throws -> (Data, URLResponse) {
        let readOnly = original.httpMethod == "GET"
        if !readOnly { try beginMutation() }
        defer { if !readOnly { endMutation() } }
        try Task.checkCancellation()
        let snapshot = routeLock.withLock { (routeEpoch, activeURL, routes) }
        var candidates = [snapshot.1] + snapshot.2.filter { $0 != snapshot.1 }
        if !readOnly { candidates = [snapshot.1] }
        var lastError: Error = URLError(.cannotConnectToHost)
        for origin in candidates {
            try Task.checkCancellation()
            var request = try rebound(original, to: origin)
            // Ordinary GETs may quickly fail over. Model operations and writes
            // keep their existing long timeouts and are dispatched only once.
            if readOnly, candidates.count > 1, original.timeoutInterval <= 20 { request.timeoutInterval = min(request.timeoutInterval, 4) }
            do {
                let result = try await session.data(for: request)
                try Task.checkCancellation()
                if let http = result.1 as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                    routeLock.withLock {
                        if routeEpoch == snapshot.0, activeURL == snapshot.1 || activeURL == origin { activeURL = origin }
                    }
                }
                return result
            } catch {
                lastError = error
                // A TLS/pin failure or an HTTP error never selects another trust
                // identity. A lost write response never causes a second send.
                guard readOnly, !Task.isCancelled, Self.isTransportFailure(error) else { throw error }
            }
        }
        throw lastError
    }

    func request(_ path: String, method: String = "GET", body: [String: String]? = nil) throws -> URLRequest {
        guard path.hasPrefix("/v1/"), !path.contains(".."), !path.contains("?") else {
            throw CompanionError.server("Invalid companion request.")
        }
        let address = baseURL
        _ = try PairingInvitation.validatedURL(address.absoluteString)
        var req = URLRequest(url: address.appendingPathComponent(String(path.dropFirst())))
        req.httpMethod = method
        req.timeoutInterval = path.hasPrefix("/v1/model-management/") ? 180 : path.hasSuffix("/computer/start") ? 100 : path.hasPrefix("/v1/bots/connections/") && path.hasSuffix("/check") ? 35 : 20
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { req.httpBody = try JSONEncoder().encode(body) }
        return req
    }

    /// Only this typed endpoint may add a query; arbitrary paths and redirects
    /// remain forbidden by the ordinary pinned companion transport.
    func notificationFeed(after: Int?, journalId: String?) async throws -> CompanionNotificationFeed {
        var request = try request("/v1/notifications")
        if let after, let journalId, after >= 0, !journalId.isEmpty {
            var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "after", value: String(after)), URLQueryItem(name: "journalId", value: journalId)]
            request.url = components.url
        }
        let (data, response) = try await self.data(for: request)
        try Self.check(response, data: data)
        return try JSONDecoder().decode(CompanionNotificationFeed.self, from: data)
    }

    func perform<T: Decodable>(_ path: String, method: String = "GET", body: [String: String]? = nil) async throws -> T {
        let (data, response) = try await self.data(for: request(path, method: method, body: body))
        try Self.check(response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func request<Body: Encodable>(_ path: String, method: String, jsonBody: Body) throws -> URLRequest {
        var req = try request(path, method: method)
        req.httpBody = try JSONEncoder().encode(jsonBody)
        return req
    }

    func perform<T: Decodable, Body: Encodable>(_ path: String, method: String, jsonBody: Body) async throws -> T {
        let (data, response) = try await self.data(for: request(path, method: method, jsonBody: jsonBody))
        try Self.check(response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func discard(_ path: String, method: String = "POST", body: [String: String]? = nil) async throws {
        let (data, response) = try await self.data(for: request(path, method: method, body: body))
        try Self.check(response, data: data)
    }

    // Only the saved conversation ID can become a query item. General requests
    // continue to reject arbitrary query strings and URL forwarding.
    func computer(botId: String, chatId: String?) async throws -> BotComputerState {
        let path = try Self.computerPath(botId: botId)
        var req = try request(path)
        if let chatId {
            guard Self.isSafeIdentifier(chatId), var url = URLComponents(url: req.url!, resolvingAgainstBaseURL: false) else { throw CompanionError.server("Choose a saved bot conversation.") }
            url.queryItems = [URLQueryItem(name: "chatId", value: chatId)]
            req.url = url.url
        }
        let (data, response) = try await self.data(for: req)
        try Self.check(response, data: data)
        return try JSONDecoder().decode(BotComputerState.self, from: data)
    }

    static func computerPath(botId: String, action: String? = nil) throws -> String {
        guard isSafeIdentifier(botId), action == nil || ["start", "stop", "takeover", "control", "release"].contains(action!) else { throw CompanionError.server("Choose a saved bot computer.") }
        return "/v1/bots/\(botId)/computer" + (action.map { "/" + $0 } ?? "")
    }

    func botProviderModels(_ provider: String) async throws -> BotProviderModels {
        guard ["claude", "codex", "devin", "grok", "kimi", "ollama", "configured"].contains(provider) else { throw CompanionError.server("Choose a supported provider.") }
        var req = try request("/v1/bots/provider-models")
        var url = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "provider", value: provider)]; req.url = url.url
        let (data, response) = try await self.data(for: req)
        try Self.check(response, data: data)
        return try JSONDecoder().decode(BotProviderModels.self, from: data)
    }

    /// The Team room is the only source of these bounded integer cursors. Keep
    /// arbitrary query strings forbidden by the general request builder.
    func teamChannel(teamId: String, after: Int? = nil, before: Int? = nil) async throws -> BotTeamChannel {
        guard Self.isSafeIdentifier(teamId), after == nil || before == nil,
              [after, before].compactMap({ $0 }).allSatisfy({ $0 >= 0 && $0 < Int.max }) else {
            throw CompanionError.server("Choose a saved team and valid history position.")
        }
        var req = try request("/v1/bots/teams/\(teamId)/channel")
        var url = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!
        var query: [URLQueryItem] = []
        if let after { query.append(URLQueryItem(name: "after", value: String(after))) }
        if let before { query.append(URLQueryItem(name: "before", value: String(before))) }
        url.queryItems = query; req.url = url.url
        let (data, response) = try await self.data(for: req)
        try Self.check(response, data: data)
        return try JSONDecoder().decode(BotTeamChannel.self, from: data)
    }

    /// Only a saved team/plan and a numeric task cursor can become this GET.
    /// General request paths still reject arbitrary query strings.
    func teamWorkPlan(teamId: String, planId: String, taskOffset: Int = 0) async throws -> BotTeamWorkPlan {
        guard Self.isSafeIdentifier(teamId), BotTeamWorkPlan.validID(planId, "tp_"), (0...9_007_199_254_740_991).contains(taskOffset) else {
            throw CompanionError.server("Choose a saved team plan and valid task position.")
        }
        var req = try request("/v1/bots/teams/\(teamId)/plans/\(planId)")
        if taskOffset > 0 {
            var components = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "taskOffset", value: String(taskOffset))]; req.url = components.url
        }
        let (data, response) = try await self.data(for: req)
        try Self.check(response, data: data)
        struct Result: Decodable { var plan: BotTeamWorkPlan }
        return try JSONDecoder().decode(Result.self, from: data).plan
    }

    func teamWorkPlans(teamId: String, beforePlanId: String? = nil) async throws -> BotTeamWorkPlansSnapshot {
        guard Self.isSafeIdentifier(teamId), beforePlanId.map({ BotTeamWorkPlan.validID($0, "tp_") }) ?? true else { throw CompanionError.server("Choose a saved team and plan cursor.") }
        var req = try request("/v1/bots/teams/\(teamId)/plans")
        if let beforePlanId {
            var components = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "beforePlanId", value: beforePlanId)]; req.url = components.url
        }
        let (data, response) = try await self.data(for: req)
        try Self.check(response, data: data)
        return try JSONDecoder().decode(BotTeamWorkPlansSnapshot.self, from: data)
    }

    static func isSafeIdentifier(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 120 && value.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 95 || $0 == 45 }
    }

    func stream(message: String, chatId: String?, onFrame: @escaping @MainActor (ChatFrame) -> Void) async throws {
        var body = ["message": message]
        if let chatId { body["chatId"] = chatId }
        var streamRequest = try request("/v1/chat", method: "POST", body: body)
        streamRequest.timeoutInterval = 600 // Model prefill can exceed the dashboard's short timeout.
        try beginMutation()
        defer { endMutation() }
        let selectedRequest = try rebound(streamRequest, to: baseURL)
        let (bytes, response) = try await session.bytes(for: selectedRequest)
        try Self.check(response)
        var completed = false
        for try await line in bytes.lines {
            try Task.checkCancellation()
            let raw: String
            if line.hasPrefix("data:") { raw = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces) }
            else if line.hasPrefix("{") { raw = line } // NDJSON is also understood.
            else { continue }
            guard raw != "[DONE]", let data = raw.data(using: .utf8) else { continue }
            let frame = try JSONDecoder().decode(ChatFrame.self, from: data)
            await onFrame(frame)
            if frame.type == "error" { throw CompanionError.server(frame.message ?? "The Mac could not finish this reply.") }
            if frame.type == "done" { completed = true }
        }
        if !completed { throw CompanionError.server("The connection ended before the reply finished. Check your Mac before trying again.") }
    }

    private static func check(_ response: URLResponse, data: Data = Data()) throws {
        guard let http = response as? HTTPURLResponse else { throw CompanionError.server("The Mac returned an unreadable response.") }
        guard (200..<300).contains(http.statusCode) else {
            let error = try? JSONDecoder().decode(ServerError.self, from: data)
            let message = error?.message ?? error?.error
            throw CompanionHTTPError(statusCode: http.statusCode,
                                     message: message ?? (http.statusCode == 401 ? "This pairing has expired or was removed on the Mac. Pair again." : "The Mac returned an error (\(http.statusCode))."))
        }
    }
}

struct CompanionHTTPError: LocalizedError {
    var statusCode: Int
    var message: String
    var errorDescription: String? { message }
    var isUnsupported: Bool { statusCode == 404 || statusCode == 405 || statusCode == 501 }
}

struct ChatFrame: Decodable {
    var type: String
    var text: String?
    var message: String?
    var chatId: String?
}
private struct ServerError: Decodable { var error: String?; var message: String? }

enum ConnectionKeychain {
    private static let service = "com.strata.companion.connection"
    private static let account = "paired-mac"
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    static func load() -> PairedConnection? {
        var read = query; read[kSecReturnData as String] = true; read[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(read as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(PairedConnection.self, from: data)
    }
    static func save(_ connection: PairedConnection) throws {
        let data = try JSONEncoder().encode(connection)
        let values: [String: Any] = [kSecValueData as String: data,
                                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query; values.forEach { insert[$0.key] = $0.value }
            let result = SecItemAdd(insert as CFDictionary, nil)
            guard result == errSecSuccess else { throw CompanionError.keychain(result) }
        } else if status != errSecSuccess { throw CompanionError.keychain(status) }
    }
    static func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CompanionError.keychain(status) }
    }
}
