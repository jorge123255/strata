import Foundation
import SwiftUI

@MainActor
final class CompanionStore: ObservableObject {
    @Published private(set) var connection: PairedConnection?
    @Published private(set) var status: CompanionStatus?
    @Published private(set) var models: [CompanionModel] = []
    @Published private(set) var modelTargets: [ModelManagementTarget] = []
    @Published private(set) var selectedModelTargetId: String?
    // A Picker can read its previous binding while a capability refresh removes
    // the last target. Never subscript the changing collection from that binding.
    var modelTargetSelection: String { selectedModelTargetId ?? modelTargets.first?.id ?? "" }
    @Published private(set) var modelCatalog: ModelManagementCatalog?
    @Published private(set) var modelManagementMessage: String?
    @Published private(set) var isDiscoveringModelTargets = false
    @Published private(set) var isLoadingModelCatalog = false
    @Published private(set) var reviewingModelDownload: DownloadableModel?
    @Published private(set) var modelDownloadPlan: ModelDownloadPlan?
    @Published private(set) var modelDownloadReviewError: String?
    @Published private(set) var isPlanningModelDownload = false
    @Published private(set) var isStartingModelDownload = false
    @Published private(set) var cancellingModelDownloadId: String?
    var isModelDownloadBusy: Bool { isStartingModelDownload || cancellingModelDownloadId != nil }
    @Published private(set) var chats: [CompanionChat] = []
    @Published private(set) var messages: [ChatMessage] = []
    @Published private(set) var currentChatId: String?
    @Published private(set) var conversations: [MacConversationSummary] = []
    @Published private(set) var currentConversation: MacConversation?
    @Published private(set) var pendingApprovals: [MacToolActivity] = []
    @Published private(set) var isSubmittingMessage = false
    @Published private(set) var isSelectingConversation = false
    @Published private(set) var decidingToolId: String?
    @Published private(set) var botCatalog: CompanionBots?
    @Published private(set) var botsMessage: String?
    @Published private(set) var isLoadingBots = false
    @Published private(set) var creatingBotConversationId: String?
    @Published private(set) var savingBotAvatarId: String?
    @Published private(set) var savingBotProfile = false
    @Published private(set) var botProfileError: String?
    private var botProfileOperation: UUID?
    var isWorking: Bool { isSending || currentConversation?.active == true }
    var isLegacyConversation: Bool { currentChatId != nil }
    private var hasChosenConversation = false
    private var chatVisible = false
    private var modelsVisible = false
    private var botsVisible = false
    private var botsRequest: UUID?
    private var hasDiscoveredModelTargets = false
    private var modelTargetGeneration = UUID()
    private var modelReviewGeneration = UUID()
    private var modelTargetsRequest: UUID?
    private var modelCatalogRequest: UUID?
    private var modelReviewTargetId: String?
    @Published private(set) var isLoading = false
    @Published private(set) var isSending = false
    @Published var error: String?
    @Published var pendingInvitation: PairingInvitation?
    var isPaired: Bool { connection != nil }
    private var client: CompanionClient?
    private var streamTask: Task<Void, Never>?
    private var connectionGeneration = UUID()
    var pairingGeneration: UUID { connectionGeneration }
    private var conversationGeneration = UUID()
    private var loadingOperation: UUID?
    private var streamOperation: UUID?
    private let saveConnection: (PairedConnection) throws -> Void
    private let deleteConnection: () throws -> Void

    init(connection: PairedConnection? = nil, client: CompanionClient? = nil,
         saveConnection: @escaping (PairedConnection) throws -> Void = ConnectionKeychain.save,
         deleteConnection: @escaping () throws -> Void = ConnectionKeychain.delete) {
        self.saveConnection = saveConnection
        self.deleteConnection = deleteConnection
        if let saved = connection ?? (client == nil ? ConnectionKeychain.load() : nil) {
            self.connection = saved
            self.client = client ?? CompanionClient(baseURL: saved.baseURL, fingerprint: saved.fingerprint, token: saved.token)
        }
    }

    func computerSession(botId: String, chatId: String? = nil) -> BotComputerSession {
        let generation = connectionGeneration
        return BotComputerSession(client: client, botId: botId, chatId: chatId, isCurrent: { [weak self] in
            self?.connectionGeneration == generation && self?.isPaired == true
        })
    }

    func botWorkspaceStore() -> BotWorkspaceStore {
        let generation = connectionGeneration
        return BotWorkspaceStore(client: client, isCurrent: { [weak self] in
            self?.connectionGeneration == generation && self?.isPaired == true
        })
    }

