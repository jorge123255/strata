import SwiftUI

struct ConnectionView: View {
    @ObservedObject var store: CompanionStore
    let pair: () -> Void
    @State private var showingDisconnect = false
    @State private var showingForget = false
    @State private var showingNotifications = false
    @State private var showingMacAddress = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                PageHeading(eyebrow: "Better together", title: "Connection", subtitle: "A direct link to your Strata workspace.")
                if store.isPaired {
                    connectedCard
                    Button { showingNotifications = true } label: {
                        HStack { Label("Notifications", systemImage: "bell.badge"); Spacer(); Image(systemName: "chevron.right") }
                            .foregroundStyle(StrataTheme.ink).frame(minHeight: 44).strataCard()
                    }.accessibilityIdentifier("connectionNotificationsButton")
                } else {
                    VStack(spacing: 14) {
                        PairingIllustration(compact: true)
                        VStack(spacing: 8) {
                            Text("Your Mac is the missing piece.")
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(StrataTheme.ink)
                                .multilineTextAlignment(.center)
                            Text("Scan a pairing code to bring your\nStrata workspace to your phone.")
                                .font(.subheadline)
                                .foregroundStyle(StrataTheme.secondaryInk)
                                .multilineTextAlignment(.center)
                                .lineSpacing(4)
                        }
                        Button(action: pair) {
                            Label("Pair your Mac", systemImage: "qrcode.viewfinder")
                        }
                        .buttonStyle(StrataPrimaryButtonStyle())
                        .padding(.top, 6)
                        .accessibilityIdentifier("connectionPairButton")
                    }
                    .padding(.horizontal, 18)
                    .padding(.bottom, 18)
                    .strataCard(padding: 0)
                }
                VStack(alignment: .leading, spacing: 22) {
                    DetailRow(icon: "network", title: "At home or away", detail: "Use the same Wi-Fi, or connect your iPhone and Mac to Tailscale. Your Mac must stay awake with Strata running.")
                    DetailRow(icon: "lock.shield", title: "A trusted connection", detail: "A one-time code pairs your phone. Your Mac’s certificate is checked on every connection.")
                    DetailRow(icon: "desktopcomputer", title: "Your workspace, connected", detail: "Use models and API connections configured on your Mac. Selected providers may run remotely.")
                }
                .strataCard(padding: 18)
                HStack {
                    StrataMark(size: 22)
                    Text("Strata for iPhone").font(.caption)
                    Spacer()
                    Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
                        .font(.caption.monospacedDigit())
                }
                .foregroundStyle(StrataTheme.secondaryInk)
                .padding(.top, 12)
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 30)
        }
        .background(StrataTheme.background)
        .sheet(isPresented: $showingNotifications) { NotificationsView(notifications: store.notifications) }
        .sheet(isPresented: $showingMacAddress) { UpdateMacAddressView(store: store) }
        .toolbar(.hidden, for: .navigationBar)
        .confirmationDialog("Disconnect this Mac?", isPresented: $showingDisconnect, titleVisibility: .visible) {
            Button("Disconnect Mac", role: .destructive) { Task { await store.disconnect() } }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("You can pair again at any time using a new code from your Mac.")
        }
        .confirmationDialog("Forget this Mac?", isPresented: $showingForget, titleVisibility: .visible) {
            Button("Forget this Mac", role: .destructive) { store.forgetMac() }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("This removes the pairing key from this iPhone. To revoke its access on the Mac too, choose Pair iPhone in Strata and remove this device.")
        }
        .refreshable { if store.isPaired { await store.refresh() } }
    }

    private var connectedCard: some View {
        VStack(alignment: .leading, spacing: 20) {
            (typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 14)) : AnyLayout(HStackLayout(spacing: 14))) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 27, weight: .light))
                    .foregroundStyle(StrataTheme.accentText)
                    .frame(width: 56, height: 56)
                    .background(StrataTheme.grouped, in: RoundedRectangle(cornerRadius: 18))
                VStack(alignment: .leading, spacing: 6) {
                    Text(store.status?.macName ?? store.connection?.macName ?? "Your Mac")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(StrataTheme.ink)
                    HStack(spacing: 6) {
                        Circle().fill(store.status?.hostConnected == true ? StrataTheme.success : StrataTheme.secondaryInk).frame(width: 6, height: 6)
                        Text(store.status?.hostConnected == true ? "Connected" : "Paired · Mac unavailable")
                            .font(.caption)
                            .foregroundStyle(StrataTheme.secondaryInk)
                    }
                }
                if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
            }
            Divider().overlay(StrataTheme.line)
            if let address = (store.connectedAddress ?? store.connection?.baseURL)?.absoluteString {
                VStack(alignment: .leading, spacing: 6) {
                    Text("MAC ADDRESS").font(.system(.caption2, weight: .bold)).tracking(1.6)
                    Text(address).font(.subheadline.monospaced()).textSelection(.enabled)
                }
                .foregroundStyle(StrataTheme.secondaryInk)
            }
            Button { Task { await store.refresh() } } label: {
                HStack {
                    if store.isLoading { ProgressView().controlSize(.small) }
                    else { Image(systemName: "arrow.clockwise") }
                    Text(store.isLoading ? "Checking connection…" : "Check connection")
                }
            }
            .buttonStyle(StrataSecondaryButtonStyle())
            .disabled(store.isLoading)
            .accessibilityIdentifier("refreshConnectionButton")
            Button { showingMacAddress = true } label: {
                Label("Update Mac address", systemImage: "network")
            }
            .buttonStyle(StrataSecondaryButtonStyle())
            .disabled(!store.canUpdateMacAddress)
            .accessibilityIdentifier("updateMacAddressButton")
            Button(action: pair) {
                Label("Pair again", systemImage: "qrcode.viewfinder")
            }
            .buttonStyle(StrataSecondaryButtonStyle())
            .disabled(store.isLoading || store.isSending)
            .accessibilityIdentifier("pairAgainButton")
            Button("Disconnect Mac", role: .destructive) { showingDisconnect = true }
                .font(.system(.subheadline, weight: .medium))
                .frame(maxWidth: .infinity, minHeight: 44)
                .accessibilityIdentifier("disconnectMacButton")
            Button("Forget this Mac", role: .destructive) { showingForget = true }
                .font(.system(.caption, weight: .medium))
                .frame(maxWidth: .infinity, minHeight: 44)
                .accessibilityIdentifier("forgetMacButton")
        }
        .strataCard()
    }
}

