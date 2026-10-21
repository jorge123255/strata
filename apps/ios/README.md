# Strata for iPhone

A native SwiftUI companion for the Strata desktop app. It uses Strata's emerald, white and charcoal palette in light and dark mode. Requires iOS 17 or later.

## Connect

1. Keep Strata open on your Mac.
2. In the Mac Strata app, choose **Pair iPhone** in the sidebar, or **Settings → iPhone**, then choose **Enable iPhone pairing**.
3. Open **Strata** on iPhone, choose **Pair your Mac**, and scan the Mac's QR code. Check the address and choose **Pair with Mac**.
4. Allow local network access. Keep both devices on the same trusted network.

Each invitation expires after five minutes and works once. Use **New pairing code** on the Mac for another device. The camera is optional: enter the HTTPS address, six-digit code, and certificate fingerprint manually instead. Strata remembers that pairing is enabled and restores the listener on its next launch. **Disable pairing** closes the listener while preserving paired phones for later.

## What it controls

- Live connection and model status from the Mac.
- The Mac's configured API models, with credentials kept on the Mac.
- Loading and unloading models that are already installed locally.
- Downloading catalog models on the paired Mac or a supported Strata connection, after reviewing size, storage, picture reading, and required engine steps.
- The Mac's existing conversations, their saved message history, and current work.
- Saved coding and computer-control bots, their provider and computer details, and bot-specific conversation history.
- Continuing the same conversation and workspace from either device.
- The Mac's Thinking text in an expandable panel, with a live preview and recorded duration when available.
- Progress summaries between reply paragraphs, in the same order as the Mac.
- Live browser and tool activity, including the action, its target, status, and expandable results.
- Allowing or denying an action when the Mac asks for approval, and stopping the selected conversation.

Open **Chat → Conversation history** to choose a Mac conversation. Home also shows recent conversations. The active or most recent conversation opens automatically after connecting. New conversations started on the phone also appear on the Mac. Existing conversations keep their model and permission mode; new conversations start in the Mac's default workspace and ask before actions. Pairing already grants this access, so a paired phone does not need a new invitation after updating both apps.

Tap **Thinking** or **Thought for…** above a reply to read the Thinking text shared by the Mac. The live preview follows the Mac's current Thinking; it changes to a recorded panel once the answer begins. Progress such as **Ran 3 commands** stays between the relevant reply paragraphs. Expand a progress row when the Mac identifies its actions; other action cards remain visible below the reply. Older Mac versions still show their saved replies and activity cards.

While Chat is open in the foreground, its history and activity refresh about once per second. Other status and conversation lists refresh about every five seconds. On iOS 18 or later, scrolling back through history pauses automatic scrolling; choose **Latest** to follow new replies again. On iOS 17, use **Latest** to jump to current work; live updates leave the scroll position alone. Leaving Chat or putting the phone away does not stop the Mac's agent. Browser activity describes what the Mac is doing; it does not stream the Mac's screen. **Open page on iPhone** opens a reported web address locally.

Requests go through the Mac. A configured API provider may run remotely. Earlier phone-only chats remain available under **Earlier iPhone conversations**; continuing one uses its original text-only chat path.

## Work with a bot

Open **Bots**, choose a bot configured on the Mac, then open one of its conversations or choose **New conversation**. In the new-conversation sheet, retain the bot defaults or choose a saved ready computer, a model from your configured connections, and the folder on that computer. Remote computers must first be set up on the Mac. Creating the conversation freezes these choices; a message starts the work. Existing conversations keep their original settings. Opening a bot does not start a task. Its conversation opens in the existing Chat screen, with shared history, available Thinking, action approvals and Stop. Existing bot history remains readable when a provider needs attention.

Bot avatars use a small native emoji set shared with the Mac. A conversation keeps its original avatar, computer and model labels after the bot profile changes. Selecting a configured model applies only to that new conversation and does not switch serving or another chat's Maya connection. An older Mac keeps the saved-default flow and explains when selection needs an update.

Create bots, sign in to providers, and configure computer access in the Mac app. Provider credentials and SSH connection details stay on the Mac. Bot providers and execution computers are separate from the existing model library and Maya connections. Older Mac builds show an update message without affecting existing chats or model controls.

## Connect services to bots and teams

Open **Bots → workspace menu → Connectors**, or open **Connectors** from a bot profile or **Team connectors** in team details. Choose a service from the catalog or add a **Custom HTTP connector**. Name the account, enter its server URL and choose authentication. HTTP setup and bearer keys can be entered on iPhone; local programs and OAuth app registrations are configured on Mac. Credentials are saved privately on the Mac and are never returned to the phone.

For account sign-in, choose **Start account sign-in**, then finish in a browser on your Mac. The phone can share the sign-in link to your Mac and show current status. If the browser cannot return to Strata, paste the complete callback address into the connector’s sign-in screen. Each service may require its own account, token scopes or OAuth app setup.

Choose **Check & discover tools**, then explicitly select bot access, team access and tools before choosing **Save access**. Discovery grants no access. Team grants apply only during that team’s work and follow its current membership; members’ private chats use their separate bot grants. Connector instructions describe how to use that account. New conversations receive assigned tools, and removing access revokes it immediately. Tools retain the bot’s approval policy; read-only classification is reviewed on Mac.

You can edit HTTP setup, disable a connector while retaining its account, sign out an OAuth account, or remove the connector and its saved credentials. If another device changes the setup or access, Strata retains your draft and requires a fresh review before saving. Earlier Mac builds keep saved-connection checks and bot access available, with an update message for newer controls. Connectors do not change model serving, configured model accounts or Maya.

