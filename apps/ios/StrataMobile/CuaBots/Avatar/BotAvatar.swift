// SPDX-License-Identifier: FSL-1.1-MIT
// Copyright (c) 2026 Cua AI, Inc.

import SwiftUI
import UIKit

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

    func validated(supportedShapes: [String]?) throws -> Self {
        if let geometricShape {
            guard kind == .koala, supportedShapes?.contains(geometricShape.rawValue) == true else {
                throw CompanionError.server("Update Strata on your Mac to save this character, or choose an animal.")
            }
        }
        var value = self
        if shape == .classic, supportedShapes == nil { value.shape = nil }
        return value
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
        case .working: return Self(lift: sin(time * 2.4) * -1.8, scale: 1 + sin(time * 3.1) * 0.025, tilt: sin(time * 1.5) * 1.7)
        case .thinking: return Self(lift: sin(time * 1.2) * -0.7, scale: 1, tilt: sin(time * 0.8) * 2)
        default: return Self()
        }
    }
}

struct BotAvatarState {
    static func mood(conversation: MacConversation?, pending: [MacToolActivity], paused: Bool = false) -> BotMood {
        if !pending.isEmpty { return .needsApproval }
        if paused { return .paused }
        guard let conversation else { return .idle }
        let reply = conversation.messages.last { $0.role == "assistant" }
        if conversation.active {
            if reply?.isThinkingInProgress == true { return .thinking }
            if conversation.messages.contains(where: { $0.tools?.contains(where: \.isRunning) == true }) { return .working }
            return reply?.streaming == true && reply?.content.isEmpty == false ? .working : .thinking
        }
        if reply?.error?.isEmpty == false { return .error }
        return reply?.content.isEmpty == false ? .done : .idle
    }

    static func flourish(conversation: MacConversation?) -> String {
        guard let conversation, let reply = conversation.messages.last(where: { $0.role == "assistant" }) else { return "" }
        return conversation.id + ":" + reply.id + (conversation.active || reply.streaming == true ? ":working" : ":arrived")
    }
}

struct ExpressiveBotAvatar: View {
    var config: AvatarConfig
    var size: CGFloat
    var mood: BotMood = .idle
    var animated = false
    var interactive = false
    var flourishToken = ""
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var interaction = 0

    var body: some View {
        Group {
            if interactive {
                Button { interaction += 1; UIImpactFeedbackGenerator(style: .soft).impactOccurred() } label: { face.frame(minWidth: 44, minHeight: 44) }
                    .buttonStyle(.plain).accessibilityLabel("Animate bot avatar").accessibilityValue(mood.label)
                    .accessibilityIdentifier("animateBotAvatarButton")
            } else { face }
        }
    }

    private var face: some View {
        KoalaAvatar(config, mood: mood, animated: animated && scenePhase == .active)
            .frame(width: size, height: size)
            .modifier(AvatarFlourish(trigger: flourishToken + ":" + String(interaction), enabled: !reduceMotion && scenePhase == .active))
    }
}

private struct AvatarFlourish: ViewModifier {
    var trigger: String
    var enabled: Bool
    func body(content: Content) -> some View {
        if enabled {
            content.phaseAnimator([0, 1, 2], trigger: trigger) { view, phase in
                view.scaleEffect(x: phase == 1 ? 1.10 : phase == 2 ? 0.98 : 1, y: phase == 1 ? 0.92 : phase == 2 ? 1.04 : 1)
                    .rotationEffect(.degrees(phase == 1 ? -6 : phase == 2 ? 2 : 0))
                    .offset(y: phase == 1 ? -2 : 0)
            } animation: { phase in .spring(response: phase == 1 ? 0.22 : 0.34, dampingFraction: 0.68) }
        } else { content }
    }
}

// MARK: - Drawing

