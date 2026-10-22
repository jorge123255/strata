# Team results and guided recovery — activation record

Product source: `99d4e8f7b985cf586c6b92fc0836ffba083a2eed`, branch
`feature/iphone-companion`. Activated on Mac October 21, 2026, at 19:24 CT
(October 22 at 00:24 UTC). This record is a documentation-only follow-up to
the installed product commit.

## Delivered behavior

- Team **Work → Tasks & results** shows assignment owners, progress and results.
  Bots submit a summary with labeled evidence; a provider finishing its response
  does not verify a task. The owner can **Mark verified** or **Request changes**
  for the exact reviewed result. Result and review histories are retained.
- **Review recovery** is a read-only preview of one tracked unfinished task,
  including its saved bot, model, computer, folder, requested corrections and
  completed sibling reports. Explicit **Resume unfinished work** creates one
  new continuation. It inspects current state and retains the original scope
  and holds; it does not replay native checkpoints or prior tool calls.
- Recovery checks saved authority against current access and settings. Stale
  plans, changed settings, revoked access, human computer control and uncertain
  cleanup prevent execution. Retrying an uncertain response does not duplicate
  the continuation.
- Mac and paired iPhone use the same host records. Individual casual bot chats
  remain conversations. Older team tasks keep their history without invented
  evidence or recovery authority; continuing them requires a new explicit request.

## Validation scope

| Check | Result |
| --- | --- |
| Committed focused host/bridge and real host integration fixtures | 142/142 passed |
| Independent backend regression review | 124/124 passed; 0 P1 / 0 P2 |
| Mac result/recovery browser component workflow | Passed |
| Retained full team-panel browser regression | Passed |
| TypeScript check and production UI build | Passed; existing Vite chunk-size advisory |
| Fresh locked native Mac build and Rust tests | Passed; 29 tests |
| Release/provenance/preservation guards | 46/46 passed |
| iOS unit suite | 195 passed, 1 optional live-TLS check skipped, 0 failed |
| Focused new iOS checks | 12 passed |
| Native iOS simulator result/recovery workflow | Passed against isolated TLS bridge fixtures |
| Independent signed Mac and iOS artifact reviews | 0 P1 / 0 P2 |

These are focused source, fixture, simulator and packaging checks, not a claim
that every repository test or every live model provider was exercised. The
simulator workflow recorded exactly two review writes and one selected
continuation. No model prompts, owner conversations, provider checkpoints,
SSH commands or computer actions were executed by those fixtures. No separate
maximum-Dynamic-Type workflow was run.

## Mac activation and preservation

Two successful idle snapshots were 15.34 seconds apart, followed by an immediate
pre-quit check. All 13 checks passed: active agent turns, shared conversations,
approvals, native jobs, serving requests, scheduled tasks, every conversation's
goal, team queues, MCP checks, OAuth sign-ins, bot turns, computer controllers
and cleanup. Strata quit through its native menu shortcut and its host exited.
No running owner work was stopped to create this idle state.

The existing app and quiescent data were preserved in a new unique local backup.
The staged signed app was atomically moved to `/Applications/Strata.app` and
reopened. The original CUA runtime and disk identities remained in place; its
separate runtime copy is retained as a best-effort copy, not a validated VM restore.

After launch, the full installed package matched the accepted signed candidate:

- 42,683 resource entries, manifest SHA-256
  `5f531ced5a5fc4879a47d92e1c6cda4406ccd4c3a07a821f960813f1c80ee590`.
- Strict recursive code-signature verification passed. The fresh native executable,
  host, bridge, UI, Control source and retained engine/Python donors matched their
  reviewed pins. The host remained at `http://127.0.0.1:47831`.
- All 139 shared conversations, 564 messages, two paired devices and nine saved
  model connections were retained. Bot files, profiles, connectors, skills,
  notification journal, historical team jobs/runs and public channel history
  matched the pre-update snapshot. The sole expected schema change was adding
  the empty top-level `recoveryKeys` journal.
- Maya connections remained separate. No Maya service, credential, proxy or
  deployment changes were performed.
- Independent activation review passed with 0 P1 / 0 P2 and all 13 idle checks.

After that preservation checkpoint, native UI navigation opened the retained
team, **Work → Tasks & results**, and a legacy task's review dialog. The dialog
correctly explained that no structured result exists and offered no verification
action. Strata was left on Work. This navigation may mark viewed notices read;
no owner task was accepted, resumed or sent a model prompt.

## iPhone delivery boundary

Strata iPhone **0.1.0 (28)** is signed and independently accepted. Its complete
12-entry bundle aggregate SHA-256 is
`74d87ccb90e06f6af1ddbe27e716479a9b62f14ee17e20f647de984b090e12cb`.
Existing application identity, signing team, profile and keychain access were
retained. The QA simulator was returned to its original shutdown state.

Build 28 has **not been installed on the physical iPhone**: the final CoreDevice
inventory still reported the paired phone's tunnel disconnected. No uninstall,
pairing reset, physical app launch or claim of device acceptance is made. The
accepted build is retained for installation when the phone reconnects.

## Local evidence references

Private receipts and backups remain outside the repository. Evidence root:
`/Users/gszulc/Projects/Strata-iphone-evidence/strata-verified-work-20261021-2obpzsq_`.

- `host-focused-committed.json`, `ui-acceptance.json`,
  `independent-verified-work-backend-acceptance-r2.json`.
- `independent-native-source-acceptance.json`,
  `independent-compiler-acceptance.json`, `independent-release-helper-acceptance.json`.
- `release/independent-artifact-acceptance.json`,
  `independent-activation-acceptance.json`, `installed-native-ui-check.json`.
- `activation-attempts/attempt-2d47f210/activation-move.json`,
  `after-preservation-checks.json` and `artifact-gate-after-launch.json` in that
  attempt directory. The move receipt records the unique backup location.
- `independent-ios28-acceptance.json`, `ios/author-final-validation.json`,
  `ios/device-build28-receipt.json` and `device-availability-final.json`.

No upstream PR, merge or release publication is part of this activation.
