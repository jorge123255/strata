# Native Mac bot companion

October 21, 2026. This slice adds an optional native panel to Strata's existing Mac process and bundle. It keeps the Bots workspace, shared Mac/iPhone conversations and thinking, team coordination, providers, SSH execution, model management, Connectors, notifications and CUA controls. Maya stays separate. The iPhone application is unchanged by this Mac-only slice.

## Behavior and scope

- Settings → Appearance → Bot companion enables the panel and selects a display. It starts off, retains a disconnected display choice and uses the main display until that display returns.
- Compact mode highlights an actual urgent bot conversation. Expansion shows at most six bounded rows. Explicit clicks open the exact existing conversation or Bots → Activity. Automatic presentation does not take keyboard focus. View → Focus Bot Companion provides keyboard access.
- Original Strata vector characters blink, breathe, glance and react to activity. One focused character moves; dense list faces are static. Freshly observed work finishing can trigger a brief response; historical completion and polling do not replay it. Interacting with the face is cosmetic.
- Reduced motion, hidden/disabled state, stale activity, screen sleep and inactive/locked sessions stop character motion. The native controller cancels requests and invalidates stale callbacks during lifecycle changes.
- A private per-launch loopback read credential carries up to 8,192 bytes of status. It does not carry transcript, approval identifiers, tool arguments/results or profile credentials. Neither this feed nor a character interaction can start work, approve tools or open an arbitrary URL.
- Hiding the companion disables that panel. Strata retains its existing main-window close/Quit behavior. No second production app, sound, remote artwork, extra Apple identity or Coucou character asset is added.

## Validation and delivery

Source/UI validation, the fresh Rust/Swift compiler output, signed packaging and activation are separate checks. Private receipts are retained under `/Users/gszulc/Projects/Strata-iphone-evidence/coucou-companion-20261021-wuaj9b5n`.

The actual Settings component passed 25 browser checks covering native canonical state, opt-in settings, keyboard/display controls, disconnected/reconnected displays, light/dark and narrow layouts, reduced motion, timeout and cancellation races. The focused host and retained notification/supervision suite passed 18 tests. TypeScript and the production UI build passed. Native model/transport/motion checks passed 162 checks, including 100 real cancellation/completion races and ten cancellation-before-start/repeated-start cases. All mutable transport state now belongs to one serial queue. The desktop Rust suite passed 29 tests before that narrow transport correction; the final committed compiler is checked again for the release candidate.

Actual native-window evidence shows expressive changing lead frames, still list faces and stale faces, exact chat/Activity callbacks, disabled stale chat controls, editor focus retained across refreshes, and polling suspended/recovered across app Hide/Unhide. The Reduce Motion branch and invariant drawing are checked in source and units; its operating-system setting and runtime clock cessation were not instrumented. A fixture-only environment override could not compile because that environment key is read-only in the installed SDK. No owner accessibility setting was changed.

The first compiler attempt stopped because an unstaged development Harness resource was absent. The accepted recipe uses the existing resource-only Tauri override and production custom-protocol feature; packaging verifies and retains the carrier resources separately. Tauri's own generated schema changes are preserved as evidence and restored to their exact prior bytes. A later cancellation review withdrew the first source/compiler candidate before artifact acceptance or installation; its receipts and exact executable are retained.

The first packaging attempt also exposed recursive Control manifest ancestry: the installed legacy `BUNDLE.json` had grown to 5,332,767,995 bytes. Only the task's verified packaging child was stopped. Packaging now reads bounded top-level metadata and records streamed parent hashes and byte counts, preserving runtime identity and current source provenance without nesting prior manifests again. Eleven regression tests exercise the actual embedded writer across thirty overlays, bounded reads of large/sparse legacy manifests, input mutation, malformed metadata and runtime compatibility. The old installed app and failed candidate are retained. Final source, compiler, signed package and activation results are recorded after their corresponding checks finish.

Native tests and a disposable, distinctly named fixture use synthetic status and a separate preferences suite. They do not prompt owner bots, run tools, approve work, authenticate connectors or change production settings. Screen geometry and simulated lifecycle tests do not imply physical multi-monitor, notch, lock, sleep, Spaces or full-screen acceptance.

## Historical accepted candidate before the combined update

Packaged product source: `90cf20463348ea927c3f8a193e74c0e09e7340e9`, on `feature/iphone-companion`. A later evidence-only commit does not change the accepted product. The earlier `f496eb4c` candidate was withdrawn and was never installed.

