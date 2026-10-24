import SwiftUI
import AuthenticationServices

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

/// Recreate only when the pairing changes; ordinary refreshes retain account navigation.
struct ConnectorsHomeView: View {
    @ObservedObject var store: CompanionStore
    let pair: () -> Void
    let settings: () -> Void
    @State private var workspace: BotWorkspaceStore?
    @State private var generation: UUID?
    var body: some View {
        Group {
            if store.isPaired, generation == store.pairingGeneration, let workspace {
                BotConnectionsView(store: store, workspace: workspace)
                    .id(store.pairingGeneration)
            } else if store.isPaired { ProgressView("Loading connectors…") }
            else {
                ScrollView {
                    ConnectionNeededView(icon: "puzzlepiece.extension", title: "Connect your services", message: "Pair your Mac to add accounts and share their tools with your bots and teams.", pair: pair)
                        .padding(.horizontal, 20)
                        .padding(.top, 8)
                        .padding(.bottom, 28)
                }
                .background(StrataTheme.background)
                .navigationTitle("Connectors")
                .navigationBarTitleDisplayMode(.inline)
            }
        }
        .toolbar { ToolbarItem(placement: .topBarTrailing) {
            Button(action: settings) { Image(systemName: "desktopcomputer") }
                .accessibilityLabel("Mac connection settings").accessibilityIdentifier("connectorMacSettingsButton")
        } }
        .task(id: store.pairingGeneration) {
            workspace = nil; generation = store.pairingGeneration
            if store.isPaired { workspace = store.botWorkspaceStore() }
        }
    }
}

private enum ConnectorCollection: String, CaseIterable { case accounts = "Your accounts", discover = "Discover" }
private struct ConnectorAccountDestination: Identifiable, Hashable { let id: String; var startSignIn = false }
/// Presentation and the selected preset travel together. A Boolean sheet can
/// otherwise initialize its form before a separate preset assignment arrives.
private enum ConnectorSetupDestination: Identifiable {
    case custom
    case preset(BotConnectorCatalogEntry)
    var id: String { switch self { case .custom: "custom"; case .preset(let entry): "preset:" + entry.id } }
    var entry: BotConnectorCatalogEntry? { switch self { case .custom: nil; case .preset(let entry): entry } }
}

private struct ConnectorServiceIcon: View {
    let catalogId: String?
    var program = false
    private var symbol: String {
        switch catalogId {
        case "github": "chevron.left.forwardslash.chevron.right"
        case "linear", "linear-readonly": "line.3.horizontal.decrease.circle"
        case "notion": "doc.text"
        case "atlassian": "triangle"
        case "slack": "number"
        default: program ? "terminal" : "puzzlepiece.extension"
        }
    }
    private var tint: Color {
        switch catalogId {
        case "linear", "linear-readonly": .indigo
        case "atlassian": .blue
        case "slack": .purple
        case "notion", "github": StrataTheme.ink
        default: StrataTheme.accentText
        }
    }
    var body: some View {
        Image(systemName: symbol).font(.system(size: 22, weight: .semibold))
            .foregroundStyle(tint).frame(width: 46, height: 46)
            .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 15))
            .accessibilityHidden(true)
    }
}

