// Standalone test executable only. Never staged into Strata or its app resources.
// Every setting and callback belongs to a fresh disposable fixture, not the user.
import AppKit
import SwiftUI

private var fixtureOutput: URL?
private let fixtureCallback: CompanionOpenCallback = { raw in
    guard let raw, let output = fixtureOutput else { return }
    let line = String(cString: raw) + "\n"
    if let data = line.data(using: .utf8) {
        if !FileManager.default.fileExists(atPath: output.path) { FileManager.default.createFile(atPath: output.path, contents: nil) }
        if let handle = try? FileHandle(forWritingTo: output) { _ = try? handle.seekToEnd(); try? handle.write(contentsOf: data); try? handle.close() }
    }
}

@main struct PanelFixture {
    static func main() {
        let arguments = CommandLine.arguments
        guard arguments.count == 4, let port = UInt16(arguments[1]), port > 0,
              arguments[2].hasPrefix("/"), arguments[3].hasPrefix("strata.companion.fixture.") else {
            fputs("Usage: PanelFixture <private fixture port> <private output directory> <strata.companion.fixture.UUID>\n", stderr); exit(2)
        }
        setenv("STRATA_COMPANION_TEST_MODE", "1", 1)
        setenv("STRATA_COMPANION_TEST_DEFAULTS", arguments[3], 1)
        let suite = UserDefaults(suiteName: arguments[3])!
        suite.removePersistentDomain(forName: arguments[3])
        fixtureOutput = URL(fileURLWithPath: arguments[2]).appendingPathComponent("callbacks.jsonl")
        let app = NSApplication.shared
        let delegate = FixtureDelegate(port: port, directory: URL(fileURLWithPath: arguments[2]), suite: arguments[3])
        app.delegate = delegate
        app.run()
        CompanionController.shared.shutdown()
        suite.removePersistentDomain(forName: arguments[3])
        withExtendedLifetime(delegate) {}
    }
}

private final class FixtureDelegate: NSObject, NSApplicationDelegate {
    let port: UInt16
    let directory: URL
    let suite: String
    var window: NSWindow?
    var statusTimer: Timer?
    init(port: UInt16, directory: URL, suite: String) { self.port = port; self.directory = directory; self.suite = suite }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem(); let appMenu = NSMenu(title: "Strata Companion Fixture")
        let show = NSMenuItem(title: "Enable Fixture Companion", action: #selector(showCompanion), keyEquivalent: "e"); show.target = self; appMenu.addItem(show)
        let editor = NSMenuItem(title: "Focus Fixture Editor", action: #selector(focusEditor), keyEquivalent: "d"); editor.target = self; appMenu.addItem(editor)
        appMenu.addItem(.separator())
        let hide = NSMenuItem(title: "Hide Fixture", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"); hide.target = NSApp; appMenu.addItem(hide)
        let unhide = NSMenuItem(title: "Unhide Fixture", action: #selector(NSApplication.unhide(_:)), keyEquivalent: "u"); unhide.target = NSApp; appMenu.addItem(unhide)
        appMenu.addItem(withTitle: "Quit Fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu; menu.addItem(appItem); NSApp.mainMenu = menu
        let window = NSWindow(contentRect: CGRect(x: 120, y: 100, width: 660, height: 380), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Strata Companion — disposable native fixture"
        let text = NSTextView(frame: CGRect(x: 20, y: 20, width: 620, height: 340))
        text.string = "Native companion fixture\n\nThis editor should keep keyboard focus when the companion appears and refreshes.\n\nNo real Strata app, bot, model, history, pairing or approval is used.\n\nUse View → Focus Bot Companion for keyboard access."
        text.font = NSFont.systemFont(ofSize: 17); text.isEditable = true
        text.setAccessibilityIdentifier("fixtureEditor")
        window.contentView = text; window.makeKeyAndOrderFront(nil); window.makeFirstResponder(text); self.window = window
        CompanionController.shared.initialize(fixtureCallback)
        CompanionController.shared.configure(port: port, token: String(repeating: "f", count: 64))
        _ = CompanionController.shared.settings(["enabled": true, "screen": "main"])
        writeStatus()
        statusTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.writeStatus() }
    }
    private func writeStatus() {
        var value = CompanionController.shared.status()
        value["editorIsKey"] = window?.isKeyWindow == true
        value["keyWindowTitle"] = NSApp.keyWindow?.title ?? ""
        value["fixtureSuite"] = suite
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) { try? data.write(to: directory.appendingPathComponent("status.json"), options: .atomic) }
    }
    @objc private func showCompanion() { _ = CompanionController.shared.settings(["enabled": true]) }
    @objc private func focusEditor() { window?.makeKeyAndOrderFront(nil) }
    func applicationWillTerminate(_ notification: Notification) {
        statusTimer?.invalidate(); statusTimer = nil; CompanionController.shared.shutdown()
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
