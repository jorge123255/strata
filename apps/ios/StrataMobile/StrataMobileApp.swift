import SwiftUI

@main
struct StrataMobileApp: App {
    @UIApplicationDelegateAdaptor(StrataNotificationDelegate.self) private var notificationDelegate
    @StateObject private var store = CompanionStore()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            ContentView(store: store)
                .onAppear {
                    StrataNotificationDelegate.owner = store.notifications
                    if let pending = StrataNotificationDelegate.pendingTap { StrataNotificationDelegate.pendingTap = nil; store.notifications.receiveTap(pending) }
                }
                .onChange(of: scenePhase, initial: true) { _, phase in
                    store.notifications.active = phase == .active
                    if phase == .active { store.notifications.resume() }
                }
                .task(id: scenePhase) {
                    guard scenePhase == .active else { return }
                    await store.notifications.updateAuthorization()
                    var tick = 0
                    while !Task.isCancelled {
                        await store.refreshLiveState(refreshOverview: tick % 5 == 0)
                        if tick % 2 == 0 { await store.notifications.refresh() }
                        tick += 1
                        do { try await Task.sleep(for: .seconds(1)) }
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
