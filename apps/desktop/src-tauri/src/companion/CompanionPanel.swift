// Native, opt-in presentation inside Strata's existing process and bundle.
// No Coucou artwork, sounds, brand, character or animation sequence is used.
import AppKit
import SwiftUI
import QuartzCore

typealias CompanionOpenCallback = @convention(c) (UnsafePointer<CChar>?) -> Void

final class CompanionNativePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class CompanionController: NSObject, ObservableObject, NSWindowDelegate, NSMenuItemValidation {
    static let shared = CompanionController()
    @Published private(set) var snapshot: CompanionSnapshot?
    @Published private(set) var stale = true
    @Published private(set) var expanded = false
    @Published private(set) var presented = false
    @Published private(set) var reaction: CompanionReaction?
    private(set) var lifecycle = CompanionLifecycle()
    private var selectedScreen = "main"
    private var defaults: UserDefaults = .standard
    private var panel: CompanionNativePanel?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var focusItem: NSMenuItem?
    private var callback: CompanionOpenCallback?
    private var feedURL: URL?
    private var feedToken = ""
    private var request: CompanionFeedRequest?
    private var nextPoll: DispatchWorkItem?
    private var expiry: DispatchWorkItem?
    private var lastReceived: Date?
    private var initialized = false
    private var reactionTracker = CompanionReactionTracker()
    private var reactionSequence: UInt64 = 0
    var motionAllowed: Bool { presented && !stale && lifecycle.shouldShow }

