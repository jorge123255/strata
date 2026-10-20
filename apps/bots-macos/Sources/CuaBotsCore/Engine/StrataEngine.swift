// Strata host adapter. CUA-derived UI remains FSL-1.1-MIT; see LICENSE.
import Foundation

@MainActor public final class StrataEngine {
    public let origin: URL
    private let session: URLSession
    private let transport: ((String, String, [String: Any]?) async throws -> [String: Any])?
    public init(origin: URL? = nil, session: URLSession? = nil, transport: ((String, String, [String: Any]?) async throws -> [String: Any])? = nil) {
        let args = ProcessInfo.processInfo.arguments
        let index = args.firstIndex(of: "--strata-host")
        let argument = index.map { $0 + 1 < args.count ? args[$0 + 1] : "invalid:" }
        let value = origin ?? URL(string: argument ?? ProcessInfo.processInfo.environment["STRATA_BOTS_ORIGIN"] ?? "http://127.0.0.1:47831") ?? URL(fileURLWithPath: "/invalid-strata-host")
        self.origin = value; self.transport = transport
        if let session { self.session = session } else { let config = URLSessionConfiguration.ephemeral; config.httpCookieStorage = nil; config.urlCache = nil; self.session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil) }
    }
    public func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> [String: Any] {
        guard origin.scheme == "http", ["127.0.0.1", "localhost", "::1", "[::1]"].contains(origin.host ?? ""), origin.user == nil, origin.password == nil, origin.query == nil, origin.fragment == nil, ["", "/"].contains(origin.path),
              path.hasPrefix("/api/"), let url = URL(string: path, relativeTo: origin)?.absoluteURL, url.host == origin.host, url.port == origin.port else { throw StrataError("Open this feature from Strata on this Mac.") }
        if let transport { return try await transport(path, method, body) }
        var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = method == "GET" ? 15 : 600
        request.setValue(origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw StrataError("Strata returned an invalid response.") }
        let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(http.statusCode) else { throw StrataError(value["error"] as? String ?? value["message"] as? String ?? "Strata could not complete this action (\(http.statusCode)).") }
        return value
    }
    public func computer(_ bot: Bot, action: String? = nil, body: [String: Any] = [:], chatID: String? = nil) async throws -> [String: Any] {
        var parameters = body; if let chatID { parameters["chatId"] = chatID }
        let query = action == nil ? chatID.map { "?chatId=\($0)" } ?? "" : ""
        return try await request("/api/bots/\(bot.id)/computer" + (action.map { "/\($0)" } ?? "") + query, method: action == nil ? "GET" : "POST", body: action == nil ? nil : parameters)
    }
    public func interrupt(_ bot: Bot, chatID: String?) async throws {
        guard let chatID else { return }; _ = try await request("/api/companion/conversations/\(chatID)/stop", method: "POST", body: [:])
    }
    public func pairingQR() async throws -> Data {
        guard origin.scheme == "http", ["127.0.0.1", "localhost", "::1", "[::1]"].contains(origin.host ?? ""), origin.user == nil, origin.password == nil, origin.query == nil, origin.fragment == nil,
              let url = URL(string: "/api/companion/qr", relativeTo: origin)?.absoluteURL else { throw StrataError("Open pairing from Strata on this Mac.") }
        var request = URLRequest(url: url); request.timeoutInterval = 15; request.setValue(origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 2 * 1024 * 1024, data.starts(with: [137, 80, 78, 71]) else { throw StrataError("The pairing QR code is unavailable.") }
        return data
    }
    public static func date(_ value: Any?) -> Date? {
        guard let value = value as? String else { return nil }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    public static func object<T: Encodable>(_ value: T) -> Any {
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        return (try? JSONSerialization.jsonObject(with: encoder.encode(value))) ?? NSNull()
    }
}
private final class NoRedirects: NSObject, URLSessionTaskDelegate { func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) } }
public struct StrataError: Error, LocalizedError { public var message: String; public init(_ message: String) { self.message = message }; public var errorDescription: String? { message } }

public struct HostOption: Identifiable, Hashable {
    public let id: String; public let name: String; public let detail: String; public let available: Bool
    public let connectionID: String?; public let model: String?
    public init(id: String, name: String, detail: String = "", available: Bool = true, connectionID: String? = nil, model: String? = nil) { self.id = id; self.name = name; self.detail = detail; self.available = available; self.connectionID = connectionID; self.model = model }
}
public struct HostConversation: Identifiable, Hashable {
    public let id: String; public let title: String; public let updatedAt: Date; public let active: Bool
    public let computerMode: String?; public let computerName: String?; public let modelName: String?; public let workspace: String?
    public init(id: String, title: String, updatedAt: Date, active: Bool, computerMode: String? = nil, computerName: String? = nil, modelName: String? = nil, workspace: String? = nil) {
        self.id = id; self.title = title; self.updatedAt = updatedAt; self.active = active
        self.computerMode = computerMode; self.computerName = computerName; self.modelName = modelName; self.workspace = workspace
    }
}
/// Display-only snapshot. Labels are never parsed into provider or SSH settings.
public struct BotViewContext: Hashable {
    public let chatID: String?; public let computerMode: String?; public let computerName: String; public let modelName: String; public let workspace: String?
    public var hasComputer: Bool { computerMode == "cua" }
}
