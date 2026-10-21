# Coucou ideas inside Strata

Analysis source: [jorge123255/coucou](https://github.com/jorge123255/coucou/tree/1e5180921c1326fc72e41d313e3e2855e9c10162), pinned to `1e5180921c1326fc72e41d313e3e2855e9c10162` on October 21, 2026. Strata base: `420b3f67aff733b4202b5db40c79a26282ee2510`, with the iPhone companion, bot teams, shared history/thinking, SSH execution, model management and Connectors already present.

Coucou's strongest addition is a calm, visible companion that tells you which agent needs you and what the others are doing. Strata should bring that experience into its existing app. Coucou observes coding tools; Strata also owns execution, team coordination and isolated CUA computers. Replacing Strata's runtime with Coucou would lose those capabilities.

## What is implemented first

Bots → Activity now begins with live supervision on Mac and iPhone. It shows conversations waiting for approval, failed work, tools in use, thinking and results from the past 24 hours. Personal, team and subagent conversations keep their exact identities. Filters show **Needs you**, **Working** and **Recently finished**. Existing Strata avatars react to real activity; keyboard controls, VoiceOver labels, accessibility text sizes and reduced motion use the existing platform controls and avatar system.

**Review approval** opens the exact shared conversation. It does not approve a tool. The existing conversation and tool ownership checks remain responsible for decisions. The panel receives no actionable approval IDs, arguments, commands, results, credentials or transcript text. The card title and computer label are the same public conversation metadata already available through pairing.

The host derives approval state from its current runtime requests, rather than old proposed tool cards. `conversations.supervisionSources()` reads compact last-message flags and one current tool name without cloning the complete history. The read-only `/api/bots/supervision` route and paired `/v1/bots/supervision` projection cap output at 200 conversations. Bot, conversation and pairing identities remain scoped to Strata. Failed refreshes retain explicitly labelled last-known data. Older hosts explain that an update is needed.

This is supervision of actual bot turns, not a claim that the computer is idle. Queued team work and handoffs remain in the team activity section beneath it. A goal between rounds is not invented into an active tool call. Nonbot chats, including a separate Maya conversation, are excluded. A Strata bot that intentionally uses a configured Maya model remains a Strata bot and is included. No model service or API connection is changed.

The first slice runs inside Strata's existing windows and iPhone app. A physical notch panel, Lock Screen Live Activity and widgets are subsequent increments; this change does not claim those are installed or working.

## Source architecture and the import decisions

Paths below are relative to the pinned Coucou repository. Findings come from reading source, not executing Coucou or signing into its services.

| Area | Coucou implementation | Strata decision |
| --- | --- | --- |
| Mac companion | `Sources/App/IslandWindowController.swift` hosts SwiftUI in a transparent, nonactivating `NSPanel`; `IslandStateMachine.swift` controls hidden/compact/expanded states. | Add an optional panel to the existing Strata process after native integration. Keep the main Bots workspace and one application. |
| Display placement | `Sources/CoucouKit/IslandScreenGeometry.swift` reads notch/safe-area geometry and provides a no-notch fallback. | Use the geometric approach with Strata's own character and screen preference. Test external displays, Spaces, fullscreen and display removal. |
| Multiple sessions | `Sources/App/PillSessionRegistry.swift` keeps several sessions behind one agent pill. `Sources/Phone/SessionStatus.swift` prioritizes waiting, failure, work and completion. | First slice uses exact bot/chat identities and urgency ordering. Do not reduce several remote computers to one provider pill. |
| Agent event input | `Sources/App/HookServer.swift` receives newline JSON on an owner-only Unix socket, checks peer UID and holds supported permission requests for manual decisions. | Strata-owned bots already emit events. A later optional external-agent adapter should use the existing event format and preserve local-only authentication. No owner CLI dotfiles are edited now. |
| Permission queue | `Sources/App/ApprovalQueue.swift` supplies a bounded FIFO. The hook server rechecks the clicked request against the queue head. | Keep Strata's unique live tool request IDs, turn ownership and existing policy choices. No raw shortcut bypass is added. |
| Last turn and diffs | `Sources/CoucouKit/TurnSnapshot.swift` and `DiffEngine.swift` provide bounded last-turn/diff data. | Add a compact expandable turn view using Strata's recorded text, tool results and patches. No arbitrary folder reads or guessed progress counts. |
| iPhone transport | `Sources/App/PhoneLink/SessionPublisher.swift` and `Sources/Phone/PhoneLink.swift` use a private CloudKit zone, with sensitive project fields in encrypted values. | Preserve current certificate-pinned pairing, history and remote routing. CloudKit can be a separate opt-in transport, with Strata-owned capabilities and migration design. |
| Live Activities | `Sources/Phone/LiveActivityLink.swift`, `Sources/Widgets/MochiLiveActivity.swift` and `Sources/App/PhoneLink/LiveActivityRelay.swift` coordinate tokens and lock/unlock state. | Use the new compact supervision data as the basis for an original ActivityKit presentation. Do not copy the author's relay URL, container or application identifiers. |
| Background delivery | `relay/src/index.ts` signs APNs Live Activity pushes. | Requires our own authenticated provider service, Apple setup and real background delivery acceptance. Foreground simulator rendering is not proof of this feature. |
| Widgets and Shortcuts | `Sources/Phone/SharedSessions.swift` writes an App Group snapshot. WidgetKit reads it. `CoucouIntents.swift` adds status, instruction and Focus intents. | Add read-only status widgets and an explicit bot/team destination first. New extension bundle IDs, App Groups and profiles must be valid for Strata's Apple team. Existing build 22 signing does not imply those rights. |
| Notifications | `Sources/Phone/AgentNotifier.swift` adds quiet hours, Focus and authenticated actions. `Decisions.swift` checks device-owner authentication. | Extend Strata's current notification inbox and per-device preferences. Notification actions must re-fetch the exact pending request and recheck pairing before any decision. |
| Services | GitHub, Vercel, Stripe, n8n, Notion, Resend and Cal.com have direct pollers and native detail views. `PhoneLink/ServicePublisher.swift` projects their state. | Add account-aware service dashboards to Connectors. Reuse existing sign-in, scopes and explicit bot/team grants; do not create a second credential store. CI/redeploy/merge actions still follow the user's policy. |
| Voice and local speech | `FlowDictation.swift`, `ParakeetEngine.swift` and the FluidAudio dependency add hot-key dictation, ASR and explicit model download. | Later opt-in feature with model/license provenance, microphone and Accessibility setup. Route cleanup through configured Strata models. Apple speech fallback must not be described as universally offline. |
| Meeting notes | `NoteTaker.swift` captures microphone/system audio and uses local or cloud summarization. | Separate opt-in work with recording controls, retention/error handling and model choice. It is not needed for bot supervision. |
| Other platforms | Windows uses TypeScript/Vite/Tauri; Android uses Compose and a separate pinned local phone link. | Reuse platform-neutral concepts rather than adding another Mac shell. Android support is a later task. |
| Teamwork and computers | Subagent hooks are displayed, but Coucou has no Strata-style bot-to-bot channel/coordinator or CUA guest scheduler. | Preserve and improve Strata's existing teams, roles, shared computers/folders, remote SSH choices and explicit computer control. |

All `Sources/…` paths in this table begin under `NotchBuddy/`. Coucou's source contains 192 source files in that directory and 47 files under `tests/` at the pinned revision. Those tests were inspected as reference; they were not run or represented as Strata validation.

## Patterns that should not be imported unchanged

These are bounded source observations and import risks, not a full security audit of Coucou or proof of an exploit against a deployed service.

1. In `relay/src/index.ts`, the inspected request path validates the push payload but does not authenticate/rate-limit its caller before using the APNs signer. Deployment protections outside that handler were not tested. Strata needs paired-device authorization, replay/rate limits and an actual streamed byte bound before operating a relay.
2. `PhoneLink/ApprovalRelay.swift` fingerprints session/tool/command/input without the unique queued request UUID. Repeated identical requests can share a hash, and the source accepts a small decision-time tolerance. Preserve Strata's unique request and turn identity instead of using command content as authority.
3. `PhoneLink/InstructionRunner.swift` attempts CloudKit deletion with `try?` and then handles the records even if deletion failed. This does not establish exactly-once execution after retries/restarts. Keep durable idempotency receipts and explicit queue admission; a failed take must not start work.
4. CloudKit records named by provider pill, such as `session-<pillId>` and `turn-<pillId>`, are not namespaced by computer. The instruction runner also targets the last session for a pill. Strata needs computer/bot/chat/turn identifiers for simultaneous local and remote work.
5. Owner-UID hook input is not attestation of a specific CLI. Never expose that hook protocol on the LAN without Strata's authentication and ownership checks. Settings imports must preserve unreadable files, compare the reviewed bytes and keep unique backups.
6. Lock-screen previews, widget caches and Spotlight can expose project information. Offer explicit preview controls, pairing-scoped cache invalidation and expiry. Encrypted CloudKit fields do not encrypt every on-device cache.

## Rights and distribution

[Coucou source is MIT](https://github.com/jorge123255/coucou/blob/1e5180921c1326fc72e41d313e3e2855e9c10162/LICENSE), copyright Louis Raillé, 2026. Its [separate asset notice](https://github.com/jorge123255/coucou/blob/1e5180921c1326fc72e41d313e3e2855e9c10162/LICENSE-ASSETS.md) excludes the Coucou/Mochi names, character design and animations, icons, sounds and demo/design media from MIT distribution rights. Strata uses its existing avatars, colors and controls. No Coucou character, icon, sound, media, hosted endpoint, credential, OAuth registration or Apple identifier is imported. The first supervision implementation is original Strata code informed by the source architecture. The source license is retained in [the provenance notice](../third_party/coucou/NOTICE.md) for subsequent permitted code adaptations.

## Original Strata personality — October 21, 2026

The character pass adds original soft cheek marks, small mood-aware mouths, curved happy eyes, highlights, natural blinks and brief ear/head reactions to Strata’s existing animal and geometric avatar families. New-bot previews and the iPhone roster use a quiet companion stage; Mac Activity reflects the most urgent actual conversation. Saved shapes, colors, configurations and exact conversation destinations are retained. Historical finished cards keep a happy static face; only a newly observed completion can trigger a brief response.

Motion follows Reduce Motion, app/document visibility and viewport clipping. Small idle list avatars stay still. The presentation sends no tools, prompts, approvals or provider requests, and adds no sounds, remote artwork or new permissions. Coucou’s Mochi artwork, character design, poses and animation sequences are not used. See [the personality validation](../STRATA-PERSONALITY-VALIDATION.md) for the measured scope and activation status.

## Next imports in order

1. **Same-process Mac companion:** optional native compact panel with Strata's avatar, one urgent conversation and the other active bots; expand to review, jump to the existing Bots workspace, explicit screen choice and no-notch fallback. Keep approvals visible until resolved; do not steal text-entry focus.
2. **Compact last-turn detail:** real emitted steps and bounded diffs, paired with the existing Thinking and tool timeline; no synthetic percentages.
3. **Apple system surfaces:** provision our own widget extension/App Group and ActivityKit targets; read-only widgets and status Shortcuts first, then authenticated Live Activity delivery with an independently reviewed APNs path and physical iPhone tests.
4. **Account dashboards:** GitHub PR/CI/reviews and Vercel deployment states using explicitly selected Connectors accounts, with staleness, visibility-based polling and account-generation cancellation.
5. **Optional voice:** local dictation and explicit Parakeet download after native permissions/model provenance work. Meeting recording is a separate feature with clear recording and retention controls.

## Validation of the first slice

Validation receipts are recorded separately from runtime activation. The development branch does not install or restart the production Mac app or replace the iPhone app. It does not sign into services, install hooks, start external models/computers, modify Maya or prompt a user's bot.

Focused validation includes a real disposable bot runtime pending → completion transition; host local-origin/read-only rules; actual paired HTTPS authentication/revocation; bounded/redacted projection; historical-tool and stale-poll regressions; native store pairing-generation races; and Mac/iPhone visual navigation. Packaging and physical activation require the normal source/artifact, idle, pairing and history-preservation gates after integration.
