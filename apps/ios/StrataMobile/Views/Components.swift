import SwiftUI

struct StrataMark: View {
    var size: CGFloat = 34

    var body: some View {
        VStack(spacing: size * 0.095) {
            Capsule().fill(StrataTheme.ink).frame(width: size * 0.54)
            Capsule().fill(StrataTheme.logoMint).frame(width: size * 0.79)
            Capsule().fill(StrataTheme.ink).frame(width: size * 0.54)
        }
        .frame(width: size, height: size * 0.64)
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// A quiet, original stage for Strata's own characters. Motion belongs to the avatar.
struct StrataCompanionStage<Face: View>: View {
    let size: CGFloat
    let tint: Color
    let face: Face
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    init(size: CGFloat, tint: Color, @ViewBuilder face: () -> Face) {
        self.size = size
        self.tint = tint
        self.face = face()
    }

    var body: some View {
        ZStack {
            ZStack {
                if !reduceTransparency {
                    Circle()
                        .fill(RadialGradient(colors: [tint.opacity(0.13), tint.opacity(0)], center: .center, startRadius: 0, endRadius: size * 0.65))
                        .frame(width: size * 1.35, height: size * 1.35)
                }
                Ellipse().fill(StrataTheme.line.opacity(0.65))
                    .frame(width: size * 0.47, height: size * 0.045)
                    .offset(y: size * 0.52)
                Image(systemName: "sparkle")
                    .font(.system(size: size * 0.075, weight: .medium))
                    .foregroundStyle(tint.opacity(0.45))
                    .offset(x: -size * 0.57, y: -size * 0.23)
                Circle().fill(tint.opacity(0.4))
                    .frame(width: size * 0.03, height: size * 0.03)
                    .offset(x: size * 0.57, y: size * 0.18)
            }.accessibilityHidden(true).allowsHitTesting(false)
            face
        }.frame(width: size * 1.35, height: size * 1.22)
    }
}

struct StrataHeader: View {
    var isPaired: Bool
    var isOnline: Bool = false
    var onConnection: () -> Void

    var body: some View {
        HStack(spacing: 7) {
            StrataMark()
            Text("strata")
                .font(.system(.title2, weight: .semibold))
                .tracking(-0.6)
                .foregroundStyle(StrataTheme.ink)
            Spacer()
            Button(action: onConnection) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(isOnline ? StrataTheme.success : StrataTheme.secondaryInk.opacity(0.45))
                        .frame(width: 6, height: 6)
                    Text(isOnline ? "Connected" : isPaired ? "Paired" : "Not paired")
                        .font(.system(.caption, weight: .medium))
                }
                .foregroundStyle(StrataTheme.secondaryInk)
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .strataChrome(radius: 16)
            }
            .accessibilityIdentifier("connectionStatus")
            .accessibilityLabel("Connection: \(isOnline ? "connected" : isPaired ? "paired" : "not paired")")
        }
    }
}

struct PageHeading: View {
    let eyebrow: String
    let title: String
    var subtitle: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(eyebrow.uppercased())
                .font(.system(.caption2, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(StrataTheme.secondaryInk)
            Text(title)
                .font(.system(.title, weight: .semibold))
                .tracking(-0.4)
                .foregroundStyle(StrataTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
            if let subtitle {
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(StrataTheme.secondaryInk)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct PairingIllustration: View {
    var compact = false

    var body: some View {
        GeometryReader { proxy in
            let center = CGPoint(x: proxy.size.width / 2, y: proxy.size.height / 2)
            ZStack {
                ForEach(0..<3) { index in
                    Circle()
                        .stroke(StrataTheme.accent.opacity(0.10 + Double(index) * 0.02), lineWidth: 1)
                        .frame(width: CGFloat(110 + index * 64), height: CGFloat(110 + index * 64))
                        .position(center)
                }
                Circle()
                    .fill(StrataTheme.accent.opacity(0.055))
                    .frame(width: 220, height: 220)
                    .position(center)
                HStack(alignment: .center, spacing: 17) {
                    VStack(spacing: 6) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 12)
                                .fill(StrataTheme.surface)
                                .frame(width: 125, height: 86)
                                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(StrataTheme.ink, lineWidth: 2.5))
                            StrataMark(size: 37)
                        }
                        Capsule().fill(StrataTheme.ink).frame(width: 50, height: 4)
                    }
                    Image(systemName: "link")
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(StrataTheme.accentText)
                        .rotationEffect(.degrees(-20))
                    ZStack {
                        RoundedRectangle(cornerRadius: 16)
                            .fill(StrataTheme.surface)
                            .frame(width: 58, height: 105)
                            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(StrataTheme.ink, lineWidth: 2.5))
                        VStack {
                            Capsule().fill(StrataTheme.ink).frame(width: 21, height: 5)
                            Spacer(minLength: 15)
                            Image(systemName: "checkmark")
                                .font(.system(size: 19, weight: .bold))
                                .foregroundStyle(StrataTheme.accentText)
                                .frame(width: 32, height: 32)
                                .background(StrataTheme.accentTint, in: Circle())
                            Spacer(minLength: 15)
                            Capsule().fill(StrataTheme.ink.opacity(0.6)).frame(width: 21, height: 3)
                        }
                        .padding(.vertical, 7)
                        .frame(width: 58, height: 105)
                    }
                    .rotationEffect(.degrees(7))
                    .offset(y: 9)
                }
                .position(center)
            }
        }
        .frame(height: compact ? 160 : 204)
        .clipped()
        .accessibilityHidden(true)
    }
}

