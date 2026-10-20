// SPDX-License-Identifier: FSL-1.1-MIT
// Copyright (c) 2026 Cua AI, Inc.

import AppKit
import CuaBotsCore
import SwiftUI

@main
struct StrataBotsApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup("Strata Bots") {
            RootView()
                .environmentObject(model)

                .frame(minWidth: 980, minHeight: 640)
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in model.releaseControls() }

        }
        .defaultSize(width: 1280, height: 800)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Bot") { model.route = .newBot }.keyboardShortcut("n")
            }
            CommandMenu("Bot") {
                Button("Open Computer") { model.showComputer = true }
                    .keyboardShortcut("k").disabled(model.selectedBot?.spaceID == nil)
                Button("Pause or Resume") { if let b = model.selectedBot { model.togglePause(b) } }
                    .keyboardShortcut("p", modifiers: [.command, .shift]).disabled(model.selectedBot == nil)
                Button("Show Profile") { model.showProfile.toggle() }
                    .keyboardShortcut("i").disabled(model.selectedBot == nil)
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // A SwiftPM executable starts as a background process; make it a
        // regular app with a Dock icon and a key window.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        NSApp.applicationIconImage = AppIcon.image()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

/// The Dock icon: a Cua koala on a rounded tile, drawn in code.
enum AppIcon {
    @MainActor static func image() -> NSImage {
        let view = ZStack {
            RoundedRectangle(cornerRadius: 230, style: .continuous).fill(Color(hex: 0x0B0E13))
            KoalaAvatar(AvatarConfig(color: .cloud, eyes: .star, ears: .scalloped), animated: false)
                .padding(150)
        }
        .frame(width: 1024, height: 1024)
        let r = ImageRenderer(content: view)
        r.scale = 1
        return r.nsImage ?? NSImage()
    }
}
