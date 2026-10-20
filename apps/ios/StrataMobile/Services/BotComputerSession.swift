import Foundation
import SwiftUI
import UIKit

struct BotComputerState: Decodable, Equatable {
    struct Image: Decodable, Equatable { var mimeType: String; var data: String }
    struct Control: Decodable, Equatable { var expiresAt: Double?; var owned: Bool; var active: Bool }
    var available: Bool
    var running: Bool?
    var cleanupConfirmed: Bool?
    var detail: String?
    var computerName: String?
    var width: Int?
    var height: Int?
    var image: Image?
    var activeChatId: String?
    var control: Control?
    var leaseToken: String?
    var expiresAt: Double?
}

struct BotComputerInput: Encodable {
    var chatId: String?
    var leaseToken: String?
    var action: String?
    var x: Double?
    var y: Double?
    var text: String?
    var key: String?
}

/// Coordinates refer to pixels in the screenshot, excluding aspect-fit margins.
enum ComputerCanvasPosition {
    static func pixel(at point: CGPoint, canvas: CGSize, image: CGSize) -> CGPoint? {
        guard canvas.width > 0, canvas.height > 0, image.width > 0, image.height > 0,
              [point.x, point.y, canvas.width, canvas.height, image.width, image.height].allSatisfy(\.isFinite) else { return nil }
        let scale = min(canvas.width / image.width, canvas.height / image.height)
        let origin = CGPoint(x: (canvas.width - image.width * scale) / 2, y: (canvas.height - image.height * scale) / 2)
        let x = (point.x - origin.x) / scale, y = (point.y - origin.y) / scale
        guard x >= 0, y >= 0, x < image.width, y < image.height else { return nil }
        return CGPoint(x: floor(x), y: floor(y))
    }
}

@MainActor
final class BotComputerSession: ObservableObject {
    @Published private(set) var state: BotComputerState?
    @Published private(set) var image: UIImage?
    @Published private(set) var error: String?
    @Published private(set) var isBusy = false
    @Published private(set) var isRefreshing = false
    @Published private(set) var hasControl = false
    var isRunning: Bool { state?.running ?? (state?.image != nil) }
    private let client: CompanionClient?
    private let botId: String
    private let chatId: String?
    private let isCurrent: () -> Bool
    private let now: () -> Date
    private var visible = false
    private var visibility = UUID()
    private var stateEpoch = UUID()
    private var token: String?
    private var expiresAt: Double?

    init(client: CompanionClient?, botId: String, chatId: String?, isCurrent: @escaping () -> Bool, now: @escaping () -> Date = Date.init) {
        self.client = client; self.botId = botId; self.chatId = chatId; self.isCurrent = isCurrent; self.now = now
    }

    func activate() {
        visible = isCurrent(); visibility = UUID()
        if !visible { state = nil; image = nil; clearControl(); error = "Pair this iPhone with your Mac to open the computer view." }
    }
    func deactivate() {
        visible = false; visibility = UUID(); stateEpoch = UUID()
        let held = token; clearControl(); isBusy = false; isRefreshing = false
        if !isCurrent() { state = nil; image = nil }
        if let held { Task { await releaseGrant(held) } }
    }

    func run() async {
        activate()
        let generation = visibility
        while valid(generation), !Task.isCancelled {
            await refresh()
            do { try await Task.sleep(for: .seconds(1)) } catch { break }
        }
        if visibility == generation { deactivate() }
    }

    private func valid(_ generation: UUID) -> Bool { visible && visibility == generation && isCurrent() }
    private func clearControl() { token = nil; expiresAt = nil; hasControl = false }
    private func controlIsValid() -> Bool { hasControl && token != nil && (expiresAt ?? 0) > now().timeIntervalSince1970 * 1000 && isCurrent() && visible }

    func refresh() async {
        guard visible, isCurrent(), !isBusy, !isRefreshing, let client else { return }
        let generation = visibility, epoch = stateEpoch
        isRefreshing = true
        defer { if visibility == generation { isRefreshing = false } }
        if hasControl, !controlIsValid() {
            let held = token; clearControl()
            if let held { await releaseGrant(held) }
        }
        do {
            let value = try await client.computer(botId: botId, chatId: chatId)
            guard valid(generation), stateEpoch == epoch else { return }
            apply(value); error = nil
            if token != nil, value.control?.owned != true { clearControl() }
        } catch {
            guard valid(generation), stateEpoch == epoch else { return }
            self.error = error.localizedDescription
        }
    }