struct ConnectionNeededView: View {
    let icon: String
    let title: String
    let message: String
    let pair: () -> Void

    var body: some View {
        VStack(spacing: 22) {
            Image(systemName: icon)
                .font(.system(size: 26, weight: .regular))
                .foregroundStyle(StrataTheme.ink)
                .frame(width: 64, height: 64)
                .background(StrataTheme.surfaceSecondary, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            VStack(spacing: 8) {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(StrataTheme.ink)
                    .multilineTextAlignment(.center)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(StrataTheme.secondaryInk)
                    .lineSpacing(3)
                    .multilineTextAlignment(.center)
            }
            Button(action: pair) {
                Label("Pair your Mac", systemImage: "qrcode.viewfinder")
            }
            .buttonStyle(StrataPrimaryButtonStyle())
            .accessibilityIdentifier("emptyStatePairButton")
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 28)
        .frame(maxWidth: .infinity)
        .strataCard(padding: 0)
    }
}

struct DetailRow: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(StrataTheme.ink)
                .frame(width: 36, height: 36)
                .background(StrataTheme.surfaceSecondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(.subheadline, weight: .semibold)).foregroundStyle(StrataTheme.ink)
                Text(detail).font(.caption).foregroundStyle(StrataTheme.secondaryInk).lineSpacing(3)
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}


struct StrataTeamAvatars: View {
    let bots: [CompanionBot]
    var size: CGFloat = 48
    var horizontal = false
    var body: some View {
        ZStack {
            if bots.isEmpty { Image(systemName: "person.3.fill").font(.system(size: size * 0.44)).foregroundStyle(StrataTheme.secondaryInk) }
            else {
                ForEach(Array(bots.prefix(3).enumerated()), id: \.element.id) { index, bot in
                    AvatarBadge(bot.face, size: size * (horizontal ? 0.78 : 0.66))
                        .offset(x: horizontal ? (CGFloat(index) - CGFloat(min(bots.count, 3) - 1) / 2) * size * 0.36 : index == 1 ? -size * 0.20 : index == 2 ? size * 0.20 : 0,
                                y: horizontal ? 0 : index == 0 ? -size * 0.18 : size * 0.16)
                }
            }
        }.frame(width: horizontal ? size * 1.50 : size, height: size).accessibilityHidden(true)
    }
}

struct RoomMentionMember: Equatable {
    var id: String
    var name: String
}

struct RoomMentionQuery: Equatable {
    var start: Int
    var query: String
}

struct RoomMentionChoice: Equatable {
    var kind: String
    var memberID: String
    var label: String
    var rowID: String { "\(kind):\(memberID)" }
}

struct RoomMentionEdit: Equatable {
    var text: String
    var cursor: Int
}

struct RoomMentionAudience: Equatable {
    var recipientIds: [String]?
    var everyone: Bool?
}

/// Mention text for a room composer. Inserting a token does not choose recipients.
enum RoomMention {
    static func query(text: String, cursor: Int) -> RoomMentionQuery? {
        let chars = Array(text)
        let end = max(0, min(cursor, chars.count))
        guard end > 0 else { return nil }
        var at = -1
        var index = end - 1
        while index >= 0 {
            let character = chars[index]
            if character == "@" { at = index; break }
            if character.isWhitespace { return nil }
            if index == 0 { break }
            index -= 1
        }
        guard at >= 0 else { return nil }
        if at > 0, !chars[at - 1].isWhitespace { return nil }
        let query = String(chars[(at + 1)..<end])
        if query.contains(where: { $0.isWhitespace || $0 == "@" }) { return nil }
        return RoomMentionQuery(start: at, query: query)
    }

