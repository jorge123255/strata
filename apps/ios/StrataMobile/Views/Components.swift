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
                .font(.system(.title2, weight: .bold))
                .tracking(-1)
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
                .padding(.horizontal, 11)
                .frame(minHeight: 44)
                .strataChrome(radius: 22)
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
        VStack(alignment: .leading, spacing: 9) {
            Text(eyebrow.uppercased())
                .font(.system(.caption2, weight: .bold))
                .tracking(1.1)
                .foregroundStyle(StrataTheme.secondaryInk)
            Text(title)
                .font(.system(.largeTitle, weight: .bold))
                .tracking(-0.8)
                .foregroundStyle(StrataTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
            if let subtitle {
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(StrataTheme.secondaryInk)
                    .lineSpacing(4)
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
        VStack(spacing: 21) {
            Image(systemName: icon)
                .font(.system(size: 30, weight: .regular))
                .foregroundStyle(StrataTheme.accentText)
                .frame(width: 80, height: 80)
                .background(StrataTheme.grouped, in: RoundedRectangle(cornerRadius: 22))
            VStack(spacing: 9) {
                Text(title)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(StrataTheme.ink)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(StrataTheme.secondaryInk)
                    .lineSpacing(4)
                    .multilineTextAlignment(.center)
            }
            Button(action: pair) {
                Label("Pair your Mac", systemImage: "qrcode.viewfinder")
            }
            .buttonStyle(StrataPrimaryButtonStyle())
            .accessibilityIdentifier("emptyStatePairButton")
        }
        .padding(24)
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
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(StrataTheme.accentText)
                .frame(width: 36, height: 36)
                .background(StrataTheme.accentTint, in: RoundedRectangle(cornerRadius: 11))
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