| Check | Result and scope |
| --- | --- |
| Host and Settings | 18 focused host/retained tests and 25 actual-component browser checks passed; TypeScript and production UI passed. |
| Native transport, models and motion | 162 focused checks passed, including real concurrent cancellation, cancellation before start, repeated start, bounded HTTP transport, display geometry, finite motion and exact identity transitions. |
| Native window workflows | Focus, Hide/Unhide, stale controls, static stale/list faces, exact destinations, in-flight disable and fresh recovery passed in isolated fixtures. All fixtures and their private preferences are cleaned up. |
| Packaging and retained consumers | 59 tests passed. Thirty fixture overlays stayed bounded; the real legacy manifest was streamed rather than parsed recursively. Four retained path assertions first failed on `/var` versus `/private/var`; their canonical-temp-directory run passed without unrelated source changes. |
| Final compiler | 29 Rust tests passed. Independent acceptance checked 75 native inputs, 67 generated UI inputs, actual arm64/macOS 15 compiler output, system Swift linkage and the exact production recipe. |
| Independent source review | Corrected source has 0 P1 / 0 P2. |
| Signed Mac app | All 41 package checks and 73 independent artifact checks passed. All 42,677 resources, 152 host files, 258 Control source records, 424 lifecycle archive entries, bridge, engine/Python contents, native compiler identity and strict recursive signatures were verified. |

The new Control manifest is **29,207 bytes**, preserves Python `3.12.15` / build `20261009` and its exact runtime digest, and references both accepted 5,332,767,995-byte parent manifests by their full streamed hashes and sizes. There is no nested ancestry.

The accepted app is staged at `apps/desktop/build/Strata-native-companion-r2-20261021.app`. Its full signed application aggregate is `4ab53995c0e20bdfe8623e7a79f3d67bd5036f8af1a254de7db5934f1c81b6c2`; its resource aggregate is `e3504e45cf257c2bc4e2fdccf71a3e366f5f5af987bcf155eb1a00b5fde174dc`.

**At that earlier acceptance:** the fresh idle check still found active bot conversations and team work. The running Mac app, Maya, paired devices, history and physical iPhone build 24 have not been replaced or restarted during this pass. The accepted candidate and immutable evidence are recorded in `mac-ready-awaiting-idle.json`. The existing idle follow-up will finish activation only after two complete idle snapshots, native draft inspection and an immediate pre-Quit check, then verify installed resources, signatures, pairing and history. The companion remains off until enabled in Settings → Appearance → Bot companion.

## Installed combined update and navigation correction — October 21, 2026

The combined Mac app was first installed at `dab336f5` at 20:43 UTC. Production native QA verified Settings opt-in, View → Focus Bot Companion, the same-process panel, expansion and the cosmetic character response. Actual Activity/chat clicks then exposed a host journal filter that discarded companion destinations. That failed result is retained in `activation-attempts/attempt-s8e5bdxx/native-ui-check.json`; it was not accepted as successful navigation.

Product source `c69e8f68b83b7cf6b30f0a30083a126594813eba` corrects the host filter. A private native queue may open the fixed Activity page or an exact currently saved conversation even when notifications are off and no journal event exists. Missing/deleted chats, extra fields and arbitrary pages are rejected. General notification delivery and team journal rules remain unchanged. Three reproduced failures now pass; 40 focused notification/APNs/browser/companion checks and 23 independent service/private-adapter checks passed. All 75 native inputs and 67 generated UI files remain identical to the accepted DAB graph; a fresh final-source production build and 29 Rust tests were nevertheless completed and independently accepted.

The corrected signed app was activated at **2026-10-21T21:04:33.629473+00:00**, after the user's saved-draft confirmation, fresh idle checks and native Quit. All 42 artifact checks, 42,681 resource hashes, the exact installed native/source hashes and strict recursive signatures passed. The prior app is preserved at `/Users/gszulc/Projects/Strata-iphone-evidence/backups/strata-companion-navigation-20261021T210404Z-9557f3ef`. Exact preservation passed for 92 conversations/436 messages, two paired devices, eight connections and all inspected durable stores; Maya and the original CUA guest were retained.

Final production Settings opt-in passed. The owner resumed a new unsaved bot setup during the remaining UI check, so Activity/exact-chat clicks were held to preserve that draft. Five checks executing the installed host module passed with a private disposable store and synthetic sources/native inputs; they do not establish whole-app native click acceptance. The original **off/main** companion preference was restored through the existing local settings API and read back, without changing the setup form. Physical-notch, multi-display, lock/sleep, Spaces, full-screen and OS Reduce Motion acceptance remains limited to the earlier stated fixture/source scope.

Private evidence: `strata-team-concurrency-49eoj00o/release-r3/independent-artifact-acceptance.json`, `activation-attempts/attempt-nav-kh_8bskf/{activation-move,artifact-gate-after-launch,after-preservation-checks,independent-activation-acceptance,native-ui-check,companion-restoration}.json`, and `installed-navigation-smoke.json`. This correction requires no additional iPhone build; build 25 is installed separately without launch.