    static func choices(members: [RoomMentionMember], query: String) -> [RoomMentionChoice] {
        let needle = query.lowercased()
        func matches(_ value: String) -> Bool { value.lowercased().contains(needle) }
        var rows: [RoomMentionChoice] = []
        if matches("everyone") || (!needle.isEmpty && "all".hasPrefix(needle)) {
            rows.append(RoomMentionChoice(kind: "everyone", memberID: "everyone", label: "everyone"))
        }
        for member in members {
            let trimmed = member.name.trimmingCharacters(in: .whitespacesAndNewlines)
            let label = trimmed.isEmpty ? "Unavailable bot" : trimmed
            if matches(label) || matches(member.id) {
                rows.append(RoomMentionChoice(kind: "member", memberID: member.id, label: label))
            }
        }
        return rows
    }

    static func nameRoutes(_ name: String) -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 1 else { return false }
        let escaped = NSRegularExpression.escapedPattern(for: trimmed)
        guard let expression = try? NSRegularExpression(pattern: "(?:^|\\s)@\(escaped)\\b", options: [.caseInsensitive]) else { return false }
        let sample = "@\(trimmed) "
        return expression.firstMatch(in: sample, range: NSRange(sample.startIndex..., in: sample)) != nil
    }

    static func insertion(choice: RoomMentionChoice, members: [RoomMentionMember]) -> String {
        if choice.kind == "everyone" { return "@everyone " }
        let name = members.first { $0.id == choice.memberID }?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return nameRoutes(name) ? "@\(name) " : "@\(choice.memberID) "
    }

    static func insert(text: String, query: RoomMentionQuery, cursor: Int, token: String) -> RoomMentionEdit {
        let chars = Array(text)
        let start = max(0, min(query.start, chars.count))
        let end = max(start, min(cursor, chars.count))
        let next = String(chars[..<start]) + token + String(chars[end...])
        return RoomMentionEdit(text: next, cursor: start + token.count)
    }

    static func keyAction(_ key: String) -> String {
        switch key {
        case "ArrowDown": return "down"
        case "ArrowUp": return "up"
        case "Enter", "Tab": return "pick"
        case "Escape", " ": return "close"
        default: return "noop"
        }
    }

    static func keyStops(_ key: String) -> Bool {
        let action = keyAction(key)
        return action == "down" || action == "up" || action == "pick" || key == "Escape"
    }

    static func moveIndex(_ index: Int, count: Int, direction: String) -> Int {
        guard count > 0 else { return 0 }
        let current = min(max(index, 0), count - 1)
        return direction == "down" ? min(current + 1, count - 1) : max(current - 1, 0)
    }

    static func listVisible(activeStart: Int?, dismissedStart: Int?, choiceCount: Int) -> Bool {
        guard let activeStart, choiceCount > 0 else { return false }
        return activeStart != dismissedStart
    }

    static func addressesEveryone(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let expression = try? NSRegularExpression(pattern: "(?:^|\\s)@(?:everyone|all)\\b", options: [.caseInsensitive]) else { return false }
        return expression.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)) != nil
    }

    static func audience(text: String, recipient: String, memberIds: [String]) -> RoomMentionAudience {
        if recipient == "everyone" { return RoomMentionAudience(recipientIds: memberIds, everyone: true) }
        if !recipient.isEmpty { return RoomMentionAudience(recipientIds: [recipient], everyone: nil) }
        if addressesEveryone(text) { return RoomMentionAudience(recipientIds: nil, everyone: true) }
        return RoomMentionAudience(recipientIds: nil, everyone: nil)
    }
}

struct RoomReplySource: Equatable {
    var id: String
    var kind: String
    var authorType: String
    var content: String
    var replyToId: String?
    var replyGroupId: String?
    var recipientIds: [String]?
    var hasRecovery: Bool
}

enum RoomFeedEntry: Equatable {
    case message(String)
    case replies(id: String, triggerId: String, messageIds: [String])
}

