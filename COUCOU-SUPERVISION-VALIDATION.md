# Bot supervision: source and simulator validation

This change brings the first Coucou-inspired experience into the existing Strata Mac and iPhone apps. Bots → Activity shows current waiting, working/thinking and recently finished conversations. iPhone also has a direct **Bot activity** toolbar button. Review links open the exact existing chat; they never approve a request or start work.

The full source, license, architecture, comparison and next-import assessment is in [COUCOU-ANALYSIS.md](docs/COUCOU-ANALYSIS.md). Reference source is pinned to Coucou `1e5180921c1326fc72e41d313e3e2855e9c10162`. Strata implementation is original code and retains its existing avatars. No Coucou character, sound, icon, hosted relay or Apple account identifier was imported.

## Scope

- Compact read-only host snapshot and paired bridge projection. Current runtime pending counts determine approvals; historical proposed tool cards do not.
- Exact personal/team/subagent conversation links, current tool display name, computer label and rolling 24-hour completed/failed history.
- Mac filters, keyboard controls, responsive cards and last-known state after a failed poll.
- Native iPhone cards, Dynamic Type, existing reduced-motion avatars, direct Activity entry and pairing-generation/stale-response guards.
- iPhone build number 23. XcodeGen regeneration changed only four `CURRENT_PROJECT_VERSION` settings and the one project.yml value from 22 to 23. Signing capabilities, bundle identities and entitlements are unchanged.

Standalone nonbot Maya chats are excluded by bot ownership. Strata bots that intentionally select a configured Maya model remain included. No model-serving configuration, credentials, SSH keys, bot policy, team instruction, history or pairing setting is changed by supervision.

## Passed checks

| Check | Result | Scope |
| --- | --- | --- |
| Host, actual disposable bot runtime and shared-conversation regressions; paired HTTPS bridge | 47 passed, 0 failures/skips | Actual pending → completion, no full-history/pending-argument copies, historical tools, context ownership, bounded/redacted output, local read-only requests, paired authentication/revocation and old-host fallback. |
| TypeScript | Passed | `npm run typecheck` in apps/host. |
| Production UI | Passed | `npm run build` in apps/host. Existing bundle-size advisory remains. |
| Mac Chromium component workflow | 1 passed | Actual shipped component, keyboard filters, exact review/open IDs, subagent tool label, cleared approvals, stale state, reduced motion and 820px bounds. Real icon sprite and concatenated styles are served and hashed. |
| Native iPhone unit suite, final build 23 inputs | 162 passed, 1 existing optional live test skipped; 0 failures | 163 total; includes four new supervision model/filter/pairing-generation/stale-poll checks. All 53 iOS source/test/project inputs match before and after the run. |
| Native iPhone UI workflow, final build 23 inputs | 1 passed | Real pairing to an ephemeral bridge on a new scratch simulator, actual Activity button, attention filter → exact chat, working subagent, cleared approval, relaunch, dark appearance and largest accessibility text. All host fixture requests were GET. All 53 inputs match before/after. |
| Source whitespace | Passed | `git diff --check`. |

The fixture signs in only to an ephemeral local test bridge. It does not contact owner accounts, an external provider, production Strata, Maya, a physical iPhone or an actual CUA/SSH computer. The signed simulator app and test-runner artifacts were copied and hashed before reusing derived data for the final unit run.

## Evidence and acceptance limits

Final evidence is under `coucou-supervision-20261021-tnptbowt` in the private Strata evidence directory: `mac/component-final`, `ios/supervision-build23-r1.xcresult`, `ios/units-build23-r1.xcresult`, their source manifests/receipts and `ios/native-build23-artifact.json`. Five native screenshots cover attention, exact chat, subagent, cleared approval and largest text in dark appearance. The final source aggregate ties those reports to committed files.

Earlier preparation and failed attempts remain under `coucou-analysis-4__z3pl_`. Native UI r2/r3 exercised the existing workspace context menu and did not complete reliably: one menu closed during cold loading; another remained open after a synthesized tap. Those are excluded from passing acceptance. The accepted workflow uses the newly visible Activity button at normal and largest text sizes. The context menu is unchanged and is not claimed as newly verified. An initial browser report-export error and an unbooted-simulator setup refusal are retained as failed preparation attempts, not product passes.

This packet proves source, disposable runtime/bridge behavior, the Mac component and native simulator navigation. It does not prove a native Mac notch panel, Live Activities, widgets, background push delivery, service OAuth consent or physical-device behavior. No production app was installed/restarted by this lane. Packaging and activation follow the normal independent artifact, idle-work, pairing/history preservation and device-process checks after integration.