/// The koala head: a flat blob with scalloped ears, the Cua mark's nose and
/// type-mark eyes. Flat fills only: no outline, gradient or shadow.
public struct KoalaAvatar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    public var config: AvatarConfig
    public var mood: BotMood
    public var animated: Bool

    public init(_ config: AvatarConfig, mood: BotMood = .idle, animated: Bool = false) {
        self.config = config
        self.mood = mood
        self.animated = animated
    }

    public var body: some View {
        if animated && mood.isAnimated && !reduceMotion && scenePhase == .active {
            TimelineView(.animation(minimumInterval: 1 / 18)) { context in
                canvas(t: context.date.timeIntervalSinceReferenceDate)
            }
        } else {
            canvas(t: 0)
        }
    }

    private func canvas(t: Double) -> some View {
        let motion = AvatarMotionSample.sample(mood: mood, time: t, enabled: animated && !reduceMotion && scenePhase == .active)
        return Canvas { ctx, size in
            KoalaRenderer.draw(in: &ctx, size: size, config: config, mood: mood, t: t)
        }
        .aspectRatio(1, contentMode: .fit)
        .offset(y: motion.lift).scaleEffect(motion.scale).rotationEffect(.degrees(motion.tilt))
        .accessibilityLabel("\(config.color.name) \(config.characterName), \(mood == .needsApproval ? "needs approval" : mood.rawValue)")
    }
}

public enum KoalaRenderer {
    static let headPath = SVGPath.parse(KoalaGeometry.head)
    static let earPath = SVGPath.parse(KoalaGeometry.ear)
    static let nosePath = SVGPath.parse(KoalaGeometry.nose)
    static let geometricHeads = GeometricAvatarGeometry.paths.mapValues { SVGPath.parse($0) }
    static let characterHeads: [AvatarKind: Path] = [
        .fox: SVGPath.parse(AvatarCharacterGeometry.foxHead),
        .cat: SVGPath.parse(AvatarCharacterGeometry.catHead),
        .robot: SVGPath.parse(AvatarCharacterGeometry.robotHead),
    ]

    /// The head radius that fits the whole koala (ears included) in a square.
    public static func radius(for size: CGSize) -> CGFloat { min(size.width, size.height) / 2.85 }

    public static func draw(in ctx: inout GraphicsContext, size: CGSize, config: AvatarConfig,
                            mood: BotMood, t: Double) {
        let R = radius(for: size)
        let center = CGPoint(x: size.width / 2, y: size.height / 2 + 0.06 * R)
        let unit = CGAffineTransform(translationX: center.x, y: center.y).scaledBy(x: R, y: R)
        let face = GraphicsContext.Shading.color(config.color.face)

        let geometric = config.geometricShape.flatMap { geometricHeads[$0] }
        // Geometric characters have their own silhouette and eyes only.
        if geometric == nil {
            if config.kind == .koala {
                for side in [-1.0, 1.0] { ctx.fill(ear(config.ears, side: side).applying(unit), with: face) }
            } else { drawCharacterEars(in: &ctx, unit: unit, config: config) }
        }

        let head = (geometric ?? characterHeads[config.kind] ?? headPath).applying(unit)
        ctx.fill(head, with: face)

        var inner = ctx
        inner.clip(to: head)
        if geometric == nil {
            inner.stroke(SVGPath.parse(AvatarCharacterGeometry.highlight).applying(unit), with: .color(.white.opacity(0.18)), style: StrokeStyle(lineWidth: 0.1 * R, lineCap: .round))
            if config.kind == .fox {
                inner.fill(SVGPath.parse(AvatarCharacterGeometry.foxMask).applying(unit), with: .color(.white.opacity(0.52)))
            }
            if config.kind == .cat {
                inner.stroke(SVGPath.parse(AvatarCharacterGeometry.catWhiskers).applying(unit), with: .color(config.color.nose.opacity(0.65)), style: StrokeStyle(lineWidth: 0.045 * R, lineCap: .round))
            }
            switch config.kind {
            case .koala:
                inner.fill(nosePath.applying(unit), with: .color(config.color.nose))
            case .robot:
                inner.fill(Path(roundedRect: CGRect(x: -0.28, y: 0.34, width: 0.56, height: 0.13), cornerRadius: 0.065).applying(unit), with: .color(config.color.nose))
            case .fox, .cat:
                inner.fill(SVGPath.parse(AvatarCharacterGeometry.animalNose).applying(unit), with: .color(config.color.nose))
                inner.stroke(SVGPath.parse(AvatarCharacterGeometry.animalMouth).applying(unit), with: .color(config.color.nose), style: StrokeStyle(lineWidth: 0.04 * R, lineCap: .round))
            }

        }
        let lag = t - 0.05  // the right eye swaps a beat after the left
        let pair = mood.eyes(style: config.eyes, at: t)
        let right = mood.eyes(style: config.eyes, at: lag).right
        // Working: the plus eyes rock between +15 and -15 degrees, a snap
        // then a hold, as in the koala design; they never pass 45 (an x).
        let spin = mood == .working ? (t.truncatingRemainder(dividingBy: 1.2) < 0.6 ? 15.0 : -15.0) : 0
        let gaze = mood == .thinking || mood == .idle ? sin(t * 0.72) * 0.035 : 0
        let leftEye = (x: (geometric != nil ? GeometricAvatarGeometry.leftX : KoalaGeometry.leftEye.x) + gaze,
                       y: geometric != nil ? GeometricAvatarGeometry.eyeY : KoalaGeometry.leftEye.y,
                       squash: geometric != nil ? 1 : KoalaGeometry.leftEye.squash)
        let rightEye = (x: (geometric != nil ? GeometricAvatarGeometry.rightX : KoalaGeometry.rightEye.x) + gaze,
                        y: geometric != nil ? GeometricAvatarGeometry.eyeY : KoalaGeometry.rightEye.y,
                        squash: geometric != nil ? 1 : KoalaGeometry.rightEye.squash)
        drawEye(pair.left, at: leftEye, in: &inner, unit: unit,
                color: config.color.eye, spin: spin, geometric: geometric != nil)
        drawEye(right, at: rightEye, in: &inner, unit: unit,
                color: config.color.eye, spin: spin, geometric: geometric != nil)
    }

