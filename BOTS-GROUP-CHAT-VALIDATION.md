# Bots and shared group chat

This pass brings individual bots and teams into one conversation roster and moves the shared team room toward the owner's BotAI visual direction. It adds a compact group header with stacked avatars, attributed rounded messages, right-aligned owner messages, a pinned capsule composer, and working details and message menus. Team settings and previous work remain available through explicit controls.

## Source status

Accepted Mac/host source: `d1567f6738b5b0d44b503e93e0892d2cb39709e1`.

The Mac source freeze covers ten files, aggregate `f80cbb7e8a5725f31fd9ee2453325aeb925cdee61bf39fbdae4b458658d65cd6`. Its production UI contains 67 frozen files, aggregate `dc16b1e6ee4047a0145082a2ff586d91278775cb5eff814aa1a1c6cc97c0329f`.

Accepted iPhone product source: `ad225a74e3b991c0acce904d5ea480e2be37dffe`, build 15. Native app, metadata, tests and fixture candidate r6 has aggregate `bc9c51c8a74f3a805ba2b72afcaaf861475b70dad02e1b92e03918a52bc440e8`. The signed artifact freezes all 35 product/signing inputs at aggregate `9a944bf24316e8e296919b3b3ece9d4cfc90be3996e79c97dc5c617450cfb40f`. This product commit is distinct from the installed Mac/host commit above. Final native runtime acceptance passed, and the exact signed build 15 was installed and verified on the retained physical iPhone without launching it.

## Public previews and preserved behavior

The existing team-list API now includes an optional `channelPreview` drawn only from the latest public journal message. It carries that message's identity, sequence, kind, public author, bounded content and original time. Content is limited to 280 Unicode code points and excludes NUL characters. Empty teams retain their creation-time fallback; a settings rename does not become new conversation activity.

The authenticated companion bridge applies an explicit field allowlist. Malformed optional previews are omitted without removing the team. Older hosts and empty rooms remain compatible. Preview reads do not create journal files, start models or perform mutations. Private chats, bot instructions, memory, checkpoints and provider diagnostics are not consulted for team previews.

Individual bot roster captions exclude team-owned routing and worker transcripts. This changes the teaser selection only: the full bot conversation history and explicit Thinking and tools links remain available. The mixed roster uses actual direct or public group activity and retains search and filtering.

This is a presentation and public-preview update. It retains the established coordinator routing, visible peer speech, assignment/report journal, bounded execution, retry identity, pagination, stale-navigation guards and Stop behavior. An addressing choice does not grant tools or change a task into a discussion. Existing model, computer and approval settings remain in force. The earlier team-channel validation records those underlying execution boundaries.

Maya services, credentials and connections remain separate. No Maya, SSH, remote worker or CUA VM operational change was part of this pass. Existing pairing, history and configured model features remain preservation requirements for installation acceptance.

## Automated and compiled-App checks

| Check | Result | Scope |
| --- | --- | --- |
| Host and companion preview regression suite | **53/53 passed**, no skips | Public-only captions, Unicode bounds, malformed projection, authenticated pinned TLS transport, restart, read-only file preservation, and existing team lifecycle boundaries |
| Mac focused component and browser suite | **19/19 passed**, no skips | Unified roster, real group header/bubbles/actions, public attribution, direct captions, pagination, retry, Stop and viewport behavior; synthetic transport where documented |
| Mac typecheck and production UI build | **Passed** | Final frozen source; the existing bundle-size advisory remains |
| Complete compiled App against a disposable host | **66/66 passed** | Actual App navigation, actual HTTP host, team scheduler, conversation stores and public journals; test-only inert provider brain |

The complete-App workflow checked the public team-list preview against the roster, direct history captions, the single bot/team list, details and plus actions, draft-only greetings, earlier-page merging, explicit Everyone submission, peer reply identity, owner-message alignment and remaining in the room after sending. All fixture work settled. It recorded **15 captures** across dark and light desktop layouts and a 390-pixel compact layout. Principal layouts were visually inspected. There were no browser errors, blocked external origins or unexpected effectful routes.

All 67 production UI files matched the frozen manifest after that run. All nine executed HTML/JavaScript/CSS assets matched those same inputs. The disposable host and its temporary data were removed. No production conversation was written and no real provider prompt was sent.

These workflows prove the UI and real host wiring with controlled model output. They do not establish new live-model coordination acceptance, physical-device UI acceptance or installed-app activation.

## Independent iPhone source review

Candidate r6 passed independent review with **0 unresolved P1 / 0 unresolved P2** findings. All eleven frozen app, metadata, test and fixture hashes matched. The owned diff check passed.

Two P2 issues found in the initial candidate were fixed before this review:

- Thinking navigation now belongs to the persistent team view, so closing its transient message menu cannot cancel the selected asynchronous navigation. Leaving the team view still invalidates late actions.
- The unified roster explicitly observes its workspace, allowing a public preview refresh to redraw captions, times and ordering without requiring an unrelated companion-store update.

The review also checked additive preview decoding, preservation of full direct history, pairing-scoped requests, existing send identity and cursor validation, recipient/reply menus, reviewed enablement and Stop controls. Latest remains reachable in populated history. An explicit successful send requests a scroll only for the same navigation generation; incoming polling does not trigger that action.

