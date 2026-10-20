// SPDX-License-Identifier: FSL-1.1-MIT
// Copyright (c) 2026 Cua AI, Inc.

import SwiftUI

// MARK: - Avatar

/// The koala avatar in a size, with an optional pencil badge.
public struct AvatarBadge: View {
    public var avatar: AvatarConfig
    public var mood: BotMood
    public var size: CGFloat
    public var editable: Bool

    public init(_ avatar: AvatarConfig, mood: BotMood = .idle, size: CGFloat, editable: Bool = false) {
        self.avatar = avatar
        self.mood = mood
        self.size = size
        self.editable = editable
    }

    public var body: some View {
        KoalaAvatar(avatar, mood: mood)
            .frame(width: size, height: size)
            .overlay(alignment: .bottomTrailing) {
                if editable {
                    Image(systemName: "pencil")
                        .font(.system(size: size * 0.13, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(size * 0.06)
                        .background(Circle().fill(.background).shadow(color: .black.opacity(0.12), radius: 2, y: 1))
                        .offset(x: -size * 0.04, y: -size * 0.1)
                }
            }
    }
}

/// Color, eyes and ears: the customization a bot gets.
public struct AvatarPicker: View {
    @Binding public var avatar: AvatarConfig
    public var name: String

    public init(avatar: Binding<AvatarConfig>, name: String) {
        _avatar = avatar
        self.name = name
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            section("Color") {
                HStack(spacing: 10) {
                    ForEach(BotColor.allCases) { c in
                        Button { avatar.color = c } label: {
                            Circle().fill(c.face)
                                .overlay(Circle().strokeBorder(.primary.opacity(0.12)))
                                .frame(width: 26, height: 26)
                                .padding(3)
                                .overlay(Circle().strokeBorder(avatar.color == c ? Color.accentColor : .clear, lineWidth: 2))
                        }
                        .buttonStyle(.plain)
                        .help(c.name)
                        .accessibilityLabel(c.name)
                    }
                }
            }
            section("Eyes") {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 58), spacing: 8)], spacing: 8) {
                    ForEach(EyeStyle.allCases) { e in
                        option(selected: avatar.eyes == e, label: e.name) {
                            avatar.eyes = e
                        } content: {
                            KoalaAvatar(AvatarConfig(color: avatar.color, eyes: e, ears: avatar.ears), animated: false)
                        }
                    }
                }
            }
            section("Ears") {
                HStack(spacing: 8) {
                    ForEach(EarShape.allCases) { ear in
                        option(selected: avatar.ears == ear, label: ear.name) {
                            avatar.ears = ear
                        } content: {
                            KoalaAvatar(AvatarConfig(color: avatar.color, eyes: avatar.eyes, ears: ear), animated: false)
                        }
                    }
                }
            }
        }
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
            content()
        }
    }

    private func option<C: View>(selected: Bool, label: String, action: @escaping () -> Void,
                                 @ViewBuilder content: () -> C) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                content().frame(width: 46, height: 46)
                Text(label).font(.caption2).foregroundStyle(.secondary)
            }
            .frame(width: 58, height: 66)
            .background(RoundedRectangle(cornerRadius: 8).fill(selected ? Color.accentColor.opacity(0.12) : .clear))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(selected ? Color.accentColor : .primary.opacity(0.08)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
