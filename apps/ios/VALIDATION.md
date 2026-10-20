# Bots companion — October 20, 2026

The fifth native tab lists saved coding, computer-control and combined bots. Details show the saved provider, model, execution kind and permissions. Existing bot conversations open in the same Chat view; creating an empty bot conversation starts no model work. The paired phone cannot edit bot credentials or execution configuration. Existing model, Maya, pairing and shared-chat paths are retained.

- Simulator build-for-testing passed on iPhone 17 Pro, iOS 26.5.
- The full Swift unit suite passed: 46 tests, one optional live TLS test skipped, zero failures. Seven new tests verify all five provider entries, empty saved-settings bot conversation creation, retained shared Thinking, delayed creation versus chat selection, delayed catalog versus forgotten pairing, older-host fallback, readable offline catalog, and legacy summary identity fallback.
- All 37 companion bridge tests passed. Six new tests cover explicit bot route/method allowlisting, no-launch catalog reads, removal of credentials and SSH details, retained shared history/Thinking, older hosts, safe provider failures, in-flight read revocation, and revocation during creation-body receipt.
- The full native Bots UI workflow passed on final phone source in 77.7 seconds, one test with zero failures or skips. It exercised real pinned-TLS pairing to an isolated synthetic host, card/detail navigation, provider/computer/permission descriptions, existing shared history and expanded Thinking, no prompt while viewing, empty saved-bot creation, continuation, exact-chat Stop and restored bot history after relaunch.
- Four passing screenshots were exported and visually inspected. This caught and fixed a preexisting selectable Thinking layout issue: expanded text now grows vertically and shows both full lines rather than a truncated single line.
- The UI workflow used a dedicated disposable simulator named **Strata Bots QA 20261020**. It did not alter the existing paired simulator, physical iPhone, production Strata host, provider accounts, models or Maya connections. All provider and computer results were synthetic; this is phone/bridge acceptance, not live provider or desktop execution proof.

Private result bundles remain in the ignored Bots derived-data directory: final unit `Test-StrataMobile-2026.10.20_13-21-06--0500.xcresult`; final UI `Test-StrataMobile-2026.10.20_13-16-46--0500.xcresult`. The fixture removed its temporary identity and listeners afterward. No app was installed on or launched on the physical iPhone for these checks.

---

# Thinking and ordered progress — October 19, 2026

Build 4 adds the Mac's expandable Thinking text, a live latest-line preview, recorded Thinking durations, and ordered progress summaries between reply paragraphs. Explicitly grouped actions appear under their own summary; unassigned actions and approvals remain visible once. Older Mac snapshots retain the existing reply/activity view. The accepted native scrolling implementation from Build 3 is unchanged.

- Simulator compilation passed on Xcode 26.6 for iPhone 17 Pro, iOS 26.5, with no compiler warnings or errors.
- The full unit suite passed 25 tests and skipped the optional live TLS test without an invitation. A subsequent targeted run passed all nine Thinking/timeline tests, including an additional edit-counter regression: 26 unique unit tests passed across these runs. They cover ordered text/group rendering without aggregate-answer duplication, exact helper action membership and deduplication, unassigned pending/running/denied actions, malformed/unknown block fallback, legacy snapshots, Thinking duration/live-stop semantics, and Thinking/progress updates without changed answer text.
- The complete real pinned-TLS fixture UI flow passed on the final Build 4 source in 82.5 seconds (one test, zero failures or skips). It opened and read expanded Thinking, checked recorded **Thought for 2s**, live Thinking preview, transition back to recorded Thinking while tools continued, exact narrative/progress order, historical versus live indicators, a grouped browser action appearing once, expandable results, Allow/Deny, native history scrolling and **Latest**, same-conversation continuation, Stop, and saved history/Thinking/progress after relaunch.
- Fixture history, Thinking, progress, browser activity, and approvals are synthetic. The fixture uses the actual TLS/authentication bridge but starts no model, browser, or Mac agent. The user's active Mac work was untouched. No new real Mac pairing or model request was made for this update.
- Integration confirmed development-signed Build 4 installed on the physical iPhone without launching it. Existing phone pairing is preserved. The updated Mac protocol still requires the integration task's Mac activation once current work is idle.

Final result bundles are kept privately outside source: full unit suite `test_sim_2026-10-20T03-41-16-104Z_pid58913_ce555c42.xcresult`; final nine Thinking tests `test_sim_2026-10-20T03-42-15-492Z_pid58913_fa08693c.xcresult`; full UI flow `test_sim_2026-10-20T03-42-54-005Z_pid58913_1fce72de.xcresult`. Five passed screenshots and their export manifest are under the private evidence directory `shared-chats/thinking-ui-passed/`. Production and test source are frozen at that accepted UI run. The owned fixture listener and private invitation/control metadata were removed afterward; the simulator's saved fixture pairing is consequently offline. Physical pairing was not modified.

---

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
