import Foundation
import SwiftUI
import UserNotifications
import UIKit

@MainActor
final class CompanionNotifications: ObservableObject {
    @Published private(set) var settings = CompanionNotificationSettings()
    @Published private(set) var events: [CompanionNotificationEvent] = []
    @Published private(set) var readIds: Set<String> = []
    @Published private(set) var authorization: UNAuthorizationStatus = .notDetermined
    @Published private(set) var pushConfigured = false
    @Published private(set) var pushDetail = "Check your Mac connection to see notification delivery status."
    @Published private(set) var error: String?
    @Published private(set) var saving = false
    @Published private(set) var supported = true
    @Published private(set) var verifiedJournalId: String?
    @Published private(set) var registrationFailure: String?
    @Published private(set) var route: CompanionNotificationRoute?
    var unreadCount: Int { events.filter { !readIds.contains($0.id) }.count }
    var focusedDestination: CompanionNotificationDestination?
    var active = false
    private var client: CompanionClient?
    private var scope: String?
    private var generation = UUID()
    private var preferenceGeneration = UUID()
    private var pairingGeneration = UUID()
    private var ledger = CompanionNotificationLedger()
    private var refreshing = false
    private var token: String?
    private var registeredToken: String?
    private var registration = CompanionNotificationRegistration()
    private var inboxJournalId: String?
    private var presentedIds: Set<String> = []
    private var pendingLocalIds: Set<String> = []
    private var registrationCleanupNeeded = false
    private var pendingTap: [AnyHashable: Any]?
    private var hasLoadedSettings = false
    private let deliverForTesting: ((CompanionNotificationEvent) -> Void)?
    private let defaults: UserDefaults
    private let center = UNUserNotificationCenter.current()
    static var pushEnvironment: String? {
        #if STRATA_PUSH
        let value = Bundle.main.object(forInfoDictionaryKey: "StrataPushEnvironment") as? String
        return ["sandbox", "production"].contains(value ?? "") ? value : nil
        #else
        return nil
        #endif
    }
    var supportsPush: Bool { Self.pushEnvironment != nil }
    var deliveryDescription: String {
        if !supportsPush { return "This build can show alerts while Strata is open. Background iPhone alerts need a push-enabled build and Apple notification setup on your Mac." }
        if !pushConfigured { return pushDetail }
        if let registrationFailure { return registrationFailure }
        return registeredToken == nil ? "Waiting for Apple’s device registration. Open Strata after allowing notifications." : "Apple push delivery is configured. Your Mac must stay running and connected to the internet."
    }
    init(defaults: UserDefaults = .standard, deliver: ((CompanionNotificationEvent) -> Void)? = nil) { self.defaults = defaults; self.deliverForTesting = deliver }

    func bind(client: CompanionClient?, connection: PairedConnection?, pairingGeneration: UUID) {
        let next = connection.map { PinnedSessionDelegate.digest(Data(($0.baseURL.absoluteString + ":" + $0.fingerprint + ":" + $0.token).utf8)) }
        guard next != scope || self.pairingGeneration != pairingGeneration else { self.client = client; return }
        // Cancel the old application registration ownership before adopting a
        // new pairing. Apple's token is app-wide; it grants no Mac access by
        // itself, and any later callback still needs this pairing's consent.
        if StrataNotificationDelegate.owner === self { StrataNotificationDelegate.attempt = nil }
        generation = UUID(); self.pairingGeneration = pairingGeneration; self.client = client; scope = next
        ledger.reset(); refreshing = false; saving = false; registeredToken = nil; route = nil; focusedDestination = nil
        settings = CompanionNotificationSettings(); pushConfigured = false; error = nil; supported = true
        registration.reset(); registrationFailure = nil; verifiedJournalId = nil; inboxJournalId = nil; presentedIds = []; pendingLocalIds = []
        registrationCleanupNeeded = false; pendingTap = nil; hasLoadedSettings = false
        center.removeAllDeliveredNotifications(); center.removeAllPendingNotificationRequests()
        events = []; readIds = []
        if let next, let data = defaults.data(forKey: "strata.notifications.inbox." + next), let cache = try? JSONDecoder().decode(Inbox.self, from: data), let journal = cache.journalId {
            inboxJournalId = journal; events = Array(cache.events.filter(\.isValid).prefix(100)); readIds = Set(cache.readIds); presentedIds = Set(cache.presentedIds ?? [])
        }
        if next == nil { center.removeAllDeliveredNotifications(); center.removeAllPendingNotificationRequests(); UIApplication.shared.unregisterForRemoteNotifications() }
    }
    func resume() { ledger.reset(); registration.resume() }
    var canOpenInbox: Bool { verifiedJournalId != nil && inboxJournalId == verifiedJournalId }
    func updateAuthorization() async { authorization = await center.notificationSettings().authorizationStatus }

