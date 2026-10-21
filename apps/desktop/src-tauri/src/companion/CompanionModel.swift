// Original Strata companion projection and display geometry. No execution authority.
import Foundation
import CoreFoundation

struct CompanionSession: Decodable, Identifiable {
    let id: String
    let botId: String
    let name: String
    let title: String
    let state: String
    let approvalCount: Int
    let toolName: String?
    let computerName: String?
    let updatedAt: String?
    let avatarConfig: AvatarConfig

    var label: String {
        switch state {
        case "approval": return "Needs approval"
        case "error": return "Needs attention"
        case "working": return "Using tools"
        case "thinking": return "Thinking"
        default: return "Reply ready"
        }
    }
    var symbol: String {
        switch state {
        case "approval": return "hand.raised"
        case "error": return "exclamationmark.circle"
        case "working": return "wrench.and.screwdriver"
        case "thinking": return "ellipsis.bubble"
        default: return "checkmark.bubble"
        }
    }
}

struct CompanionCounts: Decodable {
    let waiting: Int
    let working: Int
    let completed: Int
    let errors: Int
}

struct CompanionSnapshot: Decodable {
    static let maximumBytes = 8192
    let supported: Bool
    let sessions: [CompanionSession]
    let counts: CompanionCounts
    let hasMore: Bool
    let updatedAt: String

    /// Validate the entire narrow projection before rendering any field. Native
    /// views never receive transcript text, actionable tools or raw SVG strings.
    static func decode(_ data: Data) throws -> Self {
        func reject() -> NSError { NSError(domain: "StrataCompanion", code: 1, userInfo: [NSLocalizedDescriptionKey: "The companion snapshot was incomplete."]) }
        guard data.count <= maximumBytes,
              let row = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(row.keys) == ["supported", "sessions", "counts", "hasMore", "updatedAt"],
              boolean(row["supported"]) == true,
              boolean(row["hasMore"]) != nil,
              date(row["updatedAt"]),
              let counts = row["counts"] as? [String: Any],
              Set(counts.keys) == ["waiting", "working", "completed", "errors"],
              counts.values.allSatisfy({ integer($0, maximum: 10000) != nil }),
              let sessions = row["sessions"] as? [[String: Any]], sessions.count <= 6 else { throw reject() }
        var ids = Set<String>()
        for item in sessions {
            let allowed: Set<String> = ["id", "botId", "name", "title", "state", "approvalCount", "toolName", "computerName", "updatedAt", "avatarConfig"]
            let required: Set<String> = ["id", "botId", "name", "title", "state", "approvalCount", "avatarConfig"]
            guard Set(item.keys).isSubset(of: allowed), required.isSubset(of: Set(item.keys)),
                  identifier(item["id"]), identifier(item["botId"]),
                  let id = item["id"] as? String, ids.insert(id).inserted,
                  text(item["name"], maximum: 64), text(item["title"], maximum: 120),
                  let state = item["state"] as? String, ["approval", "error", "working", "thinking", "completed"].contains(state),
                  let pending = integer(item["approvalCount"], maximum: 10000),
                  (state == "approval" ? pending > 0 : pending == 0),
                  item["toolName"] == nil || text(item["toolName"], maximum: 64),
                  item["computerName"] == nil || text(item["computerName"], maximum: 64),
                  item["updatedAt"] == nil || date(item["updatedAt"]),
                  let avatar = item["avatarConfig"] as? [String: Any],
                  Set(avatar.keys).isSubset(of: ["color", "eyes", "ears", "kind", "shape"]),
                  ["color", "eyes", "ears"].allSatisfy({ avatar[$0] is String }),
                  BotColor(rawValue: avatar["color"] as? String ?? "") != nil,
                  EyeStyle(rawValue: avatar["eyes"] as? String ?? "") != nil,
                  EarShape(rawValue: avatar["ears"] as? String ?? "") != nil,
                  avatar["kind"] == nil || AvatarKind(rawValue: avatar["kind"] as? String ?? "") != nil,
                  avatar["shape"] == nil || AvatarShape(rawValue: avatar["shape"] as? String ?? "") != nil else { throw reject() }
        }
        return try JSONDecoder().decode(Self.self, from: data)
    }

    static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
    static func integer(_ value: Any?, maximum: Int) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= 0, number.doubleValue <= Double(maximum) else { return nil }
        return number.intValue
    }
    static func text(_ value: Any?, maximum: Int) -> Bool {
        guard let value = value as? String, !value.isEmpty, value.utf16.count <= maximum else { return false }
        // Match the host's C0/C1 policy. Foundation's broader control set also
        // contains U+200D, which is needed by ordinary joined emoji names.
        return !value.unicodeScalars.contains(where: { $0.value < 0x20 || (0x7f...0x9f).contains($0.value) })
    }
    static func identifier(_ value: Any?) -> Bool {
        guard let value = value as? String else { return false }
        return value.range(of: "^[A-Za-z0-9_-]{1,120}$", options: .regularExpression) != nil
    }
    static func date(_ value: Any?) -> Bool {
        guard let value = value as? String, value.utf8.count <= 40 else { return false }
        return timestamp(value) != nil
    }
    static func timestamp(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

enum CompanionGeometry {
    /// Screen rectangles may have negative origins. Use the actual visible frame
    /// and safe-area top; never assume the notebook is the primary display.
    static func frame(screen: CGRect, visible: CGRect, safeAreaTop: CGFloat,
                      menuBarHeight: CGFloat, expanded: Bool, rows: Int) -> CGRect {
        let intersection = visible.intersection(screen)
        guard !intersection.isNull else { return .zero }
        let ceiling = min(intersection.maxY, screen.maxY - max(0, safeAreaTop, menuBarHeight))
        let area = CGRect(x: intersection.minX, y: intersection.minY, width: intersection.width, height: max(0, ceiling - intersection.minY))
        guard area.width > 0, area.height > 0 else { return .zero }
        let margin: CGFloat = min(8, area.width / 8, area.height / 8)
        let width = min(expanded ? 370 : 326, max(1, area.width - margin * 2))
        let wantedHeight: CGFloat = expanded ? CGFloat(158 + min(6, max(0, rows)) * 66) : 76
        let height = min(wantedHeight, max(1, area.height - margin * 2))
        let top = area.maxY - margin
        let x = min(max(screen.midX - width / 2, area.minX + margin), area.maxX - width - margin)
        let y = min(max(top - height, area.minY + margin), area.maxY - height - margin)
        return CGRect(x: x, y: y, width: width, height: height)
    }
    static func canonicalScreen(_ value: String) -> Bool {
        value == "main" || UUID(uuidString: value)?.uuidString == value
    }
}

/// Pure lifecycle rules shared by native ownership and the executable tests.
struct CompanionLifecycle {
    var enabled = false
    var configured = false
    var awake = true
    var sessionActive = true
    var displayAvailable = true
    var applicationHidden = false
    var stopped = false
    var generation: UInt64 = 0
    var shouldShow: Bool { enabled && configured && awake && sessionActive && displayAvailable && !applicationHidden && !stopped }
    mutating func invalidate() { generation &+= 1 }
    func accepts(_ requestGeneration: UInt64) -> Bool { shouldShow && generation == requestGeneration }
}
