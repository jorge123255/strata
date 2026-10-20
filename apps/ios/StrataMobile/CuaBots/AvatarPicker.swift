// SPDX-License-Identifier: FSL-1.1-MIT
// Copyright (c) 2026 Cua AI, Inc.

import SwiftUI

// Strata presentation adapts spacing, contrast and Dynamic Type; geometry is unchanged.

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

/// Character, color, eyes and ears. Selection stays in the parent's draft.
public struct AvatarPicker: View {
    @Binding public var avatar: AvatarConfig
    public var name: String

    public init(avatar: Binding<AvatarConfig>, name: String) {
        _avatar = avatar
        self.name = name
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            section("Character") {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 70), spacing: 10)], spacing: 8) {
                    ForEach(AvatarKind.allCases) { kind in
                        option(selected: avatar.kind == kind, label: kind.name, identifier: "avatar-character-\(kind.rawValue)") {
                            avatar.kind = kind
                        } content: {
                            KoalaAvatar(AvatarConfig(color: avatar.color, eyes: avatar.eyes, ears: avatar.ears, kind: kind), animated: false)
                        }
                    }
                }
            }
            section("Color") {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 44), spacing: 8)], spacing: 8) {
                    ForEach(BotColor.allCases) { c in
                        Button { avatar.color = c } label: {
                            Circle().fill(c.face)
                                .overlay(Circle().strokeBorder(.primary.opacity(0.12)))
                                .frame(width: 26, height: 26)
                                .padding(4)
                                .overlay(Circle().strokeBorder(avatar.color == c ? StrataTheme.accentText : .clear, lineWidth: 2))
                                .frame(width: 44, height: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help(c.name)
                        .accessibilityLabel(c.name)
                        .accessibilityIdentifier("avatar-color-\(c.rawValue)")
                        .accessibilityAddTraits(avatar.color == c ? .isSelected : [])
                    }
                }
            }
            section("Eyes") {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 70), spacing: 10)], spacing: 8) {
                    ForEach(EyeStyle.allCases) { e in
                        option(selected: avatar.eyes == e, label: e.name, identifier: "avatar-eyes-\(e.rawValue)") {
                            avatar.eyes = e
                        } content: {
                            KoalaAvatar(AvatarConfig(color: avatar.color, eyes: e, ears: avatar.ears, kind: avatar.kind), animated: false)
                        }
                    }
                }
            }
            section("Ears") {
                HStack(spacing: 8) {
                    ForEach(EarShape.allCases) { ear in
                        option(selected: avatar.ears == ear, label: ear.name, identifier: "avatar-ears-\(ear.rawValue)") {
                            avatar.ears = ear
                        } content: {
                            KoalaAvatar(AvatarConfig(color: avatar.color, eyes: avatar.eyes, ears: ear, kind: avatar.kind), animated: false)
                        }
                    }
                }
            }
        }
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(StrataTheme.secondaryInk).accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func option<C: View>(selected: Bool, label: String, identifier: String, action: @escaping () -> Void,
                                 @ViewBuilder content: () -> C) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                content().frame(width: 46, height: 46)
                Text(label).font(.caption).foregroundStyle(selected ? StrataTheme.ink : StrataTheme.secondaryInk).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, minHeight: 78).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 16).fill(selected ? StrataTheme.accentTint : StrataTheme.surfaceSecondary))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(selected ? StrataTheme.accentText : StrataTheme.line))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
