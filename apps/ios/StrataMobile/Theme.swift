import SwiftUI

enum StrataTheme {
    // Shared with the Mac facelift. The neutral hierarchy and blue interaction
    // color follow BotAI's actual mobile palette; Strata keeps its mint mark.
    static let background = adaptive(0xFCFCFC, 0x070707)
    static let surface = adaptive(0xFFFFFF, 0x181818)
    static let surfaceSecondary = adaptive(0xF7F7F7, 0x111111)
    static let grouped = adaptive(0xF1F1F1, 0x202020)
    static let line = adaptive(0xE3E3E3, 0x303030, highLight: 0x969696, highDark: 0x777777)
    static let ink = adaptive(0x141414, 0xFCFCFC)
    static let secondaryInk = adaptive(0x626262, 0xA8A8A8)
    static let accent = adaptive(0x0C64C1, 0x459FFE)
    static let accentText = accent
    static let accentTint = adaptive(0xEAF2FC, 0x10243B)
    static let accentInk = adaptive(0xFFFFFF, 0x061B33)
    static let primaryFill = adaptive(0x141414, 0xFCFCFC)
    static let primaryInk = adaptive(0xFFFFFF, 0x141414)
    static let userBubble = adaptive(0x141414, 0x0C64C1)
    static let userBubbleInk = Color.white
    static let assistantBubble = adaptive(0xF1F1F1, 0x202020)
    static let logoMint = Color(hex: 0x34D399)
    static let success = adaptive(0x007C49, 0x38D591)
    static let successTint = adaptive(0xEAF7EF, 0x10291E)
    static let warning = adaptive(0x875500, 0xFFAF38)
    static let warningTint = adaptive(0xFFF6E6, 0x30220D)
    static let destructive = adaptive(0xB42318, 0xFF817A)

    private static func adaptive(_ light: UInt, _ dark: UInt, highLight: UInt? = nil, highDark: UInt? = nil) -> Color {
        Color(uiColor: UIColor { traits in
            let high = traits.accessibilityContrast == .high
            let value = traits.userInterfaceStyle == .dark ? (high ? highDark ?? dark : dark) : (high ? highLight ?? light : light)
            return UIColor(rgb: value)
        })
    }
}

private extension UIColor {
    convenience init(rgb: UInt) {
        self.init(red: Double((rgb >> 16) & 0xFF) / 255,
                  green: Double((rgb >> 8) & 0xFF) / 255,
                  blue: Double(rgb & 0xFF) / 255, alpha: 1)
    }
}

extension Color {
    init(hex: UInt) { self.init(uiColor: UIColor(rgb: hex)) }
}

struct StrataPrimaryButtonStyle: ButtonStyle {
    var compact = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: compact ? 44 : 50)
            .padding(.horizontal, 16)
            .foregroundStyle(StrataTheme.primaryInk)
            .background(StrataTheme.primaryFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .opacity(enabled ? (configuration.isPressed ? 0.76 : 1) : 0.42)
            .scaleEffect(!reduceMotion && configuration.isPressed ? 0.985 : 1)
    }
}

struct StrataSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 46)
            .padding(.horizontal, 16)
            .foregroundStyle(StrataTheme.ink)
            .background(StrataTheme.grouped, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .opacity(enabled ? (configuration.isPressed ? 0.65 : 1) : 0.42)
    }
}

private struct StrataChrome: ViewModifier {
    var radius: CGFloat
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), !reduceTransparency {
            content.glassEffect(.regular, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
        } else {
            content.background(StrataTheme.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(StrataTheme.line, lineWidth: 0.7))
        }
    }
}

extension View {
    func strataCard(padding: CGFloat = 20) -> some View {
        self.padding(padding)
            .background(StrataTheme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(StrataTheme.line, lineWidth: 0.7))
    }
    func strataChrome(radius: CGFloat = 22) -> some View { modifier(StrataChrome(radius: radius)) }
    func strataList() -> some View {
        self.listStyle(.insetGrouped).listSectionSpacing(20)
            .scrollContentBackground(.hidden).background(StrataTheme.background)
            .listRowSeparatorTint(StrataTheme.line)
    }
}

enum StrataStatusTone { case neutral, accent, success, attention }

struct StrataStatusPill: View {
    let title: String
    var icon: String? = nil
    var tone: StrataStatusTone = .neutral
    private var foreground: Color {
        switch tone { case .neutral: StrataTheme.secondaryInk; case .accent: StrataTheme.accentText; case .success: StrataTheme.success; case .attention: StrataTheme.warning }
    }
    private var fill: Color {
        switch tone { case .neutral: StrataTheme.grouped; case .accent: StrataTheme.accentTint; case .success: StrataTheme.successTint; case .attention: StrataTheme.warningTint }
    }
    var body: some View {
        HStack(spacing: 5) { if let icon { Image(systemName: icon) }; Text(title) }
            .font(.caption.weight(.semibold)).foregroundStyle(foreground)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(fill, in: Capsule()).fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
    }
}

struct StrataSectionHeading: View {
    let title: String
    var subtitle: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.title3.weight(.semibold)).foregroundStyle(StrataTheme.ink)
            if let subtitle { Text(subtitle).font(.subheadline).foregroundStyle(StrataTheme.secondaryInk) }
        }.accessibilityAddTraits(.isHeader)
    }
}
