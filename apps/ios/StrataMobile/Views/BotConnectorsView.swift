import SwiftUI

/// Keep the pairing-scoped workspace stable while a bot profile refreshes.
struct BotConnectorsForBotView: View {
    @ObservedObject var store: CompanionStore
    let botId: String
    @StateObject private var workspace: BotWorkspaceStore
    init(store: CompanionStore, botId: String) {
        self.store = store; self.botId = botId
        _workspace = StateObject(wrappedValue: store.botWorkspaceStore())
    }
    var body: some View { BotConnectionsView(store: store, workspace: workspace, botId: botId) }
}

struct BotConnectionsView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    var botId: String?
    var teamId: String?
    @State private var search = ""
    @State private var adding = false
    @State private var catalogEntry: BotConnectorCatalogEntry?
    @State private var showAll = false
    private var features: BotConnectorFeatures? { workspace.connections?.connectorFeatures }
    private var rows: [BotMCPConnection] {
        (workspace.connections?.connections ?? []).filter { connection in
            (showAll || botId == nil || connection.botIds.contains(botId!)) &&
            (showAll || teamId == nil || connection.teamIds?.contains(teamId!) == true) &&
            (search.isEmpty || (connection.name + " " + (connection.accountLabel ?? "")).localizedCaseInsensitiveContains(search))
        }
    }
    var body: some View {
        List {
            Section {
                Label("Your services, together", systemImage: "link")
                Text("Connect service accounts, discover their tools and choose which bots or teams can use them. Credentials stay on your Mac.").font(.caption).foregroundStyle(.secondary)
                if botId != nil || teamId != nil {
                    Toggle("Show all connectors", isOn: $showAll).accessibilityIdentifier("showAllBotConnectorsToggle")
                    Text("Team access applies within that team. A member’s private conversations need personal bot access.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("Your connectors") {
                ForEach(rows) { connection in
                    NavigationLink {
                        BotConnectionDetailView(store: store, workspace: workspace, connectionId: connection.id)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: connection.transport == "stdio" ? "terminal" : "network")
                                .font(.title3).frame(width: 42, height: 42).background(StrataTheme.grouped, in: RoundedRectangle(cornerRadius: 14))
                            VStack(alignment: .leading, spacing: 5) {
                                Text(connection.name).font(.body.weight(.semibold))
                                Text((connection.accountLabel ?? "Personal") + " · " + connection.statusLabel).font(.caption).foregroundStyle(StrataTheme.secondaryInk)
                            }
                            Spacer()
                            Text("\(connection.enabledToolIds.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }.padding(.vertical, 4)
                    }.accessibilityIdentifier("botConnection-\(connection.id)")
                }
                if rows.isEmpty, workspace.loading.contains("connections") == false {
                    Text(botId != nil || teamId != nil ? "No connectors assigned here. Show all connectors to choose access." : "Add a connector to bring your services into Strata.").font(.subheadline).foregroundStyle(.secondary)
                }
                ConnectorWorkspaceMessage(workspace: workspace, key: "connections")
            }
            if features?.catalog == true {
                Section("Browse connectors") {
                    ForEach((workspace.connectorCatalog?.connectors ?? []).filter { search.isEmpty || ($0.name + " " + $0.description).localizedCaseInsensitiveContains(search) }) { entry in
                        Button { catalogEntry = entry; adding = true } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "square.stack.3d.up").font(.title3).frame(width: 38)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(entry.name).font(.body.weight(.semibold))
                                    Text(entry.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                }
                                Spacer(); Image(systemName: "plus.circle").font(.title3)
                            }.padding(.vertical, 5)
                        }.disabled(features?.httpCreation != true || workspace.mutation != nil).accessibilityIdentifier("addConnector-\(entry.id)")
                    }
                    ConnectorWorkspaceMessage(workspace: workspace, key: "connectorCatalog")
                }
            }
            if features?.httpCreation == true {
                Section {
                    Button { catalogEntry = nil; adding = true } label: { Label("Custom HTTP connector", systemImage: "plus") }
                        .disabled(workspace.mutation != nil).accessibilityIdentifier("createBotConnectorButton")
                    Text("Program connections are configured on Mac. Here you can add service URLs and bearer keys.").font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Section { Text("Add programs, server URLs and credentials in Strata on Mac. Update the Mac app to add HTTP connectors from iPhone.").font(.caption).foregroundStyle(.secondary) }
            }
        }.strataList().navigationTitle("Connectors").navigationBarTitleDisplayMode(.inline)
            .searchable(text: $search, prompt: "Search connectors")
            .task(id: ObjectIdentifier(workspace)) { await reload() }
            .refreshable { await reload() }
            .sheet(isPresented: $adding) { BotConnectorSetupView(workspace: workspace, entry: catalogEntry) }
    }
    private func reload() async { await workspace.refreshConnections(); await workspace.refreshTeams(); await workspace.refreshConnectorCatalog() }
}

