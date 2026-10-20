import Foundation
import SwiftUI

@MainActor
final class CompanionStore: ObservableObject {
    @Published private(set) var connection: PairedConnection?
    @Published private(set) var status: CompanionStatus?
    @Published private(set) var models: [CompanionModel] = []
    @Published private(set) var chats: [CompanionChat] = []
    @Published private(set) var messages: [ChatMessage] = []
    @Published private(set) var currentChatId: String?
    @Published private(set) var isLoading = false
    @Published private(set) var isSending = false
    @Published var error: String?
    @Published var pendingInvitation: PairingInvitation?
    var isPaired: Bool { connection != nil }
    private var client: CompanionClient?
    private var streamTask: Task<Void, Never>?
    private var connectionGeneration = UUID()
    private var conversationGeneration = UUID()
    private var loadingOperation: UUID?
    private var streamOperation: UUID?
    private let saveConnection: (PairedConnection) throws -> Void
    private let deleteConnection: () throws -> Void

    init(connection: PairedConnection? = nil, client: CompanionClient? = nil,
         saveConnection: @escaping (PairedConnection) throws -> Void = ConnectionKeychain.save,
         deleteConnection: @escaping () throws -> Void = ConnectionKeychain.delete) {
        self.saveConnection = saveConnection
        self.deleteConnection = deleteConnection
        if let saved = connection ?? (client == nil ? ConnectionKeychain.load() : nil) {
            self.connection = saved
            self.client = client ?? CompanionClient(baseURL: saved.baseURL, fingerprint: saved.fingerprint, token: saved.token)
        }
    }

    func pair(url: String, code: String, fingerprint: String) async {
        guard !isLoading, !isSending else { return }
        let operation = beginLoading()
        let generation = connectionGeneration
        error = nil
        defer { finishLoading(operation) }
        do {
            let address = try PairingInvitation.validatedURL(url.trimmingCharacters(in: .whitespacesAndNewlines))
            let pin = try PairingInvitation.normalizedFingerprint(fingerprint.trimmingCharacters(in: .whitespacesAndNewlines))
            guard code.count == 6, code.allSatisfy({ $0 >= "0" && $0 <= "9" }) else {
                throw CompanionError.invalidInvitation("Enter the six-digit pairing code shown on your Mac.")
            }
            let pairingClient = CompanionClient(baseURL: address, fingerprint: pin)
            let result: PairResult = try await pairingClient.perform("/v1/pair", method: "POST", body: ["code": code, "deviceName": UIDevice.current.name])
            guard connectionGeneration == generation, loadingOperation == operation else { return }
            let saved = PairedConnection(baseURL: address, macName: result.macName, fingerprint: pin, token: result.token)
            try saveConnection(saved)
            connectionGeneration = UUID(); conversationGeneration = UUID()
            connection = saved
            client = CompanionClient(baseURL: address, fingerprint: pin, token: saved.token)
            status = nil; models = []; chats = []; messages = []; currentChatId = nil
            pendingInvitation = nil
            try await fetchState()
        } catch is CancellationError { }
        catch { if loadingOperation == operation { self.error = friendly(error) } }
    }

    func refresh(silently: Bool = false) async {
        guard isPaired, !isLoading else { return }
        let operation = beginLoading()
        defer { finishLoading(operation) }
        do { try await fetchState(); if !silently { error = nil } }
        catch is CancellationError { }
        catch { if loadingOperation == operation { markUnreachable(); if !silently { self.error = friendly(error) } } }
    }

    private func fetchState() async throws {
        guard let client else { throw CompanionError.unpaired }
        let generation = connectionGeneration
        async let fetchedStatus: CompanionStatus = client.perform("/v1/status")
        async let fetchedModels: ModelResult = client.perform("/v1/models")
        async let fetchedChats: ChatListResult = client.perform("/v1/chats")
        let (newStatus, newModels, newChats) = try await (fetchedStatus, fetchedModels, fetchedChats)
        guard connectionGeneration == generation else { throw CancellationError() }
        status = newStatus; models = newModels.models; chats = newChats.chats
    }

    func loadModel(_ id: String) async {
        guard let client, !isLoading, !isSending else { return }
        let operation = beginLoading()
        let generation = connectionGeneration
        error = nil
        defer { finishLoading(operation) }
        do {
            let escaped = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%"))) ?? id
            try await client.discard("/v1/models/\(escaped)/load", body: [:])
            guard connectionGeneration == generation else { return }
            try await fetchState()
        } catch is CancellationError { }
        catch { if loadingOperation == operation { self.error = friendly(error) } }
    }