    func supportedBotEfforts(_ bot: CompanionBot) async -> [String] {
        guard let client, bot.provider != "configured", bot.execution.kind != "ssh" else { return [] }
        let generation = connectionGeneration
        do {
            let catalog = try await client.botProviderModels(bot.provider)
            guard connectionGeneration == generation, !Task.isCancelled else { return [] }
            return catalog.models.first { $0.id == bot.model }?.efforts ?? []
        } catch { return [] }
    }

    func botModels(provider: String) async -> BotProviderModels? {
        guard let client else { return nil }
        let generation = connectionGeneration
        do {
            let result = try await client.botProviderModels(provider)
            guard connectionGeneration == generation, !Task.isCancelled else { return nil }
            return result
        } catch { return nil }
    }

    func clearBotProfileError() { botProfileError = nil }

    func saveBotProfile(_ draft: BotProfileDraft, original: CompanionBot?, expectedPairingGeneration: UUID) async -> CompanionBot? {
        guard connectionGeneration == expectedPairingGeneration, let client, let catalog = botCatalog, !savingBotProfile, savingBotAvatarId == nil,
              status?.hostConnected == true else { return nil }
        let generation = connectionGeneration, operation = UUID()
        botProfileOperation = operation; savingBotProfile = true; botProfileError = nil
        // A catalog read started before the write must not replace its result.
        botsRequest = nil; isLoadingBots = false
        defer {
            if connectionGeneration == generation, botProfileOperation == operation {
                savingBotProfile = false; botProfileOperation = nil
            }
        }
        do {
            let body = try draft.validated(in: catalog, original: original)
            if let original, !CompanionClient.isSafeIdentifier(original.id) { throw CompanionError.server("Choose a saved bot.") }
            let path = original.map { "/v1/bots/" + $0.id } ?? "/v1/bots"
            let result: BotProfileSaveResult = try await client.perform(path, method: original == nil ? "POST" : "PATCH", jsonBody: body)
            guard connectionGeneration == generation, botProfileOperation == operation else { return nil }
            botsRequest = nil; isLoadingBots = false
            botCatalog = result.catalog; botsMessage = result.catalog.reason
            return result.bot
        } catch is CancellationError { return nil }
        catch {
            if connectionGeneration == generation, botProfileOperation == operation { botProfileError = friendly(error) }
            return nil
        }
    }

    func saveBotAvatar(botId: String, avatar: AvatarConfig) async -> Bool {
        guard let client, botCatalog?.bots.contains(where: { $0.id == botId }) == true, savingBotAvatarId == nil, !savingBotProfile else { return false }
        if let shape = avatar.geometricShape, botCatalog?.avatarShapes?.contains(shape.rawValue) != true {
            error = "Update Strata on your Mac to save this character, or choose an animal."
            return false
        }
        let generation = connectionGeneration
        savingBotAvatarId = botId; error = nil
        defer { if connectionGeneration == generation { savingBotAvatarId = nil } }
        do {
            struct AvatarUpdate: Encodable { var avatarConfig: AvatarConfig }
            struct Saved: Decodable { var saved: Bool }
            let result: Saved = try await client.perform("/v1/bots/\(botId)/avatar", method: "POST", jsonBody: AvatarUpdate(avatarConfig: try avatar.validated(supportedShapes: botCatalog?.avatarShapes)))
            guard connectionGeneration == generation else { return false }
            await refreshBots()
            return result.saved
        } catch {
            if connectionGeneration == generation { self.error = error.localizedDescription }
            return false
        }
    }

    func pair(url: String, code: String, fingerprint: String) async {
        guard !isLoading, !isSending, !isSubmittingMessage, !isModelDownloadBusy, creatingBotConversationId == nil, !savingBotProfile else { return }
        let operation = beginLoading()
        let generation = connectionGeneration
        error = nil
        defer { finishLoading(operation) }
        do {
            let address = try PairingInvitation.validatedURL(url.trimmingCharacters(in: .whitespacesAndNewlines))
            let pin = try PairingInvitation.normalizedFingerprint(fingerprint.trimmingCharacters(in: .whitespacesAndNewlines))
            guard code.count == 6, code.allSatisfy({ $0 >= "0" && $0 <= "9" }) else {
                throw CompanionError.invalidInvitation("Enter the six-digit pairing code shown on your Mac.")
            }
            let pairingClient = CompanionClient(baseURL: address, fingerprint: pin)
            let result: PairResult = try await pairingClient.perform("/v1/pair", method: "POST", body: ["code": code, "deviceName": UIDevice.current.name])
            guard connectionGeneration == generation, loadingOperation == operation else { return }
            let saved = PairedConnection(baseURL: address, macName: result.macName, fingerprint: pin, token: result.token)
            try saveConnection(saved)
            connectionGeneration = UUID(); conversationGeneration = UUID()
            clearModelManagement()
            clearBots()
            connection = saved
            client = CompanionClient(baseURL: address, fingerprint: pin, token: saved.token)
            status = nil; models = []; chats = []; messages = []; currentChatId = nil
            conversations = []; currentConversation = nil; pendingApprovals = []; hasChosenConversation = false
            pendingInvitation = nil
            try await fetchState()
        } catch is CancellationError { }
        catch { if loadingOperation == operation { self.error = friendly(error) } }
    }