struct BotConnectionsView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    var botId: String?
    var teamId: String?
    @State private var search = ""
    @State private var setupDestination: ConnectorSetupDestination?
    @State private var serviceSetup: BotConnectorCatalogEntry?
    @State private var showAll = false
    @State private var collection: ConnectorCollection = .accounts
    @State private var destination: ConnectorAccountDestination?
    private var features: BotConnectorFeatures? { workspace.connections?.connectorFeatures }
    private var rows: [BotMCPConnection] {
        (workspace.connections?.connections ?? []).filter { connection in
            (showAll || botId == nil || connection.botIds.contains(botId!)) &&
            (showAll || teamId == nil || connection.teamIds?.contains(teamId!) == true) &&
            (search.isEmpty || (connection.name + " " + (connection.accountLabel ?? "")).localizedCaseInsensitiveContains(search))
        }
    }
    private var discover: [BotConnectorCatalogEntry] {
        (workspace.connectorCatalog?.connectors ?? []).filter { $0.id != "custom-http" && (search.isEmpty || ([$0.name, $0.description] + ($0.aliases ?? [])).joined(separator: " ").localizedCaseInsensitiveContains(search)) }
    }
    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Bring your work together.").font(.title2.weight(.semibold))
                    Text("Connect your accounts, then choose which bots and teams can use them.").font(.subheadline).foregroundStyle(.secondary)
                }.padding(.vertical, 8)
                if features?.catalog == true {
                    Picker("Connector collection", selection: $collection) {
                        ForEach(ConnectorCollection.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }.pickerStyle(.segmented).accessibilityIdentifier("connectorCollectionPicker")
                }
                if (botId != nil || teamId != nil), collection == .accounts {
                    Toggle("Show all connectors", isOn: $showAll).accessibilityIdentifier("showAllBotConnectorsToggle")
                    Text("Team access applies within that team. Private bot chats need personal access.").font(.caption).foregroundStyle(.secondary)
                }
            }
            if collection == .accounts || features?.catalog != true { accountsSection }
            else { discoverSection }
            if features?.httpCreation == true {
                Section {
                    DisclosureGroup("Advanced") {
                        Button { setupDestination = .custom } label: { Label("Custom HTTP connector", systemImage: "network.badge.shield.half.filled") }
                            .disabled(workspace.mutation != nil).accessibilityIdentifier("createBotConnectorButton")
                        Text("Connect a custom MCP server by URL. Program connections are configured on Mac.").font(.caption).foregroundStyle(.secondary)
                    }.accessibilityIdentifier("connectorAdvancedOptions")
                }
            } else {
                Section { Text("Your Mac supports existing connector access. Update Strata on Mac to discover and add accounts here.").font(.caption).foregroundStyle(.secondary) }
            }
            ConnectorWorkspaceMessage(workspace: workspace, key: "connections")
        }.strataList().navigationTitle("Connectors").navigationBarTitleDisplayMode(.large)
            .searchable(text: $search, prompt: "Search services and accounts")
            .task(id: ObjectIdentifier(workspace)) { await reload() }
            .refreshable { await reload() }
            .navigationDestination(item: $destination) { account in
                BotConnectionDetailView(store: store, workspace: workspace, connectionId: account.id, startSignIn: account.startSignIn)
            }
            .sheet(item: $setupDestination) { selected in
                BotConnectorSetupView(workspace: workspace, entry: selected.entry) { saved in
                    collection = .accounts; destination = ConnectorAccountDestination(id: saved.id)
                }
            }
            .sheet(item: $serviceSetup) { entry in BotConnectorServiceSetupView(entry: entry) }
    }
    private var accountsSection: some View {
        Section("Your accounts") {
            ForEach(rows) { connection in
                Button { destination = ConnectorAccountDestination(id: connection.id) } label: {
                    HStack(spacing: 12) {
                        ConnectorServiceIcon(catalogId: connection.catalogId, program: connection.transport == "stdio")
                        VStack(alignment: .leading, spacing: 5) {
                            Text(connection.name).font(.body.weight(.semibold)).foregroundStyle(StrataTheme.ink)
                            Text(connection.accountLabel ?? "Personal").font(.subheadline).foregroundStyle(.secondary)
                            Text(connection.statusLabel + " · \(connection.enabledToolIds.count) tools enabled").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                    }.padding(.vertical, 6).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityIdentifier("botConnection-\(connection.id)")
            }
            if rows.isEmpty, !workspace.loading.contains("connections") {
                VStack(alignment: .leading, spacing: 12) {
                    Label(botId != nil || teamId != nil ? "No accounts assigned here" : "Your services belong here", systemImage: "person.crop.rectangle.stack")
                        .font(.headline)
                    Text(botId != nil || teamId != nil ? "Show all connectors to choose access, or discover a service to add an account." : "Sign in to your services or add an API key. Your credentials stay on your Mac.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    if features?.catalog == true { Button("Discover connectors") { collection = .discover }.accessibilityIdentifier("discoverConnectorsButton") }
                }.padding(.vertical, 12)
            }
        }
    }
    private var discoverSection: some View {
        Section {
            ForEach(discover) { entry in
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 12) {
                        ConnectorServiceIcon(catalogId: entry.id)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(entry.name).font(.headline)
                            Text(entry.setupSummary).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                    Text(entry.description).font(.subheadline).foregroundStyle(.secondary)
                    Button {
                        if !entry.isReady { serviceSetup = entry }
                        else if entry.supportsSignIn { Task { await connect(entry) } }
                        else { setupDestination = .preset(entry) }
                    } label: {
                        HStack { Text(entry.isReady && (workspace.connections?.connections.contains { $0.catalogId == entry.id } ?? false) ? "Add account" : entry.accountAction); Spacer(); Image(systemName: !entry.isReady ? "info.circle" : entry.supportsSignIn ? "person.crop.circle.badge.plus" : "key") }
                    }.buttonStyle(.bordered).disabled(workspace.mutation != nil || entry.isReady && (features?.httpCreation != true || entry.supportsSignIn && features?.oauth != true))
                        .accessibilityIdentifier("addConnector-\(entry.id)")
                }.padding(.vertical, 10)
            }
            ConnectorWorkspaceMessage(workspace: workspace, key: "connectorCatalog")
        } header: { Text("Discover services") } footer: { Text("Each account has its own access settings. Adding an account grants no tools to bots or teams.") }
    }
    private func connect(_ entry: BotConnectorCatalogEntry) async {
        guard let account = await workspace.createConnectorAccount(entry) else { return }
        // Creation succeeded even if authorization is cancelled or unavailable.
        // Keep its exact ID visible so the owner can retry without duplicate accounts.
        collection = .accounts; destination = ConnectorAccountDestination(id: account.id, startSignIn: true)
    }
    private func reload() async { await workspace.refreshConnections(); await workspace.refreshTeams(); await workspace.refreshConnectorCatalog(); await store.refreshBots() }
}

/// Catalog coverage never implies that Strata can connect a service directly.
/// Configuration-only and managed services stay informational on the phone.
private struct BotConnectorServiceSetupView: View {
    let entry: BotConnectorCatalogEntry
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 12) { ConnectorServiceIcon(catalogId: entry.id); Text(entry.name).font(.title3.weight(.semibold)) }
                    Text(entry.description).font(.subheadline)
                    Label(entry.setupSummary, systemImage: "info.circle").font(.subheadline.weight(.medium))
                    if let note = entry.setupNote { Text(note).font(.subheadline).foregroundStyle(.secondary) }
                }
                Section("Setup") {
                    Text(entry.setupState == "managed" ? "This service uses a managed connection. Review its configuration and account requirements in Strata on Mac." : entry.setupState == "unavailable" ? "A working connector configuration is not available in this catalog. Review the documentation or public source for the service’s requirements." : "Review this service in Strata on Mac. It may require a server, a registered application or another configuration before an account can connect.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text("Viewing this page creates no account, starts no sign-in and grants no bot or team access.").font(.caption).foregroundStyle(.secondary)
                }
                if let url = BotConnectorDraft.authorizationURL(entry.documentationURL) {
                    Section { Link("Service documentation", destination: url).accessibilityIdentifier("connectorSetupDocumentationLink") }
                }
                if let url = BotConnectorDraft.authorizationURL(entry.sourceURL) {
                    Section { Link("Public connector configuration", destination: url).accessibilityIdentifier("connectorSetupSourceLink") }
                }
            }.strataList().navigationTitle("Service setup").navigationBarTitleDisplayMode(.inline)
                .accessibilityIdentifier("connectorServiceSetupView")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("dismissConnectorServiceSetupButton") } }
        }
    }
}

