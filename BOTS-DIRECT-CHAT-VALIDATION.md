# Direct bot conversation validation

## Behavior and accepted source

Bot roster taps previously opened a profile on iPhone, leaving conversation creation behind additional controls. Both devices now open the latest personal bot conversation, or create exactly one empty conversation from saved defaults. Team, worker and child conversation ancestry is excluded from this shortcut. Complete history remains available through explicit history and team links.

Profile/settings remain separate actions. New conversation within a bot chat retains the bot identity. Opening a chat starts no provider turn, tool or computer. Duplicate taps coalesce, stale navigation and pairing responses cannot replace the current selection, and errors remain actionable. Paused bots retain readable personal history.

- Mac source: `f8452099e9b4bc44c111e4b6607572dccb4680d1`.
- iPhone source: `ef54683ba9073f2e430a7cce179fa2318debf811`, version 0.1.0 (18).
- No backend, native shell, model connection, Maya service, remote worker or credential change.

## Isolated checks

Mac typecheck and production build passed. The initial focused UI/helper regression set passed 18 checks; the final response-validation and persistent-error delta passed three focused checks. Existing host/bridge bot baselines passed 43 checks. Independent source review found zero P1 and zero P2 findings.

The complete compiled production App passed 12 checks against disposable actual HTTP conversation and bot stores. It resumed exact personal history despite a newer team transcript, created one empty saved-default chat, reused it on return, and retained personal/team messages and bot profiles. The provider runtime was inert and never executed. No external requests, permission requests, native notification delivery or browser errors occurred. The accepted 67 compiled assets match the packaged assets exactly.

Full Swift suite: 136 passed, zero failed, one existing optional live TLS test skipped. Coverage includes first-chat defaults, latest-personal selection, all team ancestry markers, duplicate taps, ownership/response validation, pairing/selection races, paused history and retry errors.

The native iPhone workflow passed one test with eight durable checks against a pinned TLS fixture. It exercised roster-to-chat navigation, empty first chat, profile history return, profile-to-New-to-Create-to-composer, bot-specific New cancellation, fixture-only send/Stop, relaunch and accessibility XXXL. Captures were inspected. Complete product inputs and compiled unit app were unchanged. Original unit custody is retained separately from subsequent UI-test-only locator edits. Raw results, before/after receipts and committed source pins were independently checked; final review found zero P1 and zero P2 findings.

No owner model prompt, live provider turn, remote task or computer-control action was used for acceptance. One native test attempt failed a viewport helper before a visible Create button; the failed evidence was retained and the locator alone corrected before the passing run.

## Mac packaging and activation

The signed carrier passed 37 packaging checks: exact source/bridge/Control payload and lifecycle archive, compiled assets, unchanged engine/Python donors, retained native compiler provenance and signing identity, and strict recursive signature verification. The accepted resource manifest contains 42,667 entries with SHA256 `a474d7392ca73c216f29436283b1965646f6c1fd2b3794cefdea705ee3eda8ac`.

Activation completed on 2026-10-21 after two successful complete idle observations separated by 19 seconds and an immediate prequit observation. Native Quit stopped only Strata. A unique verified backup retained the prior app and all non-CUA owner data and pairing before atomic replacement. The original live CUA process, runtime and disk identities remained in place. Its separate copied backup is best effort; coherent guest restore was not validated.

An initial activation attempt safely stopped before any app move because its executable-open check mistook read-only macOS TCC signature inspection for a running app. The corrected guard permits only exact read-only TCC file descriptors, rejects executable mappings and all other openers, and also checks the exact process image and host listener. Independent review passed; activation restarted with fresh preservation and idle observations. Failed receipts and the unused backup were retained.

Postlaunch verification passed at the original host origin. Every resource matches the accepted manifest and strict recursive signatures remain valid. All 26 conversations / 190 messages, bot profiles/files, team roster/coordinator/computer/folder and public journal, seven model connections, two paired devices, five durable pairing files and notification state are unchanged. No team migration was needed. The installed native Bots screen loaded the existing personal conversation and composer. Preservation was checked again after navigation; no chat was created or sent.

## iPhone artifact and installation

The signed build passed 19 author checks and 17 independent artifact checks. All 39 committed product inputs match the tested source, aggregate `f896b751a2ba9880d0d1e203efbd3a8803fcd3dc1b34d2cc235f66e7f5b1a9ba`. Retained development profile, signing leaf, entitlements, application identifier and Keychain groups match build 17. Executable SHA256: `caf5114966417b847710b6bbf5ab27c5c5b7140308f535fa2a01cd7e9b749e51`.

Fresh offline gates and actual unit/native custody were rechecked before contacting the same existing iPhone. Installation and post-install version checks passed: 0.1.0 (18). The exact artifact remained unchanged. Build 17 remains available for recovery. There was no uninstall, launch, physical UI automation, Keychain reset, re-pairing, account/provisioning change or model prompt. Physical UI acceptance remains with the owner; interaction was verified in the isolated simulator.

## Private evidence

Mac: `bots-direct-chat-20261021` contains source/review manifests, `actual-app/report.json`, packaging gates, fresh idle observations, activation/backup receipt, postlaunch resource/signature and preservation checks, and installed native UI observations.

iPhone: `bots-direct-chat-ios-20261021` contains original unit and final native source manifests, raw result bundles and custody receipts, inspected captures, committed source pins, independent reviews, signed artifact gates and the build 18 installation summary. Owner conversations, pairing records, device identifiers and credentials are not published.