    func unloadModel() async {
        guard let client, !isLoading, !isSending else { return }
        let operation = beginLoading()
        let generation = connectionGeneration
        error = nil
        defer { finishLoading(operation) }
        do {
            try await client.discard("/v1/models/unload", body: [:])
            guard connectionGeneration == generation else { return }
            try await fetchState()
        } catch is CancellationError { }
        catch { if loadingOperation == operation { self.error = friendly(error) } }
    }

    func newChat() {
        guard !isSending else { return }
        conversationGeneration = UUID()
        currentChatId = nil; messages = []; error = nil
    }

    func selectChat(_ chat: CompanionChat) async {
        guard let client, !isSending else { return }
        let generation = connectionGeneration
        let conversation = UUID()
        conversationGeneration = conversation
        do {
            let history: ChatHistory = try await client.perform("/v1/chats/\(chat.id)")
            guard connectionGeneration == generation, conversationGeneration == conversation, !isSending else { return }
            currentChatId = chat.id; messages = history.messages; error = nil
        } catch {
            if connectionGeneration == generation, conversationGeneration == conversation { self.error = friendly(error) }
        }
    }

    func sendMessage(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let client, !isSending, !trimmed.isEmpty else { return }
        let generation = connectionGeneration
        let conversation = UUID()
        let operation = UUID()
        conversationGeneration = conversation
        streamOperation = operation
        error = nil; isSending = true
        messages.append(ChatMessage(id: UUID().uuidString, role: "user", content: trimmed))
        let replyId = UUID().uuidString
        messages.append(ChatMessage(id: replyId, role: "assistant", content: ""))
        let chatId = currentChatId
        let task = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.streamOperation == operation {
                    self.isSending = false; self.streamTask = nil; self.streamOperation = nil
                }
            }
            do {
                try await client.stream(message: trimmed, chatId: chatId) { [weak self] frame in
                    guard let self else { return }
                    guard self.connectionGeneration == generation, self.conversationGeneration == conversation else { return }
                    if let id = frame.chatId { self.currentChatId = id }
                    if frame.type == "delta", let text = frame.text,
                       let index = self.messages.firstIndex(where: { $0.id == replyId }) { self.messages[index].content += text }
                }
                if self.connectionGeneration == generation { try await self.fetchState() }
            } catch is CancellationError { }
            catch { if self.connectionGeneration == generation { self.error = self.friendly(error) } }
        }
        streamTask = task
        await task.value
    }

    func cancelMessage() async {
        guard let client, let currentChatId, isSending else { return }
        let operation = streamOperation
        let generation = connectionGeneration
        do {
            try await client.discard("/v1/chat/\(currentChatId)/cancel", body: [:])
            if streamOperation == operation { streamTask?.cancel() }
        } catch { if connectionGeneration == generation, streamOperation == operation { self.error = friendly(error) } }
    }

    func disconnect() async {
        guard let client else { return }
        guard !isSending else { error = "Stop the current reply before disconnecting."; return }
        let generation = connectionGeneration
        do {
            // Revoke on the Mac before deleting the local credential.
            try await client.discard("/v1/session", method: "DELETE")
            guard connectionGeneration == generation else { return }
            try deleteConnection()
            clearConnection()
        } catch { if connectionGeneration == generation { self.error = friendly(error) } }
    }

    func forgetMac() {
        guard !isSending else { error = "Stop the current reply before forgetting this Mac."; return }
        do {
            try deleteConnection()
            clearConnection()
        } catch { self.error = friendly(error) }
    }

    private func beginLoading() -> UUID {
        let operation = UUID()
        loadingOperation = operation; isLoading = true
        return operation
    }

    private func finishLoading(_ operation: UUID) {
        guard loadingOperation == operation else { return }
        loadingOperation = nil; isLoading = false
    }

    private func clearConnection() {
        connectionGeneration = UUID(); conversationGeneration = UUID()
        loadingOperation = nil; isLoading = false
        client = nil; connection = nil; status = nil; models = []; chats = []; messages = []; currentChatId = nil; error = nil
    }

    private func markUnreachable() {
        status?.hostConnected = false
        status?.tokensPerSecond = nil
        status?.activeRequests = 0
    }

    private func friendly(_ error: Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .serverCertificateUntrusted, .secureConnectionFailed, .cancelled:
                return "The Mac certificate could not be verified. Scan a fresh pairing QR code from your Mac."
            case .cannotConnectToHost, .cannotFindHost, .timedOut, .notConnectedToInternet:
                return "Your Mac is unreachable. Keep Strata Companion running and connect both devices to the same network."
            default: break
            }
        }
        return error.localizedDescription
    }
}

private struct PairResult: Decodable { var token: String; var macName: String }
private struct ModelResult: Decodable { var models: [CompanionModel] }
private struct ChatListResult: Decodable { var chats: [CompanionChat] }
private struct ChatHistory: Decodable { var messages: [ChatMessage] }
