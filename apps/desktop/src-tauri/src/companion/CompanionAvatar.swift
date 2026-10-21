// SPDX-License-Identifier: FSL-1.1-MIT
// Copyright (c) 2026 Cua AI, Inc.
// Drawing-only adaptation of StrataMobile/CuaBots/Avatar/BotAvatar.swift.
// Strata expressions and additional character geometry retain their original identity.
// No UIKit, store, provider or haptic dependency. Only the visible lead has a clock.
import SwiftUI

// MARK: - Configuration

/// A bot's face colour, from the Cua koala bots palette. Each has a darker
/// nose step (lighter on graphite) and an eye colour that reads on it.
public enum BotColor: String, Codable, CaseIterable, Identifiable, Sendable {
    case cloud, violet, orange, sky, graphite, slate

    public var id: String { rawValue }

    public var name: String {
        switch self {
        case .cloud: "Cloud"
        case .violet: "Violet"
        case .orange: "Orange"
        case .sky: "Sky"
        case .graphite: "Graphite"
        case .slate: "Slate"
        }
    }

    public var faceHex: UInt32 {
        switch self {
        case .cloud: 0xE3E7EC
        case .violet: 0x8B5CF6
        case .orange: 0xFF7A2F
        case .sky: 0x61BCFF
        case .graphite: 0x262A31
        case .slate: 0x8E98A3
        }
    }

    public var noseHex: UInt32 {
        switch self {
        case .cloud: 0x7D8793
        case .violet: 0x5B2FC9
        case .orange: 0xC24E10
        case .sky: 0x2A7FC4
        case .graphite: 0x4B525E
        case .slate: 0x5B6571
        }
    }

    public var eyeHex: UInt32 { self == .graphite ? 0xF3F6FA : 0x0B0E13 }

    public var face: Color { Color(hex: faceHex) }
    public var nose: Color { Color(hex: noseHex) }
    public var eye: Color { Color(hex: eyeHex) }

    /// An accent for UI chrome tinted by the bot (the computer frame, the
    /// cursor badge). Cloud and graphite are too neutral to tint with, so
    /// they borrow the palette's steel blue and koala gray.
    public var accent: Color {
        switch self {
        case .cloud: Color(hex: 0x61BCFF)
        case .graphite: Color(hex: 0x8E98A3)
        default: face
        }
    }

    /// A stable default from a name, so a new bot never needs a choice.
    public static func `default`(for name: String) -> BotColor {
        let all: [BotColor] = [.violet, .orange, .sky, .cloud, .slate, .graphite]
        let sum = name.unicodeScalars.reduce(0) { $0 &+ Int($1.value) }
        return all[abs(sum) % all.count]
    }
}

/// The eye marks a bot uses when it is at rest. Every other expression is a
/// glyph swap from the same vocabulary, never a morph.
public enum EyeStyle: String, Codable, CaseIterable, Identifiable, Sendable {
    case star, round, happy, calm, plus, delight

    public var id: String { rawValue }

    public var name: String {
        switch self {
        case .star: "Star"
        case .round: "Round"
        case .happy: "Happy"
        case .calm: "Calm"
        case .plus: "Plus"
        case .delight: "Delight"
        }
    }

    public var glyphs: EyePair {
        switch self {
        case .star: EyePair(.star, .star)
        case .round: EyePair(.round, .round)
        case .happy: EyePair(.caret, .caret)
        case .calm: EyePair(.dash, .dash)
        case .plus: EyePair(.plus, .plus)
        case .delight: EyePair(.greater, .less)
        }
    }
}

/// The koala ear. Scalloped is the koala design's fan; round and small are
/// the two alternatives on offer.
public enum EarShape: String, Codable, CaseIterable, Identifiable, Sendable {
    case scalloped, round, small

    public var id: String { rawValue }

    public var name: String {
        switch self {
        case .scalloped: "Scalloped"
        case .round: "Round"
        case .small: "Small"
        }
    }
}

public enum AvatarKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case koala, fox, cat, robot
    public var id: String { rawValue }
    public var name: String { rawValue.capitalized }
}