/// Stacks bot replies that share replyGroupId. A missing field uses a consecutive run.
enum RoomReplyGroup {
    static let previewLimit = 5
    static let staggerSeconds = 0.06
    static let previewCharacters = 160

    static func label(_ count: Int) -> String {
        if count == 1 { return "1 bot replied" }
        return "\(count) bots replied"
    }

    static func stagger(_ index: Int) -> Double {
        Double(max(0, index)) * staggerSeconds
    }

    static func visibleCount(_ total: Int, expanded: Bool) -> Int {
        expanded || total <= previewLimit ? total : previewLimit
    }

    static func preview(_ content: String) -> String {
        let line = content.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
        if line.count <= previewCharacters { return String(line) }
        return String(line.prefix(previewCharacters)) + "…"
    }

    static func addressesRoom(content: String, recipientIds: [String]?, memberIds: [String]) -> Bool {
        if RoomMention.addressesEveryone(content) { return true }
        guard !memberIds.isEmpty, let recipientIds, recipientIds.count == memberIds.count else { return false }
        let members = Set(memberIds)
        guard members.count == memberIds.count else { return false }
        var seen = Set<String>()
        for id in recipientIds {
            if !members.contains(id) || seen.contains(id) { return false }
            seen.insert(id)
        }
        return seen.count == members.count
    }

    static func group(messages: [RoomReplySource], memberIds: [String]) -> [RoomFeedEntry] {
        var buckets: [String: [Int]] = [:]
        for (index, message) in messages.enumerated() {
            let groupId = replyGroupKey(message)
            guard !groupId.isEmpty, canGroup(message) else { continue }
            buckets[groupId, default: []].append(index)
        }
        var explicit = Set<Int>()
        for indices in buckets.values where indices.count >= 2 {
            explicit.formUnion(indices)
        }
        var items: [RoomFeedEntry] = []
        var index = 0
        while index < messages.count {
            let message = messages[index]
            let groupId = replyGroupKey(message)
            if !groupId.isEmpty, explicit.contains(index), let indices = buckets[groupId] {
                if indices.first == index {
                    items.append(.replies(id: messages[indices[0]].id, triggerId: groupId, messageIds: indices.map { messages[$0].id }))
                }
                index += 1
                continue
            }
            let run = fallbackRun(messages: messages, start: index, memberIds: memberIds, explicit: explicit)
            if run.count >= 2 {
                let first = messages[run[0]]
                let replyTo = replyKey(first)
                let triggerId = replyTo.isEmpty ? (index > 0 ? messages[index - 1].id : first.id) : replyTo
                items.append(.replies(id: first.id, triggerId: triggerId, messageIds: run.map { messages[$0].id }))
                index = run[run.count - 1] + 1
                continue
            }
            items.append(.message(message.id))
            index += 1
        }
        return items
    }

    private static func canGroup(_ message: RoomReplySource) -> Bool {
        message.authorType == "bot" && message.kind == "message" && !message.hasRecovery
    }

