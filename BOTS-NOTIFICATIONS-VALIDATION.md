# Bot and team notifications

Date: 2026-10-21 UTC. Parent: `df9ee26e1eefc004c9c0e1b5e139f83ee97ee8b3`.
Mac/host implementation: `6b8031308eb4340d97ed52a00003675320ee4be2`.
iPhone implementation: `6c9a77bdf59247e5ba6be61013ce87a5ff4718f9`.

## Delivered behavior

- Opt-in native Mac notifications and a shared-source inbox for bot replies, public team messages, completed/failed work, and actual pending approvals.
- Independent preferences per Mac or paired iPhone: categories, sound, and conversation/team mutes. Scheduled completion alerts respect the routine's existing completion preference.
- Generic banners omit message contents, Thinking, tool arguments, paths and credentials. Clicking navigates to the exact conversation or team; it cannot approve an action or start work.
- Durable source identities, bounded pages, journal identity and preference generations prevent normal reconnect/restart replay, stale-feed resurrection and duplicate delivery. First enable starts at the current source position.
- The Mac host drives native delivery even when its renderer is absent. Native focus suppression checks the actual visible selected conversation and active macOS session.
- The same Strata executable owns macOS permission, delivery and cold-start click handling. A fixed **Send test notification** action verifies delivery without a model turn or new conversation.
- iOS includes a native inbox, permission/settings controls, local foreground alerts and optional APNs-enabled build configurations. See [setup instructions](apps/desktop/NOTIFICATIONS.md).

## Source and workflow verification

- Host final revision: 39 focused checks passed, 0 failures/skips. An earlier broader host regression passed 144 checks; the final focused run covers the subsequent generation, native-test and routine-classification changes.
- Independent root host review and independent Mac source review: 0 unresolved P1 / 0 P2. Mac source review pinned all 21 owned file hashes.
- Complete compiled Mac App acceptance: 14 checks passed using the actual HTTP host, durable conversation store and production renderer. An inert provider seam was never executed; the private native HTTP transport was a bounded fake. It verified explicit opt-in, generic inbox, exact navigation, delivery after the whole renderer closed, mute, disable/re-enable without replay, and no external browser requests/errors.
- The first full-App harness attempt blocked its own disposable native origin under the copied network guard. The guard was corrected to allow only that exact fixture origin; no product change was required. Both attempt receipts were retained privately.
- Native Rust suite: 25 passed. Its initial run exposed an existing test that hardcoded version 0.2.0 after the package became 0.2.1; that assertion now reads the actual package version.
- Mac typechecking, production renderer build, 17 notification UI/policy checks and the existing captured group-chat regression passed.
- Final Swift suite: 122 executed, 121 passed, one existing optional live-TLS skip, zero failures. Independent iPhone source review pinned all 18 changed files with 0 unresolved P1 / 0 P2. Review fixes covered replaced-journal inbox clearing, scoped Apple registration retries, shared local/APNs presentation deduplication, and authoritative post-settings cursor baselines.
- The final iPhone notification workflow passed in 127.974 seconds with eight passing postchecks. It used a disposable pinned-TLS host and the real durable notification service, showed a real local iOS system banner, opened exact chat/team destinations, saved mutes/sound, survived relaunch and disabled explicitly. Test source messages were inert; no owner bot/model/tool was invoked.
- The final iPhone Bots/shared-history workflow passed in 108.834 seconds with six passing postchecks, retaining history, Thinking, model/computer choices, continuation, Stop and relaunch. Both workflows match the complete 39-input signed product aggregate `48ed2690864f9e1e084d3a1b032d28df8696c774968288bb3c799c24352dc9f7`.
- Earlier UI harness attempts included offscreen controls, an unhittable TabBar frame during badge updates and competing simulator touch sessions. Receipts were retained; the final workflows ran sequentially with explicit visible/hittable controls. These failures are not counted as product passes.

## Apple push delivery boundary

The installed development profile at the beginning of this task had no `aps-environment` entitlement. Xcode had no signed-in developer account, and no usable local APNs provider configuration was found in the known project configuration locations. Only filenames and configuration metadata were inspected; private key contents were not read.

An unsigned PushDebug build verifies the code/configuration, not APNs registration or delivery. Closed/locked iPhone delivery requires an APNs-enabled signed profile, device token registration, notification permission and an authorized provider key on the paired running Mac. Synthetic APNs transport tests do not prove a real Apple delivery. Ordinary Debug builds continue to support foreground notifications with the retained signing profile.

No Maya service, API key, SSH setting or provider configuration was changed. No model prompt was sent in an owner conversation for notification testing.

## Activation evidence

The Mac update was activated from source `6b8031308eb4340d97ed52a00003675320ee4be2` after two successful idle snapshots more than ten seconds apart and an immediate pre-quit recheck. The checks included every active goal, approvals, agent/native/serving/task work, bot/team queues, connection checks and computer-control leases.

The previous app and verified quiescent owner-data/pairing backups were kept in a new unique local backup directory. The replacement used atomic renames on the same volume. The original live CUA runtime, guest process and disk inodes stayed in place; its separate live copy is not claimed as a validated coherent VM backup.

After launch, all 42,667 resource entries matched the accepted manifest; strict recursive signing passed. The native executable's signed hash stayed unchanged, its identity remained `ai.strata.desktop`, hardened runtime remained enabled and its entitlement state matched the carrier. Independent provenance checks matched all compiler code/data bytes while allowing only the measured signature allocation difference in the read-only Mach-O `__LINKEDIT` segment. All 39 engine and 4,655 Python component entries matched the donor.

Preservation comparison passed for 20 conversations / 176 messages, two paired devices, all five durable pairing files, seven configured model connections, bots, bot files, team journals and the existing CUA computer. No phone was launched during Mac activation.

The installed Mac permission request was triggered through the app. Computer Use blocks access to the system permission dialog, so the user was asked to click **Allow**. A subsequent status read reported macOS authorization **denied**, and app alerts remain disabled. The user can allow Strata in **System Settings → Notifications → Strata**, then enable alerts in Strata. Actual operating-system banner/click acceptance remains pending until that permission is granted; the full compiled-App transport test is not substituted for that proof.

The ordinary development-signed iPhone build **0.1.0 (16)** passed 19 artifact checks and 17 independent offline checks. All 39 committed app/resource/project/scheme inputs matched the tested aggregate. The prior signing certificate, profile bytes, app/team identifiers, entitlements and Keychain groups were retained, with build 15 kept as verified recovery.

A fresh physical-device/profile and installed-build preflight passed, followed by installation of the exact gated artifact and a post-install query confirming build 16. Signed executable and profile/resource seals remained unchanged. The phone app was not launched; no physical UI automation, Keychain reset, re-pairing, provisioning change or owner model prompt occurred. Physical phone notification behavior remains for the user's manual test. This build has no APNs entitlement and therefore provides new phone alerts while Strata is active only.