/// Optional geometry retains the existing kind and palette wire values.
public enum AvatarShape: String, Codable, CaseIterable, Identifiable, Sendable {
    case classic, orb, pebble, tile, diamond, spark, hexagon
    public var id: String { rawValue }
    public var name: String { rawValue.capitalized }
    public static var geometric: [Self] { allCases.filter { $0 != .classic } }
}

/// Everything that makes a bot's face its own. Koala keeps its original wire shape.
public struct AvatarConfig: Codable, Hashable, Sendable {
    public var color: BotColor
    public var eyes: EyeStyle
    public var ears: EarShape
    public var kind: AvatarKind
    public var shape: AvatarShape?
    public var geometricShape: AvatarShape? { shape == .classic ? nil : shape }
    public var characterName: String { geometricShape?.name ?? kind.name }

    public init(color: BotColor = .sky, eyes: EyeStyle = .star, ears: EarShape = .scalloped, kind: AvatarKind = .koala, shape: AvatarShape? = nil) {
        self.color = color
        self.eyes = eyes
        self.ears = ears
        self.kind = kind
        self.shape = shape
    }

    private enum CodingKeys: String, CodingKey { case color, eyes, ears, kind, shape }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        color = try values.decode(BotColor.self, forKey: .color)
        eyes = try values.decode(EyeStyle.self, forKey: .eyes)
        ears = try values.decode(EarShape.self, forKey: .ears)
        kind = values.contains(.kind) ? try values.decode(AvatarKind.self, forKey: .kind) : .koala
        if values.contains(.shape) {
            let rawShape = try values.decode(String.self, forKey: .shape)
            shape = AvatarShape(rawValue: rawShape)
            // A future host may add geometry. Keep the roster readable using
            // the stable koala kind; omitted shape preserves it on that host.
            if shape == nil { kind = .koala }
        } else { shape = nil }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(color, forKey: .color)
        try values.encode(eyes, forKey: .eyes)
        try values.encode(ears, forKey: .ears)
        if kind != .koala { try values.encode(kind, forKey: .kind) }
        try values.encodeIfPresent(shape, forKey: .shape)
    }

    mutating func chooseAnimal(_ kind: AvatarKind) {
        self.kind = kind
        shape = .classic
    }

    public static func `default`(for name: String) -> AvatarConfig {
        AvatarConfig(color: .default(for: name))
    }
}

// MARK: - Expressions

/// One eye mark.
public enum Glyph: String, Codable, Sendable {
    case star = "*", round = "o", dash = "-", caret = "^", plus = "+", cross = "x"
    case greater = ">", less = "<", slash = "/", backslash = "\\"
}

public struct EyePair: Hashable, Sendable {
    public var left: Glyph
    public var right: Glyph
    public init(_ left: Glyph, _ right: Glyph) {
        self.left = left
        self.right = right
    }
}

/// What the bot is doing, as the avatar shows it.
public enum BotMood: String, Codable, Sendable, CaseIterable {
    case idle, thinking, working, needsApproval, done, paused, error

    /// The eyes for this mood at time `t` (seconds). Idle blinks, thinking
    /// glances side to side, working spins; the rest hold.
    public func eyes(style: EyeStyle, at t: Double) -> EyePair {
        switch self {
        case .idle:
            let phase = t.truncatingRemainder(dividingBy: 4.2)
            return phase > 4.0 ? EyePair(.dash, .dash) : style.glyphs
        case .thinking:
            let phase = t.truncatingRemainder(dividingBy: 1.6)
            return phase < 0.8 ? EyePair(.slash, .slash) : EyePair(.backslash, .backslash)
        case .working:
            return EyePair(.plus, .plus)
        case .needsApproval:
            return EyePair(.round, .round)
        case .done:
            return EyePair(.caret, .caret)
        case .paused:
            return EyePair(.dash, .dash)
        case .error:
            return EyePair(.cross, .cross)
        }
    }

