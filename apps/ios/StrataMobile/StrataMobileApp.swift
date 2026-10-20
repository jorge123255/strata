import SwiftUI

@main
struct StrataMobileApp: App {
    @StateObject private var store = CompanionStore()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            ContentView(store: store)
                .task(id: scenePhase) {
                    guard scenePhase == .active else { return }
                    while !Task.isCancelled {
                        await store.refresh(silently: true)
                        do { try await Task.sleep(for: .seconds(5)) }
                        catch { return }
                    }
                }
                .onOpenURL { url in
                    do { store.pendingInvitation = try PairingInvitation.parse(url.absoluteString) }
                    catch { store.error = error.localizedDescription }
                }
        }
    }
}