private struct UpdateMacAddressView: View {
    @ObservedObject var store: CompanionStore
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var kind = CompanionEndpoint.Kind.tailscale
    @State private var updateTask: Task<Void, Never>?
    @FocusState private var addressFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    PageHeading(eyebrow: "Same Mac, new route", title: "Update Mac address", subtitle: "Keep your pairing and chat history. This address must present your Mac’s existing certificate.")
                    VStack(alignment: .leading, spacing: 14) {
                        Picker("Connection type", selection: $kind) {
                            Text("Tailscale").tag(CompanionEndpoint.Kind.tailscale)
                            Text("Local Wi-Fi").tag(CompanionEndpoint.Kind.lan)
                        }.pickerStyle(.segmented).accessibilityIdentifier("macAddressKindPicker")
                        Text(kind == .tailscale ? "TAILSCALE ADDRESS" : "MAC ADDRESS")
                            .font(.caption.weight(.semibold)).foregroundStyle(StrataTheme.secondaryInk)
                        TextField("https://100.x.x.x:8787", text: $address)
                            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .textContentType(.URL).padding(14).background(StrataTheme.grouped, in: RoundedRectangle(cornerRadius: 14))
                            .focused($addressFocused)
                            .accessibilityIdentifier("macAddressField")
                        Text("On your Mac, open Pair iPhone and copy its Tailscale address. Connect both devices to Tailscale first. Include https:// and the port.")
                            .font(.footnote).foregroundStyle(StrataTheme.secondaryInk)
                    }.strataCard()
                    if let message = store.macAddressError {
                        Text(message).font(.subheadline).foregroundStyle(StrataTheme.warning)
                            .accessibilityIdentifier("macAddressError")
                    }
                    Button {
                        updateTask = Task {
                            if await store.updateMacAddress(address, kind: kind) { dismiss() }
                        }
                    } label: {
                        HStack {
                            if store.isUpdatingMacAddress { ProgressView().controlSize(.small) }
                            Text(store.isUpdatingMacAddress ? "Checking your Mac…" : "Check and save")
                        }
                    }.buttonStyle(StrataPrimaryButtonStyle())
                        .disabled(!store.canUpdateMacAddress || address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("saveMacAddressButton")
                }.padding(20)
            }.background(StrataTheme.background)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer()
                        Button("Done") { addressFocused = false }.accessibilityIdentifier("dismissMacAddressKeyboardButton")
                    }
                }
        }
        .onDisappear { updateTask?.cancel(); store.cancelMacAddressUpdate() }
    }
}