    func initialize(_ callback: CompanionOpenCallback?) {
        self.callback = callback
        guard !initialized else { return }; initialized = true
        // Only disposable test executables may select a private defaults suite.
        // Production always shares Strata's existing bundle identity.
        if ProcessInfo.processInfo.environment["STRATA_COMPANION_TEST_MODE"] == "1",
           let suite = ProcessInfo.processInfo.environment["STRATA_COMPANION_TEST_DEFAULTS"],
           suite.hasPrefix("strata.companion.fixture."), let value = UserDefaults(suiteName: suite) { defaults = value }
        lifecycle.enabled = defaults.bool(forKey: "strata.botCompanion.enabled.v1")
        // Notifications only describe changes after launch. Read the current
        // console session first so a login-item/reopen cannot expose titles on
        // an already locked or switched-away session.
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        lifecycle.sessionActive = (session?[kCGSessionOnConsoleKey as String] as? Bool == true)
            && (session?[kCGSessionLoginDoneKey as String] as? Bool == true)
            && (session?["CGSSessionScreenIsLocked"] as? Bool != true)
        lifecycle.awake = CGDisplayIsAsleep(CGMainDisplayID()) == 0
        lifecycle.applicationHidden = NSApp.isHidden
        if let saved = defaults.string(forKey: "strata.botCompanion.screen.v1"), CompanionGeometry.canonicalScreen(saved) { selectedScreen = saved }
        observe(NSWorkspace.shared.notificationCenter, NSWorkspace.screensDidSleepNotification) { $0.lifecycle.awake = false; $0.reconcile() }
        observe(NSWorkspace.shared.notificationCenter, NSWorkspace.screensDidWakeNotification) { $0.lifecycle.awake = true; $0.reconcile() }
        observe(NSWorkspace.shared.notificationCenter, NSWorkspace.sessionDidResignActiveNotification) { $0.lifecycle.sessionActive = false; $0.reconcile() }
        observe(NSWorkspace.shared.notificationCenter, NSWorkspace.sessionDidBecomeActiveNotification) { $0.lifecycle.sessionActive = true; $0.reconcile() }
        observe(DistributedNotificationCenter.default(), NSNotification.Name("com.apple.screenIsLocked")) { $0.lifecycle.sessionActive = false; $0.reconcile() }
        observe(DistributedNotificationCenter.default(), NSNotification.Name("com.apple.screenIsUnlocked")) { $0.lifecycle.sessionActive = true; $0.reconcile() }
        observe(.default, NSApplication.didChangeScreenParametersNotification) { $0.reconcile() }
        observe(.default, NSApplication.didHideNotification) { $0.lifecycle.applicationHidden = true; $0.reconcile() }
        observe(.default, NSApplication.didUnhideNotification) { $0.lifecycle.applicationHidden = false; $0.reconcile() }
        observe(.default, NSApplication.didFinishLaunchingNotification) { $0.installMenu() }
        observe(.default, NSApplication.willTerminateNotification) { $0.shutdown() }
        installMenu()
    }
    private func observe(_ center: NotificationCenter, _ name: Notification.Name, action: @escaping (CompanionController) -> Void) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in if let self { action(self) } }
        observers.append((center, token))
    }
    private func installMenu() {
        guard focusItem == nil, let menu = NSApp.mainMenu else { return }
        let view = menu.items.first(where: { $0.submenu?.title == "View" })?.submenu ?? {
            let item = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
            let submenu = NSMenu(title: "View"); item.submenu = submenu; menu.addItem(item); return submenu
        }()
        let item = NSMenuItem(title: "Focus Bot Companion", action: #selector(focusFromMenu), keyEquivalent: "b")
        item.keyEquivalentModifierMask = [.command, .shift]; item.target = self
        item.isEnabled = lifecycle.enabled; view.addItem(item); focusItem = item
    }
    @objc private func focusFromMenu() {
        guard lifecycle.shouldShow else { return }
        ensurePanel(); panel?.makeKeyAndOrderFront(nil)
    }
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        menuItem === focusItem ? lifecycle.shouldShow : true
    }
    func configure(port: UInt16, token: String) {
        stopPolling(); snapshot = nil; stale = true; lastReceived = nil; reactionTracker.reset(); reaction = nil
        feedURL = port > 0 && token.utf8.count >= 32 && token.utf8.count <= 200 ? URL(string: "http://127.0.0.1:\(port)/api/bots/companion/snapshot") : nil
        feedToken = feedURL == nil ? "" : token
        lifecycle.configured = feedURL != nil; reconcile()
    }
    func settings(_ value: [String: Any]) -> [String: Any] {
        let keys = Set(value.keys)
        guard !keys.isEmpty, keys.isSubset(of: ["enabled", "screen"]),
              value["enabled"] == nil || CompanionSnapshot.boolean(value["enabled"]) != nil,
              value["screen"] == nil || (value["screen"] as? String).map(CompanionGeometry.canonicalScreen) == true else {
            return ["available": true, "error": "Choose valid companion settings."]
        }
        if let enabled = CompanionSnapshot.boolean(value["enabled"]) { lifecycle.enabled = enabled; defaults.set(enabled, forKey: "strata.botCompanion.enabled.v1") }
        if let screen = value["screen"] as? String { selectedScreen = screen; defaults.set(screen, forKey: "strata.botCompanion.screen.v1") }
        reconcile(); return status()
    }
    func status() -> [String: Any] {
        let screens = NSScreen.screens.enumerated().compactMap { entry -> [String: String]? in
            let (index, screen) = entry
            guard let id = Self.displayID(screen) else { return nil }
            let name = screen.localizedName.trimmingCharacters(in: .whitespacesAndNewlines)
            return ["id": id, "name": name.isEmpty ? "Display \(index + 1)" : String(decoding: name.utf16.prefix(160), as: UTF16.self)]
        }
        return ["available": true, "settings": ["enabled": lifecycle.enabled, "screen": selectedScreen], "screens": screens,
                "visible": panel?.isVisible == true, "expanded": expanded, "stale": stale,
                "detail": "Your bot companion stays with Strata while the Mac app is open. Open a conversation to review tools and approvals."]
    }
    private func ensurePanel() {
        guard panel == nil else { return }
        let panel = CompanionNativePanel(contentRect: CGRect(x: 0, y: 0, width: 326, height: 76), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Strata Bot Companion"; panel.identifier = NSUserInterfaceItemIdentifier("strataBotCompanionPanel")
        panel.isReleasedWhenClosed = false; panel.backgroundColor = .clear; panel.isOpaque = false
        panel.hasShadow = true; panel.hidesOnDeactivate = false; panel.becomesKeyOnlyIfNeeded = true
        panel.level = .floating; panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.delegate = self
        panel.contentView = NSHostingView(rootView: CompanionRootView(controller: self))
        self.panel = panel
    }
    private func reconcile() {
        lifecycle.displayAvailable = !NSScreen.screens.isEmpty
        stopPolling(); focusItem?.isEnabled = lifecycle.enabled
        guard lifecycle.shouldShow else { stale = true; expanded = false; presented = false; reaction = nil; reactionTracker.reset(); panel?.orderOut(nil); return }
        ensurePanel(); guard relocate() else { stale = true; presented = false; return }; panel?.orderFrontRegardless(); presented = true
        // orderFront does not activate Strata or make this panel the key window.
        poll()
    }
    private func stopPolling() {
        lifecycle.invalidate(); request?.cancel(); request = nil
        nextPoll?.cancel(); nextPoll = nil; expiry?.cancel(); expiry = nil
    }
    private func poll() {
        guard lifecycle.shouldShow, panel?.isVisible == true, let feedURL, request == nil else { return }
        let generation = lifecycle.generation
        let request = CompanionFeedRequest(url: feedURL, token: feedToken) { [weak self] result in
            guard let self, self.lifecycle.accepts(generation), self.panel?.isVisible == true else { return }
            self.request = nil
            switch result {
            case .success(let data):
                if let snapshot = try? CompanionSnapshot.decode(data),
                   let generated = CompanionSnapshot.timestamp(snapshot.updatedAt),
                   abs(generated.timeIntervalSinceNow) <= 30 {
                    if let kind = self.reactionTracker.observe(snapshot) {
                        self.reactionSequence &+= 1
                        self.reaction = CompanionReaction(sequence: self.reactionSequence, kind: kind, startedAt: Date())
                    }
                    self.snapshot = snapshot; self.stale = false; self.lastReceived = Date(); self.relocate()
                    self.expiry?.cancel()
                    let expiry = DispatchWorkItem { [weak self] in
                        guard let self, self.lifecycle.accepts(generation) else { return }; self.stale = true; self.reactionTracker.reset(); self.reaction = nil
                    }
                    self.expiry = expiry; DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: expiry)
                } else { self.stale = true; self.reactionTracker.reset(); self.reaction = nil }
            case .failure: self.stale = true; self.reactionTracker.reset(); self.reaction = nil
            }
            let next = DispatchWorkItem { [weak self] in guard let self, self.lifecycle.accepts(generation) else { return }; self.poll() }
            self.nextPoll = next; DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: next)
        }
        self.request = request; request.start()
    }
    func toggleExpanded() {
        guard lifecycle.shouldShow else { return }
        expanded.toggle(); relocate(animated: true)
        // A deliberate click can give the panel keyboard access; automatic
        // presentation never takes key status from the user's editor.
        panel?.makeKey()
    }
    func hide() { _ = settings(["enabled": false]) }
    func windowShouldClose(_ sender: NSWindow) -> Bool { hide(); return false }
    func open(_ row: CompanionSession) {
        guard lifecycle.shouldShow, !stale, let received = lastReceived, Date().timeIntervalSince(received) <= 12,
              snapshot?.sessions.contains(where: { $0.id == row.id && $0.botId == row.botId }) == true else { return }
        emit(["type": "chat", "id": row.id])
    }
    func openActivity() { guard lifecycle.shouldShow else { return }; emit(["type": "bots", "id": "activity"]) }
    private func emit(_ destination: [String: String]) {
        guard let callback, let data = try? JSONSerialization.data(withJSONObject: destination), let string = String(data: data, encoding: .utf8) else { return }
        string.withCString { callback($0) }
    }
    private static func displayID(_ screen: NSScreen) -> String? {
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
              let uuid = CGDisplayCreateUUIDFromDisplayID(number.uint32Value)?.takeRetainedValue() else { return nil }
        return CFUUIDCreateString(nil, uuid) as String
    }
    @discardableResult private func relocate(animated: Bool = false) -> Bool {
        guard let panel else { return false }
        guard let screen = NSScreen.screens.first(where: { Self.displayID($0) == selectedScreen }) ?? NSScreen.screens.first else { presented = false; panel.orderOut(nil); stopPolling(); return false }
        let menuHeight = max(NSStatusBar.system.thickness, screen.frame.maxY - screen.visibleFrame.maxY)
        let frame = CompanionGeometry.frame(screen: screen.frame, visible: screen.visibleFrame, safeAreaTop: screen.safeAreaInsets.top, menuBarHeight: menuHeight, expanded: expanded, rows: snapshot?.sessions.count ?? 0)
        if frame.isEmpty { presented = false; panel.orderOut(nil); stopPolling(); return false }
        if animated && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.24; context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                panel.animator().setFrame(frame, display: true)
            }
        } else { panel.setFrame(frame, display: true, animate: false) }
        return true
    }
    func shutdown() {
        guard !lifecycle.stopped else { return }; lifecycle.stopped = true; stopPolling()
        presented = false; reaction = nil; reactionTracker.reset()
        panel?.orderOut(nil); panel?.delegate = nil; panel = nil; snapshot = nil; feedURL = nil; feedToken = ""; callback = nil
        observers.forEach { $0.0.removeObserver($0.1) }; observers.removeAll()
        if let item = focusItem { item.menu?.removeItem(item) }; focusItem = nil
    }
}

