# Strata for iPhone

A native SwiftUI companion for the Strata desktop app. It uses Strata's emerald, white and charcoal palette in light and dark mode. Requires iOS 17 or later.

## Connect

1. Keep Strata open on your Mac.
2. Open **Strata Companion** on the Mac. The app lives in `apps/companion-mac` and runs the opt-in pairing bridge.
3. Open **Strata** on iPhone, choose **Pair your Mac**, and scan the Mac's QR code. Check the address and choose **Pair with Mac**.
4. Allow local network access. Keep both devices on the same trusted network.

Each invitation expires after five minutes and works once. Use **New invitation** on the Mac for another device. The camera is optional: enter the HTTPS address, six-digit code, and certificate fingerprint manually instead.

## What it controls

- Live connection and model status from the Mac.
- The Mac's configured API models, with credentials kept on the Mac.
- Loading and unloading models that are already installed locally. Download models in the desktop app first.
- Streaming chat, stopping a reply, new conversations, and phone conversation history.

Requests go through the Mac. A configured API provider may run remotely. Phone conversations are kept separately from desktop conversations, whose history is currently stored by the desktop web view. The phone chat does not enable desktop agent tools or filesystem access.

**Connection → Disconnect Mac** revokes the phone's access and removes its local credential. **Forget this Mac** is available when the Mac is unreachable; it removes the credential only from the phone. Remove that device in the Mac pairing window to revoke its old session. **Pair again** also recovers a changed certificate or address.

## Build

Install Xcode and XcodeGen, then:

```sh
cd apps/ios
xcodegen generate
open StrataMobile.xcodeproj
```

Select the `StrataMobile` scheme and an iPhone simulator or your device. Set your own development team under Signing & Capabilities when building outside this fork's configured team. Device installation requires a valid development profile containing the phone's UDID and `com.strata.companion.ios` app identifier. No paid dependencies or third-party Swift packages are used.

For a connected, unlocked iPhone, `./install-iphone.sh <device-identifier>` builds, installs, and launches the app. Set `STRATA_PROVISIONING_PROFILE` to an existing dedicated profile name when Xcode has no account signed in, and `STRATA_DEVELOPMENT_TEAM` to override the team. Set `STRATA_LAUNCH_AFTER_INSTALL=0` to install while the phone remains locked.

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

The optional live TLS and pairing/chat tests require `STRATA_TEST_INVITATION` in the test runner environment. They use the real bridge and real selected model. The live UI test consumes the one-use invitation and leaves its simulator paired. Keep those result bundles private because XCTest records entered pairing fields.

## Connection security

The QR invitation includes the SHA-256 fingerprint of the Mac's TLS certificate. The app checks that exact certificate before transmitting the pairing code or token, and refuses redirects. The phone saves its connection in the device-only Keychain. The bridge stores token hashes, checks every request, limits pairing guesses, and supports immediate revocation. The control routes are deliberately narrow; the desktop's whole API is never exposed to the phone.