struct PairMacView: View {
    @ObservedObject var store: CompanionStore
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var code = ""
    @State private var fingerprint = ""
    @State private var showingScanner = false
    @State private var scanError: String?
    @State private var showingManual = false
    @FocusState private var focusedField: PairingField?

    private enum PairingField: Hashable { case address, code, fingerprint }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 16) {
                        Image(systemName: "link")
                            .font(.system(size: 29, weight: .regular))
                            .foregroundStyle(StrataTheme.accentText)
                            .frame(width: 65, height: 65)
                            .background(StrataTheme.accentTint, in: RoundedRectangle(cornerRadius: 21))
                        PageHeading(eyebrow: "Hello, Mac", title: "Make it a pair.", subtitle: "Open Strata on your Mac, choose Pair iPhone, then enable pairing and scan its QR code. Keep both devices on the same network.")
                    }

                    Button { showingScanner = true } label: {
                        Label("Scan pairing code", systemImage: "qrcode.viewfinder")
                    }
                    .buttonStyle(StrataPrimaryButtonStyle())
                    .accessibilityIdentifier("scanPairingCodeButton")

                    HStack(spacing: 13) {
                        Rectangle().fill(StrataTheme.line).frame(height: 1)
                        Text("OR").font(.system(.caption2, weight: .bold)).foregroundStyle(StrataTheme.secondaryInk)
                        Rectangle().fill(StrataTheme.line).frame(height: 1)
                    }
                    .padding(.vertical, 2)

                    VStack(alignment: .leading, spacing: 18) {
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) { showingManual.toggle() }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text("Enter details manually")
                                        .font(.system(.subheadline, weight: .semibold))
                                        .foregroundStyle(StrataTheme.ink)
                                    Text("Use the address and code on your Mac.")
                                        .font(.caption)
                                        .foregroundStyle(StrataTheme.secondaryInk)
                                }
                                Spacer()
                                Image(systemName: showingManual ? "chevron.up" : "chevron.down")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(StrataTheme.secondaryInk)
                            }
                        }
                        .accessibilityIdentifier("manualPairingButton")
                        if showingManual {
                            VStack(alignment: .leading, spacing: 17) {
                                field("MAC ADDRESS", hint: "https://192.168.1.10:9443", value: $address, field: .address)
                                    .keyboardType(.URL)
                                field("PAIRING CODE", hint: "6-digit code", value: $code, field: .code)
                                    .keyboardType(.numberPad)
                                field("CERTIFICATE FINGERPRINT", hint: "Paste the fingerprint from your Mac", value: $fingerprint, field: .fingerprint)
                                    .keyboardType(.asciiCapable)
                                Text("The fingerprint confirms you’re connecting to your Mac. Scanning the QR code fills all three fields for you.")
                                    .font(.caption)
                                    .foregroundStyle(StrataTheme.secondaryInk)
                                    .lineSpacing(3)
                                Button(action: connect) {
                                    HStack(spacing: 10) {
                                        if store.isLoading { ProgressView().tint(StrataTheme.accentInk) }
                                        Text(store.isLoading ? "Pairing with your Mac…" : "Pair with Mac")
                                    }
                                }
                                .buttonStyle(StrataPrimaryButtonStyle())
                                .disabled(!canPair || store.isLoading)
                                .opacity(canPair && !store.isLoading ? 1 : 0.5)
                                .accessibilityIdentifier("confirmPairingButton")
                            }
                        }
                    }
                    .strataCard()

                    if let error = scanError ?? store.error {
                        Label(error, systemImage: "exclamationmark.circle")
                            .font(.subheadline)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("pairingError")
                    }
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "lock.shield").foregroundStyle(StrataTheme.accentText)
                        Text("Your pairing key is stored securely on this iPhone. You can disconnect at any time.")
                            .font(.caption)
                            .foregroundStyle(StrataTheme.secondaryInk)
                            .lineSpacing(3)
                    }
                    .padding(.horizontal, 2)
                }
                .padding(.horizontal, 20)
                .padding(.top, 20)
                .padding(.bottom, 30)
            }
            .background(StrataTheme.background)
            .navigationTitle("Pair your Mac")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        store.pendingInvitation = nil
                        dismiss()
                    }
                    .accessibilityIdentifier("dismissPairingButton")
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focusedField = nil }
                        .accessibilityIdentifier("dismissPairingKeyboardButton")
                }
            }
            .sheet(isPresented: $showingScanner) {
                NavigationStack {
                    QRScannerView { payload in
                        showingScanner = false
                        receive(payload)
                    }
                    .navigationTitle("Scan pairing code")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Done") { showingScanner = false }
                        }
                    }
                }
            }
            .onChange(of: store.connection) { _, connection in
                if connection != nil {
                    store.pendingInvitation = nil
                    dismiss()
                }
            }
            .onAppear {
                if let invitation = store.pendingInvitation {
                    apply(invitation)
                }
            }
        }
        .tint(StrataTheme.accentText)
        .interactiveDismissDisabled(store.isLoading)
    }

    private var canPair: Bool {
        !address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !fingerprint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func field(_ title: String, hint: String, value: Binding<String>, field: PairingField) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(.caption2, weight: .bold))
                .tracking(1.3)
                .foregroundStyle(StrataTheme.secondaryInk)
            TextField(hint, text: value)
                .font(.subheadline.monospaced())
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focusedField, equals: field)
                .padding(14)
                .foregroundStyle(StrataTheme.ink)
                .background(StrataTheme.surfaceSecondary, in: RoundedRectangle(cornerRadius: 12))
                .accessibilityIdentifier(field == .address ? "pairingAddressInput" : field == .code ? "pairingCodeInput" : "pairingFingerprintInput")
        }
    }

    private func receive(_ payload: String) {
        do {
            apply(try PairingInvitation.parse(payload))
        } catch {
            scanError = "That code isn’t a Strata pairing invitation. Choose Pair iPhone in Strata on your Mac and scan its code."
        }
    }

    private func apply(_ invitation: PairingInvitation) {
        address = invitation.url
        code = invitation.code
        fingerprint = invitation.fingerprint
        scanError = nil
        showingManual = true
    }

    private func connect() {
        focusedField = nil
        scanError = nil
        store.error = nil
        Task {
            await store.pair(url: address.trimmingCharacters(in: .whitespacesAndNewlines),
                             code: code.trimmingCharacters(in: .whitespacesAndNewlines),
                             fingerprint: fingerprint.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }
}
