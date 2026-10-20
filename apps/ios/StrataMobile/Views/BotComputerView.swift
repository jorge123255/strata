import SwiftUI

struct BotComputerView: View {
    @StateObject private var session: BotComputerSession
    @Environment(\.scenePhase) private var scenePhase
    @State private var confirmingTakeover = false
    @State private var confirmingStop = false
    @State private var text = ""
    @FocusState private var typing: Bool
    let name: String

    init(store: CompanionStore, botId: String, chatId: String? = nil, name: String) {
        self.name = name
        _session = StateObject(wrappedValue: store.computerSession(botId: botId, chatId: chatId))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(session.state?.computerName ?? name).font(.system(.title2, design: .rounded, weight: .bold)).foregroundStyle(StrataTheme.ink)
                    Label(session.hasControl ? "You have control" : "View only", systemImage: session.hasControl ? "hand.point.up.left.fill" : "eye")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(StrataTheme.accentText).accessibilityIdentifier("computerControlState")
                    Text("Snapshots refresh while this screen is open. Start the computer explicitly if it isn’t running.")
                        .font(.caption).foregroundStyle(StrataTheme.secondaryInk)
                }
                canvas
                if let detail = session.state?.detail, !detail.isEmpty {
                    Text(detail).font(.subheadline).foregroundStyle(StrataTheme.secondaryInk).accessibilityIdentifier("computerDetail")
                }
                if session.state?.cleanupConfirmed == false {
                    Label("Stop the isolated computer to confirm its processes have ended.", systemImage: "exclamationmark.circle")
                        .font(.subheadline).foregroundStyle(StrataTheme.warning)
                }
                if let error = session.error {
                    Label(error, systemImage: "exclamationmark.circle").font(.subheadline).foregroundStyle(StrataTheme.warning).accessibilityIdentifier("computerError")
                }
                if session.hasControl { inputControls }
                HStack(spacing: 12) {
                    if session.hasControl {
                        Button("Release control") { typing = false; Task { await session.release() } }
                            .buttonStyle(StrataPrimaryButtonStyle()).accessibilityIdentifier("releaseComputerControlButton")
                    } else if session.isRunning {
                        Button("Take over") { confirmingTakeover = true }
                            .buttonStyle(StrataPrimaryButtonStyle()).accessibilityIdentifier("takeOverComputerButton")
                    } else {
                        Button("Start computer") { Task { await session.start() } }
                            .buttonStyle(StrataPrimaryButtonStyle()).accessibilityIdentifier("startBotComputerButton")
                    }
                    Button { Task { await session.refresh() } } label: { Image(systemName: "arrow.clockwise").frame(width: 40, height: 44) }
                        .accessibilityLabel("Refresh computer view")
                }.disabled(session.isBusy)
                if session.isRunning || session.state?.cleanupConfirmed == false {
                    Button(role: .destructive) { confirmingStop = true } label: {
                        Label("Stop isolated computer", systemImage: "power")
                    }.font(.subheadline).disabled(session.isBusy).accessibilityIdentifier("stopBotComputerButton")
                }
                Text("Releasing control leaves the bot stopped. Return to its conversation when you’re ready to give it more work.")
                    .font(.caption).foregroundStyle(StrataTheme.secondaryInk)
            }.padding(24)
        }
        .background(StrataTheme.background)
        .navigationTitle("Computer view").navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .task(id: scenePhase) { if scenePhase == .active { await session.run() } }
        .onChange(of: scenePhase) { _, value in if value != .active { typing = false; session.deactivate() } }
        .onDisappear { session.deactivate() }
        .confirmationDialog("Take over this isolated computer?", isPresented: $confirmingTakeover, titleVisibility: .visible) {
            Button("Stop bots and take over") { Task { await session.takeOver() } }
            Button("Cancel", role: .cancel) { }
        } message: { Text("All bot work using this isolated computer will stop before you get control. It will stay stopped after you release control.") }
        .confirmationDialog("Stop isolated computer?", isPresented: $confirmingStop, titleVisibility: .visible) {
            Button("Stop computer", role: .destructive) { typing = false; Task { await session.stop() } }
            Button("Cancel", role: .cancel) { }
        } message: { Text("Its processes will stop. Files are retained. Start the computer again when you need it.") }
    }

    private var canvas: some View {
        GeometryReader { geometry in
            ZStack {
                RoundedRectangle(cornerRadius: 15).fill(Color.black.opacity(0.92))
                if let image = session.image, let state = session.state, let width = state.width, let height = state.height {
                    Image(uiImage: image).resizable().scaledToFit().accessibilityLabel("Isolated computer screenshot")
                    Color.clear.contentShape(Rectangle())
                        .gesture(SpatialTapGesture().onEnded { value in
                            guard session.hasControl, !session.isBusy,
                                  let pixel = ComputerCanvasPosition.pixel(at: value.location, canvas: geometry.size, image: CGSize(width: width, height: height)) else { return }
                            typing = false
                            Task { await session.click(x: pixel.x, y: pixel.y) }
                        })
                } else {
                    VStack(spacing: 12) {
                        if session.isBusy || session.isRefreshing { ProgressView().tint(.white) }
                        Image(systemName: "desktopcomputer").font(.system(size: 35, weight: .light))
                        Text(session.isRunning ? "Waiting for a computer image…" : "Computer is not running")
                            .font(.subheadline).multilineTextAlignment(.center)
                    }.foregroundStyle(.white.opacity(0.8)).padding(20)
                }
            }.clipShape(RoundedRectangle(cornerRadius: 15))
        }
        .frame(height: 250)
        .accessibilityIdentifier("botComputerCanvas")
    }

    private var inputControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Tap the image to click. Type or send a key below.").font(.caption).foregroundStyle(StrataTheme.secondaryInk)
            HStack(alignment: .top, spacing: 10) {
                TextField("Text for the computer", text: $text, axis: .vertical)
                    .lineLimit(1...4).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .padding(12).background(StrataTheme.surface, in: RoundedRectangle(cornerRadius: 12))
                    .focused($typing).accessibilityIdentifier("computerTypeField")
                Button("Type") { let value = text; typing = false; Task { await session.type(value); if session.error == nil { text = "" } } }
                    .font(.subheadline.weight(.semibold)).padding(.top, 12)
                    .disabled(text.isEmpty || text.utf16.count > 4_000).accessibilityIdentifier("computerTypeButton")
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(["Enter", "Tab", "Escape", "Backspace", "Control+L"], id: \.self) { key in
                        Button(key == "Control+L" ? "Address bar" : key) { typing = false; Task { await session.key(key) } }
                            .font(.caption.weight(.semibold)).padding(.horizontal, 12).padding(.vertical, 10)
                            .background(StrataTheme.accentTint, in: Capsule()).accessibilityIdentifier("computerKey-\(key)")
                    }
                }
            }
        }.foregroundStyle(StrataTheme.ink).disabled(session.isBusy)
    }
}
