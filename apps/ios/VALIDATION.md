# Shared Mac conversations — October 19, 2026

Build 3 adds shared Mac conversation history, same-session continuation, foreground activity polling, readable browser/tool cards, explicit pending approvals, and Stop. Existing pairings use the same Keychain credential. Earlier iPhone-only chats remain a separate section.

- Simulator compilation passed on Xcode 26.6 for iPhone 17 Pro, iOS 26.5.
- Sixteen unit tests passed; the optional live TLS test was skipped without an invitation. Seven new shared-conversation tests verify same-ID continuation with no permission override, Mac-started browser updates without a phone message, new shared conversation creation, delayed snapshot isolation after changing views, opaque helper approval IDs and exact-conversation Stop, prevention of a second message while the Mac is working, and zero view-state publications for unchanged live snapshots.
- The complete actual-UI flow passed in 75.5 seconds on the final source: real pinned-TLS pairing to an isolated bridge, existing Mac history, a Mac-started browser card with expandable results, Allow and Deny of exact helper action IDs, native scrolling to older history, **Latest** returning to current work, continuing the same conversation ID, Stop, and saved pairing/history after app relaunch. The history, model, browser actions, and approvals in this fixture are explicitly synthetic; it starts no model, browser, or Mac agent.
- A separate UI test against the actual running Mac passed in 69.3 seconds: a fresh real pairing, reading existing Mac message history, app relaunch, and restored pairing/history. It sent no model message, approval decision, or Stop action. The user's active Mac task continued during the check. A new live model-marker test was intentionally held while that task was active.
- Earlier UI attempts exposed a real scrolling failure. The final implementation uses native scroll anchors for content-size changes, a regular conversation stack with deterministic row heights, and nonanimated jumps for explicit navigation. It has no geometry preference feedback or custom pan handlers. The final full UI test exercises the scroll and Latest paths that previously stalled.
- Automatic following pauses while reading older history on iOS 18 or later. iOS 17 keeps native scrolling and an explicit **Latest** action without live automatic scrolling. Unchanged live snapshots do not publish new conversation view state; that regression test passed.

Final UI result bundles: synthetic full flow `test_sim_2026-10-20T02-50-56-789Z_pid58913_9fd09104.xcresult`; real Mac read-only history `test_sim_2026-10-20T02-54-18-865Z_pid58913_d2072aaf.xcresult`. Both are kept outside tracked source with private screenshots. The standalone fixture listener and its invitation/control metadata are removed after validation.

The historical validation below describes the earlier text-only companion. Physical installation, current Mac packaging, and any subsequent live checks are recorded by the integration task separately.

---

# Initial companion validation — October 19, 2026

Source base: upstream and fork `main` at `e88ee39d1d6be6e3364183af3b39b62a7ed6f211`. Companion changes are opt-in and live in separate app folders; the existing desktop host and engine are not modified.

## Passed

- Native iOS build and launch on iPhone 17 Pro simulator, iOS 26.5, Xcode 26.6.
- Nine iOS unit tests: invitation validation, exact certificate digest, bounded request construction, and four delayed-response state-race regressions. Race fixtures use isolated URLProtocol responses and never use the saved pairing Keychain.
- Four UI flows through the actual app: unpaired navigation and manual pairing rejection of insecure addresses, invalid fingerprints, and invalid codes.
- Live TLS test against the Mac companion: the invited certificate reaches the authenticated endpoint; a different fingerprint fails before an HTTP response.
- Live UI flow: actual Mac pairing, configured API model library, streamed `STRATA_PHONE_OK` model reply, app relaunch, saved Keychain pairing, and conversation history restoration.
- Native Mac companion build and launch, local Core Image QR generation, secure listener, existing Strata host discovery, and normal Quit stopping its child bridge.
- Development-signed iPhone build and installation on the connected iPhone 15 Pro. Installed bundle `com.strata.companion.ios`, version 0.1.0 (1), verified through CoreDevice. A separate development profile was created for Strata using the already registered phone and existing signing certificate.

All fourteen bridge Node tests passed. They cover pairing, TLS identity stability, token hashing/revocation, admin restrictions, narrow controls, secret filtering, streaming/truncation, concurrent turns, selected native-instance consistency, and revocation while a model action awaits a snapshot. These use temporary identities and a mock desktop host. See `apps/companion-bridge/test/bridge.test.mjs`.

## Limits

The iPhone was locked when a remote launch was attempted, so this record confirms physical installation, not an accepted physical pairing/camera flow. Unlock the phone, open Strata, and scan the Mac companion QR code to complete that check.

The Mac has configured API models but no downloaded local native model. The real chat test used a configured API model through the Mac. Native load/unload and multiple-instance routing were verified with fixtures; native inference was not exercised. Desktop conversation synchronization and desktop agent tools are outside this companion's scope. No model download or live engine restart was performed.

Result bundles, screenshots, signing materials, device data, and live invitations are kept outside tracked source files.