    func refresh() async {
        guard let client, !refreshing, !saving else { return }
        let preference = preferenceGeneration
        let expected = generation; refreshing = true
        defer { if expected == generation { refreshing = false } }
        do {
            var pages = 0
            repeat {
                let feed = try await client.notificationFeed(after: ledger.cursor, journalId: ledger.journalId)
                guard expected == generation, preference == preferenceGeneration, !saving, !Task.isCancelled else { return }
                apply(feed)
                pages += 1
                if !feed.hasMore || pages >= 4 { break }
            } while !Task.isCancelled
            error = nil
            await syncRegistration(expected: expected)
        } catch is CancellationError { }
        catch {
            guard expected == generation, preference == preferenceGeneration, !saving else { return }
            // Reconnection starts at a fresh baseline instead of presenting an
            // accumulated burst of old alerts as if they just arrived.
            ledger.reset()
            if (error as? CompanionHTTPError)?.isUnsupported == true { supported = false; self.error = "Update Strata on your Mac to use notifications." }
            else { self.error = "Notifications will reconnect when your Mac is available." }
        }
    }
    private func apply(_ feed: CompanionNotificationFeed) {
        guard feed.supported, !feed.journalId.isEmpty else { return }
        if inboxJournalId != feed.journalId {
            events = []; readIds = []; presentedIds = []; pendingLocalIds = []; route = nil
            inboxJournalId = feed.journalId
            center.removeAllDeliveredNotifications(); center.removeAllPendingNotificationRequests()
        }
        verifiedJournalId = feed.journalId
        hasLoadedSettings = true; settings = feed.settings; pushConfigured = feed.push.configured; pushDetail = feed.push.detail; supported = feed.supported
        if feed.push.registered == false { registeredToken = nil }
        let fresh = ledger.consume(feed)
        if let scope { defaults.set(ledger.journalId, forKey: "strata.notifications.journal." + scope) }
        for event in fresh {
            guard settings.allows(event), !events.contains(where: { $0.id == event.id }) else { continue }
            events.insert(event, at: 0)
            if active, focusedDestination == event.destination { readIds.insert(event.id) }
            else if !(supportsPush && pushConfigured && registeredToken != nil) { postLocal(event) }
        }
        events = Array(events.prefix(100)); persist()
        if let pending = pendingTap { pendingTap = nil; receiveTap(pending) }
    }
    func save(_ updated: CompanionNotificationSettings, requestPermission: Bool = false) async {
        guard let client, !saving else { return }
        let expected = generation; preferenceGeneration = UUID(); saving = true; error = nil
        defer { if expected == generation { saving = false } }
        if updated.enabled, requestPermission {
            do { _ = try await center.requestAuthorization(options: [.alert, .badge, .sound]) }
            catch { if expected == generation { self.error = "iOS could not open notification permission. Try Settings." } }
            guard expected == generation else { return }
            await updateAuthorization()
        }
        guard expected == generation, !Task.isCancelled else { return }
        do {
            let result: CompanionNotificationFeed = try await client.perform("/v1/notifications/settings", method: "POST", jsonBody: updated)
            guard expected == generation, !Task.isCancelled else { return }
            // The write response is an authoritative no-replay baseline. In
            // particular, permission UI may have reset the foreground cursor
            // while enabling; prime it now so the next new reply is retained.
            apply(result)
            if !settings.enabled {
                if StrataNotificationDelegate.owner === self { StrataNotificationDelegate.attempt = nil }
                center.removeAllPendingNotificationRequests(); center.removeAllDeliveredNotifications(); UIApplication.shared.unregisterForRemoteNotifications(); registeredToken = nil; registration.reset(); registrationFailure = nil; registrationCleanupNeeded = true
            }
            await syncRegistration(expected: expected)
        } catch { if expected == generation { self.error = "Couldn’t save notification settings. Try again when your Mac is connected." } }
    }
    func setMuted(_ destination: CompanionNotificationDestination, muted: Bool) async {
        guard destination.isValid else { return }
        var value = settings; value.muted.removeAll { $0 == destination.key }
        if muted { value.muted.append(destination.key) }
        await save(value)
        if muted, settings.muted.contains(destination.key) {
            let ids = events.filter { $0.destination == destination }.map { requestId($0.id) }
            center.removeDeliveredNotifications(withIdentifiers: ids); center.removePendingNotificationRequests(withIdentifiers: ids)
        }
    }
    func isMuted(_ destination: CompanionNotificationDestination) -> Bool { settings.muted.contains(destination.key) }
    func receiveToken(_ data: Data, attemptId: UUID, expectedPairingGeneration: UUID) async {
        guard expectedPairingGeneration == pairingGeneration, settings.enabled, registration.complete(attemptId) else { return }
        registrationFailure = nil
        token = data.map { String(format: "%02x", $0) }.joined()
        await syncRegistration(expected: generation)
    }
    private func syncRegistration(expected: UUID) async {
        guard let client, expected == generation else { return }
        if !settings.enabled {
            guard registrationCleanupNeeded else { return }
            struct Removed: Decodable { var registered: Bool }
            _ = try? await client.perform("/v1/notifications/registration", method: "DELETE") as Removed
            if expected == generation { registrationCleanupNeeded = false }
            return
        }
        guard supportsPush, authorization == .authorized || authorization == .provisional || authorization == .ephemeral else { return }
        if StrataNotificationDelegate.attempt == nil, let id = registration.begin() {
            StrataNotificationDelegate.attempt = .init(id: id, pairingGeneration: pairingGeneration)
            UIApplication.shared.registerForRemoteNotifications()
        }
        guard let token, registeredToken != token, let environment = Self.pushEnvironment else { return }
        struct Registration: Encodable { var token: String; var environment: String }
        struct Result: Decodable { var registered: Bool; var configured: Bool; var detail: String }
        do {
            let result: Result = try await client.perform("/v1/notifications/registration", method: "POST", jsonBody: Registration(token: token, environment: environment))
            guard expected == generation, settings.enabled else { return }
            registeredToken = result.registered ? token : nil; pushConfigured = result.configured; pushDetail = result.detail
        } catch { if expected == generation { pushDetail = "Apple device registration will retry when your Mac is available." } }
    }
    func registrationFailed(attemptId: UUID, expectedPairingGeneration: UUID) {
        guard expectedPairingGeneration == pairingGeneration, settings.enabled, registration.fail(attemptId) else { return }
        registrationFailure = "Apple device registration is unavailable. Strata will retry, or reopen the app after checking your internet connection."
    }
    private func requestId(_ id: String) -> String { "strata." + (ledger.journalId ?? "") + "." + id }
    private func postLocal(_ event: CompanionNotificationEvent) {
        guard settings.enabled, !presentedIds.contains(event.id), !pendingLocalIds.contains(event.id) else { return }
        pendingLocalIds.insert(event.id)
        if let deliverForTesting { deliverForTesting(event); return }
        let content = UNMutableNotificationContent()
        content.title = event.title; content.body = event.body; content.threadIdentifier = event.destination.key
        content.categoryIdentifier = "STRATA_BOT_UPDATE"
        if settings.sound { content.sound = .default }
        content.userInfo = ["journalId": ledger.journalId ?? "", "eventId": event.id, "destination": ["type": event.destination.type, "id": event.destination.id]]
        let expected = generation
        Task {
            guard expected == generation, settings.allows(event), !(active && focusedDestination == event.destination) else { return }
            let id = requestId(event.id)
            do { try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) }
            catch { pendingLocalIds.remove(event.id) }
            if expected != generation || !settings.allows(event) {
                center.removeDeliveredNotifications(withIdentifiers: [id]); center.removePendingNotificationRequests(withIdentifiers: [id])
            }
        }
    }
    func receiveTap(_ userInfo: [AnyHashable: Any]) {
        guard scope != nil else { return }
        if !hasLoadedSettings { pendingTap = userInfo; return }
        guard settings.enabled, let journal = userInfo["journalId"] as? String,
              journal == verifiedJournalId,
              let raw = userInfo["destination"] as? [String: Any], let type = raw["type"] as? String, let id = raw["id"] as? String else { return }
        let destination = CompanionNotificationDestination(type: type, id: id)
        guard destination.isValid, !isMuted(destination) else { return }
        if let id = userInfo["eventId"] as? String { presentedIds.insert(id); markRead(id) }
        route = CompanionNotificationRoute(destination: destination, pairingGeneration: pairingGeneration, journalId: journal)
    }
    func open(_ event: CompanionNotificationEvent) {
        guard event.destination.isValid, canOpenInbox, let journal = verifiedJournalId,
              events.contains(where: { $0.id == event.id }) else { return }
        markRead(event.id); route = CompanionNotificationRoute(destination: event.destination, pairingGeneration: pairingGeneration, journalId: journal)
    }
    func clearRoute(_ id: UUID) { if route?.id == id { route = nil } }
    func markRead(_ id: String) { readIds.insert(id); persist() }
    func markAllRead() { readIds.formUnion(events.map(\.id)); persist() }
    func focus(_ destination: CompanionNotificationDestination?) {
        focusedDestination = destination
        if let destination { readIds.formUnion(events.filter { $0.destination == destination }.map(\.id)); persist() }
    }
    func presentation(for userInfo: [AnyHashable: Any]) -> UNNotificationPresentationOptions {
        guard settings.enabled, let journal = userInfo["journalId"] as? String, journal == verifiedJournalId,
              let eventId = userInfo["eventId"] as? String, !eventId.isEmpty, eventId.count <= 256,
              let raw = userInfo["destination"] as? [String: Any], let type = raw["type"] as? String, let id = raw["id"] as? String else { return [] }
        let destination = CompanionNotificationDestination(type: type, id: id)
        guard destination.isValid, !isMuted(destination), !presentedIds.contains(eventId) else { return [] }
        if let event = events.first(where: { $0.id == eventId }), !settings.allows(event) { return [] }
        // Local fallback reserves an ID when enqueuing but only consumes it
        // here, so its first system callback is still allowed. APNs and local
        // callbacks share the same ownership, whichever reaches this first.
        presentedIds.insert(eventId); pendingLocalIds.remove(eventId)
        if presentedIds.count > 1_000 { presentedIds = Set(events.map(\.id)).union([eventId]) }
        persist()
        guard !(active && focusedDestination == destination) else { return [] }
        return settings.sound ? [.banner, .list, .sound] : [.banner, .list]
    }
    private struct Inbox: Codable { var journalId: String?; var events: [CompanionNotificationEvent]; var readIds: [String]; var presentedIds: [String]? }
    private func persist() {
        guard let scope else { return }
        readIds.formIntersection(Set(events.map(\.id)))
        if let data = try? JSONEncoder().encode(Inbox(journalId: inboxJournalId, events: events, readIds: Array(readIds), presentedIds: Array(presentedIds))) { defaults.set(data, forKey: "strata.notifications.inbox." + scope) }
    }
}

