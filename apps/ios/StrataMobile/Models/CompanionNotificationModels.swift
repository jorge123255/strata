import Foundation

struct CompanionNotificationDestination: Codable, Equatable, Hashable {
    var type: String
    var id: String
    var key: String { type + ":" + id }
    var isValid: Bool { ["chat", "team"].contains(type) && CompanionClient.isSafeIdentifier(id) }
}

struct CompanionNotificationEvent: Codable, Equatable, Identifiable {
    var id: String
    var sequence: Int
    var kind: String
    var createdAt: String
    var title: String
    var body: String
    var destination: CompanionNotificationDestination
    var botId: String?
    var isValid: Bool {
        !id.isEmpty && id.count <= 256 && sequence > 0 && ["reply", "team_message", "completed", "failed", "approval"].contains(kind)
        && destination.isValid && title.count <= 240 && body.count <= 1_000
    }
    var icon: String { switch kind { case "approval": "hand.raised"; case "failed": "exclamationmark.circle"; case "completed": "checkmark.circle"; case "team_message": "person.3"; default: "bubble.left" } }
}

struct CompanionNotificationSettings: Codable, Equatable {
    var enabled = false
    var replies = true
    var teams = true
    var work = true
    var approvals = true
    var previews = false
    var sound = true
    var muted: [String] = []
    func allows(_ event: CompanionNotificationEvent) -> Bool {
        guard enabled, event.isValid, !muted.contains(event.destination.key) else { return false }
        switch event.kind { case "reply": return replies; case "team_message": return teams; case "completed", "failed": return work; case "approval": return approvals; default: return false }
    }
}

struct CompanionNotificationFeed: Decodable {
    struct Push: Decodable { var configured: Bool; var detail: String; var registered: Bool? = nil }
    var supported: Bool
    var journalId: String
    var cursor: Int
    var nextCursor: Int
    var hasMore: Bool
    var baseline: Bool?
    var events: [CompanionNotificationEvent]
    var settings: CompanionNotificationSettings
    var push: Push
}

struct CompanionNotificationRoute: Equatable, Identifiable {
    var id = UUID()
    var destination: CompanionNotificationDestination
    var pairingGeneration: UUID
    var journalId: String
}

/// Pure cursor rules: baselines never replay history, duplicate IDs never alert,
/// and a reset journal cannot inherit an older cursor.
struct CompanionNotificationLedger {
    private(set) var journalId: String?
    private(set) var cursor: Int?
    private var seen: Set<String> = []
    mutating func reset() { journalId = nil; cursor = nil; seen = [] }
    mutating func consume(_ feed: CompanionNotificationFeed) -> [CompanionNotificationEvent] {
        let priming = cursor == nil || journalId != feed.journalId || feed.baseline == true
        guard feed.supported, !feed.journalId.isEmpty, feed.cursor >= 0, feed.nextCursor >= 0,
              feed.nextCursor <= feed.cursor else { return [] }
        let previous = cursor ?? 0
        guard priming || feed.nextCursor >= previous else { return [] }
        journalId = feed.journalId; cursor = feed.nextCursor
        if priming { seen = Set(feed.events.map(\.id)); return [] }
        let result = feed.events.filter { $0.isValid && $0.sequence > previous && $0.sequence <= feed.nextCursor && !seen.contains($0.id) }
        for event in result { seen.insert(event.id) }
        if seen.count > 1_000 { seen = Set(result.map(\.id)) }
        return result
    }
}

/// The Apple callback does not expose tokens to logs or preference storage.
/// Attempt IDs let delayed callbacks expire when pairing or consent changes.
struct CompanionNotificationRegistration {
    private(set) var requested = false
    private(set) var attemptId: UUID?
    private var retryAfter: Date?
    mutating func begin(now: Date = Date()) -> UUID? {
        guard !requested, retryAfter.map({ $0 <= now }) ?? true else { return nil }
        let id = UUID(); requested = true; attemptId = id; return id
    }
    mutating func complete(_ id: UUID) -> Bool {
        guard attemptId == id else { return false }
        attemptId = nil; retryAfter = nil; return true
    }
    @discardableResult mutating func fail(_ id: UUID, now: Date = Date()) -> Bool {
        guard attemptId == id else { return false }
        requested = false; attemptId = nil; retryAfter = now.addingTimeInterval(30); return true
    }
    mutating func resume() { retryAfter = nil }
    mutating func reset() { self = Self() }
}
