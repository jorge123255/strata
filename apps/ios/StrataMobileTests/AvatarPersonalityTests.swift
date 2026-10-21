import XCTest
import SwiftUI
import UIKit
@testable import StrataMobile

@MainActor
final class AvatarPersonalityTests: XCTestCase {
    private func image(config: AvatarConfig, mood: BotMood, time: Double, motionEnabled: Bool) throws -> UIImage {
        let renderer = ImageRenderer(content: Canvas { context, size in
            KoalaRenderer.draw(in: &context, size: size, config: config, mood: mood, t: time, motionEnabled: motionEnabled)
        }.frame(width: 128, height: 128))
        renderer.scale = 2
        return try XCTUnwrap(renderer.uiImage)
    }

    func testReducedOrHiddenMotionRendersExactlyTheSameAtEveryTime() throws {
        for mood in BotMood.allCases {
            for config in [AvatarConfig(), AvatarConfig(color: .graphite, eyes: .round, kind: .cat), AvatarConfig(shape: .spark)] {
                let rest = try XCTUnwrap(image(config: config, mood: mood, time: 0, motionEnabled: false).pngData())
                for time in [4.4, 9.4, 9.7, 123.4, 1_000_000] {
                    XCTAssertEqual(try image(config: config, mood: mood, time: time, motionEnabled: false).pngData(), rest,
                                   "Disabled motion must stop eyes, ears and gaze, not only the outer head transform.")
                }
            }
        }
    }

    func testAttentionAndInactiveStatesDoNotKeepAnAnimationClock() {
        for mood: BotMood in [.needsApproval, .done, .paused, .error] {
            XCTAssertFalse(mood.isAnimated)
            for time in stride(from: 0.0, through: 30, by: 0.2) {
                XCTAssertEqual(AvatarPersonalitySample.sample(mood: mood, time: time, offset: 4.4, enabled: true), AvatarPersonalitySample())
                XCTAssertEqual(AvatarMotionSample.sample(mood: mood, time: time, enabled: true), AvatarMotionSample())
            }
        }
    }

    func testMountedFaceStopsBeingVisibleOutsideItsScrollClip() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIViewController(); window.rootViewController = controller
        window.isHidden = false
        defer { window.isHidden = true }
        let clip = UIView(frame: CGRect(x: 20, y: 100, width: 200, height: 120)); clip.clipsToBounds = true
        controller.view.addSubview(clip)
        let face = UIView(frame: CGRect(x: 20, y: 20, width: 80, height: 80)); clip.addSubview(face)
        XCTAssertTrue(AvatarViewportState.isVisible(face))
        face.frame.origin.y = 130
        XCTAssertFalse(AvatarViewportState.isVisible(face), "Mounted inside the screen but outside a scroll clip must stop motion.")
        face.frame.origin.y = 110
        XCTAssertTrue(AvatarViewportState.isVisible(face), "A partly visible face can still respond.")
        clip.isHidden = true; XCTAssertFalse(AvatarViewportState.isVisible(face))
        clip.isHidden = false; clip.alpha = 0; XCTAssertFalse(AvatarViewportState.isVisible(face))
        clip.alpha = 1; face.removeFromSuperview(); XCTAssertFalse(AvatarViewportState.isVisible(face))
    }

    func testFocusedMotionStaysSmallAndNaturalBlinkCadenceIsMostlyOpen() {
        for mood: BotMood in [.idle, .thinking, .working] {
            var closed = 0
            for step in 0..<1320 {
                let time = Double(step) / 100
                let motion = AvatarMotionSample.sample(mood: mood, time: time, enabled: true)
                XCTAssertLessThanOrEqual(abs(motion.lift), 0.7)
                XCTAssertLessThanOrEqual(abs(motion.scale - 1), 0.01)
                XCTAssertLessThanOrEqual(abs(motion.tilt), 1.6)
                let face = AvatarPersonalitySample.sample(mood: mood, time: time, offset: 0, enabled: true)
                if face.blinking { closed += 1 }
                XCTAssertLessThanOrEqual(abs(face.gaze), 0.05)
                XCTAssertLessThanOrEqual(abs(face.earLift), 0.045)
            }
            XCTAssertGreaterThan(closed, 20, "A focused character should actually blink.")
            XCTAssertLessThan(closed, 80, "Long quiet intervals keep a character readable and avoid repetitive flashing.")
        }
        let first = AvatarConfig(color: .sky, eyes: .round, kind: .koala)
        let second = AvatarConfig(color: .violet, eyes: .round, kind: .fox)
        XCTAssertEqual(AvatarPersonalitySample.phaseOffset(config: first), AvatarPersonalitySample.phaseOffset(config: first))
        XCTAssertNotEqual(AvatarPersonalitySample.phaseOffset(config: first), AvatarPersonalitySample.phaseOffset(config: second))
    }

    func testRealMoodFacesRemainVisuallyDistinctAndConfigurationsRemainUntouched() throws {
        let config = AvatarConfig(color: .orange, eyes: .round, ears: .small, kind: .fox)
        let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
        let encoded = try encoder.encode(config)
        var images = Set<Data>()
        for mood in BotMood.allCases {
            images.insert(try XCTUnwrap(image(config: config, mood: mood, time: 0, motionEnabled: false).pngData()))
        }
        XCTAssertGreaterThanOrEqual(images.count, 6, "Attentive approval, concern, focus, rest and reply-ready expressions remain distinguishable.")
        XCTAssertEqual(try encoder.encode(config), encoded)
    }

    func testOriginalCharacterContactSheetsForVisualReview() throws {
        let configs: [AvatarConfig] = [
            .init(color: .sky, eyes: .round), .init(color: .orange, eyes: .happy, kind: .fox),
            .init(color: .violet, eyes: .star, kind: .cat), .init(color: .cloud, eyes: .round, kind: .robot),
            .init(color: .graphite, eyes: .round, shape: .orb), .init(color: .sky, eyes: .round, shape: .pebble),
            .init(color: .violet, eyes: .star, shape: .tile), .init(color: .orange, eyes: .round, shape: .diamond),
            .init(color: .slate, eyes: .happy, shape: .spark), .init(color: .cloud, eyes: .round, shape: .hexagon),
        ]
        for dark in [false, true] {
            let ink = dark ? Color.white : Color.black
            let background = dark ? Color(hex: 0x16191E) : Color(hex: 0xF5F7FA)
            let sheet = VStack(spacing: 16) {
                Text("Original Strata characters").font(.title2.bold()).foregroundStyle(ink)
                ForEach([BotMood.idle, .needsApproval, .done, .error], id: \.rawValue) { mood in
                    VStack(spacing: 4) {
                        Text(mood.label).font(.caption.bold()).foregroundStyle(ink)
                        HStack(spacing: 4) {
                            ForEach(Array(configs.enumerated()), id: \.offset) { _, config in
                                VStack(spacing: 4) {
                                    KoalaAvatar(config, mood: mood, animated: false).frame(width: 76, height: 76)
                                    KoalaAvatar(config, mood: mood, animated: false).frame(width: 24, height: 24)
                                }
                            }
                        }
                    }
                }
            }.padding(20).background(background)
            let renderer = ImageRenderer(content: sheet); renderer.scale = 2
            let rendered = try XCTUnwrap(renderer.uiImage)
            XCTAssertGreaterThan(rendered.size.width, 700)
            let attachment = XCTAttachment(image: rendered)
            attachment.name = "Strata original warm characters — \(dark ? "dark" : "light") — hero and badge"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }
}
