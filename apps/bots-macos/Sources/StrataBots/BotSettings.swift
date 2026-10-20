// Strata configuration inside the CUA-derived native feature window.
import CuaBotsCore
import SwiftUI

struct BotConfigurationForm: View {
    @EnvironmentObject var model: AppModel
    @Binding var draft: BotDraft
    var body: some View {
        Section("Computer") {
            Picker("Execution computer", selection: $draft.computerID) {
                if !model.store.computers.contains(where: { $0.id == "local" }) { Text("This Mac").tag("local") }
                ForEach(model.store.computers) { computer in Text(computer.name).tag(computer.id) }
                Text("Custom SSH computer…").tag("custom-ssh")
            }
            if draft.computerID == "custom-ssh" {
                TextField("SSH host or alias", text: $draft.customHost)
                TextField("SSH user (optional)", text: $draft.customUser)
                TextField("SSH port (optional; uses SSH configuration)", text: $draft.customPort)
            }
            Picker("Tools operate on", selection: $draft.computerMode) { Text("Isolated CUA computer").tag("cua"); Text("Selected host").tag("host") }
            if draft.computerMode == "cua" { Text("An owned Ubuntu computer, with 2 CPUs and 4 GB RAM. Prepare and Start are separate actions. Files and commands stay inside /workspace.").font(.caption).foregroundStyle(.secondary) }
            else { TextField("Workspace on selected host", text: $draft.workspace) }
            Picker("Capabilities", selection: $draft.capabilities) { Text("Coding + computer").tag("both"); Text("Coding").tag("code"); Text("Computer control").tag("computer") }
        }
        Section("Model") {
            Picker("Provider", selection: $draft.harness) { ForEach(Harness.allCases) { Text($0.name).tag($0) } }
            if draft.harness == .configured {
                Picker("Saved Models connection", selection: $draft.modelID) { Text("Choose a model").tag(""); ForEach(model.store.models) { Text($0.name).tag($0.id) } }
                Text("Maya and every Strata connection stay separate. This selection does not switch a server’s active model.").font(.caption).foregroundStyle(.secondary)
            } else {
                TextField("Model (optional; provider default)", text: $draft.nativeModel)
                if draft.computerID == "local", let provider = model.store.providers.first(where: { $0.id == draft.harness.rawValue }) { Text(provider.detail).font(.caption).foregroundStyle(.secondary) }
                Text("Uses the provider’s account on the execution computer. Credentials are never copied to iPhone.").font(.caption).foregroundStyle(.secondary)
            }
            Picker("Permissions", selection: $draft.policy) { Text("Ask before changes").tag("manual"); Text("Plan: inspect only").tag("plan"); Text("Automatic").tag("bypass") }
            TextField("Standing instructions", text: $draft.instructions, axis: .vertical).lineLimit(3...8)
        }
    }
}
struct BotSettingsSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    @State var draft = BotDraft()
    @State var saving = false
    var body: some View {
        VStack(spacing: 0) {
            Form { BotConfigurationForm(draft: $draft) }.formStyle(.grouped)
            Text("Profile changes apply to new conversations. Existing conversations keep their original settings.").font(.caption).foregroundStyle(.secondary).padding(.horizontal)
            HStack { Spacer(); Button("Cancel") { dismiss() }; Button("Save") { save() }.buttonStyle(.borderedProminent).disabled(saving) }.padding()
        }.frame(width: 560, height: 690).onAppear(perform: load)
    }
    private func load() {
        guard let selected = model.selectedBot, let bot = model.store.bot(selected.id) else { return }; let row = model.store.profile(bot.id), execution = row["execution"] as? [String: Any] ?? [:]
        draft.harness = bot.harness; draft.nativeModel = row["model"] as? String ?? ""; draft.workspace = row["workspace"] as? String ?? "/workspace"; draft.computerMode = row["computerMode"] as? String ?? "host"; draft.capabilities = row["capabilities"] as? String ?? "both"; draft.policy = row["policy"] as? String ?? "manual"; draft.instructions = row["instructions"] as? String ?? ""
        if execution["kind"] as? String == "ssh" { draft.computerID = "custom-ssh"; draft.customHost = execution["host"] as? String ?? ""; draft.customUser = execution["user"] as? String ?? ""; draft.customPort = (execution["port"] as? Int).map(String.init) ?? "" }
        if let source = row["modelSource"] as? [String: Any] { draft.modelID = model.store.models.first { $0.connectionID == source["connectionId"] as? String && $0.model == source["model"] as? String }?.id ?? "" }
    }
    private func save() {
        guard !saving, let bot = model.selectedBot else { return }; let selection = draft; saving = true
        Task {
            let draft = selection
            defer { saving = false }
            do {
                var execution: [String: Any] = ["kind": "local"]
                if draft.computerID == "custom-ssh" { execution = ["kind": "ssh", "host": draft.customHost]; if !draft.customUser.isEmpty { execution["user"] = draft.customUser }; if !draft.customPort.isEmpty { guard let port = Int(draft.customPort), (1...65535).contains(port) else { throw StrataError("Use a port from 1 to 65535.") }; execution["port"] = port } }
                else if draft.computerID != "local" { let catalog = try await model.store.engine.request("/api/bots"); guard let computer = (catalog["computers"] as? [[String: Any]])?.first(where: { $0["id"] as? String == draft.computerID }), let saved = computer["execution"] as? [String: Any] else { throw StrataError("Choose an available execution computer.") }; execution = saved }
                var body: [String: Any] = ["provider": draft.harness.rawValue, "model": draft.nativeModel, "execution": execution, "workspace": draft.computerMode == "cua" ? "/workspace" : draft.workspace, "computerMode": draft.computerMode, "capabilities": draft.capabilities, "policy": draft.policy, "instructions": draft.instructions]
                if draft.harness == .configured { guard let selected = model.store.models.first(where: { $0.id == draft.modelID }), let connection = selected.connectionID, let name = selected.model else { throw StrataError("Choose a saved model connection.") }; body["model"] = name; body["modelSource"] = ["connectionId": connection, "model": name] }
                _ = try await model.store.engine.request("/api/bots/\(bot.id)", method: "PATCH", body: body); try await model.store.refresh(); dismiss()
            } catch { model.store.lastError = error.localizedDescription }
        }
    }
}