## Download a model

Open **Models → Downloads**, choose the destination computer, and choose **Review download**. The review names the computer and shows the expected download size, storage needed, free storage, picture reading choice, and any required engine changes. Starting may unload native models and prepare or update the engine; the review explains those steps. Choose **Download on…** only when you are ready. Downloading does not load the model automatically.

Progress shows the current stage and downloaded amount. Downloads continue on the selected computer when you leave the screen or put the phone away. While Models is open, active progress refreshes about once per second. Use **Stop download** for a download started by this phone; work started elsewhere can be watched here and managed from its original computer or device. **Review and retry** checks a fresh plan before starting again. An expired review or insufficient storage blocks the confirmation.

These files stay on the destination computer. API-only providers use their existing **Use model** action and do not offer model downloads. Older Mac builds keep their model library available and show an update message when phone downloads are unsupported. Configure Strata connections in the Mac app; provider credentials stay there.

For a Terminal server, edit its connection on the Mac and choose **Model management → Terminal server over SSH**. Host, optional username, port and source folder are configured separately for each server. The Mac uses its SSH keys and verified host key; these details are not sent to the iPhone. SSH downloads only model files into a separate server library. Preparation and loading remain separate Terminal actions, and the serving model keeps running. See [remote setup](../host/REMOTE-MODELS.md).

**Connection → Disconnect Mac** revokes the phone's access and removes its local credential. **Forget this Mac** is available when the Mac is unreachable; it removes the credential only from the phone. Remove that device in the Mac pairing window to revoke its old session. **Pair again** also recovers a changed certificate or address.

## Build

Install Xcode and XcodeGen, then:

```sh
cd apps/ios
xcodegen generate
open StrataMobile.xcodeproj
```

Select the `StrataMobile` scheme and an iPhone simulator or your device. Set your own development team under Signing & Capabilities when building outside this fork's configured team. Device installation requires a valid development profile containing the phone's UDID and `com.strata.companion.ios` app identifier. No paid dependencies or third-party Swift packages are used.

For a connected, unlocked iPhone, `./install-iphone.sh <device-identifier>` builds, installs, and launches the app. Set `STRATA_PROVISIONING_PROFILE` to an existing dedicated profile name when Xcode has no account signed in, and `STRATA_DEVELOPMENT_TEAM` to override the team. Set `STRATA_LAUNCH_AFTER_INSTALL=0` to install without opening the app.

## Verify

```sh
xcodebuild -project StrataMobile.xcodeproj -scheme StrataMobile \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:StrataMobileTests test
xcodebuild -project StrataMobile.xcodeproj -scheme StrataMobile \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:StrataMobileUITests/CompanionSmokeTests/testHomePairingAndUnpairedTabs \
  -only-testing:StrataMobileUITests/CompanionSmokeTests/testManualPairingRejectsInsecureAddress \
  -only-testing:StrataMobileUITests/CompanionSmokeTests/testManualPairingRejectsMalformedFingerprint \
  -only-testing:StrataMobileUITests/CompanionSmokeTests/testManualPairingRejectsInvalidCode test
```

The [synthetic companion fixture](test-support/README.md) runs shared-chat and model-download UI workflows through the real TLS bridge without starting an actual model, download, or desktop agent. Its download workflow covers plan confirmation, typed picture-reading requests, progress, Stop, fresh-plan retry, remote target selection, relaunch, and older-Mac fallback.

The optional real Mac read-only test takes `STRATA_READONLY_INVITATION`. It pairs, reads existing history, and verifies saved pairing after relaunch, without sending a model message or approving/stopping work. The isolated synthetic shared-conversation test takes `STRATA_TEST_INVITATION` and `STRATA_SHARED_FIXTURE_CONTROL`; the download test uses `STRATA_MODEL_MANAGEMENT_FIXTURE_CONTROL` instead. Its fixture data and loopback control endpoint are test-owned.

The optional live TLS and pairing/chat tests require `STRATA_TEST_INVITATION` in the test runner environment. They use the real bridge and real selected model. The live UI test consumes the one-use invitation and leaves its simulator paired. Keep those result bundles private because XCTest records entered pairing fields.

## Connection security

The QR invitation includes the SHA-256 fingerprint of the Mac's TLS certificate. The app checks that exact certificate before transmitting the pairing code or token, and refuses redirects. The phone saves its connection in the device-only Keychain. The bridge stores token hashes, checks every request, limits pairing guesses, and supports immediate revocation. The control routes are deliberately narrow; the desktop's whole API is never exposed to the phone.


The Bots tab reuses the actual Cua Bots sample's SwiftUI koala renderer, color/eyes/ears picker and native list/profile layout, adapted to the existing CompanionStore. The copied sources and provenance are in `StrataMobile/CuaBots`, including FSL-1.1-MIT attribution and license. Appearance saves change only the bot avatar; existing conversations display their frozen avatar configuration.

For a bot configured with a CUA isolated computer on Mac, **Computer view** opens read-only, refreshes PNG snapshots about once per second while visible, and starts no VM or model turn. **Start computer** is explicit and requires Mac preparation. New CUA conversations use `/workspace`; the folder override is disabled. Paused profiles are shown, and the Mac rejects new work until resumed. **Take over** asks for confirmation and stops all bot work using that target before granting temporary control. Taps map through aspect-fit margins to screenshot pixels; native text and keyboard buttons send input only with a valid device-bound lease. Backgrounding or leaving releases control, and release never resumes bot work. **Stop isolated computer** confirms shutdown with retained files. This is snapshot viewing, not decoded video. Host/computer setup and credentials remain on Mac.