    private func apply(_ value: BotComputerState) {
        // The bridge validates PNG headers and bounds. Repeat bounds here so a
        // malformed direct test/old host cannot decode an unbounded image.
        var decoded: UIImage?
        if let width = value.width, let height = value.height, width > 0, height > 0,
           width <= 8192, height <= 8192, width * height <= 16_777_216,
           let frame = value.image, frame.mimeType == "image/png", frame.data.utf8.count <= 11_184_812,
           let data = Data(base64Encoded: frame.data), data.count <= 8_388_608,
           let image = UIImage(data: data), image.cgImage?.width == width, image.cgImage?.height == height { decoded = image }
        var publicState = value
        publicState.leaseToken = nil; publicState.expiresAt = nil
        state = publicState; image = decoded
    }

    func start() async { await changeComputer("start") }
    func stop() async { await changeComputer("stop") }
    private func changeComputer(_ action: String) async {
        guard visible, isCurrent(), !isBusy, let client else { return }
        let generation = visibility
        isBusy = true; stateEpoch = UUID(); error = nil
        let held = action == "stop" ? token : nil
        if action == "stop" { clearControl() }
        var failure: String?
        do {
            try await client.discard(try CompanionClient.computerPath(botId: botId, action: action), body: chatId.map { ["chatId": $0] } ?? [:])
        } catch {
            failure = error.localizedDescription
            if let held { await releaseGrant(held) }
        }
        guard valid(generation) else { return }
        isBusy = false
        await refresh()
        if valid(generation), let failure { error = failure }
    }

    func takeOver() async {
        guard visible, isCurrent(), !isBusy, !controlIsValid(), let client else { return }
        let generation = visibility
        isBusy = true; stateEpoch = UUID(); error = nil
        defer { if valid(generation) { isBusy = false } }
        do {
            let value: BotComputerState = try await client.perform(try CompanionClient.computerPath(botId: botId, action: "takeover"), method: "POST", body: chatId.map { ["chatId": $0] } ?? [:])
            guard let grant = value.leaseToken, !grant.isEmpty else { throw CompanionError.server("The Mac did not confirm computer control.") }
            guard valid(generation), let expiry = value.expiresAt, expiry.isFinite, expiry > now().timeIntervalSince1970 * 1000 else {
                await releaseGrant(grant); return
            }
            token = grant; expiresAt = expiry; hasControl = true; apply(value)
        } catch { if valid(generation) { self.error = error.localizedDescription } }
        if valid(generation) { isBusy = false }
    }

    func release() async {
        let generation = visibility
        let held = token
        clearControl(); stateEpoch = UUID()
        let released = if let held { await releaseGrant(held) } else { true }
        await refresh()
        if valid(generation), !released { error = "The Mac could not confirm release. Control expires automatically; check Strata on your Mac before resuming work." }
    }
    @discardableResult private func releaseGrant(_ grant: String) async -> Bool {
        guard let client, let path = try? CompanionClient.computerPath(botId: botId, action: "release") else { return false }
        do {
            try await client.discard(path, body: ["leaseToken": grant].merging(chatId.map { ["chatId": $0] } ?? [:]) { old, _ in old })
            return true
        } catch { return false }
    }

    func click(x: Double, y: Double) async {
        guard let state, let width = state.width, let height = state.height, image != nil,
              x.isFinite, y.isFinite, x >= 0, y >= 0, x < Double(width), y < Double(height) else { return }
        await control(BotComputerInput(chatId: chatId, action: "click", x: x, y: y))
    }
    func type(_ text: String) async {
        guard !text.isEmpty, text.utf16.count <= 4_000, !text.contains("\0") else { return }
        await control(BotComputerInput(chatId: chatId, action: "type", text: text))
    }
    func key(_ key: String) async {
        guard ["Enter", "Tab", "Escape", "Backspace", "Control+L"].contains(key) else { return }
        await control(BotComputerInput(chatId: chatId, action: "key", key: key))
    }
    private func control(_ input: BotComputerInput) async {
        guard controlIsValid(), !isBusy, let client else { return }
        let generation = visibility
        var input = input; input.leaseToken = token
        isBusy = true; stateEpoch = UUID(); error = nil
        var failure: String?
        do {
            let result: ComputerAcknowledgement = try await client.perform(try CompanionClient.computerPath(botId: botId, action: "control"), method: "POST", jsonBody: input)
            if valid(generation), token == input.leaseToken, let expiry = result.expiresAt, expiry.isFinite, expiry > now().timeIntervalSince1970 * 1000 { expiresAt = expiry }
        } catch {
            if valid(generation) {
                failure = error.localizedDescription
                let held = token; clearControl()
                if let held { await releaseGrant(held) }
            }
        }
        guard valid(generation) else { return }
        isBusy = false; await refresh()
        if valid(generation), let failure { error = failure }
    }
}
private struct ComputerAcknowledgement: Decodable { var accepted: Bool?; var expiresAt: Double? }
