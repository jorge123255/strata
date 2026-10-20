// SPDX-License-Identifier: FSL-1.1-MIT
// Copyright (c) 2026 Cua AI, Inc.

import CuaBotsCore
import CuaBotsUI
import SwiftUI

struct ChatView: View {
    @EnvironmentObject var model: AppModel
    var bot: Bot
    @State private var draft = ""
    @FocusState private var focused: Bool

    var messages: [ChatMessage] { model.store.messages(for: bot.id) }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("Conversation", selection: Binding(get: { model.store.selectedChats[bot.id] ?? "" }, set: { model.store.chooseChat(bot.id, $0) })) { ForEach(model.store.conversations[bot.id] ?? []) { Text($0.title).tag($0.id) } }.labelsHidden()
                Button { model.newConversationFor = bot } label: { Image(systemName: "square.and.pencil") }.help("New shared conversation")
                if model.store.isBusy(bot.id) { Button("Stop") { model.togglePause(bot) } }
            }.padding(.horizontal, 16).padding(.vertical, 8)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        header.padding(.bottom, 8)
                        ForEach(Array(messages.enumerated()), id: \.element.id) { i, m in
                            if i == 0 || !Calendar.current.isDate(m.date, equalTo: messages[i - 1].date, toGranularity: .hour) {
                                Text(m.date.formatted(date: .abbreviated, time: .shortened))
                                    .font(.caption2).foregroundStyle(.tertiary)
                                    .frame(maxWidth: .infinity)
                            }
                            row(m).id(m.id)
                        }
                        if model.store.isBusy(bot.id) {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text(bot.status).font(.caption).foregroundStyle(.secondary)
                            }
                            .id("typing")
                        }
                        if let phase = model.store.setupPhase[bot.id] {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text(phase).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if messages.count <= 2 { suggestions }
                    }
                    .padding(.horizontal, 20).padding(.vertical, 16)
                    .frame(maxWidth: 720)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: messages.count) { _, _ in
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(messages.last?.id, anchor: .bottom) }
                }
                .onAppear { proxy.scrollTo(messages.last?.id, anchor: .bottom) }
            }
            if bot.isPaused { pausedBar }
            composer
        }
    }

    var header: some View {
        VStack(spacing: 4) {
            AvatarBadge(bot.avatar, mood: bot.mood, size: 64)
            Text(bot.name).font(.headline)
            Text(presenceLine(bot, busy: model.store.isBusy(bot.id), lastActive: model.lastActive(bot.id)))
                .font(.caption).foregroundStyle(.secondary)
            let context = model.store.viewContext(for: bot.id)
            Text(context.modelName).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            Text(context.computerName + (context.hasComputer ? " · Isolated CUA computer" : context.computerMode == "host" ? " · Host tools" : " · Settings unavailable"))
                .font(.caption2).foregroundStyle(.tertiary).textSelection(.enabled)
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder func row(_ m: ChatMessage) -> some View {
        switch m.kind {
        case .thinking:
            DisclosureGroup("Thinking") { Text(m.text).font(.callout).foregroundStyle(.secondary).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.font(.caption)
        case .activity:
            DisclosureGroup(m.text.components(separatedBy: "\n").first ?? "Activity") { Text(m.text).font(.caption.monospaced()).textSelection(.enabled) }.font(.caption).foregroundStyle(.secondary)
        case .text:
            MessageRow(m, accent: bot.avatar.color.accent)
        case .notice:
            MessageRow(ChatMessage(botID: m.botID, role: .system, text: m.text), accent: bot.avatar.color.accent)
        case .approval(let id):
            if let a = model.store.approval(id) {
                ApprovalCard(a, botName: bot.name, onDecide: { model.decide(a, $0) },
                             onOpenComputer: { model.showComputer = true })
            }
        case .login(let site, let id):
            SignInCard(site: site, approval: model.store.approval(id)) {
                if let a = model.store.approval(id) { model.signInFor = a }
            }
        case .result(let title, let outputs):
            ResultCard(title: title, outputs: outputs) { model.openOutput = $0 }
        }
    }

    var suggestions: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Try").font(.caption).foregroundStyle(.secondary)
            ForEach(Self.suggestions(for: bot), id: \.self) { s in
                Button { draft = s; focused = true } label: {
                    Text(s).font(.callout)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(Capsule().strokeBorder(.primary.opacity(0.12)))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 8)
    }

    static func suggestions(for bot: Bot) -> [String] {
        [
            "Research standing desks and write me a short summary",
            "Review my project and suggest the next improvement",
            "Research a topic and save a short summary in outputs/",
        ]
    }

    var pausedBar: some View {
        Button { model.togglePause(bot) } label: {
            HStack {
                Image(systemName: "pause.circle")
                Text("Paused").fontWeight(.medium)
                Text("·")
                Text("Click to resume")
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(8)
            .background(.quaternary.opacity(0.5))
        }
        .buttonStyle(.plain)
    }

    var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
                        TextField("Message \(bot.name)", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...6)
                .focused($focused)
                .onSubmit(send)
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill").font(.title2)
            }
            .buttonStyle(.borderless)
            .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
            .keyboardShortcut(.return, modifiers: .command)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 18).fill(.background))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(.primary.opacity(0.12)))
        .padding(.horizontal, 20).padding(.bottom, 14).padding(.top, 6)
        .frame(maxWidth: 760)
    }

    func send() {
        let t = draft
        draft = ""
        model.send(t)
    }

}
