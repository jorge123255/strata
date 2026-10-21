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
    public var animated: Bool
    public var flourishToken: String

    public init(_ avatar: AvatarConfig, mood: BotMood = .idle, size: CGFloat, editable: Bool = false, animated: Bool = false, flourishToken: String = "") {
        self.avatar = avatar
        self.mood = mood
        self.size = size
        self.editable = editable
        self.animated = animated
        self.flourishToken = flourishToken
    }

    public var body: some View {
        ExpressiveBotAvatar(config: avatar, size: size, mood: mood, animated: animated, flourishToken: flourishToken)
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
    public var supportedShapes: [String]
    public var compact: Bool
    @State private var detailsExpanded = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    public init(avatar: Binding<AvatarConfig>, name: String, supportedShapes: [String] = [], compact: Bool = false) {
        _avatar = avatar; self.name = name; self.supportedShapes = supportedShapes; self.compact = compact
    }

    private var shapes: [AvatarShape] { AvatarShape.geometric.filter { supportedShapes.contains($0.rawValue) } }

    public var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            section("Character") {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: dynamicTypeSize.isAccessibilitySize ? 132 : 52), spacing: 8)], spacing: 10) {
                    ForEach(AvatarKind.allCases) { kind in
                        option(selected: avatar.geometricShape == nil && avatar.kind == kind, label: kind.name, identifier: "avatar-character-\(kind.rawValue)") {
                            avatar.chooseAnimal(kind)
                        } content: {
                            KoalaAvatar(AvatarConfig(color: avatar.color, eyes: avatar.eyes, ears: avatar.ears, kind: kind), animated: false)
                        }
                    }
                    ForEach(shapes) { shape in
                        option(selected: avatar.geometricShape == shape, label: shape.name, identifier: "avatar-shape-\(shape.rawValue)") {
                            avatar.kind = .koala; avatar.shape = shape
                        } content: {
                            KoalaAvatar(AvatarConfig(color: avatar.color, eyes: avatar.eyes, ears: avatar.ears, shape: shape), animated: false)
                        }
                    }
                }
            }
            section("Color") {
                HStack(spacing: 8) {
                    ForEach(BotColor.allCases) { color in
                        Button { avatar.color = color } label: {
                            Circle().fill(color.face)
                                .overlay(Circle().strokeBorder(.primary.opacity(0.12)))
                                .frame(width: 28, height: 28).padding(5)
                                .overlay(Circle().strokeBorder(avatar.color == color ? StrataTheme.ink : .clear, lineWidth: 2))
                                .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).help(color.name).accessibilityLabel(color.name)
                        .accessibilityIdentifier("avatar-color-\(color.rawValue)")
                        .accessibilityAddTraits(avatar.color == color ? .isSelected : [])
                    }
                }
            }
            if let shape = avatar.geometricShape, !supportedShapes.contains(shape.rawValue) {
                Text("This Mac cannot save this character yet. Update Strata on your Mac, or choose an animal.")
                    .font(.caption).foregroundStyle(StrataTheme.warning).accessibilityIdentifier("avatarShapeUnsupported")
            }
            if compact {
                VStack(alignment: .leading, spacing: 0) {
                    Button { detailsExpanded.toggle() } label: {
                        HStack { Text("More appearance options"); Spacer(); Image(systemName: detailsExpanded ? "chevron.down" : "chevron.right").font(.caption.weight(.semibold)) }
                            .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain).font(.subheadline).foregroundStyle(StrataTheme.secondaryInk)
                        .accessibilityIdentifier("avatarAppearanceDisclosure").accessibilityValue(detailsExpanded ? "Expanded" : "Collapsed")
                    if detailsExpanded { details.padding(.top, 16) }
                }
            } else { details }
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 20) {
            section("Eyes") {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: dynamicTypeSize.isAccessibilitySize ? 132 : 60), spacing: 8)], spacing: 8) {
                    ForEach(EyeStyle.allCases) { eyes in
                        option(selected: avatar.eyes == eyes, label: eyes.name, identifier: "avatar-eyes-\(eyes.rawValue)") {
                            avatar.eyes = eyes
                        } content: {
                            KoalaAvatar(AvatarConfig(color: avatar.color, eyes: eyes, ears: avatar.ears, kind: avatar.kind, shape: avatar.shape), animated: false)
                        }
                    }
                }
            }
            if avatar.geometricShape == nil {
                section("Ears") {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: dynamicTypeSize.isAccessibilitySize ? 132 : 85), spacing: 8)], spacing: 8) {
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
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title).font(.caption.weight(.medium)).foregroundStyle(StrataTheme.secondaryInk).accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func option<C: View>(selected: Bool, label: String, identifier: String, action: @escaping () -> Void,
                                 @ViewBuilder content: () -> C) -> some View {
        Button(action: action) {
            VStack(spacing: 3) {
                content().frame(width: 46, height: 46)
                Text(label).font(.caption2).foregroundStyle(selected ? StrataTheme.ink : StrataTheme.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, minHeight: 70).padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(selected ? StrataTheme.grouped : .clear))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(selected ? StrataTheme.ink : .clear, lineWidth: 1.5))
            .contentShape(RoundedRectangle(cornerRadius: 18))
        }
        .buttonStyle(.plain).accessibilityLabel(label).accessibilityIdentifier(identifier)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