    /// Whether the avatar needs a clock (a blink, a glance or a spin).
    public var isAnimated: Bool { self == .idle || self == .thinking || self == .working }
    public var label: String { self == .needsApproval ? "Needs approval" : self == .done ? "Reply ready" : rawValue.capitalized }
}

/// Motion belongs to a visible, focused avatar. Static roster faces use no clock.
struct AvatarMotionSample: Equatable {
    var lift: Double = 0
    var scale: Double = 1
    var tilt: Double = 0
    static func sample(mood: BotMood, time: Double, enabled: Bool) -> Self {
        guard enabled else { return Self() }
        switch mood {
        case .idle: return Self(lift: sin(time * 1.1) * -0.35, scale: 1 + sin(time * 1.1) * 0.006, tilt: sin(time * 0.43) * 0.65)
        case .working: return Self(lift: sin(time * 1.8) * -0.65, scale: 1 + sin(time * 1.8) * 0.009, tilt: sin(time * 0.9) * 0.8)
        case .thinking: return Self(lift: sin(time * 1.1) * -0.4, scale: 1, tilt: sin(time * 0.6) * 1.6)
        default: return Self()
        }
    }
}

/// Original Strata face choreography. The quiet and double blinks have a long,
/// uneven cadence; the stable offset keeps different characters from blinking
/// together. This has no relationship to execution or persisted bot state.
struct AvatarPersonalitySample: Equatable {
    var blinking = false
    var gaze: Double = 0
    var earLift: Double = 0

    static func phaseOffset(config: AvatarConfig) -> Double {
        let identity = [config.color.rawValue, config.eyes.rawValue, config.ears.rawValue,
                        config.kind.rawValue, config.shape?.rawValue ?? "classic"].joined(separator: ":")
        let sum = identity.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) % 997 }
        return Double(sum) / 997 * 13.2
    }

    static func sample(mood: BotMood, time: Double, offset: Double, enabled: Bool) -> Self {
        guard enabled, mood.isAnimated else { return Self() }
        let phase = (max(0, time) + offset).truncatingRemainder(dividingBy: 13.2)
        let blinking = (4.35..<4.51).contains(phase) || (9.3..<9.46).contains(phase) || (9.65..<9.79).contains(phase)
        // A small ear perk only occasionally, rather than a constant wiggle.
        let perk = (7.6..<8.4).contains(phase) ? sin((phase - 7.6) / 0.8 * .pi) * 0.045 : 0
        return Self(blinking: blinking,
                    gaze: sin((max(0, time) + offset) * (mood == .thinking ? 0.75 : 0.37)) * (mood == .thinking ? 0.05 : 0.018),
                    earLift: perk)
    }
}

public enum KoalaRenderer {
    static let headPath = SVGPath.parse(KoalaGeometry.head)
    static let earPath = SVGPath.parse(KoalaGeometry.ear)
    static let nosePath = SVGPath.parse(KoalaGeometry.nose)
    static let geometricHeads = GeometricAvatarGeometry.paths.mapValues { SVGPath.parse($0) }
    static let highlightPath = SVGPath.parse(AvatarCharacterGeometry.highlight)
    static let foxMaskPath = SVGPath.parse(AvatarCharacterGeometry.foxMask)
    static let catWhiskersPath = SVGPath.parse(AvatarCharacterGeometry.catWhiskers)
    static let animalNosePath = SVGPath.parse(AvatarCharacterGeometry.animalNose)
    static let robotAntennaPath = SVGPath.parse(AvatarCharacterGeometry.robotAntenna)
    static let roundEarPath = SVGPath.parse(AvatarCharacterGeometry.roundEar)
    static let pointedEarPath = SVGPath.parse(AvatarCharacterGeometry.pointedEar)
    static let innerEarPath = SVGPath.parse(AvatarCharacterGeometry.innerEar)
    static let characterHeads: [AvatarKind: Path] = [
        .fox: SVGPath.parse(AvatarCharacterGeometry.foxHead),
        .cat: SVGPath.parse(AvatarCharacterGeometry.catHead),
        .robot: SVGPath.parse(AvatarCharacterGeometry.robotHead),
    ]