private struct BotConnectionDetailView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let connectionId: String
    @Environment(\.dismiss) private var dismiss
    @State private var botIds: Set<String> = []
    @State private var teamIds: Set<String> = []
    @State private var toolIds: Set<String> = []
    @State private var instructions = ""
    @State private var callbackURL = ""
    @State private var loaded = false
    @State private var reviewedConnection: BotMCPConnection?
    @State private var saved = false
    @State private var confirmingCheck = false
    @State private var confirmingRemove = false
    @State private var confirmingSignOut = false
    @State private var editing = false
    @FocusState private var inputFocused: Bool
    private var connection: BotMCPConnection? { workspace.connections?.connections.first { $0.id == connectionId } }
    private var ready: Bool { loaded && reviewedConnection?.inventoryDigest.count == 64 && reviewedConnection?.inventoryDigest == connection?.inventoryDigest && workspace.messages["connections"] == nil }
    private var features: BotConnectorFeatures? { workspace.connections?.connectorFeatures }
    var body: some View {
        List {
            if let connection {
                Section {
                    LabeledContent("Account", value: connection.accountLabel ?? "Personal")
                    LabeledContent("Status", value: connection.statusLabel)
                    LabeledContent("Transport", value: connection.transport == "stdio" ? "Program on Mac" : "HTTP from Mac")
                    if let checked = connection.checkedAt?.date { LabeledContent("Last checked", value: checked.formatted(date: .abbreviated, time: .shortened)) }
                    if !connection.detail.isEmpty { Text(connection.detail).font(.caption).foregroundStyle(.secondary) }
                    if connection.transport == "http", features?.httpCreation == true {
                        Button("Edit connector setup") { editing = true }.disabled(workspace.mutation != nil).accessibilityIdentifier("editBotConnectorSetupButton")
                    }
                    Button("Check & discover tools") { confirmingCheck = true }.disabled(workspace.mutation != nil || connection.enabled == false)
                        .accessibilityIdentifier("checkBotConnectionButton")
                } footer: { Text("Checking lists available tools; it calls none. A program connection starts its saved program on your Mac. New tools remain off.") }
                if features?.oauth == true, connection.authType == "oauth" { authentication(connection) }
                Section("Personal bot access") {
                    ForEach(store.botCatalog?.bots ?? []) { bot in Toggle(bot.name, isOn: selection(bot.id, in: $botIds)).accessibilityIdentifier("connectionBotAccess-\(bot.id)") }
                }.disabled(!ready || workspace.mutation != nil)
                if features?.teamAccess == true {
                    Section {
                        ForEach(workspace.teams?.teams ?? []) { team in Toggle(team.name, isOn: selection(team.id, in: $teamIds)).accessibilityIdentifier("connectionTeamAccess-\(team.id)") }
                        if workspace.teams?.teams.isEmpty == true { Text("Create a team to share connectors during team work.").foregroundStyle(.secondary) }
                    } header: { Text("Team access") } footer: { Text("Team access follows current membership and applies within that team. It does not grant access to members’ private chats.") }
                        .disabled(!ready || workspace.mutation != nil || workspace.messages["teams"] != nil)
                    Section("Connector instructions") {
                        TextEditor(text: $instructions).focused($inputFocused).frame(minHeight: 110).accessibilityIdentifier("connectorInstructionsInput")
                        Text("How should your bots use this account?").font(.caption).foregroundStyle(.secondary)
                    }.disabled(!ready || workspace.mutation != nil)
                }
                Section("Tool access") {
                    ForEach(connection.tools) { tool in
                        Toggle(isOn: selection(tool.id, in: $toolIds)) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(tool.name).font(.subheadline.weight(.semibold))
                                Text(tool.description).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                                if tool.readOnly { Label("Reviewed read-only on Mac", systemImage: "checkmark.shield").font(.caption2).foregroundStyle(.secondary) }
                            }
                        }.accessibilityIdentifier("connectionToolAccess-\(tool.id)")
                    }
                    if connection.tools.isEmpty { Text("Check this connector to discover its tools.").foregroundStyle(.secondary) }
                }.disabled(!ready || workspace.mutation != nil || connection.enabled == false)
                Section {
                    if !ready, loaded { Button("Reload and review tools") { Task { await reload() } }.accessibilityIdentifier("reloadBotConnectorButton") }
                    Button("Save access") { if let reviewedConnection { Task {
                        saved = await workspace.saveConnection(reviewedConnection, botIds: botIds.sorted(), toolIds: toolIds.sorted(), teamIds: features?.teamAccess == true ? teamIds.sorted() : nil, instructions: features?.teamAccess == true ? instructions : nil)
                        if saved { await reload(); saved = true }
                    } } }.disabled(!ready || workspace.mutation != nil || instructions.utf16.count > 8000 || features?.teamAccess == true && workspace.teams == nil)
                        .accessibilityIdentifier("saveBotConnectionAccessButton")
                    if saved { Label("Access saved", systemImage: "checkmark.circle").font(.caption).foregroundStyle(StrataTheme.accentText).accessibilityIdentifier("botConnectorAccessSaved") }
                    Text("New conversations receive assigned tools. Removing access revokes it immediately. Other tools use each bot’s approval policy. Read-only classifications are reviewed on Mac.").font(.caption).foregroundStyle(.secondary)
                }
                if features?.teamAccess == true {
                    Section {
                        Button(connection.enabled == false ? "Enable connector" : "Disable connector") { Task {
                            if await workspace.setConnectorEnabled(connection, enabled: connection.enabled == false) { await reload() }
                        } }.disabled(!ready || workspace.mutation != nil).accessibilityIdentifier("toggleBotConnectorEnabledButton")
                        Text("Disabling retains setup and removes this connector from all bot and team work.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if features?.httpCreation == true {
                    Section { Button("Remove connector…", role: .destructive) { confirmingRemove = true }.disabled(workspace.mutation != nil).accessibilityIdentifier("removeBotConnectorButton") }
                }
            } else { Text("This connector is no longer available.").foregroundStyle(.secondary) }
            ConnectorWorkspaceMessage(workspace: workspace, key: "connections")
        }.strataList().navigationTitle(connection?.name ?? "Connector").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { inputFocused = false }.accessibilityIdentifier("dismissConnectorKeyboardButton") } }
            .task { await reload() }
            .task(id: connection?.auth?.status) {
                guard let auth = connection?.auth, ["waiting", "connecting"].contains(auth.status) else { return }
                let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                let deadline = min(auth.expiresAt.flatMap(formatter.date) ?? Date().addingTimeInterval(600), Date().addingTimeInterval(600))
                while !Task.isCancelled, Date() < deadline {
                    do { try await Task.sleep(for: .seconds(3)) } catch { return }
                    if workspace.mutation == nil, let connection { await workspace.connectorAuthentication(connection, action: "poll") }
                }
            }
            .sheet(isPresented: $editing) { if let connection { BotConnectorSetupView(workspace: workspace, connection: connection) } }
            .onChange(of: editing) { _, value in if !value { Task { await reload() } } }
            .confirmationDialog("Check this saved connector on your Mac?", isPresented: $confirmingCheck) {
                if let connection { Button("Check saved connector") { Task { await workspace.checkConnection(connection); await reload() } } }
            }
            .confirmationDialog("Remove this connector and its saved credentials?", isPresented: $confirmingRemove) {
                if let connection { Button("Remove connector", role: .destructive) { Task { if await workspace.removeConnector(connection) { dismiss() } } } }
            }
            .confirmationDialog("Sign out this connector account?", isPresented: $confirmingSignOut) {
                if let connection { Button("Sign out", role: .destructive) { Task { await workspace.connectorAuthentication(connection, action: "disconnect"); await reload() } } }
            }
    }
    private func authentication(_ connection: BotMCPConnection) -> some View {
        Section("Account sign-in") {
            Text(connection.auth?.detail ?? "Sign in to this service on your Mac.").font(.subheadline)
            Button(connection.auth?.status == "connected" ? "Start sign-in again" : "Start account sign-in") { Task { await workspace.connectorAuthentication(connection, action: "start"); await reload() } }
                .disabled(workspace.mutation != nil).accessibilityIdentifier("startConnectorSignInButton")
            if connection.auth?.status == "waiting" {
                Text("Open Strata’s Connectors on your Mac and finish sign-in there. The return address belongs to your Mac.").font(.caption).foregroundStyle(.secondary)
                if let url = BotConnectorDraft.authorizationURL(connection.auth?.authorizationURL) { ShareLink(item: url) { Label("Send sign-in link to your Mac", systemImage: "square.and.arrow.up") } }
                DisclosureGroup("Finish with a callback address") {
                    Text("If your browser cannot return to Strata, copy the complete callback address from that browser and paste it here.").font(.caption).foregroundStyle(.secondary)
                    TextField("Complete callback address", text: $callbackURL).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    Button("Finish sign-in") { Task { if await workspace.connectorAuthentication(connection, action: "complete", callbackURL: callbackURL) { callbackURL = ""; await reload() } } }.disabled(workspace.mutation != nil || callbackURL.isEmpty)
                }
            }
            Button("Check sign-in status") { Task { await workspace.connectorAuthentication(connection, action: "poll"); await reload() } }.disabled(workspace.mutation != nil)
            if connection.auth?.status == "connected" || connection.auth?.status == "waiting" { Button("Sign out", role: .destructive) { confirmingSignOut = true }.disabled(workspace.mutation != nil) }
        }
    }
    private func reload() async {
        loaded = false; await workspace.refreshConnections(); await workspace.refreshTeams()
        if workspace.messages["connections"] == nil, let connection {
            botIds = Set(connection.botIds); teamIds = Set(connection.teamIds ?? []); toolIds = Set(connection.enabledToolIds)
            instructions = connection.customInstructions ?? ""; reviewedConnection = connection; loaded = true; saved = false
        }
    }
    private func selection(_ id: String, in set: Binding<Set<String>>) -> Binding<Bool> {
        Binding(get: { set.wrappedValue.contains(id) }, set: { value in if value { set.wrappedValue.insert(id) } else { set.wrappedValue.remove(id) }; saved = false })
    }
}

