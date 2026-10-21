import SwiftUI

/// A profile draft has no chat, computer lease or provider credentials.
struct BotProfileEditor: View {
    @ObservedObject var store: CompanionStore
    @Environment(\.dismiss) private var dismiss
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
            Form {
                Section {
                    VStack(spacing: 14) {
                        Button { customizing = true } label: {
                            ExpressiveBotAvatar(config: draft.avatarConfig, size: 112, mood: .idle,
                                                animated: true, flourishToken: String(describing: draft.avatarConfig))
                                .overlay(alignment: .bottomTrailing) { Image(systemName: "pencil.circle.fill").font(.title2).foregroundStyle(StrataTheme.accentText) }
                        }.buttonStyle(.plain).accessibilityLabel("Customize bot avatar").accessibilityIdentifier("profileBotAvatarButton")
                        TextField("Name your bot", text: $draft.name)
                            .font(.title3.weight(.semibold)).multilineTextAlignment(.center).focused($focused, equals: .name)
                            .accessibilityIdentifier("profileBotNameInput")
                        Text(original == nil ? "Make it yours. Work starts only when you send a task." : "Edit the defaults for future conversations.")
                            .font(.caption).foregroundStyle(StrataTheme.secondaryInk).multilineTextAlignment(.center)
                    }.frame(maxWidth: .infinity).padding(.vertical, 8)
                }
                Section {
                    Picker("Template", selection: $draft.capabilities) {
                        Text("Coding").tag("code"); Text("Computer").tag("computer"); Text("Both").tag("both")
                    }.pickerStyle(.segmented).accessibilityIdentifier("profileBotTemplatePicker")
                    Text(draft.capabilities == "code" ? "Work with files, code and commands." : draft.capabilities == "computer" ? "Work with apps and the browser on the selected computer." : "Combine coding tools with computer control.")
                        .font(.caption).foregroundStyle(StrataTheme.secondaryInk)
                } header: { Text("What it does") }
                Section {
                    Picker("Provider", selection: providerBinding) {
                        ForEach(catalog?.providers ?? []) { value in Text(value.name).tag(value.id) }
                    }.accessibilityIdentifier("profileBotProviderPicker")
                    if draft.provider == "configured" {
                        Picker("Model connection", selection: Binding(get: { draft.modelId ?? "" }, set: { draft.modelId = $0.isEmpty ? nil : $0 })) {
                            Text("Choose a saved model").tag("")
                            ForEach(catalog?.models ?? []) { value in Text(value.label + (value.available ? "" : " · Setup required")).tag(value.id) }
                        }.accessibilityIdentifier("profileBotConfiguredModelPicker")
                    } else {
                        Picker("Model", selection: modelBinding) {
                            Text("Provider default").tag("")
                            if !draft.model.isEmpty, providerModels?.models.contains(where: { $0.id == draft.model }) != true { Text(draft.model).tag(draft.model) }
                            ForEach(providerModels?.models ?? []) { value in Text(value.name).tag(value.id) }
                        }.accessibilityIdentifier("profileBotModelPicker")
                        TextField("Model ID (optional)", text: modelBinding).focused($focused, equals: .model)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("profileBotModelInput")
                        if loadingModels { ProgressView("Checking models…") }
                        if !efforts.isEmpty || draft.effort?.isEmpty == false {
                            Picker("Effort", selection: Binding(get: { draft.effort ?? "" }, set: { draft.effort = $0 })) {
                                Text("Provider default").tag("")
                                if let saved = draft.effort, !saved.isEmpty, !efforts.contains(saved) { Text("Saved · " + saved).tag(saved) }
                                ForEach(efforts, id: \.self) { Text($0.capitalized).tag($0) }
                            }.accessibilityIdentifier("profileBotEffortPicker")
                        }
                    }
                    if !providerReady {
                        Label("Check provider availability on the selected computer before starting work.", systemImage: "exclamationmark.circle")
                            .font(.caption).foregroundStyle(StrataTheme.warning).accessibilityIdentifier("profileBotSetupRequired")
                    }
                } header: { Text("What powers it") } footer: {
                    Text("Uses your saved model connections and computers. Provider sign-in is managed on the selected computer. Saving a profile does not start work.")
                }
                Section {
                    Picker("Computer", selection: computerBinding) {
                        ForEach(catalog?.computers ?? []) { value in Text(value.name + (value.available ? "" : " · Setup required")).tag(value.id) }
                    }.accessibilityIdentifier("profileBotComputerPicker")
                    if let computer { Text(computer.detail).font(.caption).foregroundStyle(StrataTheme.secondaryInk) }
                    Picker("Environment", selection: environmentBinding) {
                        Text("On the selected computer").tag("host")
                        Text("Isolated computer").tag("cua")
                    }.accessibilityIdentifier("profileBotEnvironmentPicker")
                    TextField("Full workspace folder path", text: $draft.workspace).focused($focused, equals: .workspace)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().disabled(draft.computerMode == "cua")
                        .accessibilityIdentifier("profileBotWorkspaceInput")
                } header: { Text("Where it works") } footer: {
                    Text(draft.computerMode == "cua" ? "The isolated computer uses /workspace. Creating this profile does not start it." : "Use the folder path on that computer. Add other computers in Strata on your Mac.")
                }
                Section {
                    Picker("Approvals", selection: $draft.policy) {
                        ForEach(BotApprovalPolicy.allCases) { value in Text(value.label).tag(value) }
                    }.accessibilityIdentifier("profileBotPolicyPicker")
                    Text(draft.policy.detail).font(.caption).foregroundStyle(draft.policy == .bypass ? StrataTheme.warning : StrataTheme.secondaryInk)
                } header: { Text("How it acts") } footer: {
                    Text("These defaults apply to new conversations. Existing chats keep their approval mode. Saving never approves queued requests.")
                }
                Section("Instructions") {
                    TextEditor(text: $draft.instructions).frame(minHeight: 130).focused($focused, equals: .instructions)
                        .accessibilityIdentifier("profileBotInstructionsInput")
                }
            }
            .strataList().scrollDismissesKeyboard(.interactively).disabled(store.savingBotProfile || reloading)
            .safeAreaInset(edge: .bottom, spacing: 0) { actionArea }
            .navigationTitle(original == nil ? "Create bot" : "Edit bot").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(store.savingBotProfile || reloading) }
                ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { focused = nil } }
            }
            .sheet(isPresented: $customizing) {
                NavigationStack {
                    ScrollView { VStack(spacing: 24) { ExpressiveBotAvatar(config: draft.avatarConfig, size: 120, animated: true, flourishToken: String(describing: draft.avatarConfig)); AvatarPicker(avatar: $draft.avatarConfig, name: draft.name) }.padding(24) }
                        .navigationTitle("Customize avatar").navigationBarTitleDisplayMode(.inline)
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
            Text("Saving a profile starts no conversation or task.").font(.caption2).foregroundStyle(StrataTheme.secondaryInk)
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