    /// The head radius that fits the whole koala (ears included) in a square.
    public static func radius(for size: CGSize) -> CGFloat { min(size.width, size.height) / 2.85 }

    static func draw(in ctx: inout GraphicsContext, size: CGSize, config: AvatarConfig,
                            mood: BotMood, t: Double, motionEnabled: Bool = true,
                            personalityOverride: AvatarPersonalitySample? = nil) {
        let R = radius(for: size)
        let center = CGPoint(x: size.width / 2, y: size.height / 2 + 0.06 * R)
        let unit = CGAffineTransform(translationX: center.x, y: center.y).scaledBy(x: R, y: R)
        let face = GraphicsContext.Shading.color(config.color.face)
        let personality = personalityOverride ?? AvatarPersonalitySample.sample(mood: mood, time: t,
            offset: AvatarPersonalitySample.phaseOffset(config: config), enabled: motionEnabled)

        let geometric = config.geometricShape.flatMap { geometricHeads[$0] }
        // Geometric characters have their own silhouette and eyes only.
        if geometric == nil {
            if config.kind == .koala {
                for side in [-1.0, 1.0] {
                    let perk = CGAffineTransform(translationX: 0, y: -personality.earLift * (side < 0 ? 0.6 : 1))
                    ctx.fill(ear(config.ears, side: side).applying(perk).applying(unit), with: face)
                }
            } else { drawCharacterEars(in: &ctx, unit: unit, config: config, earLift: personality.earLift) }
        }

        let head = (geometric ?? characterHeads[config.kind] ?? headPath).applying(unit)
        ctx.fill(head, with: face)

        var inner = ctx
        inner.clip(to: head)
        inner.stroke(highlightPath.applying(unit), with: .color(.white.opacity(config.color == .cloud ? 0.32 : 0.19)), style: StrokeStyle(lineWidth: 0.09 * R, lineCap: .round))
        if geometric == nil {
            if config.kind == .fox {
                inner.fill(foxMaskPath.applying(unit), with: .color(.white.opacity(0.52)))
            }
            if config.kind == .cat {
                inner.stroke(catWhiskersPath.applying(unit), with: .color(config.color.nose.opacity(0.65)), style: StrokeStyle(lineWidth: 0.045 * R, lineCap: .round))
            }
            switch config.kind {
            case .koala:
                inner.fill(nosePath.applying(unit), with: .color(config.color.nose))
            case .robot:
                break
            case .fox, .cat:
                inner.fill(animalNosePath.applying(unit), with: .color(config.color.nose))
            }

        }
        drawWarmDetails(in: &inner, unit: unit, config: config, mood: mood, geometric: geometric != nil)
        // Blink together, so even a very small face reads as a friendly blink.
        let faceTime = motionEnabled ? t : 0
        let pair = personality.blinking ? EyePair(.dash, .dash) : mood == .idle ? config.eyes.glyphs : mood.eyes(style: config.eyes, at: faceTime)
        // Working: the plus eyes rock between +15 and -15 degrees, a snap
        // then a hold, as in the koala design; they never pass 45 (an x).
        let spin = mood == .working && motionEnabled ? sin(t * 1.8) * 8 : 0
        let gaze = personality.gaze
        let leftEye = (x: (geometric != nil ? GeometricAvatarGeometry.leftX : KoalaGeometry.leftEye.x) + gaze,
                       y: geometric != nil ? GeometricAvatarGeometry.eyeY : KoalaGeometry.leftEye.y,
                       squash: geometric != nil ? 1 : KoalaGeometry.leftEye.squash)
        let rightEye = (x: (geometric != nil ? GeometricAvatarGeometry.rightX : KoalaGeometry.rightEye.x) + gaze,
                        y: geometric != nil ? GeometricAvatarGeometry.eyeY : KoalaGeometry.rightEye.y,
                        squash: geometric != nil ? 1 : KoalaGeometry.rightEye.squash)
        drawEye(pair.left, at: leftEye, in: &inner, unit: unit,
                color: config.color.eye, spin: spin, geometric: geometric != nil)
        drawEye(pair.right, at: rightEye, in: &inner, unit: unit,
                color: config.color.eye, spin: spin, geometric: geometric != nil)
    }

