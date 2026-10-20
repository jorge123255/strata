// SPDX-License-Identifier: FSL-1.1-MIT
// Copyright (c) 2026 Cua AI, Inc.

import CuaBotsCore
import CuaBotsUI
import SwiftUI

// MARK: - Look

struct AvatarSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    @State var avatar = AvatarConfig()
    @State var name = ""
    @State var preview: BotMood = .idle

    var body: some View {
        VStack(spacing: 18) {
            KoalaAvatar(avatar, mood: preview).frame(width: 120, height: 120)
            Picker("Preview", selection: $preview) {
                Text("Idle").tag(BotMood.idle)
                Text("Thinking").tag(BotMood.thinking)
                Text("Working").tag(BotMood.working)
                Text("Asking").tag(BotMood.needsApproval)
                Text("Done").tag(BotMood.done)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            TextField("Name", text: $name).textFieldStyle(.roundedBorder).frame(maxWidth: 240)
            AvatarPicker(avatar: $avatar, name: name)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save") {
                    if let bot = model.selectedBot {
                        model.store.updateAvatar(bot.id, avatar)
                        if name != bot.name { model.store.rename(bot.id, to: name) }
                    }
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 460)
        .onAppear {
            if let bot = model.selectedBot { avatar = bot.avatar; name = bot.name }
        }
    }
}

// MARK: - Rules

struct RulesSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    @State var adding = false
    @State var action = ""
    @State var behavior: RuleBehavior = .askFirst

    var body: some View {
        let bot = model.selectedBot
        let rules = bot.map { model.store.rules(for: $0.id) } ?? []
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Custom rules").font(.title3.weight(.semibold))
                Spacer()
                Button { adding = true } label: { Label("Add rule", systemImage: "plus") }
            }
            Text("These standing instructions are shared with the bot. Strata’s permission mode controls tool approvals.")
                .font(.callout).foregroundStyle(.secondary)
            List {
                ForEach(rules) { r in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.action)
                            Text(r.isBuiltIn ? "Default" : "Yours").font(.caption).foregroundStyle(.tertiary)
                        }
                        Spacer()
                        if r.locked {
                            Label(r.behavior.short, systemImage: "lock").labelStyle(.titleAndIcon)
                                .font(.caption).foregroundStyle(.secondary)
                        } else {
                            Picker("", selection: Binding(get: { r.behavior }, set: { b in
                                guard let bot else { return }
                                var list = rules
                                if let i = list.firstIndex(where: { $0.id == r.id }) { list[i].behavior = b }
                                model.store.setRules(bot.id, list)
                            })) {
                                ForEach(RuleBehavior.allCases) { Text($0.short).tag($0) }
                            }
                            .labelsHidden()
                            .frame(width: 150)
                        }
                    }
                    .contextMenu {
                        if !r.locked && !r.isBuiltIn, let bot {
                            Button("Delete", role: .destructive) {
                                model.store.setRules(bot.id, rules.filter { $0.id != r.id })
                            }
                        }
                    }
                }
            }
            .listStyle(.inset(alternatesRowBackgrounds: true))
            .frame(minHeight: 260)
            Text("Written to its Volume home as agents/\(bot?.id ?? "")/rules.yaml, and into \(bot?.harness.instructionsFile ?? "its instructions") so the bot reads them.")
                .font(.caption).foregroundStyle(.tertiary)
            HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction) }
        }
        .padding(20)
        .frame(width: 560, height: 520)
        .sheet(isPresented: $adding) {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Button { adding = false } label: { Image(systemName: "xmark") }.buttonStyle(.borderless)
                    Spacer()
                    Text("Add rule").font(.headline)
                    Spacer()
                    Button {
                        if let bot, !action.trimmingCharacters(in: .whitespaces).isEmpty {
                            model.store.setRules(bot.id, rules + [CustomRule(action: action, behavior: behavior)])
                        }
                        action = ""
                        adding = false
                    } label: { Image(systemName: "checkmark") }
                    .buttonStyle(.borderedProminent)
                    .disabled(action.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                RuleForm(action: $action, behavior: $behavior, botName: bot?.name ?? "Your bot")
            }
            .padding(20)
            .frame(width: 440)
        }
    }
}

// MARK: - Memory