The final r6 product delta adds pairing-generation checks to both asynchronous shared-conversation navigation actions. Each captures the pairing before refreshing, requires it to match before selecting a conversation, and checks it again before opening Chat. The existing view-navigation tokens and the store's own guarded selection remain in place. Independent byte comparison confirmed that these two captures and four guards are the entire product delta from reviewed r4; the other changed file extends UI acceptance checks only.

The hidden tab bar is scoped to the team destination. All four final native pinned-TLS workflows passed on the accepted r6 product, each with one test and zero failures or skips:

| Native workflow | Duration | Additional postchecks |
| --- | --- | --- |
| Mixed roster, group layout and real menus | 208.229 s | 8 passed |
| Natural team channel, Thinking and Stop | 128.493 s | 11 passed |
| Older-host team fallback | 120.398 s | 8 passed |
| Existing Bots regression | 105.903 s | 5 passed |

The layout workflow exercised the real native Create bot/Create team entry sheets, public-only preview refresh, compact header and pinned composer, light/dark and accessibility XXXL modes, details and recipient menus, older-history Latest without incoming data, hidden-room tab bar and restoration through Back. Foreground roster polling stopped after navigating away. The semantic workflow retained named peers, explicit reply identity, coordinator assignment and worker report, message-menu Thinking with restored global tabs, explicit send scrolling without helper intervention, Stop and relaunch. Older-host and core Bots workflows retained reviewed enablement, settings, previous work, provider/computer/model/workspace selection, shared continuation, progress, Activity and saved history.

These are actual native simulator navigation and paired-TLS checks against isolated fixtures. Provider turns and computer data were controlled test output; no production model, SSH worker or physical iPhone UI was exercised. The optional live TLS unit test and the physical UI remain separate acceptance boundaries.

The final Swift unit run executed **105 tests: 104 passed, one existing optional live-server certificate test skipped, zero failures**. It preserved source and artifact hashes. The four native UI workflows above used actual isolated pinned TLS and did not skip their transport checks.

## Mac activation

The signed Mac application was activated at `/Applications/Strata.app` on 2026-10-21 UTC from `d1567f6738b5b0d44b503e93e0892d2cb39709e1`. The host reopened at the same local origin. Native UI inspection confirmed the existing team, mixed conversation roster, recovered room messages, stacked avatars, bubble layout, pinned composer and Thinking/Reply/Work/details controls. No production message was sent.

Before restart, two complete idle snapshots were 10.39 seconds apart, followed by an immediate pre-quit snapshot. All twelve checks passed, including every conversation goal, bot/team work, approvals, model serving, MCP checks and computer-control cleanup. Strata was quit through its native app menu. The host exited before replacement; the native shell and listener were checked again after backup immediately before renaming.

The current app was preserved in a new unique backup. All quiescent owner data and pairing files were copied and compared before the atomic application moves. The original CUA guest, runtime directory and guest disks remained in place with the same process and filesystem identities. Its separate live copy is best-effort and is not claimed as a validated coherent VM restore image.

The artifact gate matched all 139 host source files, 258 Control source records, 424 lifecycle source files, the bridge and all 67 compiled UI files to the accepted source/build. Engine and Python donor trees remained exact. The strict recursive signature and all **42,663 resource entries** passed again after launch, with no changed resources. An independent review of the activation helper closed two P2 checks before use: immediate pre-move staged-resource identity and detection of a reopened shell/host; nine isolated verification probes passed.

Post-launch preservation matched **20 conversations / 176 messages**, both paired devices, seven configured connections, five durable pairing files, all bot files, profile data and team journals. Maya was not restarted or reconfigured. The retired update heartbeat remains paused.

## iPhone installation

The build 15 artifact passed all eighteen author signing checks and sixteen independent offline checks. Both matched the exact accepted commit and all 35 input bytes, the executable and resource seals, strict recursive signature, retained provisioning-profile bytes and authorized signing certificate, app/team entitlements and Keychain groups. The profile is unexpired and the retained build 14 recovery artifact was reverified. These offline gates did not contact or launch the phone. All final native workflows and unit checks passed before any device contact. A fresh same-device and provisioning-eligibility check confirmed the existing installed 0.1.0 (14) baseline. The exact gated artifact was then installed; a new device inventory verified **0.1.0 (15)**, with executable/profile/resource seals unchanged after installation. All twelve fresh preflight checks passed. The retained signed build 14 remains available for recovery.

The phone application was **not launched**. No physical UI automation, Keychain reset, re-pairing, provisioning change or model prompt occurred. Physical-device UI acceptance remains with the owner. The installer itself passed independent read-only review and nine isolated pre-contact guard probes. The isolated native fixture processes exited; the dedicated QA simulator was shut down without changing other simulators.

Private test evidence is retained outside the repository in the `bots-group-chat-host-20261021`, `bots-group-chat-mac-20261021`, `bots-group-chat-ios-20261021` and `bots-group-chat-20261021` evidence folders. This document contains no owner chat content, pairing records, device identifiers or source photos.
