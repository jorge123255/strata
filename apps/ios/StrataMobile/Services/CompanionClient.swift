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

final class CompanionClient {
    let baseURL: URL
    let token: String?
    private let session: URLSession

    init(baseURL: URL, fingerprint: String, token: String? = nil, session: URLSession? = nil) {
        self.baseURL = baseURL; self.token = token
        if let session { self.session = session; return }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 600
        config.httpCookieStorage = nil
        config.urlCache = nil
        self.session = URLSession(configuration: config, delegate: PinnedSessionDelegate(fingerprint: fingerprint), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    func request(_ path: String, method: String = "GET", body: [String: String]? = nil) throws -> URLRequest {
        guard path.hasPrefix("/v1/"), !path.contains(".."), !path.contains("?") else {
            throw CompanionError.server("Invalid companion request.")
        }
        var req = URLRequest(url: baseURL.appendingPathComponent(String(path.dropFirst())))
        req.httpMethod = method
        req.timeoutInterval = path.hasPrefix("/v1/model-management/") ? 180 : path.hasSuffix("/computer/start") ? 100 : path.hasPrefix("/v1/bots/connections/") && path.hasSuffix("/check") ? 35 : 20
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { req.httpBody = try JSONEncoder().encode(body) }
        return req
    }

    func perform<T: Decodable>(_ path: String, method: String = "GET", body: [String: String]? = nil) async throws -> T {
        let (data, response) = try await session.data(for: request(path, method: method, body: body))
        try Self.check(response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func request<Body: Encodable>(_ path: String, method: String, jsonBody: Body) throws -> URLRequest {
        var req = try request(path, method: method)
        req.httpBody = try JSONEncoder().encode(jsonBody)
        return req
    }

    func perform<T: Decodable, Body: Encodable>(_ path: String, method: String, jsonBody: Body) async throws -> T {
        let (data, response) = try await session.data(for: request(path, method: method, jsonBody: jsonBody))
        try Self.check(response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func discard(_ path: String, method: String = "POST", body: [String: String]? = nil) async throws {
        let (data, response) = try await session.data(for: request(path, method: method, body: body))
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
        let (data, response) = try await session.data(for: req)
        try Self.check(response, data: data)
        return try JSONDecoder().decode(BotComputerState.self, from: data)
    }

    static func computerPath(botId: String, action: String? = nil) throws -> String {
        guard isSafeIdentifier(botId), action == nil || ["start", "stop", "takeover", "control", "release"].contains(action!) else { throw CompanionError.server("Choose a saved bot computer.") }
        return "/v1/bots/\(botId)/computer" + (action.map { "/" + $0 } ?? "")
    }

    func botProviderModels(_ provider: String) async throws -> BotProviderModels {
        guard ["claude", "codex", "grok", "kimi", "ollama", "configured"].contains(provider) else { throw CompanionError.server("Choose a supported provider.") }
        var req = try request("/v1/bots/provider-models")
        var url = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "provider", value: provider)]; req.url = url.url
        let (data, response) = try await session.data(for: req)
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
        let (data, response) = try await session.data(for: req)
        try Self.check(response, data: data)
        return try JSONDecoder().decode(BotTeamChannel.self, from: data)
    }

    static func isSafeIdentifier(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 120 && value.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 95 || $0 == 45 }
    }

    func stream(message: String, chatId: String?, onFrame: @escaping @MainActor (ChatFrame) -> Void) async throws {
        var body = ["message": message]
        if let chatId { body["chatId"] = chatId }
        var streamRequest = try request("/v1/chat", method: "POST", body: body)
        streamRequest.timeoutInterval = 600 // Model prefill can exceed the dashboard's short timeout.
        let (bytes, response) = try await session.bytes(for: streamRequest)
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