    func refresh(silently: Bool = false) async {
        guard isPaired, !isLoading else { return }
        let operation = beginLoading()
        defer { finishLoading(operation) }
        do { try await fetchState(); if !silently { error = nil } }
        catch is CancellationError { }
        catch { if loadingOperation == operation { markUnreachable(); if !silently { self.error = friendly(error) } } }
    }

    private func fetchState() async throws {
        guard let client else { throw CompanionError.unpaired }
        let generation = connectionGeneration
        async let fetchedStatus: CompanionStatus = client.perform("/v1/status")
        async let fetchedModels: ModelResult = client.perform("/v1/models")
        async let fetchedChats: ChatListResult = client.perform("/v1/chats")
        async let fetchedConversations: MacConversationList = client.perform("/v1/conversations")
        let (newStatus, newModels, newChats, newConversations) = try await (fetchedStatus, fetchedModels, fetchedChats, fetchedConversations)
        guard connectionGeneration == generation else { throw CancellationError() }
        status = newStatus; models = newModels.models; chats = newChats.chats
        conversations = newConversations.conversations
        if !hasChosenConversation, currentConversation == nil, !isSending, !isSubmittingMessage,
           let first = conversations.first(where: { $0.id == newConversations.activeChatId }) ?? conversations.first {
            await selectConversation(first)
        }
    }

    func loadModel(_ id: String) async {
        guard let client, !isLoading, !isSending else { return }
        let operation = beginLoading()
        let generation = connectionGeneration
        error = nil
        defer { finishLoading(operation) }
        do {
            let escaped = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%"))) ?? id
            try await client.discard("/v1/models/\(escaped)/load", body: [:])
            guard connectionGeneration == generation else { return }
            try await fetchState()
        } catch is CancellationError { }
        catch { if loadingOperation == operation { self.error = friendly(error) } }
    }

    func unloadModel() async {
        guard let client, !isLoading, !isSending else { return }
        let operation = beginLoading()
        let generation = connectionGeneration
        error = nil
        defer { finishLoading(operation) }
        do {
            try await client.discard("/v1/models/unload", body: [:])
            guard connectionGeneration == generation else { return }
            try await fetchState()
        } catch is CancellationError { }
        catch { if loadingOperation == operation { self.error = friendly(error) } }
    }

    func newChat() {
        guard !isSubmittingMessage, !isSending else { return }
        // Leaving an active Mac conversation only changes this phone's view.
        // The Mac keeps running until the person explicitly chooses Stop.
        streamTask?.cancel(); streamTask = nil; streamOperation = nil; isSending = false
        conversationGeneration = UUID(); hasChosenConversation = true
        currentChatId = nil; messages = []; currentConversation = nil; pendingApprovals = []; error = nil
        isSelectingConversation = false
    }

    func selectChat(_ chat: CompanionChat) async {
        guard let client, !isSending, !isSubmittingMessage else { return }
        let generation = connectionGeneration
        let conversation = UUID()
        conversationGeneration = conversation; hasChosenConversation = true
        currentConversation = nil; pendingApprovals = []
        do {
            let history: ChatHistory = try await client.perform("/v1/chats/\(chat.id)")
            guard connectionGeneration == generation, conversationGeneration == conversation, !isSending else { return }
            currentChatId = chat.id; messages = history.messages; error = nil
        } catch {
            if connectionGeneration == generation, conversationGeneration == conversation { self.error = friendly(error) }
        }
    }

