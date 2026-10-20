// SPDX-License-Identifier: FSL-1.1-MIT
// Copyright (c) 2026 Cua AI, Inc.
// Adapted from the actual CUA computer pane; frames and leases belong to Strata.
import CuaBotsCore
import CuaBotsUI
import SwiftUI

struct ComputerPane: View {
    @EnvironmentObject var model: AppModel
    var bot: Bot
    var body: some View {
        let contextBot = model.store.viewBot(bot.id) ?? bot
        Group {
            if contextBot.spaceID != nil { ComputerContent(session: model.session(for: contextBot), bot: contextBot, popOut: { model.popOut(contextBot) }, close: { model.showComputer = false }) }
            else { ContentUnavailableView("Host tools", systemImage: "terminal", description: Text("This conversation does not use an isolated computer.")) }
        }.id(bot.id + ":" + (model.store.selectedChats[bot.id] ?? "profile"))
    }
}
private struct ComputerContent: View {
    @ObservedObject var session: ComputerSession
    var bot: Bot
    var popOut: () -> Void
    var close: () -> Void
    @State private var text = ""
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "desktopcomputer").foregroundStyle(.secondary)
                Text(bot.computerTitle).font(.headline)
                Spacer()
                Button(action: popOut) { Image(systemName: "pip.enter") }.buttonStyle(.borderless).help("Picture in picture")
                Button(action: close) { Image(systemName: "xmark") }.buttonStyle(.borderless).help("Close")
            }.padding(.horizontal, 14).padding(.vertical, 10)
            GeometryReader { geometry in
                let aspect = session.width > 0 && session.height > 0 ? session.width / session.height : 1.6
                let width = max(0, min(geometry.size.width, (geometry.size.height - 36) * aspect + 36))
                let height = max(0, (width - 36) / aspect + 36)
                ZStack {
                    RoundedRectangle(cornerRadius: 14).fill(bot.avatar.color.accent.opacity(0.85))
                    Group {
                        if let image = session.image, session.running {
                            Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
                                .contentShape(Rectangle())
                                .gesture(SpatialTapGesture().onEnded { tap in
                                    guard session.owned, width > 36, height > 36 else { return }
                                    let x = Int(tap.location.x / (width - 36) * session.width), y = Int(tap.location.y / (height - 36) * session.height)
                                    Task { await session.input("click", values: ["x": x, "y": y]) }
                                })
                                .accessibilityLabel("\(bot.computerTitle), \(Int(session.width)) by \(Int(session.height)) pixels")
                        } else {
                            VStack(spacing: 12) {
                                if session.working { ProgressView() }
                                Image(systemName: "desktopcomputer").font(.largeTitle)
                                Text(session.detail).multilineTextAlignment(.center).font(.callout)
                                Button("Prepare CUA") { Task { await session.action("prepare") } }.disabled(session.working)
                                Button("Start computer") { Task { await session.action("start") } }.buttonStyle(.borderedProminent).disabled(session.working)
                                Text("2 CPUs · 4 GB RAM · runs on the selected computer").font(.caption).foregroundStyle(.secondary)
                            }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity).background(.background)
                        }
                    }.clipShape(RoundedRectangle(cornerRadius: 6)).padding(18)
                }.frame(width: width, height: height).position(x: geometry.size.width / 2, y: geometry.size.height / 2)
            }.padding(.horizontal, 14)
            if let error = session.error { Text(error).font(.caption).foregroundStyle(.red).padding(.horizontal, 14).textSelection(.enabled) }
            HStack(spacing: 10) {
                Text(session.owned ? "You have control" : session.running ? "\(bot.name) has control" : "Computer stopped").font(.callout)
                if session.running { Button(session.owned ? "Return control" : "Take over") { Task { if session.owned { await session.release() } else { await session.action("takeover") } } }.buttonStyle(.borderedProminent).controlSize(.small).disabled(session.working) }
                if session.running || session.cleanupUnconfirmed { Button("Stop computer") { Task { await session.action("stop") } }.controlSize(.small).disabled(session.working) }
            }.padding(.vertical, 12)
            if session.owned {
                HStack {
                    TextField("Type on the computer", text: $text).textFieldStyle(.roundedBorder).onSubmit(send)
                    Button("Type", action: send).disabled(text.isEmpty || session.working)
                }.padding(.horizontal, 14)
                HStack {
                    ForEach(["Enter", "Tab", "Escape", "Backspace", "Control+L"], id: \.self) { key in Button(key) { Task { await session.input("key", values: ["key": key]) } }.controlSize(.small).disabled(session.working) }
                }.padding(10)
            }
        }.onAppear { session.observe() }.onDisappear { session.unobserve() }
    }
    private func send() { let value = text; guard !value.isEmpty else { return }; Task { await session.input("type", values: ["text": value]); if session.error == nil { text = "" } } }
}
