import SwiftUI

/// A profile draft has no chat, computer lease or provider credentials.
struct BotProfileEditor: View {
    @ObservedObject var store: CompanionStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var original: CompanionBot?
    @State private var draft: BotProfileDraft
    @State private var providerModels: BotProviderModels?
    @State private var loadingModels = false
    @State private var customizing = false
    @State private var confirmingBypass = false
    @State private var confirmingReload = false
    @State private var reloading = false
    @State private var reloadError: String?
    @State private var visible = false
    @State private var workExpanded = false
    @State private var behaviorExpanded = false
    @State private var instructionsExpanded = false
    @State private var modelExpanded = false
    @FocusState private var focused: Field?
    private enum Field { case name, model, workspace, instructions }

    init(store: CompanionStore, bot: CompanionBot? = nil) {
        self.store = store
        _original = State(initialValue: bot)
        var value = bot.map(BotProfileDraft.init(bot:)) ?? BotProfileDraft()
        if bot == nil {
            value.provider = store.botCatalog?.providers.first(where: { $0.available && $0.id != "configured" })?.id ?? "claude"
            value.computerId = store.botCatalog?.computers.first(where: { $0.id == "local" })?.id ?? store.botCatalog?.computers.first?.id ?? ""
            value.workspace = store.botCatalog?.defaultWorkspace ?? ""
        }
        _draft = State(initialValue: value)
    }

