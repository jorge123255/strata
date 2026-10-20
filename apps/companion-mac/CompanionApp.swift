import AppKit
import SwiftUI
import WebKit

@MainActor
final class BridgeProcess: ObservableObject {
    @Published var adminURL: URL?
    @Published var failure: String?
    private var process: Process?
    private var output = Data()
    private var closing = false

    init() { start() }

    func start() {
        guard process == nil else { return }
        failure = nil; closing = false; output.removeAll()
        let resources = Bundle.main.resourceURL!
        let child = Process()
        child.executableURL = resources.appendingPathComponent("node")
        child.arguments = [resources.appendingPathComponent("bridge/index.mjs").path]
        child.currentDirectoryURL = resources.appendingPathComponent("bridge")
        let pipe = Pipe(); child.standardOutput = pipe
        let errors = Pipe(); child.standardError = errors
        // Keep all diagnostics local; never echo pairing invitations or credentials.
        errors.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { @MainActor [weak self] in self?.receive(data) }
        }
        child.terminationHandler = { [weak self] process in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.process = nil
                if !self.closing { self.adminURL = nil; self.failure = "The pairing service stopped (\(process.terminationStatus)). Make sure another copy of Strata Companion is not already running, then try again." }
            }
        }
        do { try child.run(); process = child }
        catch { failure = "Could not start Strata Companion: \(error.localizedDescription)" }
    }

    private func receive(_ data: Data) {
        output.append(data)
        while let lineEnd = output.firstIndex(of: 10) {
            let line = output[..<lineEnd]; output.removeSubrange(...lineEnd)
            guard let info = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                  info["type"] as? String == "ready", let address = info["adminURL"] as? String,
                  let url = URL(string: address), url.scheme == "http", url.host == "127.0.0.1" else { continue }
            adminURL = url
        }
    }

    func stop() { closing = true; process?.terminate() }
}

final class CompanionDelegate: NSObject, NSApplicationDelegate {
    var onQuit: (() -> Void)?
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) { onQuit?() }
}

struct PairingWebView: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.load(URLRequest(url: url)); return view
    }
    func updateNSView(_ view: WKWebView, context: Context) {
        if view.url != url { view.load(URLRequest(url: url)) }
    }
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    final class Coordinator: NSObject, WKNavigationDelegate {
        let url: URL
        init(url: URL) { self.url = url }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let target = navigationAction.request.url, target.scheme == url.scheme, target.host == url.host, target.port == url.port,
                  target.path == url.path else { decisionHandler(.cancel); return }
            decisionHandler(.allow)
        }
    }
}

@main
struct StrataCompanionApp: App {
    @NSApplicationDelegateAdaptor(CompanionDelegate.self) var delegate
    @StateObject private var bridge = BridgeProcess()
    @Environment(\.openWindow) private var openWindow
    var body: some Scene {
        Window("Strata Companion", id: "pairing") {
            Group {
                if let url = bridge.adminURL { PairingWebView(url: url) }
                else if let failure = bridge.failure {
                    VStack(spacing: 18) {
                        Image(systemName: "iphone.and.arrow.right.inward").font(.system(size: 44)).foregroundStyle(.green)
                        Text("Let’s reconnect").font(.title.bold())
                        Text(failure).multilineTextAlignment(.center).foregroundStyle(.secondary).frame(maxWidth: 420)
                        Button("Try again") { bridge.start() }.buttonStyle(.borderedProminent).tint(.green)
                    }.padding(40)
                } else {
                    VStack(spacing: 18) { ProgressView(); Text("Preparing your secure pairing…").font(.headline); Text("Open Strata on this Mac to connect your iPhone.").foregroundStyle(.secondary) }.padding(40)
                }
            }
            .frame(minWidth: 620, minHeight: 710)
            .onAppear { delegate.onQuit = { bridge.stop() } }
        }
        .defaultSize(width: 680, height: 800)
        .windowResizability(.contentMinSize)
        MenuBarExtra("Strata Companion", systemImage: "iphone.and.arrow.right.inward") {
            Button("Pair iPhone…") { openWindow(id: "pairing"); NSApp.activate(ignoringOtherApps: true) }
            Divider()
            Button("Quit Strata Companion") { bridge.stop(); NSApp.terminate(nil) }.keyboardShortcut("q")
        }
    }
}