final class StrataNotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor static weak var owner: CompanionNotifications?
    struct RegistrationAttempt { var id: UUID; var pairingGeneration: UUID }
    @MainActor static var attempt: RegistrationAttempt?
    @MainActor static var pendingTap: [AnyHashable: Any]?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories([UNNotificationCategory(identifier: "STRATA_BOT_UPDATE", actions: [], intentIdentifiers: [])])
        return true
    }
    @MainActor func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard let attempt = Self.attempt else { return }; Self.attempt = nil
        Task { await Self.owner?.receiveToken(deviceToken, attemptId: attempt.id, expectedPairingGeneration: attempt.pairingGeneration) }
    }
    @MainActor func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Capture the originating attempt before yielding to any later pairing.
        // No token, endpoint or server error is emitted to logs.
        guard let attempt = Self.attempt else { return }; Self.attempt = nil
        Self.owner?.registrationFailed(attemptId: attempt.id, expectedPairingGeneration: attempt.pairingGeneration)
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        Task { @MainActor in completionHandler(Self.owner?.presentation(for: notification.request.content.userInfo) ?? []) }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in
            if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
                if let owner = Self.owner { owner.receiveTap(response.notification.request.content.userInfo) }
                else { Self.pendingTap = response.notification.request.content.userInfo }
            }
            completionHandler()
        }
    }
}