    private var catalog: CompanionBots? { store.botCatalog }
    private var computer: BotComputer? { catalog?.computers.first { $0.id == draft.computerId } }
    private var provider: BotProvider? { catalog?.providers.first { $0.id == draft.provider } }
    private var efforts: [String] { computer?.kind == "ssh" ? [] : providerModels?.models.first { $0.id == draft.model }?.efforts ?? [] }
    private var validationError: String? {
        guard let catalog else { return "Reconnect to your Mac to save this bot." }
        do { _ = try draft.validated(in: catalog, original: original); return nil }
        catch { return error.localizedDescription }
    }
    private var canSave: Bool { validationError == nil && !store.savingBotProfile && !reloading && store.status?.hostConnected == true }
    private var providerReady: Bool {
        if draft.provider == "configured" { return catalog?.models?.first { $0.id == draft.modelId }?.available == true }
        if computer?.kind == "ssh" { return computer?.providers?.first { $0.id == draft.provider }?.available == true }
        return provider?.available == true
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    VStack(spacing: 18) {
                        Button { customizing = true } label: {
                            ExpressiveBotAvatar(config: draft.avatarConfig, size: 168, mood: .idle,
                                                animated: true, flourishToken: String(describing: draft.avatarConfig))
                        }.buttonStyle(.plain).accessibilityLabel("Customize bot avatar").accessibilityIdentifier("profileBotAvatarButton")
                        TextField("Name your bot", text: $draft.name)
                            .font(.title2.weight(.semibold)).multilineTextAlignment(.center).focused($focused, equals: .name)
                            .padding(.horizontal, 18).padding(.vertical, 18)
                            .background(StrataTheme.grouped, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                            .accessibilityIdentifier("profileBotNameInput")
                        AvatarPicker(avatar: $draft.avatarConfig, name: draft.name, supportedShapes: catalog?.avatarShapes ?? [], compact: true)
                    }
                    VStack(spacing: 0) {
                        inferenceRow("Provider") {
                            selectionMenu("Provider", selection: providerBinding, options: (catalog?.providers ?? []).map { BotEditorOption(id: $0.id, title: $0.name) }, identifier: "profileBotProviderPicker")
                        }
                        Divider().overlay(StrataTheme.line)
                        if draft.provider == "configured" {
                            inferenceRow("Model") {
                                selectionMenu("Model", selection: Binding(get: { draft.modelId ?? "" }, set: { draft.modelId = $0.isEmpty ? nil : $0 }), options: [BotEditorOption(id: "", title: "Choose a saved model")] + (catalog?.models ?? []).map { BotEditorOption(id: $0.id, title: $0.label + ($0.available ? "" : " · Setup required")) }, identifier: "profileBotConfiguredModelPicker")
                            }
                        } else {
                            inferenceRow("Model") { selectionMenu("Model", selection: modelBinding, options: modelOptions, identifier: "profileBotModelPicker") }
                            Divider().overlay(StrataTheme.line)
                            inferenceRow("Effort") {
                                selectionMenu("Effort", selection: Binding(get: { draft.effort ?? "" }, set: { draft.effort = $0.isEmpty ? nil : $0 }), options: effortOptions, identifier: "profileBotEffortPicker")
                            }
                            if loadingModels { ProgressView("Checking models…").font(.caption).padding(.vertical, 8) }
                        }
                    }.padding(.horizontal, 18).padding(.vertical, 8)
                        .background(StrataTheme.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                    if !providerReady {
                        Label("Check provider availability on the selected computer before starting work.", systemImage: "exclamationmark.circle")
                            .font(.caption).foregroundStyle(StrataTheme.warning).accessibilityIdentifier("profileBotSetupRequired")
                    }
                    VStack(alignment: .leading, spacing: 14) {
                        Text("What it does").font(.headline)
                        Picker("Template", selection: $draft.capabilities) {
                            Text("Coding").tag("code"); Text("Computer").tag("computer"); Text("Both").tag("both")
                        }.pickerStyle(.segmented).accessibilityIdentifier("profileBotTemplatePicker")
                        Text(draft.capabilities == "code" ? "Work with files, code and commands." : draft.capabilities == "computer" ? "Work with apps and the browser on the selected computer." : "Combine coding tools with computer control.")
                            .font(.caption).foregroundStyle(StrataTheme.secondaryInk)
                    }.strataBotEditorCard()
                    editorDisclosure("profileBotWorkDisclosure", isExpanded: $workExpanded) {
                        VStack(alignment: .leading, spacing: 16) {
                            inferenceRow("Computer") {
                                selectionMenu("Computer", selection: computerBinding, options: (catalog?.computers ?? []).map { BotEditorOption(id: $0.id, title: $0.name + ($0.available ? "" : " · Setup required")) }, identifier: "profileBotComputerPicker")
                            }
                            if let computer { Text(computer.detail).font(.caption).foregroundStyle(StrataTheme.secondaryInk) }
                            inferenceRow("Environment") {
                                selectionMenu("Environment", selection: environmentBinding, options: [BotEditorOption(id: "host", title: "On the selected computer"), BotEditorOption(id: "cua", title: "Isolated computer")], identifier: "profileBotEnvironmentPicker")
                            }
                            TextField("Full workspace folder path", text: $draft.workspace).focused($focused, equals: .workspace)
                                .textInputAutocapitalization(.never).autocorrectionDisabled().disabled(draft.computerMode == "cua")
                                .accessibilityIdentifier("profileBotWorkspaceInput")
                            Text(draft.computerMode == "cua" ? "The isolated computer uses /workspace. Creating this profile does not start it." : "Use the folder path on that computer. Add other computers in Strata on your Mac.")
                                .font(.caption).foregroundStyle(StrataTheme.secondaryInk)
                        }.padding(.top, 16)
                    } label: {
                        editorSummary("Where it works", detail: (computer?.name ?? "Choose a computer") + (draft.computerMode == "cua" ? " · Isolated" : ""), icon: "desktopcomputer")
                    }.strataBotEditorCard()
                    editorDisclosure("profileBotBehaviorDisclosure", isExpanded: $behaviorExpanded) {
                        VStack(alignment: .leading, spacing: 14) {
                            inferenceRow("Approvals") {
                                selectionMenu("Approvals", selection: Binding(get: { draft.policy.rawValue }, set: { draft.policy = BotApprovalPolicy(rawValue: $0) ?? .manual }), options: BotApprovalPolicy.allCases.map { BotEditorOption(id: $0.rawValue, title: $0.label) }, identifier: "profileBotPolicyPicker")
                            }
                            Text(draft.policy.detail).font(.caption).foregroundStyle(draft.policy == .bypass ? StrataTheme.warning : StrataTheme.secondaryInk)
                            Text("These defaults apply to new conversations. Existing chats keep their approval mode. Saving never approves queued requests.")
                                .font(.caption).foregroundStyle(StrataTheme.secondaryInk)
                        }.padding(.top, 16)
                    } label: { editorSummary("Approvals", detail: draft.policy.label, icon: "checkmark.shield") }
                        .strataBotEditorCard()
                    editorDisclosure("profileBotInstructionsDisclosure", isExpanded: $instructionsExpanded) {
                        TextEditor(text: $draft.instructions).frame(minHeight: 130).focused($focused, equals: .instructions)
                            .scrollContentBackground(.hidden).padding(.top, 12).accessibilityIdentifier("profileBotInstructionsInput")
                    } label: { editorSummary("Instructions", detail: draft.instructions.isEmpty ? "Add what your bot should know" : "Your custom instructions", icon: "text.alignleft") }
                        .strataBotEditorCard()
                    if draft.provider != "configured" {
                        editorDisclosure("profileBotAdvancedModelDisclosure", isExpanded: $modelExpanded) {
                            TextField("Model ID (optional)", text: modelBinding).focused($focused, equals: .model)
                                .textInputAutocapitalization(.never).autocorrectionDisabled().padding(.top, 12)
                                .accessibilityIdentifier("profileBotModelInput")
                        } label: { Text("Advanced model options").font(.subheadline) }.strataBotEditorCard()
                    }
                    if dynamicTypeSize.isAccessibilitySize {
                        Text("Saving a profile starts no conversation or task.").font(.caption2).foregroundStyle(StrataTheme.secondaryInk)
                    }
                }.padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 24)
            }
            .background(StrataTheme.background).scrollDismissesKeyboard(.interactively).disabled(store.savingBotProfile || reloading)
            .safeAreaInset(edge: .bottom, spacing: 0) { actionArea }
            .navigationTitle(original == nil ? "Create new bot" : "Edit bot").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(store.savingBotProfile || reloading) }
                ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { focused = nil } }
            }
            .sheet(isPresented: $customizing) {
                NavigationStack {
                    ScrollView { VStack(spacing: 24) { ExpressiveBotAvatar(config: draft.avatarConfig, size: 168, animated: true, flourishToken: String(describing: draft.avatarConfig)); AvatarPicker(avatar: $draft.avatarConfig, name: draft.name, supportedShapes: catalog?.avatarShapes ?? []) }.padding(24) }
                        .background(StrataTheme.background).navigationTitle("Customize avatar").navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { customizing = false } } }
                }
            }
            .confirmationDialog("Use Bypass approvals?", isPresented: $confirmingBypass, titleVisibility: .visible) {
                Button("Use Bypass approvals", role: .destructive) { save() }
            } message: { Text("New conversations can run this bot's actions without approval prompts. Existing chats and queued approvals stay unchanged.") }
            .confirmationDialog("Discard this draft and reload?", isPresented: $confirmingReload, titleVisibility: .visible) {
                Button("Reload latest bot", role: .destructive) {
                    let generation = store.pairingGeneration
                    Task {
                        guard visible, store.pairingGeneration == generation, !reloading else { return }
                        reloading = true; reloadError = nil
                        defer { reloading = false }
                        let refreshed = await store.refreshBots()
                        guard visible, store.pairingGeneration == generation else { return }
                        guard refreshed, let id = original?.id, let latest = store.botCatalog?.bots.first(where: { $0.id == id }) else {
                            reloadError = "Could not reload the latest bot. Your draft is still here. Try again when connected."
                            return
                        }
                        original = latest; draft = BotProfileDraft(bot: latest); store.clearBotProfileError()
                    }
                }
            }
            .interactiveDismissDisabled(store.savingBotProfile || reloading)
        }
        .onAppear { visible = true; store.clearBotProfileError() }.onDisappear { visible = false }
        .onChange(of: store.pairingGeneration) { _, _ in dismiss() }
        .task(id: draft.provider) {
            let provider = draft.provider
            providerModels = nil; loadingModels = provider != "configured"
            let result = provider == "configured" ? nil : await store.botModels(provider: provider)
            guard !Task.isCancelled, draft.provider == provider else { return }
            providerModels = result; loadingModels = false
        }
    }

    private var modelOptions: [BotEditorOption] {
        var values = [BotEditorOption(id: "", title: "Provider default")]
        if !draft.model.isEmpty, providerModels?.models.contains(where: { $0.id == draft.model }) != true { values.append(BotEditorOption(id: draft.model, title: draft.model)) }
        return values + (providerModels?.models ?? []).map { BotEditorOption(id: $0.id, title: $0.name) }
    }

    private var effortOptions: [BotEditorOption] {
        var values = [BotEditorOption(id: "", title: "Provider default")]
        if let saved = draft.effort, !saved.isEmpty, !efforts.contains(saved) { values.append(BotEditorOption(id: saved, title: "Saved · " + saved)) }
        return values + efforts.map { BotEditorOption(id: $0, title: $0.capitalized) }
    }

    private func selectionMenu(_ title: String, selection: Binding<String>, options: [BotEditorOption], identifier: String) -> some View {
        let selected = options.first { $0.id == selection.wrappedValue }?.title ?? selection.wrappedValue
        return Menu {
            ForEach(options) { option in
                Button { selection.wrappedValue = option.id } label: {
                    HStack { Text(option.title); if option.id == selection.wrappedValue { Image(systemName: "checkmark").accessibilityHidden(true) } }
                }
            }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(selected).multilineTextAlignment(.trailing).fixedSize(horizontal: false, vertical: true)
                Image(systemName: "chevron.up.chevron.down").font(.caption.weight(.medium)).accessibilityHidden(true)
            }.foregroundStyle(StrataTheme.secondaryInk).frame(minHeight: 44)
        }.accessibilityLabel(title).accessibilityValue(selected).accessibilityIdentifier(identifier)
    }

    private func inferenceRow<C: View>(_ title: String, @ViewBuilder content: () -> C) -> some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 8) {
                    Text(title).font(.subheadline.weight(.medium)).foregroundStyle(StrataTheme.ink)
                    content().multilineTextAlignment(.trailing).fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .trailing).tint(StrataTheme.secondaryInk)
                }.padding(.vertical, 12)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(title).foregroundStyle(StrataTheme.ink).fixedSize(horizontal: true, vertical: false)
                    Spacer(minLength: 4)
                    content().multilineTextAlignment(.trailing).fixedSize(horizontal: false, vertical: true).tint(StrataTheme.secondaryInk)
                }.frame(maxWidth: .infinity, minHeight: 50)
            }
        }
    }

    private func editorDisclosure<C: View, L: View>(_ identifier: String, isExpanded: Binding<Bool>, @ViewBuilder content: () -> C, @ViewBuilder label: () -> L) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { isExpanded.wrappedValue.toggle() } label: {
                HStack(spacing: 12) {
                    label()
                    Spacer(minLength: 0)
                    Image(systemName: isExpanded.wrappedValue ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold)).foregroundStyle(StrataTheme.secondaryInk)
                }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier(identifier)
                .accessibilityValue(isExpanded.wrappedValue ? "Expanded" : "Collapsed")
            if isExpanded.wrappedValue { content() }
        }
    }

    private func editorSummary(_ title: String, detail: String, icon: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 21, weight: .medium)).foregroundStyle(StrataTheme.accentText).frame(width: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.body.weight(.medium)).foregroundStyle(StrataTheme.ink)
                Text(detail).font(.caption).foregroundStyle(StrataTheme.secondaryInk).lineLimit(2)
            }
            Spacer(minLength: 4)
        }
    }

    private var actionArea: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let message = reloadError ?? store.botProfileError {
                Label(message, systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(StrataTheme.warning)
                    .accessibilityIdentifier("profileBotSaveError")
                if original != nil {
                    Button("Reload latest bot") { confirmingReload = true }.font(.subheadline.weight(.semibold))
                        .disabled(store.savingBotProfile || reloading).accessibilityIdentifier("reloadBotProfileButton")
                }
            } else if !draft.name.isEmpty, let validationError {
                Text(validationError).font(.caption).foregroundStyle(StrataTheme.secondaryInk)
            }
            Button {
                focused = nil
                if draft.policy == .bypass { confirmingBypass = true } else { save() }
            } label: {
                HStack { if store.savingBotProfile || reloading { ProgressView() }; Text(original == nil ? "Create bot" : "Save bot") }.frame(maxWidth: .infinity)
            }
            .buttonStyle(StrataPrimaryButtonStyle()).disabled(!canSave).accessibilityIdentifier("saveBotProfileButton")
            if !dynamicTypeSize.isAccessibilitySize { Text("Saving a profile starts no conversation or task.").font(.caption2).foregroundStyle(StrataTheme.secondaryInk) }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading).background(StrataTheme.background)
        .overlay(alignment: .top) { Rectangle().fill(StrataTheme.line).frame(height: 0.5) }
    }

    private var providerBinding: Binding<String> {
        Binding(get: { draft.provider }, set: { value in
            guard value != draft.provider else { return }
            draft.provider = value; draft.model = ""; draft.modelId = nil; draft.effort = nil
        })
    }
    private var modelBinding: Binding<String> {
        Binding(get: { draft.model }, set: { value in
            if value != draft.model { draft.model = value; draft.effort = nil }
        })
    }
    private var computerBinding: Binding<String> {
        Binding(get: { draft.computerId }, set: { value in
            guard value != draft.computerId else { return }
            draft.computerId = value; draft.effort = nil
            if draft.computerMode == "host" { draft.workspace = value == "local" ? catalog?.defaultWorkspace ?? "" : "" }
        })
    }
    private var environmentBinding: Binding<String> {
        Binding(get: { draft.computerMode }, set: { value in
            guard value != draft.computerMode else { return }
            draft.computerMode = value
            draft.workspace = value == "cua" ? "/workspace" : draft.computerId == "local" ? catalog?.defaultWorkspace ?? "" : ""
        })
    }

    private func save() {
        let generation = store.pairingGeneration, value = draft, snapshot = original
        Task {
            guard visible, store.pairingGeneration == generation else { return }
            reloadError = nil
            if await store.saveBotProfile(value, original: snapshot, expectedPairingGeneration: generation) != nil,
               visible, store.pairingGeneration == generation { dismiss() }
        }
    }
}

private extension View {
    func strataBotEditorCard() -> some View {
        self.padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .background(StrataTheme.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
}

private struct BotEditorOption: Identifiable { var id: String; var title: String }
