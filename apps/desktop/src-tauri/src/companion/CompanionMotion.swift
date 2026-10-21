// Original Strata companion motion. No copied character choreography or artwork.
import Foundation

enum CompanionReactionKind: String { case arrival, hello, changed, approval, completion, error }
struct CompanionReaction: Equatable {
    let sequence: UInt64
    let kind: CompanionReactionKind
    let startedAt: Date
}
struct CompanionMotionSample: Equatable {
    var lift = 0.0
    var scaleX = 1.0
    var scaleY = 1.0
    var tilt = 0.0
    var gaze = 0.0
    var blinking = false
    var earLift = 0.0

    static let reactionDuration = 1.35
    static func sample(state: String, time: Double, enabled: Bool,
                       reaction: CompanionReactionKind? = nil, elapsed: Double = .infinity) -> Self {
        guard enabled else { return Self() }
        let time = max(0, time.isFinite ? time : 0)
        let cycle = time.truncatingRemainder(dividingBy: 12.7)
        var value = Self()
        value.blinking = (4.2..<4.36).contains(cycle) || (9.0..<9.14).contains(cycle) || (9.34..<9.46).contains(cycle)
        switch state {
        case "idle":
            let breath = sin(time * 1.25)
            value.lift = -breath * 1.15; value.scaleX = 1 + breath * 0.02; value.scaleY = 1 - breath * 0.015
            value.tilt = sin(time * 0.55) * 2; value.gaze = sin(time * 0.4) * 0.028
        case "thinking":
            value.lift = -sin(time * 1.2) * 0.55; value.tilt = sin(time * 0.8) * 5
            value.gaze = sin(time * 0.8) * 0.07
        case "working":
            let pulse = sin(time * 2.1)
            value.lift = -pulse * 0.85; value.scaleX = 1 + pulse * 0.016; value.scaleY = 1 - pulse * 0.012
            value.tilt = sin(time * 0.9) * 2.2; value.earLift = max(0, sin(time * 1.4)) * 0.045
        case "approval":
            // Attentive, not a celebration or a repeatedly bouncing alert.
            value.scaleX = 1.015; value.scaleY = 1.025
        case "error": value.tilt = -2; value.lift = 0.6
        default: break
        }
        guard let reaction, elapsed.isFinite, elapsed >= 0, elapsed < reactionDuration else { return value }
        let p = elapsed / reactionDuration
        let arc = sin(.pi * p)
        switch reaction {
        case .arrival:
            let remaining = pow(1 - p, 3)
            value.scaleX *= 1 - 0.16 * remaining; value.scaleY *= 1 - 0.16 * remaining
            value.lift += 4 * remaining; value.tilt += sin(p * .pi * 2) * 3 * (1 - p)
        case .hello:
            value.tilt += sin(p * .pi * 2) * 9 * (1 - p); value.lift -= arc * 2
            value.earLift += arc * 0.16; value.blinking = value.blinking || (0.34..<0.44).contains(p)
        case .completion:
            value.lift -= arc * 3.2; value.scaleX += sin(p * .pi * 2) * 0.06 * (1 - p)
            value.scaleY -= sin(p * .pi * 2) * 0.05 * (1 - p)
            value.tilt += sin(p * .pi * 2) * 5 * (1 - p); value.earLift += arc * 0.18
        case .approval:
            value.scaleX += arc * 0.025; value.scaleY += arc * 0.015; value.tilt += arc * 3; value.gaze += arc * 0.035
        case .error: value.lift += arc * 1.5; value.tilt -= arc * 3
        case .changed: value.tilt += sin(p * .pi) * 2
        }
        return value
    }
}

/// Exact identities, rather than the newly selected lead, decide which event is
/// new. A first fetch, reconnect or different chat cannot celebrate old history.
struct CompanionReactionTracker {
    private var previous: [String: String] = [:]
    private var previousLeadID: String?
    private var hasBaseline = false
    mutating func reset() { previous.removeAll(); previousLeadID = nil; hasBaseline = false }
    mutating func observe(_ snapshot: CompanionSnapshot) -> CompanionReactionKind? {
        defer { previous = Dictionary(uniqueKeysWithValues: snapshot.sessions.map { ($0.id, $0.state) }); previousLeadID = snapshot.sessions.first?.id; hasBaseline = true }
        guard let lead = snapshot.sessions.first else { return hasBaseline ? nil : .arrival }
        guard hasBaseline else { return .arrival }
        if lead.id != previousLeadID { return .changed }
        let old = previous[lead.id]
        if lead.id == previousLeadID, lead.state == "completed", ["approval", "thinking", "working"].contains(old ?? "") { return .completion }
        guard old != lead.state else { return nil }
        if lead.state == "completed" { return nil }
        if lead.state == "approval" { return .approval }
        if lead.state == "error" { return .error }
        return .changed
    }
}