    /// Low-contrast cheeks and a tiny mouth are deliberately separate from the
    /// status glyphs. An approval stays attentive; a failure never smiles.
    static func drawWarmDetails(in ctx: inout GraphicsContext, unit: CGAffineTransform, config: AvatarConfig, mood: BotMood, geometric: Bool) {
        let blush = Color(hex: config.color == .graphite ? 0xF9B6C2 : 0xF7829E)
        for side in [-1.0, 1.0] {
            let cheek = Path(ellipseIn: CGRect(x: side * 0.67 - 0.16, y: 0.25, width: 0.32, height: 0.135))
            ctx.fill(cheek.applying(unit), with: .color(blush.opacity(mood == .error ? 0.14 : mood == .done ? 0.38 : 0.25)))
        }
        let y: Double = geometric ? 0.38 : config.kind == .koala ? 0.63 : config.kind == .robot ? 0.4 : 0.53
        let color = config.color.eye.opacity(config.color == .graphite ? 0.76 : 0.63)
        if mood == .needsApproval {
            ctx.stroke(Path(ellipseIn: CGRect(x: -0.065, y: y - 0.025, width: 0.13, height: 0.115)).applying(unit), with: .color(color), style: StrokeStyle(lineWidth: 0.038 * abs(unit.a)))
        } else {
            var mouth = Path()
            let width = mood == .done ? 0.19 : 0.13
            mouth.move(to: CGPoint(x: -width, y: y))
            let curve: Double = mood == .error ? -0.11 : mood == .paused ? 0.015 : mood == .thinking ? 0.035 : mood == .done ? 0.19 : 0.11
            mouth.addQuadCurve(to: CGPoint(x: width, y: y), control: CGPoint(x: 0, y: y + curve))
            ctx.stroke(mouth.applying(unit), with: .color(color), style: StrokeStyle(lineWidth: 0.045 * abs(unit.a), lineCap: .round, lineJoin: .round))
        }
        if mood == .done {
            // Two original little glints rest with a finished reply. No flash,
            // loop, or success claim beyond the existing Reply ready state.
            for side in [-1.0, 1.0] {
                var glint = Path()
                let x = side * 0.77, y = -0.45
                glint.move(to: CGPoint(x: x - 0.055, y: y)); glint.addLine(to: CGPoint(x: x + 0.055, y: y))
                glint.move(to: CGPoint(x: x, y: y - 0.065)); glint.addLine(to: CGPoint(x: x, y: y + 0.065))
                ctx.stroke(glint.applying(unit), with: .color(.white.opacity(0.7)), style: StrokeStyle(lineWidth: 0.035 * abs(unit.a), lineCap: .round))
            }
        }
    }

    static func drawCharacterEars(in ctx: inout GraphicsContext, unit: CGAffineTransform, config: AvatarConfig, earLift: Double = 0) {
        let size = config.ears == .small ? 0.78 : config.ears == .round ? 0.92 : 1.0
        for side in [-1.0, 1.0] {
            let mirror = CGAffineTransform(translationX: 0, y: -earLift * (side < 0 ? 0.6 : 1)).scaledBy(x: side, y: 1).concatenating(unit)
            if config.kind == .robot {
                ctx.fill(Path(roundedRect: CGRect(x: 0.96, y: -0.29, width: 0.23, height: 0.46 * size), cornerRadius: 0.1).applying(mirror), with: .color(config.color.face))
                ctx.stroke(robotAntennaPath.applying(mirror), with: .color(config.color.nose), style: StrokeStyle(lineWidth: 0.09 * abs(unit.a)))
                ctx.fill(Path(ellipseIn: CGRect(x: 0.425, y: -1.235, width: 0.21, height: 0.21)).applying(mirror), with: .color(config.color.face))
            } else {
                let placement = CGAffineTransform(translationX: 0.67, y: -0.58).scaledBy(x: size, y: size).concatenating(mirror)
                let shape = config.ears == .round ? roundEarPath : pointedEarPath
                ctx.fill(shape.applying(placement), with: .color(config.color.face))
                ctx.fill(innerEarPath.applying(placement), with: .color(config.color.nose.opacity(0.4)))
            }
        }
    }