    private static func replyGroupKey(_ message: RoomReplySource) -> String {
        message.replyGroupId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private static func replyKey(_ message: RoomReplySource) -> String {
        message.replyToId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private static func fallbackRun(messages: [RoomReplySource], start: Int, memberIds: [String], explicit: Set<Int>) -> [Int] {
        guard messages.indices.contains(start) else { return [] }
        let first = messages[start]
        guard !explicit.contains(start), canGroup(first), replyGroupKey(first).isEmpty else { return [] }
        let replyTo = replyKey(first)
        if !replyTo.isEmpty {
            guard let target = messages.first(where: { $0.id == replyTo }), addressesRoom(content: target.content, recipientIds: target.recipientIds, memberIds: memberIds) else { return [] }
            var run = [start]
            var cursor = start + 1
            while cursor < messages.count {
                let next = messages[cursor]
                if explicit.contains(cursor) || !canGroup(next) || !replyGroupKey(next).isEmpty || replyKey(next) != replyTo { break }
                run.append(cursor)
                cursor += 1
            }
            return run.count >= 2 ? run : []
        }
        guard start > 0 else { return [] }
        let previous = messages[start - 1]
        guard previous.authorType == "user", addressesRoom(content: previous.content, recipientIds: previous.recipientIds, memberIds: memberIds) else { return [] }
        var run = [start]
        var cursor = start + 1
        while cursor < messages.count {
            let next = messages[cursor]
            if explicit.contains(cursor) || !canGroup(next) || !replyGroupKey(next).isEmpty || !replyKey(next).isEmpty { break }
            run.append(cursor)
            cursor += 1
        }
        return run.count >= 2 ? run : []
    }
}

struct RoomMentionList: View {
    var choices: [RoomMentionChoice]
    var selected: Int
    var face: (RoomMentionChoice) -> AvatarConfig
    var onPick: (RoomMentionChoice) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(choices.enumerated()), id: \.element.rowID) { index, choice in
                Button { onPick(choice) } label: {
                    HStack(spacing: 10) {
                        if choice.kind == "everyone" {
                            Image(systemName: "person.2.fill")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(StrataTheme.ink.opacity(0.72))
                                .frame(width: 28, height: 28)
                                .background(StrataTheme.surfaceSecondary, in: Circle())
                        } else {
                            AvatarBadge(face(choice), size: 28)
                        }
                        Text(choice.label)
                            .font(.body)
                            .foregroundStyle(StrataTheme.ink)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(index == selected ? StrataTheme.surfaceSecondary : Color.clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier(choice.kind == "everyone" ? "teamMention-everyone" : "teamMention-\(choice.memberID)")
            }
        }
        .padding(8)
        .background(StrataTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: .black.opacity(0.28), radius: 16, y: 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("teamMentionList")
        .offset(y: reduceMotion || shown ? 0 : CoucouMotion.messageRise)
        .opacity(reduceMotion || shown ? 1 : 0)
        .onAppear {
            guard !reduceMotion else { shown = true; return }
            withAnimation(.spring(response: CoucouMotion.springResponse, dampingFraction: CoucouMotion.springDamping)) {
                shown = true
            }
        }
    }
}

/// Coucou chat motion. Springs stay at response 0.28 and damping 0.82.
enum CoucouMotion {
    static let springResponse = 0.28
    static let springDamping = 0.82
    static let messageRise: CGFloat = 8
    static let messageStagger = 0.04
    static let typingDot: CGFloat = 5
    static let typingScaleMin: CGFloat = 0.6
    static let typingScaleMax: CGFloat = 1.2
    static let typingCycle = 0.9
    static let typingStagger = 0.14
    static let shimmerDuration = 2.2
    static let statusCycle = 1.8
}

struct CoucouRow: Equatable {
    var id: String
    var own: Bool
}

struct CoucouEntrance: Equatable {
    var delay: Double
    var fast: Bool
}

/// The first ready snapshot is history. Later rows rise in. A prepend does not.
final class CoucouArrivals {
    private var scope = ""
    private var primed = false
    private var seen = Set<String>()
    private var signature = ""
    private var entrances: [String: CoucouEntrance] = [:]

    func begin(key: String, rows: [CoucouRow], ready: Bool) {
        if key != scope {
            scope = key
            primed = false
            seen = []
            signature = ""
            entrances = [:]
        }
        guard ready else {
            primed = false
            signature = ""
            return
        }
        let nextSignature = rows.map { "\($0.own ? "1" : "0"):\($0.id)" }.joined(separator: "\n")
        if !primed {
            primed = true
            seen = Set(rows.map(\.id))
            signature = nextSignature
            entrances = [:]
            return
        }
        if nextSignature == signature { return }
        signature = nextSignature
        if let first = rows.first, !seen.contains(first.id), !seen.isEmpty {
            for row in rows { seen.insert(row.id) }
            return
        }
        let freshBots = rows.filter { !$0.own && !seen.contains($0.id) }.count
        var botIndex = 0
        for row in rows {
            if seen.contains(row.id) { continue }
            seen.insert(row.id)
            let delay = !row.own && freshBots > 1 ? Double(botIndex) * CoucouMotion.messageStagger : 0
            if !row.own { botIndex += 1 }
            entrances[row.id] = CoucouEntrance(delay: delay, fast: row.own)
        }
    }

    func entrance(id: String) -> CoucouEntrance? { entrances[id] }

    func finish(id: String) { entrances.removeValue(forKey: id) }
}

struct CoucouMessageEnter<Content: View>: View {
    let entrance: CoucouEntrance?
    let onDone: () -> Void
    let content: Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false
    @State private var started = false

    init(entrance: CoucouEntrance?, onDone: @escaping () -> Void, @ViewBuilder content: () -> Content) {
        self.entrance = entrance
        self.onDone = onDone
        self.content = content()
    }

    var body: some View {
        content
            .opacity(reduceMotion || entrance == nil || shown ? 1 : 0)
            .offset(y: reduceMotion || entrance == nil || shown ? 0 : CoucouMotion.messageRise)
            .onAppear {
                guard !started else { return }
                started = true
                guard let entrance, !reduceMotion else { return }
                withAnimation(.spring(response: CoucouMotion.springResponse, dampingFraction: CoucouMotion.springDamping).delay(entrance.delay)) {
                    shown = true
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + entrance.delay + CoucouMotion.springResponse) { onDone() }
            }
    }
}

struct TypingDots: View {
    var label: String
    var hiddenLabel = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = true

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Color(red: 107 / 255, green: 112 / 255, blue: 121 / 255))
                    .frame(width: CoucouMotion.typingDot, height: CoucouMotion.typingDot)
                    .modifier(CoucouTypingWave(index: index, active: visible && !reduceMotion))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(hiddenLabel ? "" : label)
        .accessibilityHidden(hiddenLabel)
        .modifier(CoucouVisibility(visible: $visible))
    }
}

private struct CoucouTypingWave: ViewModifier {
    let index: Int
    let active: Bool
    @State private var lifted = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(active && lifted ? CoucouMotion.typingScaleMax : CoucouMotion.typingScaleMin)
            .opacity(active && lifted ? 1 : 0.4)
            .onAppear { restart() }
            .onChange(of: active) { _, _ in restart() }
    }