struct NewConversationSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    var bot: Bot
    @State private var computerID = ""
    @State private var modelID = ""
    @State private var workspace = ""
    @State private var host = ""
    @State private var user = ""
    @State private var port = ""
    @State private var creating = false
    @State private var error: String?
    var body: some View {
        Form {
            Section("New conversation with \(bot.name)") {
                Picker("Computer", selection: $computerID) {
                    Text("Bot profile’s computer").tag("")
                    ForEach(model.store.computers) { Text($0.name).tag($0.id) }
                    Text("Custom SSH computer…").tag("custom-ssh")
                }
                if computerID == "custom-ssh" { TextField("SSH host or alias", text: $host); TextField("SSH user (optional)", text: $user); TextField("SSH port (optional)", text: $port) }
                Picker("Model", selection: $modelID) { Text("Bot profile’s provider and model").tag(""); ForEach(model.store.models) { Text($0.name).tag($0.id) } }
                if model.store.profile(bot.id)["computerMode"] as? String != "cua" { TextField("Workspace on selected computer", text: $workspace) }
                Text("The selected computer and model belong to this new conversation. Existing conversations keep their original settings. Maya stays separate.").font(.caption).foregroundStyle(.secondary)
            }
            if let error { Text(error).foregroundStyle(.red).font(.caption) }
            HStack { Spacer(); Button("Cancel") { dismiss() }; Button("Create conversation") { create() }.buttonStyle(.borderedProminent).disabled(creating) }
        }.formStyle(.grouped).frame(width: 510).onAppear { workspace = model.store.profile(bot.id)["workspace"] as? String ?? "" }
    }
    private func create() {
        guard !creating else { return }; var selection: [String: Any] = [:]
        if computerID == "custom-ssh" {
            guard !host.trimmingCharacters(in: .whitespaces).isEmpty else { error = "Enter an SSH host or alias."; return }
            var execution: [String: Any] = ["kind": "ssh", "host": host]
            if !user.isEmpty { execution["user"] = user }
            if !port.isEmpty { guard let value = Int(port), (1...65535).contains(value) else { error = "Use a port from 1 to 65535."; return }; execution["port"] = value }
            selection["execution"] = execution
        } else if !computerID.isEmpty { selection["computerId"] = computerID }
        if !modelID.isEmpty { selection["modelId"] = modelID }
        if !workspace.isEmpty { selection["workspace"] = workspace }
        creating = true
        Task { defer { creating = false }; do { _ = try await model.store.newConversation(bot.id, selection: selection); dismiss() } catch { self.error = error.localizedDescription } }
    }
}