    static func ear(_ shape: EarShape, side: Double) -> Path {
        let at = KoalaGeometry.earAt
        switch shape {
        case .scalloped, .small:
            let k = shape == .small ? 0.72 : 1.0
            // Keep the ear's base on the head as it shrinks: pull it in along
            // the line to the head's centre.
            let pull = shape == .small ? 0.86 : 1.0
            return earPath.applying(
                CGAffineTransform(translationX: side * at.x * pull, y: at.y * pull)
                    .scaledBy(x: side * k, y: k))
        case .round:
            // A disc with the fan's area (0.598 R squared).
            let r = sqrt(0.598 / Double.pi)
            return Path(ellipseIn: CGRect(x: side * at.x * 0.97 - r, y: at.y * 1.02 - r,
                                          width: 2 * r, height: 2 * r))
        }
    }

    static func drawEye(_ glyph: Glyph, at eye: (x: Double, y: Double, squash: Double),
                        in ctx: inout GraphicsContext, unit: CGAffineTransform, color: Color,
                        spin: Double, geometric: Bool = false) {
        if glyph == .round {
            let transform = CGAffineTransform(translationX: eye.x, y: eye.y).rotated(by: -12 * .pi / 180).concatenating(unit)
            let capsule = Path(roundedRect: CGRect(x: -0.08, y: -0.17, width: 0.16, height: 0.34), cornerRadius: 0.08)
            ctx.fill(capsule.applying(transform), with: .color(color))
            return
        }
        let (path, width, rotate, gs) = glyphPath(glyph)
        let spinAngle = (glyph == .plus ? spin : 0) + rotate
        let t = CGAffineTransform(translationX: eye.x, y: eye.y)
            .rotated(by: spinAngle * .pi / 180)
            .scaledBy(x: gs * eye.squash, y: gs)
            .concatenating(unit)
        var g = ctx
        // Preserve the lead's outer pose and the Canvas device transform.
        // Replacing the transform would leave nonround eyes behind the head.
        g.concatenate(t)
        g.stroke(path, with: .color(color),
                 style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
    }

    /// The glyph in face units, its stroke width, its tilt and its scale, as
    /// `runtime.js` draws them.
    static func glyphPath(_ glyph: Glyph) -> (Path, CGFloat, Double, CGFloat) {
        func lines(_ segs: [(CGFloat, CGFloat, CGFloat, CGFloat)]) -> Path {
            var p = Path()
            for s in segs {
                p.move(to: CGPoint(x: s.0, y: s.1))
                p.addLine(to: CGPoint(x: s.2, y: s.3))
            }
            return p
        }
        func poly(_ pts: [(CGFloat, CGFloat)]) -> Path {
            var p = Path()
            p.move(to: CGPoint(x: pts[0].0, y: pts[0].1))
            for q in pts.dropFirst() { p.addLine(to: CGPoint(x: q.0, y: q.1)) }
            return p
        }
        switch glyph {
        case .star:
            return (lines([(-0.17, 0, 0.17, 0), (-0.085, -0.147, 0.085, 0.147),
                           (0.085, -0.147, -0.085, 0.147)]), 0.066, 0, 1.1)
        case .round:
            return (Path(ellipseIn: CGRect(x: -0.165, y: -0.2, width: 0.33, height: 0.4)), 0.085, -12, 1.2)
        case .dash:
            return (lines([(-0.225, 0, 0.225, 0)]), 0.075, 0, 1.15)
        case .caret:
            var happy = Path(); happy.move(to: CGPoint(x: -0.17, y: 0.1))
            happy.addQuadCurve(to: CGPoint(x: 0.17, y: 0.1), control: CGPoint(x: 0, y: -0.24))
            return (happy, 0.08, 0, 1.1)
        case .plus:
            return (lines([(-0.22, 0, 0.22, 0), (0, -0.22, 0, 0.22)]), 0.085, 0, 1.1)
        case .cross:
            return (lines([(-0.22, 0, 0.22, 0), (0, -0.22, 0, 0.22)]), 0.085, 45, 1.1)
        case .greater:
            return (poly([(-0.17, -0.17), (0.17, 0), (-0.17, 0.17)]), 0.075, 0, 1.1)
        case .less:
            return (poly([(0.17, -0.17), (-0.17, 0), (0.17, 0.17)]), 0.075, 0, 1.1)
        case .slash:
            return (lines([(-0.11, 0.21, 0.11, -0.21)]), 0.08, 0, 1.1)
        case .backslash:
            return (lines([(-0.11, -0.21, 0.11, 0.21)]), 0.08, 0, 1.1)
        }
    }
}

public extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: opacity)
    }
}


