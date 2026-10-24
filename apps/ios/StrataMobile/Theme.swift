import SwiftUI

enum StrataTheme {
    // Same calm neutrals as the Mac Bots facelift. Accent stays on links,
    // unread marks, and small status tints. Strata keeps its mint mark.
    static let background = adaptive(0xF6F7F8, 0x0E0F12)
    static let surface = adaptive(0xFFFFFF, 0x16171B)
    static let surfaceSecondary = adaptive(0xF3F4F6, 0x1D1F24)
    static let grouped = adaptive(0xEEF0F3, 0x22242A)
    static let line = adaptive(0xECEEF2, 0x26282E, highLight: 0x5C6370, highDark: 0xAEB4BE)
    static let ink = adaptive(0x1C1C1E, 0xF5F6F8)
    static let secondaryInk = adaptive(0x5C6370, 0xAEB4BE)
    static let accent = adaptive(0x3D6F99, 0x9EC0DC)
    static let accentText = adaptive(0x1E4E78, 0xD5E4F2)
    static let accentTint = adaptive(0xE7EEF5, 0x2C323A)
    static let accentInk = adaptive(0xF7F8FA, 0x121316)
    static let primaryFill = adaptive(0x1C1C1E, 0xF5F6F8)
    static let primaryInk = adaptive(0xF7F8FA, 0x121316)
    static let userBubble = adaptive(0x2C2D31, 0x2A2C31)
    static let userBubbleInk = adaptive(0xF7F8FA, 0xF5F6F8)
    static let assistantBubble = adaptive(0xEEF0F3, 0x22242A)
    static let logoMint = Color(hex: 0x34D399)
    static let success = adaptive(0x007C49, 0x38D591)
    static let successTint = adaptive(0xEAF7EF, 0x10291E)
    static let warning = adaptive(0x875500, 0xFFAF38)
    static let warningTint = adaptive(0xFFF6E6, 0x30220D)
    static let destructive = adaptive(0xB42318, 0xFF817A)

    static let cardRadius: CGFloat = 16

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
            .background(StrataTheme.primaryFill, in: RoundedRectangle(cornerRadius: StrataTheme.cardRadius, style: .continuous))
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
            .background(StrataTheme.surface, in: RoundedRectangle(cornerRadius: StrataTheme.cardRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: StrataTheme.cardRadius, style: .continuous).strokeBorder(StrataTheme.line, lineWidth: 1))
            .opacity(enabled ? (configuration.isPressed ? 0.65 : 1) : 0.42)
    }
}

private struct StrataChrome: ViewModifier {
    var radius: CGFloat
    func body(content: Content) -> some View {
        content.background(StrataTheme.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(StrataTheme.line, lineWidth: 1))
    }
}

extension View {
    func strataCard(padding: CGFloat = 20) -> some View {
        self.padding(padding)
            .background(StrataTheme.surface, in: RoundedRectangle(cornerRadius: StrataTheme.cardRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: StrataTheme.cardRadius, style: .continuous).strokeBorder(StrataTheme.line, lineWidth: 1))
    }
    func strataChrome(radius: CGFloat = 16) -> some View { modifier(StrataChrome(radius: radius)) }
    func strataList() -> some View {
        self.listStyle(.insetGrouped).listSectionSpacing(22)
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
            if let subtitle { Text(subtitle).font(.subheadline).foregroundStyle(StrataTheme.secondaryInk).lineSpacing(2) }
        }.accessibilityAddTraits(.isHeader)
    }
}