struct MemorySheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss

    var body: some View {
        let bot = model.selectedBot
        let files = bot.map { (try? model.store.volume.walk(VolumeLayout.home($0.id))) ?? [] } ?? []
        VStack(alignment: .leading, spacing: 12) {
            Text("\(bot?.name ?? "Bot")'s memory").font(.title3.weight(.semibold))
            Text("Memory lives on the Strata host, separately from the bot’s computer and shared conversations.")
                .font(.callout).foregroundStyle(.secondary)
            ScrollView {
                Text(bot.map { model.store.memory(for: $0.id) } ?? "")
                    .font(.body.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .background(RoundedRectangle(cornerRadius: 8).fill(.background))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.primary.opacity(0.1)))
            Text("Files in its home").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
            ForEach(files.filter { !$0.path.contains("/identity/") }.prefix(10)) { f in
                HStack {
                    Image(systemName: "doc").foregroundStyle(.secondary)
                    Text(f.path).font(.caption.monospaced())
                    Spacer()
                    Text(ByteCountFormatter.string(fromByteCount: Int64(f.size), countStyle: .file))
                        .font(.caption).foregroundStyle(.tertiary)
                }
            }
            HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction) }
        }
        .padding(20)
        .frame(width: 560, height: 500)
    }
}

// MARK: - Sign in

struct SignInSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    var approval: ApprovalRequest
    var body: some View { VStack(alignment: .leading, spacing: 16) { Text("Sign in on the computer").font(.title3); Text("Take over the bot’s computer and sign in yourself. Strata does not copy passwords or CUA Keyvault entries into a model."); Button("Open computer") { model.showComputer = true; dismiss() }; Button("Done") { dismiss() } }.padding(24).frame(width: 440) }
}

// MARK: - Output

struct OutputSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    var path: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: "doc.text")
                Text((path as NSString).lastPathComponent).font(.headline)
                Spacer()
                Text(path).font(.caption.monospaced()).foregroundStyle(.tertiary)
            }
            ScrollView {
                Text(MessageRow.markdown((try? model.store.volume.readText(path)) ?? "Not synced yet."))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .background(RoundedRectangle(cornerRadius: 8).fill(.background))
            HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction) }
        }
        .padding(20)
        .frame(width: 620, height: 520)
        .task(id: path) { await model.store.loadOutput(path) }
    }
}

extension MessageRow {
    static func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
    }
}

// MARK: - Pair iPhone

struct PairSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    var bot: Bot
    @State private var enabled = false
    @State private var invitation: [String: Any]?
    @State private var devices: [String] = []
    @State private var qr: NSImage?
    @State private var working = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Pair iPhone").font(.title3.weight(.semibold))
            Text("Uses Strata’s existing encrypted pairing. Paired devices share the same conversations, thinking, approvals and computers.").font(.callout).foregroundStyle(.secondary)
            if let invitation, invitation["available"] as? Bool == true {
                HStack(spacing: 20) {
                    if let qr { Image(nsImage: qr).resizable().interpolation(.none).frame(width: 160, height: 160).padding(8).background(.white).clipShape(RoundedRectangle(cornerRadius: 10)) }
                    VStack(alignment: .leading, spacing: 8) { Text("Scan in Strata on your iPhone").font(.headline); Text(invitation["code"] as? String ?? "").font(.title.monospaced()).textSelection(.enabled); if let expires = invitation["expiresAt"] as? Double { Text("Expires \(Date(timeIntervalSince1970: expires / 1000).formatted(date: .omitted, time: .shortened))").font(.caption).foregroundStyle(.secondary) } }
                }
                if let url = invitation["url"] as? String { Button("Copy invitation") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(url, forType: .string) } }
            }
            if !devices.isEmpty { Text("Paired devices").font(.headline); ForEach(devices, id: \.self) { Label($0, systemImage: "iphone") } }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            HStack { Button(enabled ? "Create new pairing code" : "Enable iPhone pairing") { Task { await load(action: enabled ? "invitation" : "start") } }.buttonStyle(.borderedProminent).disabled(working); Spacer(); Button("Done") { dismiss() } }
            Text("Existing paired devices keep their access. Opening this sheet does not enable pairing or replace an invitation.").font(.caption).foregroundStyle(.secondary)
        }.padding(24).frame(width: 520).task { await load() }
    }
    private func load(action: String? = nil) async {
        guard !working else { return }; working = true; defer { working = false }
        do { let state = try await model.store.engine.request("/api/companion" + (action.map { "/\($0)" } ?? ""), method: action == nil ? "GET" : "POST", body: action == nil ? nil : [:]); enabled = state["enabled"] as? Bool ?? false; invitation = state["invitation"] as? [String: Any]; devices = (state["devices"] as? [[String: Any]] ?? []).compactMap { $0["deviceName"] as? String }; if invitation?["qrAvailable"] as? Bool == true { qr = NSImage(data: try await model.store.engine.pairingQR()) }; error = nil } catch { self.error = error.localizedDescription }
    }
}