struct CompanionAvatar: View {
    var config: AvatarConfig
    var state: String
    var stale: Bool
    var size: CGFloat = 44
    var animated = false
    var reaction: CompanionReaction?
    var interactive = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var epoch = Date()
    @State private var helloAt: Date?
    private var mood: BotMood {
        guard !stale else { return .paused }
        switch state {
        case "approval": return .needsApproval
        case "working": return .working
        case "thinking": return .thinking
        case "completed": return .done
        case "error": return .error
        default: return .idle
        }
    }
    private var shouldAnimate: Bool { animated && !stale && !reduceMotion }
    var body: some View {
        Group {
            if interactive {
                Button { if shouldAnimate { helloAt = Date() } } label: { face }
                    .buttonStyle(.plain).contentShape(Rectangle())
                    .accessibilityLabel("Say hello to the bot avatar")
                    .accessibilityHint("A playful reaction. Does not send a message or run work.")
                    .accessibilityIdentifier("companionHelloButton")
                    .help("Say hello")
                    .onHover { inside in if inside && shouldAnimate { helloAt = Date() } }
            } else { face.allowsHitTesting(false).accessibilityHidden(true) }
        }
        .onChange(of: shouldAnimate) { _, enabled in if !enabled { helloAt = nil } }
    }
    @ViewBuilder private var face: some View {
        if shouldAnimate {
            // The complete TimelineView is removed when controller visibility,
            // session/sleep state, freshness or Reduce Motion disallows motion.
            TimelineView(.animation(minimumInterval: 1 / 15)) { frame in canvas(at: frame.date, moving: true) }
                .frame(width: size, height: size)
        } else { canvas(at: epoch, moving: false).frame(width: size, height: size) }
    }
    private func canvas(at now: Date, moving: Bool) -> some View {
        let hello = helloAt.flatMap { now.timeIntervalSince($0) < CompanionMotionSample.reactionDuration ? $0 : nil }
        let kind: CompanionReactionKind? = hello == nil ? reaction?.kind : .hello
        let started = hello ?? reaction?.startedAt
        let motion = CompanionMotionSample.sample(state: state, time: now.timeIntervalSince(epoch), enabled: moving,
                                                   reaction: kind, elapsed: started.map { now.timeIntervalSince($0) } ?? .infinity)
        return Canvas { context, bounds in
            let personality = AvatarPersonalitySample(blinking: motion.blinking, gaze: motion.gaze, earLift: motion.earLift)
            context.translateBy(x: bounds.width / 2, y: bounds.height / 2 + motion.lift)
            context.rotate(by: .degrees(motion.tilt)); context.scaleBy(x: motion.scaleX, y: motion.scaleY)
            context.translateBy(x: -bounds.width / 2, y: -bounds.height / 2)
            KoalaRenderer.draw(in: &context, size: bounds, config: config, mood: mood, t: now.timeIntervalSince(epoch),
                               motionEnabled: moving, personalityOverride: personality)
        }
    }
}
