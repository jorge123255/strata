import Foundation
import SwiftUI

@main struct CompanionTests {
    static var checks: [String] = []
    static func check(_ condition: @autoclosure () -> Bool, _ name: String) {
        guard condition() else { fputs("FAIL: \(name)\n", stderr); exit(1) }; checks.append(name)
    }
    static func fixture() -> [String: Any] {
        ["supported": true, "sessions": [["id": "chat_1", "botId": "bot_1", "name": "TEST 👩‍💻", "title": "A real conversation", "state": "approval", "approvalCount": 1, "avatarConfig": ["color": "sky", "eyes": "star", "ears": "scalloped"]]],
         "counts": ["waiting": 1, "working": 0, "completed": 0, "errors": 0], "hasMore": false, "updatedAt": "2026-10-21T18:00:00.000Z"]
    }
    static func encoded(_ value: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    static func rejected(_ value: [String: Any]) -> Bool { (try? CompanionSnapshot.decode(encoded(value))) == nil }
    static func model() {
        let valid = fixture()
        check((try? CompanionSnapshot.decode(encoded(valid)))?.sessions.first?.name == "TEST 👩‍💻", "joined emoji names retain their identity")
        var value = valid; value["execute"] = "approve"; check(rejected(value), "unknown snapshot authority rejected")
        value = valid; value["supported"] = 1; check(rejected(value), "numeric true rejected")
        value = valid; value["hasMore"] = "false"; check(rejected(value), "string false rejected")
        value = valid; value["sessions"] = Array(repeating: (valid["sessions"] as! [[String: Any]])[0], count: 7); check(rejected(value), "row bound enforced")
        var row = (valid["sessions"] as! [[String: Any]])[0]
        for id in ["", "../chat", "https://example.test", "chat\0bad", String(repeating: "x", count: 121)] {
            var item = row; item["id"] = id; value = valid; value["sessions"] = [item]; check(rejected(value), "unsafe conversation identity rejected: \(id.utf8.count)")
        }
        for field in ["approvalId", "arguments", "command", "messages", "svg"] {
            var item = row; item[field] = "private"; value = valid; value["sessions"] = [item]; check(rejected(value), "unexpected session field rejected: \(field)")
        }
        for state in ["idle", "complete", "approved", "queued"] {
            var item = row; item["state"] = state; value = valid; value["sessions"] = [item]; check(rejected(value), "invented state rejected: \(state)")
        }
        var item = row; item["state"] = "working"; value = valid; value["sessions"] = [item]; check(rejected(value), "approval count cannot masquerade as work")
        item = row; item["approvalCount"] = false; value = valid; value["sessions"] = [item]; check(rejected(value), "boolean approval count rejected")
        item = row; item["name"] = "line\nfeed"; value = valid; value["sessions"] = [item]; check(rejected(value), "C0 text rejected")
        item = row; item["name"] = "line\u{85}feed"; value = valid; value["sessions"] = [item]; check(rejected(value), "C1 text rejected")
        item = row; item["title"] = String(repeating: "a", count: 121); value = valid; value["sessions"] = [item]; check(rejected(value), "title bound enforced")
        item = row; item["updatedAt"] = "tomorrow"; value = valid; value["sessions"] = [item]; check(rejected(value), "invalid row date rejected")
        item = row; var avatar = item["avatarConfig"] as! [String: Any]; avatar["color"] = "magenta"; item["avatarConfig"] = avatar; value = valid; value["sessions"] = [item]; check(rejected(value), "unknown avatar enums fail closed")
        value = valid; var counts = valid["counts"] as! [String: Any]; counts["working"] = -1; value["counts"] = counts; check(rejected(value), "negative count rejected")
        value = valid; counts["working"] = 1.5; value["counts"] = counts; check(rejected(value), "fractional count rejected")
        value = valid; value["updatedAt"] = "not a date"; check(rejected(value), "invalid snapshot date rejected")
        check((try? CompanionSnapshot.decode(Data(repeating: 32, count: 8193))) == nil, "raw byte bound enforced")
        for kind in AvatarKind.allCases {
            for shape in AvatarShape.allCases {
                row["avatarConfig"] = ["color": "sky", "eyes": "round", "ears": "small", "kind": kind.rawValue, "shape": shape.rawValue]
                value = valid; value["sessions"] = [row]
                check((try? CompanionSnapshot.decode(encoded(value)))?.sessions.first?.avatarConfig.kind == kind, "avatar wire kind/shape retained: \(kind.rawValue)/\(shape.rawValue)")
            }
        }
        check(BotColor.allCases.count == 6 && EyeStyle.allCases.count == 6 && EarShape.allCases.count == 3, "existing avatar palettes and face choices retained")
    }
    static func geometry() {
        for screen in [CGRect(x: 0, y: 0, width: 1512, height: 982), CGRect(x: -1920, y: 110, width: 1920, height: 1080), CGRect(x: 1512, y: -300, width: 1920, height: 1080), CGRect(x: -200, y: -100, width: 230, height: 190)] {
            for safeArea: CGFloat in [0, 37] {
                let visible = screen.insetBy(dx: 0, dy: 24)
                for expanded in [false, true] {
                    let frame = CompanionGeometry.frame(screen: screen, visible: visible, safeAreaTop: safeArea, menuBarHeight: 24, expanded: expanded, rows: 6)
                    check(visible.contains(frame), "panel fits screen \(screen.minX)/\(screen.minY), notch \(safeArea), expanded \(expanded)")
                    check(frame.maxY <= screen.maxY - max(safeArea, 24), "panel respects menu/notch safe area")
                }
            }
        }
        check(CompanionGeometry.frame(screen: .zero, visible: .zero, safeAreaTop: 0, menuBarHeight: 0, expanded: false, rows: 0).isEmpty, "missing display has no click region")
        check(CompanionGeometry.canonicalScreen("main"), "main display choice supported")
        check(CompanionGeometry.canonicalScreen("12345678-ABCD-1234-ABCD-123456789012"), "canonical display UUID supported")
        check(!CompanionGeometry.canonicalScreen("12345678-abcd-1234-abcd-123456789012"), "noncanonical display UUID rejected")
        check(!CompanionGeometry.canonicalScreen("https://example.test"), "display choice cannot be URL")
    }
    static func lifecycle() {
        var life = CompanionLifecycle(); check(!life.shouldShow, "default opt-in disabled")
        life.configured = true; check(!life.shouldShow, "host configuration never opts in")
        life.enabled = true; check(life.shouldShow, "explicit enabled and configured panel visible")
        let generation = life.generation; check(life.accepts(generation), "fresh current request accepted")
        life.invalidate(); check(!life.accepts(generation), "cancelled generation cannot update panel")
        life.awake = false; check(!life.shouldShow, "sleep hides panel")
        life.awake = true; life.sessionActive = false; check(!life.shouldShow, "lock/session switch hides panel")
        life.sessionActive = true; life.displayAvailable = false; life.invalidate(); check(!life.shouldShow, "missing displays stop presentation and polling")
        life.displayAvailable = true; check(life.shouldShow, "display return restores enabled presentation eligibility")
        check(!life.accepts(generation), "pre-display-removal request cannot update recovered panel")
        let beforeHide = life.generation
        life.applicationHidden = true; life.invalidate(); check(!life.shouldShow, "application Hide immediately suspends presentation and polling")
        life.applicationHidden = false; check(life.shouldShow, "application Unhide restores enabled presentation eligibility")
        check(!life.accepts(beforeHide), "pre-Hide response cannot update unhidden panel")
        life.enabled = false; life.sessionActive = true; check(!life.shouldShow, "unlock cannot resurrect user-disabled panel")
        life.enabled = true; life.stopped = true; check(!life.shouldShow, "shutdown cannot resurrect panel")
    }
    static func motion() {
        for state in ["idle", "thinking", "working", "approval", "completed", "error"] {
            var hasMovement = false
            var bounded = true, disabledInvariant = true
            for tick in 0...900 {
                let time = Double(tick) / 15
                let sample = CompanionMotionSample.sample(state: state, time: time, enabled: true)
                hasMovement = hasMovement || sample != CompanionMotionSample()
                bounded = bounded && sample.scaleX >= 0.8 && sample.scaleX <= 1.1 && sample.scaleY >= 0.8 && sample.scaleY <= 1.1 && abs(sample.lift) <= 5 && abs(sample.tilt) <= 10 && abs(sample.gaze) <= 0.1 && abs(sample.earLift) <= 0.2
                disabledInvariant = disabledInvariant && CompanionMotionSample.sample(state: state, time: time, enabled: false, reaction: .completion, elapsed: 0.5) == CompanionMotionSample()
            }
            check(bounded, "bounded visible motion over 60 seconds: \(state)")
            check(disabledInvariant, "disabled/reduced/hidden motion is invariant over 60 seconds: \(state)")
            check(hasMovement, "visible character has an expressive pose: \(state)")
        }
        for reaction in [CompanionReactionKind.arrival, .hello, .changed, .approval, .completion, .error] {
            let base = CompanionMotionSample.sample(state: "completed", time: 1, enabled: true)
            check(CompanionMotionSample.sample(state: "completed", time: 1, enabled: true, reaction: reaction, elapsed: 2) == base, "finite reaction settles completely: \(reaction.rawValue)")
            check(CompanionMotionSample.sample(state: "completed", time: 1, enabled: true, reaction: reaction, elapsed: 0.4) != base, "finite reaction visibly changes pose: \(reaction.rawValue)")
        }
        var tracker = CompanionReactionTracker()
        func snapshot(_ id: String, _ state: String) -> CompanionSnapshot {
            var raw = fixture(), row = (fixture()["sessions"] as! [[String: Any]])[0]
            row["id"] = id; row["state"] = state; row["approvalCount"] = state == "approval" ? 1 : 0; raw["sessions"] = [row]
            return try! CompanionSnapshot.decode(encoded(raw))
        }
        check(tracker.observe(snapshot("one", "completed")) == .arrival, "historical first completion gets only neutral arrival")
        check(tracker.observe(snapshot("one", "completed")) == nil, "historical completion never repeats")
        check(tracker.observe(snapshot("two", "completed")) == .changed, "different lead history has neutral handoff, never completion")
        check(tracker.observe(snapshot("two", "working")) == .changed, "actual work state changes are observed")
        check(tracker.observe(snapshot("two", "completed")) == .completion, "same known active chat completion reacts once")
        check(tracker.observe(snapshot("two", "completed")) == nil, "refresh cannot replay completion")
        check(tracker.observe(snapshot("two", "approval")) == .approval, "approval has attentive reaction")
        check(tracker.observe(snapshot("two", "error")) == .error, "error has concern reaction")
        tracker.reset()
        check(tracker.observe(snapshot("two", "completed")) == .arrival, "reconnect does not celebrate unobserved completion")
    }
    static func feed(port: String) {
        func fetch(_ path: String) -> Result<Data, Error>? {
            var result: Result<Data, Error>?
            let request = CompanionFeedRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!, token: "fixture-token-private") { result = $0 }
            request.start()
            let deadline = Date().addingTimeInterval(8)
            while result == nil && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
            request.cancel(); return result
        }
        if case .success(let data) = fetch("/ok") { check((try? CompanionSnapshot.decode(data)) != nil, "bounded authenticated owner-local feed accepted") } else { check(false, "feed success") }
        for path in ["/oversized-length", "/oversized-chunked", "/redirect", "/auth", "/wrong-type", "/slow"] {
            if case .failure = fetch(path) { check(true, "unsafe/failed feed rejected: \(path)") } else { check(false, "feed rejected: \(path)") }
        }
        if case .success = fetch("/after-cookie") { check(true, "ephemeral follow-up feed accepted without cookies") } else { check(false, "ephemeral follow-up") }
        var allOnce = true, allFinished = true
        for index in 0..<100 {
            var callbacks = 0
            let request = CompanionFeedRequest(url: URL(string: "http://127.0.0.1:\(port)/ok")!, token: "fixture-token-private") { _ in callbacks += 1 }
            request.start()
            // Interleave immediate/near-completion cancellation from another
            // thread with the real URLSession delegate queue, not a mock.
            DispatchQueue.global().asyncAfter(deadline: .now() + Double(index % 4) * 0.00025) {
                request.cancel(); request.cancel(); request.cancel()
            }
            let deadline = Date().addingTimeInterval(2)
            while callbacks == 0 && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.005)) }
            allFinished = allFinished && callbacks > 0
            request.cancel()
            RunLoop.main.run(until: Date().addingTimeInterval(0.005))
            allOnce = allOnce && callbacks == 1
        }
        check(allFinished, "100 real cancellation/completion races finish within bounds")
        check(allOnce, "repeated concurrent cancellation delivers exactly one terminal callback")
        var beforeStartOnce = true, beforeStartCancelled = true
        for _ in 0..<10 {
            var callbacks = 0, cancelled = false
            let request = CompanionFeedRequest(url: URL(string: "http://127.0.0.1:\(port)/ok")!, token: "fixture-token-private") { result in
                callbacks += 1
                if case .failure(let error) = result { cancelled = (error as? URLError)?.code == .cancelled }
            }
            request.cancel(); request.start(); request.start(); request.cancel()
            let deadline = Date().addingTimeInterval(2)
            while callbacks == 0 && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.005)) }
            request.start(); request.cancel()
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            beforeStartOnce = beforeStartOnce && callbacks == 1
            beforeStartCancelled = beforeStartCancelled && cancelled
        }
        check(beforeStartOnce, "cancel-before-start and repeated start/cancel finish exactly once")
        check(beforeStartCancelled, "cancel-before-start cannot start or resurrect the request")
    }
    static func main() {
        model(); geometry(); lifecycle(); motion()
        if CommandLine.arguments.count == 2 { feed(port: CommandLine.arguments[1]) }
        let output: [String: Any] = ["passed": checks.count, "failed": 0, "checks": checks]
        print(String(data: try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
    }
}