private struct BotConnectionDetailView: View {
    @ObservedObject var store: CompanionStore
    @ObservedObject var workspace: BotWorkspaceStore
    let connectionId: String
    var startSignIn = false
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
    @State private var initialSignInHandled = false
    @State private var signInMessage: String?
    @State private var signInProgress = BotConnectorSignInProgress()
    @StateObject private var authenticationSession = BotConnectorAuthenticationSession()
    @FocusState private var inputFocused: Bool
    private var connection: BotMCPConnection? { workspace.connections?.connections.first { $0.id == connectionId } }
    private var ready: Bool { loaded && reviewedConnection?.inventoryDigest.count == 64 && reviewedConnection?.inventoryDigest == connection?.inventoryDigest && workspace.messages["connections"] == nil }
    private var features: BotConnectorFeatures? { workspace.connections?.connectorFeatures }
    private var phoneSignInAllowed: Bool { connection.map(workspace.canUsePhoneSignIn) == true }
    var body: some View {
        List {
            if let connection {
                Section {
                    HStack(spacing: 12) {
                        ConnectorServiceIcon(catalogId: connection.catalogId, program: connection.transport == "stdio")
                        VStack(alignment: .leading, spacing: 4) {
                            Text(connection.name).font(.headline)
                            Text(connection.accountLabel ?? "Personal").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 5)
                    LabeledContent("Account", value: connection.accountLabel ?? "Personal")
                    LabeledContent("Status", value: connection.statusLabel)
                    if let checked = connection.checkedAt?.date { LabeledContent("Last checked", value: checked.formatted(date: .abbreviated, time: .shortened)) }
                    if !connection.detail.isEmpty { Text(connection.detail).font(.caption).foregroundStyle(.secondary) }
                    if connection.transport == "http", features?.httpCreation == true {
                        Button("Edit account") { editing = true }.disabled(workspace.mutation != nil).accessibilityIdentifier("editBotConnectorSetupButton")
                    }
                    Button("Check & discover tools") { confirmingCheck = true }.disabled(workspace.mutation != nil || connection.enabled == false)
                        .accessibilityIdentifier("checkBotConnectionButton")
                } footer: { Text("Checking lists available tools; it calls none. A program connection starts its saved program on your Mac. New tools remain off.") }
                if features?.oauth == true, connection.authType == "oauth" { authentication(connection) }
                if connection.authType == "bearer", !connection.apiKeySet {
                    Section { Label("This account needs an API key. Edit the account to add one.", systemImage: "key").font(.subheadline).foregroundStyle(.secondary) }
                }
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
                Section {
                    DisclosureGroup("Advanced") {
                        LabeledContent("Transport", value: connection.transport == "stdio" ? "Program on Mac" : "HTTP from Mac")
                        if let url = connection.url { LabeledContent("Server", value: url).font(.caption) }
                        Text("Program setup and OAuth app registrations are managed in Strata on Mac.").font(.caption).foregroundStyle(.secondary)
                    }
                }
            } else { Text("This connector is no longer available.").foregroundStyle(.secondary) }
            ConnectorWorkspaceMessage(workspace: workspace, key: "connections")
        }.strataList().navigationTitle(connection?.name ?? "Connector").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { inputFocused = false }.accessibilityIdentifier("dismissConnectorKeyboardButton") } }
            .task {
                await reload()
                if startSignIn, !initialSignInHandled, !Task.isCancelled {
                    initialSignInHandled = true
                    await signIn(onPhone: phoneSignInAllowed)
                }
            }
            .onDisappear {
                let expectedState = signInProgress.invalidate()
                authenticationSession.cancel()
                if let expectedState, let connection {
                    Task { await workspace.connectorAuthentication(connection, action: "cancel", expectedState: expectedState) }
                }
            }
            .onChange(of: store.pairingGeneration) { _, _ in signInProgress.invalidate(); authenticationSession.cancel() }
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
            Button(connection.auth?.status == "connected" ? "Sign in again" : phoneSignInAllowed ? "Sign in" : "Start sign-in on Mac") { Task { await signIn(onPhone: phoneSignInAllowed) } }
                .disabled(workspace.mutation != nil || signInProgress.isActive).accessibilityIdentifier("startConnectorSignInButton")
            if authenticationSession.isActive { ProgressView("Waiting for sign-in…") }
            if let signInMessage { Text(signInMessage).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("connectorSignInMessage") }
            if phoneSignInAllowed {
                Button("Finish sign-in on Mac") { Task { await signIn(onPhone: false) } }
                    .disabled(workspace.mutation != nil || signInProgress.isActive).accessibilityIdentifier("connectorSignInOnMacButton")
                Text("If this service does not accept iPhone sign-in, use its browser sign-in on your Mac.").font(.caption).foregroundStyle(.secondary)
            }
            if connection.auth?.status == "waiting", connection.auth?.callbackTarget != "iphone" {
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
    private func signIn(onPhone: Bool) async {
        guard let connection, let attempt = signInProgress.begin() else { return }
        defer { signInProgress.finish(attempt) }
        let generation = store.pairingGeneration
        signInMessage = nil
        if connection.auth?.callbackTarget == "iphone", ["waiting", "connecting"].contains(connection.auth?.status ?? "") {
            guard let pending = BotConnectorOAuthRequest(auth: connection.auth) else {
                signInMessage = "Refresh the account status before starting another sign-in."
                return
            }
            guard await workspace.connectorAuthentication(connection, action: "cancel", expectedState: pending.expectedState), store.isPaired, generation == store.pairingGeneration, signInProgress.isCurrent(attempt), !Task.isCancelled else { return }
        }
        guard await workspace.connectorAuthentication(connection, action: "start", callbackTarget: onPhone ? "iphone" : nil),
              store.isPaired, generation == store.pairingGeneration, signInProgress.isCurrent(attempt), !Task.isCancelled else { return }
        if !onPhone { return }
        if self.connection?.auth?.status == "connected" { signInMessage = "Account connected."; return }
        guard let request = BotConnectorOAuthRequest(auth: self.connection?.auth) else {
            signInMessage = "This service could not prepare iPhone sign-in. Finish sign-in on your Mac, or try again."
            return
        }
        guard signInProgress.bind(request.expectedState, to: attempt) else { return }
        do {
            let callback = try await authenticationSession.authenticate(request)
            guard store.isPaired, generation == store.pairingGeneration, signInProgress.owns(attempt, state: request.expectedState), !Task.isCancelled, let current = self.connection else { return }
            if await workspace.connectorAuthentication(current, action: "complete", callbackURL: callback.absoluteString), store.isPaired, generation == store.pairingGeneration, signInProgress.owns(attempt, state: request.expectedState), !Task.isCancelled {
                signInProgress.releaseFlow(request.expectedState, from: attempt)
            }
        } catch {
            guard store.isPaired, generation == store.pairingGeneration, signInProgress.owns(attempt, state: request.expectedState), !Task.isCancelled else { return }
            if let current = self.connection {
                await workspace.connectorAuthentication(current, action: "cancel", expectedState: request.expectedState)
                guard store.isPaired, generation == store.pairingGeneration, signInProgress.owns(attempt, state: request.expectedState), !Task.isCancelled else { return }
                signInProgress.releaseFlow(request.expectedState, from: attempt)
            }
            let cancelled = error is CancellationError || (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
            signInMessage = cancelled ? "Sign-in cancelled. Your account is saved; sign in again whenever you’re ready." : "Couldn’t finish sign-in on iPhone. Try again, or finish sign-in on your Mac."
        }
    }
    private func reload() async {
        loaded = false; await workspace.refreshConnections(); await workspace.refreshTeams(); await workspace.refreshConnectorCatalog()
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
    var onSaved: (BotMCPConnection) -> Void = { _ in }
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
    private var missingPresetKey: Bool { connection == nil && entry?.supportsSignIn == false && draft.authType == "bearer" && apiKey.isEmpty }
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
                Section("Account") {
                    TextField("Connector name", text: $draft.name).focused($inputFocused).accessibilityIdentifier("connectorNameInput")
                    TextField("Account name", text: $draft.accountLabel).focused($inputFocused).accessibilityIdentifier("connectorAccountInput")
                }
                if draft.authType == "bearer" {
                    Section {
                        SecureField(reviewedConnection?.apiKeySet == true ? "Saved · leave blank to keep" : "Bearer API key", text: $apiKey)
                            .focused($inputFocused).textInputAutocapitalization(.never).autocorrectionDisabled().disabled(clearKey).accessibilityIdentifier("connectorKeyInput")
                        if reviewedConnection?.apiKeySet == true { Toggle("Remove saved API key", isOn: $clearKey) }
                    } header: { Text("API key") } footer: { Text("This service requires an API key. It is stored privately on your Mac. Saved keys are never shown.") }
                } else if draft.authType == "oauth" {
                    Section { Text(workspace.connections?.connectorFeatures?.iphoneOAuth == true ? "Save this account, then choose Sign in from its account page. Compatible services open sign-in on your iPhone; Mac sign-in is also available. App registrations are configured in Strata on Mac." : "Save this account, then start sign-in from its account page and finish in a browser on your Mac. App registrations are configured in Strata on Mac.").font(.caption).foregroundStyle(.secondary) }
                }
                Section {
                    if preset != nil, draft.catalogId != "custom-http" {
                        DisclosureGroup("Advanced") { serverSetup }
                    } else { serverSetup }
                }
                Section { Text("Adding starts no work and grants no access. Discover tools, then choose the bots and teams that may use them.").font(.caption).foregroundStyle(.secondary); ConnectorWorkspaceMessage(workspace: workspace, key: "connections") }
            }.disabled(!loaded || workspace.mutation != nil).strataList()
                .navigationTitle(connection == nil ? "Add \(entry?.name ?? "connector") account" : "Edit account").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { inputFocused = false }.accessibilityIdentifier("dismissConnectorKeyboardButton") }
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(workspace.mutation != nil) }
                    ToolbarItem(placement: .confirmationAction) { Button("Save") { Task {
                        var value = draft; value.name = value.name.trimmingCharacters(in: .whitespacesAndNewlines); value.url = value.url.trimmingCharacters(in: .whitespacesAndNewlines)
                        value.apiKey = value.authType == "bearer" && !apiKey.isEmpty ? apiKey : nil; value.clearKey = clearKey ? true : nil
                        if let saved = await workspace.saveConnectorAccountSetup(value, editing: reviewedConnection) { apiKey = ""; onSaved(saved); dismiss() }
                    } }.disabled(!loaded || setupChanged || !draft.isValid || missingPresetKey || apiKey.utf16.count > 8192 || workspace.mutation != nil).accessibilityIdentifier("saveBotConnectorSetupButton") }
                }
                .task { if let connection { reviewedConnection = connection; draft = BotConnectorDraft(connection: connection) } else if let entry { draft = BotConnectorDraft(entry: entry); draft.accountLabel = entry.nextAccountLabel(in: workspace.connections?.connections ?? []) }; loaded = true }
                .interactiveDismissDisabled(workspace.mutation != nil)
        }
    }
    private var serverSetup: some View {
        Group {
            TextField("Server URL", text: $draft.url).focused($inputFocused).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                .disabled(draft.catalogId != nil && draft.catalogId != "custom-http").accessibilityIdentifier("connectorURLInput")
            Picker("Authentication", selection: $draft.authType) {
                ForEach(authTypes, id: \.self) { type in Text(type == "oauth" ? "Account sign-in" : type == "bearer" ? "Bearer API key" : "None").tag(type) }
            }.accessibilityIdentifier("connectorAuthPicker")
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