private struct CompanionRootView: View {
    @ObservedObject var controller: CompanionController
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    private var lead: CompanionSession? { controller.snapshot?.sessions.first }
    private var heading: String {
        if controller.stale { return controller.snapshot == nil ? "Connecting to Strata…" : "Last known activity" }
        guard let snapshot = controller.snapshot else { return "Your little team companion" }
        if snapshot.counts.waiting > 0 { return "\(snapshot.counts.waiting) waiting for you" }
        if snapshot.counts.errors > 0 { return "A bot needs a hand" }
        if snapshot.counts.working > 0 { return "\(snapshot.counts.working) in motion" }
        return snapshot.sessions.isEmpty ? "Your next idea starts here" : "A reply is ready"
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                CompanionAvatar(config: lead?.avatarConfig ?? AvatarConfig(), state: lead?.state ?? "idle", stale: controller.stale, size: 48,
                                animated: controller.motionAllowed, reaction: controller.reaction, interactive: true)
                Button { controller.toggleExpanded() } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(heading).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                        Text(lead?.name ?? "Strata Bot Companion").font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                    }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel("\(heading). \(controller.expanded ? "Collapse" : "Expand") bot companion")
                .accessibilityIdentifier("companionExpandButton")
                Button { controller.hide() } label: { Image(systemName: "xmark").font(.system(size: 11, weight: .medium)).frame(width: 24, height: 28) }
                    .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Hide bot companion").accessibilityIdentifier("companionHideButton")
            }.padding(.horizontal, 13).frame(height: 76)
            if controller.expanded {
                Divider().padding(.horizontal, 14)
                ScrollView {
                    VStack(spacing: 6) {
                        if let snapshot = controller.snapshot, !snapshot.sessions.isEmpty {
                            ForEach(snapshot.sessions) { row in
                                Button { controller.open(row) } label: {
                                    HStack(spacing: 9) {
                                        CompanionAvatar(config: row.avatarConfig, state: row.state, stale: controller.stale, size: 40)
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(row.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                                            Text(row.title).font(.system(size: 11)).lineLimit(1)
                                            Label(controller.stale ? "Last known: \(row.label)" : row.label, systemImage: row.symbol).font(.system(size: 10)).foregroundStyle(.secondary)
                                        }.frame(maxWidth: .infinity, alignment: .leading)
                                        Image(systemName: "arrow.up.forward").font(.system(size: 10)).foregroundStyle(.secondary)
                                    }.padding(.horizontal, 8).padding(.vertical, 5).contentShape(Rectangle())
                                }.buttonStyle(.plain).disabled(controller.stale)
                                .accessibilityLabel("\(row.name). \(row.title). \(controller.stale ? "Last known: " : "")\(row.label). Open conversation")
                                .accessibilityIdentifier("companionConversation_\(row.id)")
                            }
                        } else {
                            Text(controller.stale ? "Open Strata to reconnect. Your conversations are kept in the app." : "Say hello to a bot in Strata. Its work will appear here.")
                                .font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(18)
                        }
                    }.padding(6)
                }
                Divider().padding(.horizontal, 14)
                HStack {
                    if controller.snapshot?.hasMore == true { Text("More in Activity").font(.system(size: 10)).foregroundStyle(.secondary) }
                    Spacer()
                    Button("Open Activity") { controller.openActivity() }.font(.system(size: 12, weight: .medium)).accessibilityIdentifier("companionActivityButton")
                }.padding(.horizontal, 16).frame(height: 44)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background {
            if reduceTransparency { RoundedRectangle(cornerRadius: 22).fill(Color(nsColor: .windowBackgroundColor)) }
            else { RoundedRectangle(cornerRadius: 22).fill(.regularMaterial) }
        }
        .clipShape(RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(Color.primary.opacity(0.1), lineWidth: 1))
        .accessibilityElement(children: .contain).accessibilityLabel("Strata Bot Companion")
    }
}