    func sendLegacyMessage(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let client, !isSending, !trimmed.isEmpty else { return }
        let generation = connectionGeneration
        let conversation = UUID()
        let operation = UUID()
        conversationGeneration = conversation
        streamOperation = operation
        error = nil; isSending = true
        messages.append(ChatMessage(id: UUID().uuidString, role: "user", content: trimmed))
        let replyId = UUID().uuidString
        messages.append(ChatMessage(id: replyId, role: "assistant", content: ""))
        let chatId = currentChatId
        let task = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.streamOperation == operation {
                    self.isSending = false; self.streamTask = nil; self.streamOperation = nil
                }
            }
            do {
                try await client.stream(message: trimmed, chatId: chatId) { [weak self] frame in
                    guard let self else { return }
                    guard self.connectionGeneration == generation, self.conversationGeneration == conversation else { return }
                    if let id = frame.chatId { self.currentChatId = id }
                    if frame.type == "delta", let text = frame.text,
                       let index = self.messages.firstIndex(where: { $0.id == replyId }) { self.messages[index].content += text }
                }
                if self.connectionGeneration == generation { try await self.fetchState() }
            } catch is CancellationError { }
            catch { if self.connectionGeneration == generation { self.error = self.friendly(error) } }
        }
        streamTask = task
        await task.value
    }

    func setChatVisible(_ visible: Bool) { chatVisible = visible }
    func setModelsVisible(_ visible: Bool) { modelsVisible = visible }
    func setBotsVisible(_ visible: Bool) { botsVisible = visible }

    func refreshLiveState(refreshOverview: Bool) async {
        guard isPaired else { return }
        if refreshOverview { await refresh(silently: true) }
        if chatVisible { await refreshCurrentConversation() }
        if botsVisible, refreshOverview || botCatalog == nil { await refreshBots() }
        if modelsVisible, refreshOverview || !hasDiscoveredModelTargets || modelCatalog?.jobs.contains(where: \.isRunning) == true {
            await refreshModelManagement(refreshTargets: refreshOverview)
        }
    }

    @discardableResult
    func refreshBots() async -> Bool {
        guard let client, isPaired, botsRequest == nil, !savingBotProfile else { return false }
        let generation = connectionGeneration
        let request = UUID()
        botsRequest = request; isLoadingBots = true
        defer {
            if botsRequest == request { botsRequest = nil; isLoadingBots = false }
        }
        do {
            let result: CompanionBots = try await client.perform("/v1/bots")
            guard connectionGeneration == generation, botsRequest == request else { return false }
            if botCatalog != result { botCatalog = result }
            botsMessage = result.reason
            return true
        } catch is CancellationError { return false }
        catch {
            guard connectionGeneration == generation, botsRequest == request else { return false }
            if let http = error as? CompanionHTTPError, http.isUnsupported {
                botCatalog = nil
                botsMessage = "Update Strata on your Mac to use Bots on your iPhone."
            } else { botsMessage = friendly(error) }
            return false
        }
    }

    func botConversations(_ bot: CompanionBot) -> [MacConversationSummary] {
        let ids = Set(bot.conversations ?? [])
        return conversations.filter { $0.botId == bot.id || ids.contains($0.id) }
    }

    var currentBotMood: BotMood {
        let paused = botCatalog?.bots.first { $0.id == currentConversation?.botId }?.paused == true
        return BotAvatarState.mood(conversation: currentConversation, pending: pendingApprovals, paused: paused)
    }

    func botMood(_ bot: CompanionBot) -> BotMood {
        let active = botIsWorking(bot)
        if currentConversation?.botId == bot.id, currentConversation?.active == true || !active {
            return BotAvatarState.mood(conversation: currentConversation, pending: pendingApprovals, paused: bot.paused == true)
        }
        return bot.paused == true ? .paused : active ? .working : .idle
    }

    func botIsWorking(_ bot: CompanionBot) -> Bool {
        bot.active == true || botConversations(bot).contains { $0.id != currentConversation?.id && $0.active } || (currentConversation?.botId == bot.id && currentConversation?.active == true)
    }

    @discardableResult
    func newBotConversation(_ bot: CompanionBot, computerId: String? = nil, modelId: String? = nil, workspace: String? = nil, effort: String? = nil, policy: BotApprovalPolicy? = nil) async -> Bool {
        guard let client, let currentBot = botCatalog?.bots.first(where: { $0.id == bot.id }),
              !isSending, !isSubmittingMessage, creatingBotConversationId == nil, !savingBotProfile else { return false }
        if currentBot.paused == true { error = "This bot is paused. Resume it in Strata on your Mac."; return false }
        var options: [String: String] = [:]
        if let policy {
            guard botCatalog?.lifecycleSupported == true else { error = "Update Strata on your Mac to choose approvals for a new conversation."; return false }
            options["policy"] = policy.rawValue
        }
        if let effort {
            guard effort.range(of: "^[A-Za-z0-9_-]{0,40}$", options: .regularExpression) != nil else { error = "Choose an effort supported by this model."; return false }
            options["effort"] = effort
        }
        if computerId != nil || modelId != nil || workspace != nil || currentBot.computerMode == "cua" {
            guard botCatalog?.selectionSupported == true else {
                error = "Update Strata on your Mac to choose a computer or model for this conversation."; return false
            }
        }
        if currentBot.computerMode == "cua" {
            guard workspace == nil || workspace?.trimmingCharacters(in: .whitespacesAndNewlines) == "/workspace" else {
                error = "This isolated computer uses /workspace."; return false
            }
            options["workspace"] = "/workspace"
        }
        if let computerId {
            guard botCatalog?.computers.contains(where: { $0.id == computerId && $0.available }) == true else {
                error = "This computer is not ready. Set it up on your Mac, then refresh Bots."; return false
            }
            options["computerId"] = computerId
        }
        if let modelId {
            guard botCatalog?.models?.contains(where: { $0.id == modelId && $0.available }) == true else {
                error = "This model connection is no longer available. Refresh Bots."; return false
            }
            options["modelId"] = modelId
        }
        if let workspace {
            let path = workspace.trimmingCharacters(in: .whitespacesAndNewlines)
            guard path.hasPrefix("/"), path.utf16.count <= 4_000, path.rangeOfCharacter(from: .controlCharacters) == nil else {
                error = "Enter the full workspace folder path on the selected computer."; return false
            }
            options["workspace"] = path
        }
        let generation = connectionGeneration
        let selection = UUID()
        conversationGeneration = selection; hasChosenConversation = true
        creatingBotConversationId = bot.id; isSelectingConversation = true; error = nil
        defer {
            if connectionGeneration == generation {
                creatingBotConversationId = nil
                if conversationGeneration == selection { isSelectingConversation = false }
            }
        }
        do {
            let detail: MacConversationDetail = try await client.perform("/v1/bots/" + escapedComponent(bot.id) + "/conversations", method: "POST", body: options)
            guard connectionGeneration == generation, conversationGeneration == selection else { return false }
            currentChatId = nil; messages = []; apply(detail)
            await refresh(silently: true)
            return connectionGeneration == generation && conversationGeneration == selection
        } catch is CancellationError { return false }
        catch {
            if connectionGeneration == generation, conversationGeneration == selection { self.error = friendly(error) }
            return false
        }
    }

    private func clearBots() {
        botProfileOperation = nil; savingBotProfile = false; botProfileError = nil
        savingBotAvatarId = nil
        botsRequest = nil; isLoadingBots = false; botCatalog = nil; botsMessage = nil; creatingBotConversationId = nil
    }

    func refreshModelManagement(refreshTargets: Bool = false) async {
        guard isPaired else { return }
        if refreshTargets || !hasDiscoveredModelTargets { await discoverModelTargets() }
        await refreshModelCatalog()
    }

    private func discoverModelTargets() async {
        guard let client, modelTargetsRequest == nil else { return }
        let generation = connectionGeneration
        let request = UUID()
        modelTargetsRequest = request
        if !hasDiscoveredModelTargets { isDiscoveringModelTargets = true }
        defer {
            if modelTargetsRequest == request {
                modelTargetsRequest = nil
                if isDiscoveringModelTargets { isDiscoveringModelTargets = false }
            }
        }
        do {
            let result: ModelManagementTargets = try await client.perform("/v1/model-management/targets")
            guard connectionGeneration == generation, modelTargetsRequest == request else { return }
            hasDiscoveredModelTargets = true
            if modelTargets != result.targets { modelTargets = result.targets }
            if result.targets.isEmpty {
                selectedModelTargetId = nil; modelCatalog = nil; dismissModelDownloadReview()
                modelManagementMessage = result.reason ?? "Update Strata on your Mac to download models from your iPhone."
            } else if !result.targets.contains(where: { $0.id == selectedModelTargetId }) {
                await selectModelTarget(result.targets.first(where: { $0.kind == "local" })?.id ?? result.targets[0].id)
            }
        } catch is CancellationError { }
        catch {
            guard connectionGeneration == generation, modelTargetsRequest == request else { return }
            hasDiscoveredModelTargets = true
            if let http = error as? CompanionHTTPError, http.isUnsupported {
                modelTargets = []; selectedModelTargetId = nil; modelCatalog = nil; dismissModelDownloadReview()
                modelManagementMessage = "Update Strata on your Mac to download models from your iPhone."
            } else { modelManagementMessage = friendly(error) }
        }
    }

    func selectModelTarget(_ id: String) async {
        guard modelTargets.contains(where: { $0.id == id }), !isModelDownloadBusy else { return }
        modelTargetGeneration = UUID(); modelCatalogRequest = nil
        selectedModelTargetId = id; modelCatalog = nil; modelManagementMessage = nil; isLoadingModelCatalog = false
        dismissModelDownloadReview()
        await refreshModelCatalog()
    }

    private func refreshModelCatalog() async {
        guard let client, let target = selectedModelTargetId, modelCatalogRequest == nil, !isModelDownloadBusy else { return }
        let generation = connectionGeneration
        let targetGeneration = modelTargetGeneration
        let request = UUID()
        modelCatalogRequest = request
        if modelCatalog == nil { isLoadingModelCatalog = true }
        defer {
            if modelCatalogRequest == request {
                modelCatalogRequest = nil
                if isLoadingModelCatalog { isLoadingModelCatalog = false }
            }
        }
        do {
            let catalog: ModelManagementCatalog = try await client.perform(modelManagementPath(target))
            guard connectionGeneration == generation, modelTargetGeneration == targetGeneration, selectedModelTargetId == target, modelCatalogRequest == request else { return }
            if modelCatalog != catalog { modelCatalog = catalog }
            let message = catalog.canDownload ? nil : catalog.reason ?? "This computer does not support model downloads from the phone."
            if modelManagementMessage != message { modelManagementMessage = message }
        } catch is CancellationError { }
        catch {
            if connectionGeneration == generation, modelTargetGeneration == targetGeneration, modelCatalogRequest == request {
                modelManagementMessage = friendly(error)
            }
        }
    }

    func reviewModelDownload(_ model: DownloadableModel, readPictures: Bool) async {
        guard let client, let target = selectedModelTargetId, let catalog = modelCatalog, catalog.canDownload,
              let actual = catalog.models.first(where: { $0.id == model.id }), !isModelDownloadBusy,
              actual.canDownload || catalog.jobs.contains(where: { $0.modelId == actual.id && $0.canRetry }) else { return }
        let generation = connectionGeneration
        let targetGeneration = modelTargetGeneration
        let review = UUID()
        modelReviewGeneration = review; modelReviewTargetId = target
        reviewingModelDownload = actual; modelDownloadPlan = nil; modelDownloadReviewError = nil; isPlanningModelDownload = true
        defer { if modelReviewGeneration == review { isPlanningModelDownload = false } }
        do {
            let plan: ModelDownloadPlan = try await client.perform(modelManagementPath(target) + "/plan", method: "POST",
                jsonBody: ModelDownloadPlanRequest(modelId: actual.id, readPictures: readPictures && actual.readPictures))
            guard connectionGeneration == generation, modelTargetGeneration == targetGeneration, modelReviewGeneration == review,
                  modelReviewTargetId == target, selectedModelTargetId == target else { return }
            modelDownloadPlan = plan
        } catch is CancellationError { }
        catch {
            if connectionGeneration == generation, modelTargetGeneration == targetGeneration, modelReviewGeneration == review {
                modelDownloadReviewError = friendly(error)
            }
        }
    }

    func dismissModelDownloadReview() {
        guard !isStartingModelDownload else { return }
        modelReviewGeneration = UUID(); modelReviewTargetId = nil
        reviewingModelDownload = nil; modelDownloadPlan = nil; modelDownloadReviewError = nil; isPlanningModelDownload = false
    }

    func startModelDownload() async {
        guard let client, let target = selectedModelTargetId, modelReviewTargetId == target,
              let plan = modelDownloadPlan, !isPlanningModelDownload, !isModelDownloadBusy else { return }
        guard plan.canStart() else {
            modelDownloadReviewError = plan.diskShort?.isEmpty == false ? plan.diskShort : "This review has expired. Refresh the plan before downloading."
            return
        }
        let generation = connectionGeneration
        let targetGeneration = modelTargetGeneration
        isStartingModelDownload = true; modelDownloadReviewError = nil
        // A pre-start poll cannot replace the job returned by this action.
        modelCatalogRequest = nil; isLoadingModelCatalog = false
        defer { if connectionGeneration == generation { isStartingModelDownload = false } }
        do {
            let result: ModelDownloadResult = try await client.perform(modelManagementPath(target) + "/downloads", method: "POST", body: ["planId": plan.planId])
            guard connectionGeneration == generation, modelTargetGeneration == targetGeneration, selectedModelTargetId == target else { return }
            updateModelDownload(result.job)
            isStartingModelDownload = false
            dismissModelDownloadReview()
            await refreshModelCatalog()
        } catch is CancellationError { }
        catch {
            if connectionGeneration == generation, modelTargetGeneration == targetGeneration { modelDownloadReviewError = friendly(error) }
        }
    }

    func cancelModelDownload(_ job: ModelDownloadJob) async {
        guard let client, let target = selectedModelTargetId, !isModelDownloadBusy,
              modelCatalog?.jobs.contains(where: { $0.id == job.id && $0.kind == "download" && $0.isRunning && $0.canCancel == true }) == true else { return }
        let generation = connectionGeneration
        let targetGeneration = modelTargetGeneration
        cancellingModelDownloadId = job.id; modelManagementMessage = nil
        modelCatalogRequest = nil; isLoadingModelCatalog = false
        defer { if connectionGeneration == generation { cancellingModelDownloadId = nil } }
        do {
            let result: ModelDownloadResult = try await client.perform(modelManagementPath(target) + "/downloads/" + escapedComponent(job.id) + "/cancel", method: "POST", body: [:])
            guard connectionGeneration == generation, modelTargetGeneration == targetGeneration, selectedModelTargetId == target else { return }
            updateModelDownload(result.job)
            cancellingModelDownloadId = nil
            await refreshModelCatalog()
        } catch is CancellationError { }
        catch { if connectionGeneration == generation, modelTargetGeneration == targetGeneration { modelManagementMessage = friendly(error) } }
    }

    private func updateModelDownload(_ job: ModelDownloadJob) {
        guard var catalog = modelCatalog else { return }
        if let index = catalog.jobs.firstIndex(where: { $0.id == job.id }) { catalog.jobs[index] = job }
        else { catalog.jobs.insert(job, at: 0) }
        if modelCatalog != catalog { modelCatalog = catalog }
    }

    private func modelManagementPath(_ target: String) -> String {
        "/v1/model-management/targets/" + escapedComponent(target)
    }

    private func escapedComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%"))) ?? value
    }

    private func clearModelManagement() {
        modelTargetGeneration = UUID(); modelTargetsRequest = nil; modelCatalogRequest = nil
        modelTargets = []; selectedModelTargetId = nil; modelCatalog = nil; modelManagementMessage = nil
        hasDiscoveredModelTargets = false; isDiscoveringModelTargets = false; isLoadingModelCatalog = false
        isStartingModelDownload = false; cancellingModelDownloadId = nil
        dismissModelDownloadReview()
    }

    func selectConversation(_ summary: MacConversationSummary) async {
        guard let client, !isSubmittingMessage, !isSending else { return }
        let generation = connectionGeneration
        let selection = UUID()
        conversationGeneration = selection; hasChosenConversation = true
        isSelectingConversation = true
        defer { if conversationGeneration == selection { isSelectingConversation = false } }
        do {
            let detail: MacConversationDetail = try await client.perform(conversationPath(summary.id))
            guard connectionGeneration == generation, conversationGeneration == selection else { return }
            currentChatId = nil; messages = []; apply(detail); error = nil
        } catch is CancellationError { }
        catch { if connectionGeneration == generation, conversationGeneration == selection { self.error = friendly(error) } }
    }

    func refreshCurrentConversation() async {
        guard let client, let selected = currentConversation, !isSubmittingMessage, !isSelectingConversation, decidingToolId == nil else { return }
        let generation = connectionGeneration
        let selection = conversationGeneration
        do {
            let detail: MacConversationDetail = try await client.perform(conversationPath(selected.id))
            guard connectionGeneration == generation, conversationGeneration == selection, currentConversation?.id == selected.id else { return }
            apply(detail)
        } catch is CancellationError { }
        catch {
            // Background refresh leaves the conversation readable and retryable.
            if connectionGeneration == generation { markUnreachable() }
        }
    }

    func sendMessage(_ text: String) async {
        if isLegacyConversation { await sendLegacyMessage(text); return }
        if let botId = currentConversation?.botId, botCatalog?.bots.first(where: { $0.id == botId })?.paused == true {
            error = "This bot is paused. Resume it in Strata on your Mac."; return
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let client, !isSubmittingMessage, creatingBotConversationId == nil, currentConversation?.active != true, !trimmed.isEmpty else { return }
        let generation = connectionGeneration
        let selection = UUID()
        conversationGeneration = selection; hasChosenConversation = true
        isSubmittingMessage = true; error = nil
        defer { if connectionGeneration == generation { isSubmittingMessage = false } }
        do {
            if currentConversation == nil {
                let created: MacConversationDetail = try await client.perform("/v1/conversations", method: "POST", body: [:])
                guard connectionGeneration == generation, conversationGeneration == selection else { return }
                apply(created)
            }
            guard let id = currentConversation?.id else { throw CompanionError.server("The Mac could not create a conversation.") }
            let detail: MacConversationDetail = try await client.perform(conversationPath(id) + "/messages", method: "POST", body: ["message": trimmed])
            guard connectionGeneration == generation, conversationGeneration == selection else { return }
            apply(detail)
            await refresh(silently: true)
        } catch is CancellationError { }
        catch { if connectionGeneration == generation, conversationGeneration == selection { self.error = friendly(error) } }
    }

    func stopConversation() async {
        guard let client, let selected = currentConversation, selected.active, !isSubmittingMessage, !isSelectingConversation else { return }
        let generation = connectionGeneration
        let selection = UUID()
        conversationGeneration = selection
        isSubmittingMessage = true
        defer { if connectionGeneration == generation { isSubmittingMessage = false } }
        do {
            let detail: MacConversationDetail = try await client.perform(conversationPath(selected.id) + "/stop", method: "POST", body: [:])
            guard connectionGeneration == generation, conversationGeneration == selection else { return }
            apply(detail)
        } catch is CancellationError { }
        catch { if connectionGeneration == generation, conversationGeneration == selection { self.error = friendly(error) } }
    }

    func decideApproval(_ tool: MacToolActivity, approve: Bool) async {
        guard let client, let selected = currentConversation, decidingToolId == nil,
              pendingApprovals.contains(where: { $0.id == tool.id }) else { return }
        let generation = connectionGeneration
        let selection = UUID()
        conversationGeneration = selection
        decidingToolId = tool.id
        defer { if connectionGeneration == generation { decidingToolId = nil } }
        do {
            let detail: MacConversationDetail = try await client.perform(conversationPath(selected.id) + "/approval", method: "POST", body: ["toolId": tool.id, "decision": approve ? "approve" : "deny"])
            guard connectionGeneration == generation, conversationGeneration == selection else { return }
            apply(detail); error = nil
        } catch is CancellationError { }
        catch { if connectionGeneration == generation, conversationGeneration == selection { self.error = friendly(error) } }
    }

    private func apply(_ detail: MacConversationDetail) {
        // A live poll often returns the same snapshot. Publishing it repeatedly
        // needlessly rebuilds the scroll view and its selectable text controls.
        if currentConversation != detail.conversation { currentConversation = detail.conversation }
        if pendingApprovals != detail.pending { pendingApprovals = detail.pending }
    }

    private func conversationPath(_ id: String) -> String {
        let escaped = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%"))) ?? id
        return "/v1/conversations/\(escaped)"
    }

    func cancelMessage() async {
        if currentConversation != nil { await stopConversation(); return }
        guard let client, let currentChatId, isSending else { return }
        let operation = streamOperation
        let generation = connectionGeneration
        do {
            try await client.discard("/v1/chat/\(currentChatId)/cancel", body: [:])
            if streamOperation == operation { streamTask?.cancel() }
        } catch { if connectionGeneration == generation, streamOperation == operation { self.error = friendly(error) } }
    }

    func disconnect() async {
        guard let client else { return }
        guard !isSending, !isSubmittingMessage, !isModelDownloadBusy, creatingBotConversationId == nil, !savingBotProfile else { error = "Wait for the current request before disconnecting."; return }
        let generation = connectionGeneration
        do {
            // Revoke on the Mac before deleting the local credential.
            try await client.discard("/v1/session", method: "DELETE")
            guard connectionGeneration == generation else { return }
            try deleteConnection()
            clearConnection()
        } catch { if connectionGeneration == generation { self.error = friendly(error) } }
    }

    func forgetMac() {
        guard !isSending, !isSubmittingMessage, !isModelDownloadBusy, creatingBotConversationId == nil, !savingBotProfile else { error = "Wait for the current request before forgetting this Mac."; return }
        do {
            try deleteConnection()
            clearConnection()
        } catch { self.error = friendly(error) }
    }

    private func beginLoading() -> UUID {
        let operation = UUID()
        loadingOperation = operation; isLoading = true
        return operation
    }

    private func finishLoading(_ operation: UUID) {
        guard loadingOperation == operation else { return }
        loadingOperation = nil; isLoading = false
    }

    private func clearConnection() {
        connectionGeneration = UUID(); conversationGeneration = UUID()
        clearModelManagement()
        clearBots()
        loadingOperation = nil; isLoading = false
        client = nil; connection = nil; status = nil; models = []; chats = []; messages = []; currentChatId = nil; error = nil
        conversations = []; currentConversation = nil; pendingApprovals = []; hasChosenConversation = false
        isSubmittingMessage = false; isSelectingConversation = false; decidingToolId = nil
    }

    private func markUnreachable() {
        status?.hostConnected = false
        status?.tokensPerSecond = nil
        status?.activeRequests = 0
    }

    private func friendly(_ error: Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .serverCertificateUntrusted, .secureConnectionFailed, .cancelled:
                return "The Mac certificate could not be verified. Scan a fresh pairing QR code from your Mac."
            case .cannotConnectToHost, .cannotFindHost, .timedOut, .notConnectedToInternet:
                return "Your Mac is unreachable. Keep Strata running with iPhone pairing enabled and connect both devices to the same network."
            default: break
            }
        }
        return error.localizedDescription
    }
}

private struct PairResult: Decodable { var token: String; var macName: String }
private struct ModelResult: Decodable { var models: [CompanionModel] }
private struct ChatListResult: Decodable { var chats: [CompanionChat] }
private struct ChatHistory: Decodable { var messages: [ChatMessage] }
private struct ModelDownloadPlanRequest: Encodable { var modelId: String; var readPictures: Bool }
