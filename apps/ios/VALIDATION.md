# Actual Cua Bots interface and isolated computers — October 20, 2026

Build 8 reuses the actual Cua Bots SwiftUI koala renderer, AvatarBadge and AvatarPicker, and adapts its native phone list/profile layout to the existing Strata companion store. The three renderer files exactly match pinned upstream `ef61a985d58958c6b9bc392f0ea0da785aa36ce9`; the FSL-1.1-MIT license, notices and provenance are included. Color, eyes and ears save through one narrow avatar-only route; older conversations keep their frozen face, provider, model and target.

CUA computer viewing starts read-only and refreshes bounded PNG snapshots while visible. Start, takeover, typed/click/key input, release and shutdown require explicit user actions. Takeover confirms that all bot work using that isolated target stops first. Bridge and host bind ephemeral control tokens to the paired device and exact bot/chat; navigation, backgrounding, unpairing or bridge disable releases grants, including late grants arriving after removal. An unconfirmed cleanup state keeps explicit Stop computer remediation visible. CUA new chats use the actual `/workspace` folder with no arbitrary override. Current catalog Paused state is shown and blocks known paused sends/creation; the host authoritatively rejects stale sends before adding history. Maya and other serving selections stay separate.

- All **50 bridge tests passed**. New checks cover exact routes/methods/query/headers and input bounds, PNG dimension validation, projection of display-only fields, per-device/bot/chat ownership, revocation during takeover, lease renewal/expiry, release on unpair/disable, no automatic VM/model start from reads, actual sample enum-only avatar saves, fixed CUA workspace and public pause state.
- The final **58 Swift tests ran: 57 passed and one optional live TLS test skipped**, with zero failures. Computer cases cover aspect-fit pixel mapping and margins, read-only opening, input only after a valid lease, 4,000-character limits matching the host, late-grant release after navigation, pairing-generation isolation, expired grants, frozen avatar/mode decoding, stopped/cleanup state, cleared cached images after forgetting the Mac, narrow appearance saves, fixed CUA workspace and paused work admission.
- The actual native CUA workflow passed in **83.0 seconds**, one test with zero failures or skips. Through the real pinned-TLS bridge and an explicitly synthetic host it edited/saved the actual sample koala, verified the disabled `/workspace` field, viewed without starting work, explicitly started, confirmed takeover, clicked within one screenshot pixel of the target, typed, sent Enter, released, released again on navigation/background, and explicitly stopped the computer. No model prompt, real VM, SSH connection or provider was used. The final typed-input limit was subsequently aligned with the host and verified by both unit suites.
- The shared-history/model regression passed in **103.7 seconds**, one test with zero failures or skips. It opened recorded Thinking and history without a prompt, selected a saved remote computer/configured model/full folder, created one shared conversation, continued/stopped it and restored history after relaunch using actual List scrolling. The fixture uses a host-mode bot for arbitrary workspace selection and a separate CUA-mode scenario for the fixed sandbox workspace.
- Passed native screenshots were exported and visually inspected for the actual picker and read-only/control/stop layouts. Initial test-only failures were corrected: a Retina-scaled generated fixture image did not match its metadata, the synthesized center tap rounded down one image pixel, and the native List needed scrolling before expecting an offscreen lazily materialized history row.
- A **clean signed build 8 is prepared**, using the existing Strata Companion iPhone Development profile and Apple Development identity. All 11 separate artifact checks passed: exact bundle/build/version, profile identity and actual-phone eligibility, app/team entitlements, signing certificate membership, expiry and strict recursive signing. It has **not been installed or launched by this preparation step**; integration owns activation. The earlier prepared build 7 is superseded, while the previously installed build 6 remains separate.

Private acceptance bundles under ignored `build-bots-remote-20261020/Logs/Test`: final units `Test-StrataMobile-2026.10.20_14-39-26--0500.xcresult`, computer UI `Test-StrataMobile-2026.10.20_14-36-36--0500.xcresult`, shared history/model UI `Test-StrataMobile-2026.10.20_14-32-24--0500.xcresult`. Build/signature proof is outside source in `bots-integration/iphone-build8-verification.json`, with the app under `bots-cua-device-build/Build/Products/Debug-iphoneos`. No physical-phone launch, production pairing change or real provider prompt was made. These synthetic UI results do not establish live CUA/SSH/provider or physical-phone acceptance.

---

# Bots computer/model selection and avatars — October 20, 2026

Build 7 adds native curated avatars and a new-conversation sheet for a saved computer, configured model and target workspace. The bridge accepts only known available catalog IDs and an absolute folder path; SSH connection settings and raw model-source credentials remain on the Mac. Existing conversations retain their frozen identity, computer, model and permissions. Selecting a configured model does not change serving or another chat's Maya connection.

- All 41 bridge tests passed. Four additional tests cover curated avatar fallback, configured-model and computer display projections without connection IDs or SSH details, exact target/model/workspace forwarding after a fresh catalog lookup, unavailable/removed selections, older-host rejection of overrides, and pairing revocation during catalog lookup.
- The Swift unit suite passed 49 tests, with one optional live TLS test skipped and zero failures. Three additional cases verify configured-model/target selection with no load/unload/preparation requests, frozen chat labels, rejected missing/unavailable/removed choices, full-path validation, older-host behavior and safe avatar fallback.
- The expanded real native UI workflow passed in 94.8 seconds, one test with zero failures or skips. Through the actual pinned-TLS bridge and a synthetic host it opened bot history and Thinking without sending a prompt, chose a saved remote computer, configured model and workspace, created a new conversation using only those selections, continued and stopped the exact conversation, and restored its context/history after relaunch. The first runner attempt was rejected by the scratch simulator's SpringBoard before any test started; booting that dedicated simulator resolved it.
- Five passed screenshots were exported. Avatar details, target/model/folder selection, and restored conversation context were visually inspected. Chat copy was then made target-neutral for remote work; the clean signed Build 7 compiles that final source. No execution, history or selection logic changed after the accepted UI workflow.
- A clean physical-device build uses the existing **Strata Companion iPhone Development** profile and Apple Development identity. The prepared artifact is verified separately for strict recursive signing, exact bundle/build, profile eligibility for the existing phone, app/team entitlements, certificate membership and expiration. Preparation does not install or launch it; activation is coordinated by the integration task.

Private acceptance bundles: unit `Test-StrataMobile-2026.10.20_14-05-42--0500.xcresult`; native UI `Test-StrataMobile-2026.10.20_14-00-59--0500.xcresult`, under ignored `build-bots-remote-20261020/Logs/Test`. Screenshots and credentials remain outside source. Provider, model and remote-computer behavior in this UI fixture is synthetic: these checks do not prove live SSH, live provider authentication, on-phone UI acceptance or a production model turn. Existing paired simulator and physical-phone state were not changed by QA.

---

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