private func companionMain<T>(_ action: () -> T) -> T {
    if Thread.isMainThread { return action() }; return DispatchQueue.main.sync(execute: action)
}
private func companionJSON(_ value: [String: Any]) -> UnsafeMutablePointer<CChar>? {
    guard let data = try? JSONSerialization.data(withJSONObject: value), let string = String(data: data, encoding: .utf8) else { return strdup("{}") }
    return strdup(string)
}
@_cdecl("strata_companion_init") func strataCompanionInit(_ callback: CompanionOpenCallback?) { companionMain { CompanionController.shared.initialize(callback) } }
@_cdecl("strata_companion_configure") func strataCompanionConfigure(_ port: UInt16, _ raw: UnsafePointer<CChar>?) {
    let token = raw.map { String(cString: $0) } ?? ""
    companionMain { CompanionController.shared.configure(port: port, token: token) }
}
@_cdecl("strata_companion_status") func strataCompanionStatus() -> UnsafeMutablePointer<CChar>? { companionMain { companionJSON(CompanionController.shared.status()) } }
@_cdecl("strata_companion_settings") func strataCompanionSettings(_ raw: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    let text = raw.map { String(cString: $0) } ?? ""
    guard text.utf8.count <= 512, let data = text.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return companionJSON(["available": true, "error": "Choose valid companion settings."]) }
    return companionMain { companionJSON(CompanionController.shared.settings(value)) }
}
@_cdecl("strata_companion_shutdown") func strataCompanionShutdown() { companionMain { CompanionController.shared.shutdown() } }
@_cdecl("strata_companion_free") func strataCompanionFree(_ raw: UnsafeMutablePointer<CChar>?) { free(raw) }