    private func restart() {
        lifted = false
        guard active else { return }
        withAnimation(.easeInOut(duration: CoucouMotion.typingCycle).repeatForever(autoreverses: true).delay(Double(index) * CoucouMotion.typingStagger)) {
            lifted = true
        }
    }
}

struct ShimmerText: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = true

    var body: some View {
        Text(text)
            .foregroundStyle(reduceMotion || !visible ? AnyShapeStyle(StrataTheme.secondaryInk) : AnyShapeStyle(Color.clear))
            .overlay { band }
            .modifier(CoucouVisibility(visible: $visible))
    }

    @ViewBuilder private var band: some View {
        if !reduceMotion && visible {
            TimelineView(.animation(minimumInterval: 1.0 / 20.0, paused: false)) { context in
                let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: CoucouMotion.shimmerDuration) / CoucouMotion.shimmerDuration
                GeometryReader { geometry in
                    LinearGradient(stops: [
                        .init(color: Color(red: 124 / 255, green: 129 / 255, blue: 138 / 255), location: 0),
                        .init(color: Color(red: 242 / 255, green: 243 / 255, blue: 245 / 255), location: 0.4),
                        .init(color: Color(red: 124 / 255, green: 129 / 255, blue: 138 / 255), location: 0.7)
                    ], startPoint: .leading, endPoint: .trailing)
                    .frame(width: geometry.size.width * 2.6)
                    .offset(x: geometry.size.width * 2.6 * (0.5 - phase) - geometry.size.width * 0.8)
                }
                .mask(Text(text))
            }
        }
    }
}

struct BreathingStatusDot: View {
    enum Kind { case idle, working, paused, attention }
    var kind: Kind
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = true
    @State private var lifted = false

    private var breathes: Bool { kind == .idle || kind == .working }

    var body: some View {
        Circle()
            .fill(kind == .attention ? StrataTheme.warning : kind == .paused ? StrataTheme.secondaryInk : StrataTheme.success)
            .frame(width: 8, height: 8)
            .scaleEffect(breathes && lifted && visible && !reduceMotion ? 1.2 : 1)
            .opacity(breathes && visible && !reduceMotion ? (lifted ? 1 : 0.45) : 1)
            .onAppear { restart() }
            .onChange(of: visible) { _, _ in restart() }
            .onChange(of: reduceMotion) { _, _ in restart() }
            .modifier(CoucouVisibility(visible: $visible))
            .accessibilityHidden(true)
    }

    private func restart() {
        lifted = false
        guard breathes, visible, !reduceMotion else { return }
        withAnimation(.easeInOut(duration: CoucouMotion.statusCycle / 2).repeatForever(autoreverses: true)) { lifted = true }
    }
}

func coucouKind(mood: BotMood, paused: Bool) -> BreathingStatusDot.Kind {
    if paused || mood == .paused { return .paused }
    if mood == .needsApproval || mood == .error { return .attention }
    if mood == .thinking || mood == .working { return .working }
    return .idle
}