    static func drawCharacterEars(in ctx: inout GraphicsContext, unit: CGAffineTransform, config: AvatarConfig) {
        let size = config.ears == .small ? 0.78 : config.ears == .round ? 0.92 : 1.0
        for side in [-1.0, 1.0] {
            let mirror = CGAffineTransform(scaleX: side, y: 1).concatenating(unit)
            if config.kind == .robot {
                ctx.fill(Path(roundedRect: CGRect(x: 0.96, y: -0.29, width: 0.23, height: 0.46 * size), cornerRadius: 0.1).applying(mirror), with: .color(config.color.face))
                ctx.stroke(SVGPath.parse(AvatarCharacterGeometry.robotAntenna).applying(mirror), with: .color(config.color.nose), style: StrokeStyle(lineWidth: 0.09 * abs(unit.a)))
                ctx.fill(Path(ellipseIn: CGRect(x: 0.425, y: -1.235, width: 0.21, height: 0.21)).applying(mirror), with: .color(config.color.face))
            } else {
                let placement = CGAffineTransform(translationX: 0.67, y: -0.58).scaledBy(x: size, y: size).concatenating(mirror)
                let shape = config.ears == .round ? AvatarCharacterGeometry.roundEar : AvatarCharacterGeometry.pointedEar
                ctx.fill(SVGPath.parse(shape).applying(placement), with: .color(config.color.face))
                ctx.fill(SVGPath.parse(AvatarCharacterGeometry.innerEar).applying(placement), with: .color(config.color.nose.opacity(0.4)))
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
        if geometric, glyph == .round {
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
        g.transform = t
        g.stroke(path, with: .color(color),
                 style: StrokeStyle(lineWidth: width, lineCap: .butt, lineJoin: .miter))
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
            return (poly([(-0.17, 0.2), (0, -0.2), (0.17, 0.2)]), 0.08, 0, 1.1)
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

/// `CUA_BOTS_APPEARANCE=light|dark` pins this app's appearance (never the
/// system's); unset follows the system.
public enum AppAppearance {
    public static var scheme: ColorScheme? {
        switch ProcessInfo.processInfo.environment["CUA_BOTS_APPEARANCE"]?.lowercased() {
        case "light": .light
        case "dark": .dark
        default: nil
        }
    }
}