private struct BotConnectorSetupView: View {
    @ObservedObject var workspace: BotWorkspaceStore
    var connection: BotMCPConnection?
    var entry: BotConnectorCatalogEntry?
    @Environment(\.dismiss) private var dismiss
    @State private var draft = BotConnectorDraft()
    @State private var apiKey = ""
    @State private var clearKey = false
    @State private var reviewedConnection: BotMCPConnection?
    @State private var loaded = false
    @FocusState private var inputFocused: Bool
    private var latestConnection: BotMCPConnection? { workspace.connections?.connections.first { $0.id == connection?.id } }
    private var setupChanged: Bool { if let reviewedConnection, let latestConnection { return reviewedConnection.inventoryDigest != latestConnection.inventoryDigest }; return false }
    private var preset: BotConnectorCatalogEntry? { entry ?? workspace.connectorCatalog?.connectors.first { $0.id == draft.catalogId } }
    private var authTypes: [String] { preset?.authTypes ?? ["none", "bearer"] + (workspace.connections?.connectorFeatures?.oauth == true ? ["oauth"] : []) }
    var body: some View {
        NavigationStack {
            Form {
                if setupChanged, let latestConnection {
                    Section("Connector changed") {
                        Text("This connector changed on another device. Your draft is retained. Reloading replaces it and discards any key you entered.").font(.subheadline)
                        LabeledContent("Latest account", value: latestConnection.accountLabel ?? "Personal")
                        LabeledContent("Latest server", value: latestConnection.url ?? "Unavailable")
                        LabeledContent("Authentication", value: latestConnection.authType ?? "none")
                        Button("Reload latest setup") {
                            reviewedConnection = latestConnection; draft = BotConnectorDraft(connection: latestConnection); apiKey = ""; clearKey = false
                            Task { await workspace.refreshConnections() }
                        }.accessibilityIdentifier("reloadBotConnectorSetupButton")
                    }
                }
                if let entry {
                    Section {
                        Text(entry.description)
                        if let note = entry.setupNote { Text(note).font(.caption).foregroundStyle(.secondary) }
                        if let url = BotConnectorDraft.authorizationURL(entry.documentationURL) { Link("Setup documentation", destination: url) }
                    }
                }
                Section("Connector") {
                    TextField("Connector name", text: $draft.name).focused($inputFocused).accessibilityIdentifier("connectorNameInput")
                    TextField("Account name", text: $draft.accountLabel).focused($inputFocused).accessibilityIdentifier("connectorAccountInput")
                    TextField("Server URL", text: $draft.url).focused($inputFocused).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .disabled(draft.catalogId != nil && draft.catalogId != "custom-http").accessibilityIdentifier("connectorURLInput")
                    Picker("Authentication", selection: $draft.authType) {
                        ForEach(authTypes, id: \.self) { type in Text(type == "oauth" ? "Account sign-in" : type == "bearer" ? "Bearer API key" : "None").tag(type) }
                    }.accessibilityIdentifier("connectorAuthPicker")
                }
                if draft.authType == "bearer" {
                    Section {
                        SecureField(reviewedConnection?.apiKeySet == true ? "Saved · leave blank to keep" : "Bearer API key", text: $apiKey)
                            .focused($inputFocused).textInputAutocapitalization(.never).autocorrectionDisabled().disabled(clearKey).accessibilityIdentifier("connectorKeyInput")
                        if reviewedConnection?.apiKeySet == true { Toggle("Remove saved API key", isOn: $clearKey) }
                    } header: { Text("Credentials") } footer: { Text("The key is stored privately on your Mac. Saved values are never shown.") }
                } else if draft.authType == "oauth" {
                    Section { Text("Add this connector, then start account sign-in. Finish in a browser on your Mac. If this service needs an OAuth app registration, configure it in Strata on Mac.").font(.caption).foregroundStyle(.secondary) }
                }
                Section { Text("Adding starts no work and grants no access. Discover tools, then choose the bots and teams that may use them.").font(.caption).foregroundStyle(.secondary); ConnectorWorkspaceMessage(workspace: workspace, key: "connections") }
            }.disabled(!loaded || workspace.mutation != nil).strataList()
                .navigationTitle(connection == nil ? "Add connector" : "Edit connector").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { inputFocused = false }.accessibilityIdentifier("dismissConnectorKeyboardButton") }
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(workspace.mutation != nil) }
                    ToolbarItem(placement: .confirmationAction) { Button("Save") { Task {
                        var value = draft; value.name = value.name.trimmingCharacters(in: .whitespacesAndNewlines); value.url = value.url.trimmingCharacters(in: .whitespacesAndNewlines)
                        value.apiKey = value.authType == "bearer" && !apiKey.isEmpty ? apiKey : nil; value.clearKey = clearKey ? true : nil
                        if await workspace.saveConnectorSetup(value, editing: reviewedConnection) { apiKey = ""; dismiss() }
                    } }.disabled(!loaded || setupChanged || !draft.isValid || apiKey.utf16.count > 8192 || workspace.mutation != nil).accessibilityIdentifier("saveBotConnectorSetupButton") }
                }
                .task { if let connection { reviewedConnection = connection; draft = BotConnectorDraft(connection: connection) } else if let entry { draft = BotConnectorDraft(entry: entry) }; loaded = true }
                .interactiveDismissDisabled(workspace.mutation != nil)
        }
    }
}

private struct ConnectorWorkspaceMessage: View {
    @ObservedObject var workspace: BotWorkspaceStore
    let key: String
    var body: some View {
        if let message = workspace.messages[key] { Label(message, systemImage: "info.circle").font(.caption).foregroundStyle(StrataTheme.warning).accessibilityIdentifier("botWorkspaceMessage-\(key)") }
        if workspace.loading.contains(key) { ProgressView().controlSize(.small) }
    }
}