struct RoomChoiceOption: Equatable, Identifiable {
    var id: String
    var label: String
    var style: String?
}

struct RoomRecoveryPresentation: Equatable {
    var messageId: String
    var teamId: String
    var text: String
    var question: String
    var options: [RoomChoiceOption]
    var choice: String?
}

/// The room card reads the host's recovery field and the same live event shape. Labels are never invented here.
enum RoomChoice {
    static let choiceIds: Set<String> = ["retry", "skip", "different"]

    static func fromMessage(id: String, teamId: String, content: String, recovery: BotTeamMessageRecovery?) -> RoomRecoveryPresentation? {
        guard let recovery else { return nil }
        return present(messageId: id, teamId: teamId, jobId: recovery.jobId, runId: recovery.runId, text: recovery.text ?? "", question: recovery.question, options: recovery.options.map { RoomChoiceOption(id: $0.id, label: $0.label, style: nil) }, choice: recovery.choice, fallback: content)
    }

    static func fromEvent(teamId: String, messageId: String, jobId: String, runId: String, text: String, question: String, options: [RoomChoiceOption]) -> RoomRecoveryPresentation? {
        present(messageId: messageId, teamId: teamId, jobId: jobId, runId: runId, text: text, question: question, options: options, choice: nil, fallback: "")
    }

    static func choiceId(_ optionId: String) -> String? {
        choiceIds.contains(optionId) ? optionId : nil
    }

    private static func present(messageId: String, teamId: String, jobId: String, runId: String, text: String, question: String, options: [RoomChoiceOption], choice: String?, fallback: String) -> RoomRecoveryPresentation? {
        let rows = options.compactMap { option -> RoomChoiceOption? in
            let id = option.id.trimmingCharacters(in: .whitespacesAndNewlines)
            let label = option.label.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty, !label.isEmpty else { return nil }
            return RoomChoiceOption(id: id, label: label, style: option.style)
        }
        let asked = question.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? (fallback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? asked : fallback.trimmingCharacters(in: .whitespacesAndNewlines)) : text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !messageId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !teamId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !jobId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !runId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !asked.isEmpty, !body.isEmpty, !rows.isEmpty else { return nil }
        let selected = choiceIds.contains(choice ?? "") && rows.contains { $0.id == choice } ? choice : nil
        return RoomRecoveryPresentation(messageId: messageId, teamId: teamId, text: body, question: asked, options: rows, choice: selected)
    }
}

struct RoomChoiceCard: View {
    var text: String
    var options: [RoomChoiceOption]
    var chosen: String?
    var busy: String
    var error: String = ""
    var onChoose: (String) -> Void
    var onRetry: () -> Void = {}
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    var body: some View {
        let locked = chosen != nil || !busy.isEmpty
        VStack(alignment: .leading, spacing: 12) {
            Text(text).font(.body).foregroundStyle(StrataTheme.ink).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(options) { option in
                    Button(busy == option.id ? "Sending…" : option.label) { onChoose(option.id) }
                        .buttonStyle(.bordered)
                        .tint(chosen == option.id ? StrataTheme.accentText : (option.style == "danger" ? StrataTheme.destructive : StrataTheme.ink))
                        .disabled(locked)
                        .accessibilityIdentifier("teamRoomChoice-\(option.id)")
                        .accessibilityAddTraits(chosen == option.id ? .isSelected : [])
                }
            }
            if chosen == nil, !error.isEmpty {
                Text(error).font(.caption).foregroundStyle(StrataTheme.warning).fixedSize(horizontal: false, vertical: true)
                Button("Retry", action: onRetry).font(.caption).accessibilityIdentifier("teamRoomChoiceRetry")
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StrataTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(chosen == nil ? StrataTheme.line : StrataTheme.accent.opacity(0.7), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("teamRoomChoice")
        .offset(y: reduceMotion || shown ? 0 : CoucouMotion.messageRise)
        .opacity(reduceMotion || shown ? 1 : 0)
        .onAppear {
            guard !reduceMotion else { shown = true; return }
            withAnimation(.spring(response: CoucouMotion.springResponse, dampingFraction: CoucouMotion.springDamping)) { shown = true }
        }
    }
}

private struct CoucouVisibility: ViewModifier {
    @Binding var visible: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollVisibilityChange(threshold: 0.01) { visible = $0 }.onDisappear { visible = false }
        } else {
            content.onAppear { visible = true }.onDisappear { visible = false }
        }
    }
}
