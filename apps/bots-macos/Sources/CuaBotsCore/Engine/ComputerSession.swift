// Strata computer view authority. No native CUA SDK is linked.
import Foundation
import Combine
import AppKit

@MainActor public final class ComputerSession: ObservableObject {
    public let engine: StrataEngine, bot: Bot, chatID: String?
    @Published public var image: NSImage?
    @Published public var width: Double = 0
    @Published public var height: Double = 0
    @Published public var running = false
    @Published public var working = false
    @Published public var detail = "Connecting…"
    @Published public var owned = false
    @Published public var cleanupUnconfirmed = false
    @Published public var error: String?
    private var leaseToken: String?
    private var poller: Task<Void, Never>?
    private var observers = 0
    private var controlGeneration: UInt64 = 0
    public init(engine: StrataEngine, bot: Bot, chatID: String?) { self.engine = engine; self.bot = bot; self.chatID = chatID }
    public func observe() { observers += 1; guard poller == nil else { return }; poller = Task { [weak self] in while !Task.isCancelled { guard let self else { return }; if !self.working { let generation = self.controlGeneration; do { let state = try await self.engine.computer(self.bot, chatID: self.chatID); if !Task.isCancelled && self.observers > 0 && !self.working && self.controlGeneration == generation { self.apply(state) } } catch { if !Task.isCancelled && self.observers > 0 && self.controlGeneration == generation { self.detail = error.localizedDescription } } }; try? await Task.sleep(for: .milliseconds(550)) } } }
    public func unobserve() { observers = max(0, observers - 1); if observers == 0 { controlGeneration += 1; poller?.cancel(); poller = nil; Task { await release() } } }
    public func apply(_ state: [String: Any]) {
        if let running = state["running"] as? Bool { self.running = running }
        if let confirmed = state["cleanupConfirmed"] as? Bool { cleanupUnconfirmed = !confirmed }
        detail = state["detail"] as? String ?? (running ? "Connected" : "Start this bot’s computer")
        if let image = state["image"] as? [String: Any], let encoded = image["data"] as? String, let data = Data(base64Encoded: encoded) { self.image = NSImage(data: data); width = (state["width"] as? NSNumber)?.doubleValue ?? 0; height = (state["height"] as? NSNumber)?.doubleValue ?? 0 }
        if let control = state["control"] as? [String: Any] { let granted = control["owned"] as? Bool ?? false; owned = granted && leaseToken != nil; if !granted { leaseToken = nil } }
        if let token = state["leaseToken"] as? String { leaseToken = token; owned = true }
    }
    public func action(_ action: String, body: [String: Any] = [:]) async {
        guard !working else { return }; controlGeneration += 1; working = true; let generation = controlGeneration; defer { working = false }
        do {
            let state = try await engine.computer(bot, action: action, body: body, chatID: chatID)
            if ["takeover", "control"].contains(action), generation != controlGeneration || observers == 0 {
                if let token = state["leaseToken"] as? String ?? leaseToken { await revoke(token) }
                return
            }
            apply(state); error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func revoke(_ token: String) async {
        do { _ = try await engine.computer(bot, action: "release", body: ["leaseToken": token], chatID: chatID); if leaseToken == token { leaseToken = nil }; owned = false }
        catch { self.error = error.localizedDescription; leaseToken = token; owned = false }
    }
    public func release() async {
        controlGeneration += 1; let generation = controlGeneration; owned = false
        guard leaseToken != nil else { return }
        while working { try? await Task.sleep(for: .milliseconds(100)) }
        guard controlGeneration == generation, let token = leaseToken else { return }
        working = true; defer { working = false }
        await revoke(token)
    }
    public func input(_ action: String, values: [String: Any]) async { guard owned, let leaseToken else { error = "Take over the computer before sending input."; return }; var body = values; body["action"] = action; body["leaseToken"] = leaseToken; await self.action("control", body: body) }
}
