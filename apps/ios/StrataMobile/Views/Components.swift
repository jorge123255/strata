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
