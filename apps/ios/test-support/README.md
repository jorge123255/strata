# Synthetic companion UI tests

This fixture uses the real companion bridge's TLS certificate and pairing authentication with an in-memory synthetic host. It supplies saved history, Thinking, ordered progress, browser action cards, approvals, continuation, Stop, and model download management. It never discovers or controls a running Mac app, downloads model files, starts a model, or opens a browser.

Requires macOS, Node.js 24.12.0 or later, Xcode, an installed iPhone simulator, and the matching `apps/companion-bridge/bridge.mjs` from the Mac companion changes. From the repository root:

```sh
node apps/ios/test-support/companion-fixture.mjs --test \
  'platform=iOS Simulator,name=iPhone 17 Pro'
```

For the model download review, target selection, progress, Stop, retry, and older-Mac fallback workflow, start a fresh fixture with:

```sh
node apps/ios/test-support/companion-fixture.mjs --test-downloads \
  'platform=iOS Simulator,name=iPhone 17 Pro'
```

Select a simulator installed on your Mac. The command starts the fixture, runs only `CompanionSmokeTests/testSharedMacHistoryLiveBrowserApprovalAndContinuation`, then removes its private temporary TLS identity and stops both loopback listeners. The test uses the app's **Forget this Mac** flow to replace any pairing saved in that simulator, and leaves an offline fixture pairing afterward. Use a disposable simulator if you want to preserve an existing simulator connection. It never changes a physical phone's pairing.

For the Bots catalog, provider/computer details, shared history and Thinking, empty bot conversation creation, continuation, Stop and relaunch workflow:

```sh
node apps/ios/test-support/companion-fixture.mjs --test-bots \
  'platform=iOS Simulator,name=iPhone 17 Pro'
```

This runs only `CompanionSmokeTests/testBotsSharedHistoryThinkingAndNewConversation`. It asserts that listing bots and reading existing history never submits a prompt, then chooses a saved remote computer, configured model and workspace. Creation forwards only their opaque IDs and the folder path, with no credentials or raw execution configuration. It verifies frozen context, continuation, Stop and history after relaunch. All provider and computer entries are synthetic; this verifies phone and bridge behavior, not live provider authentication, SSH or computer control.

When the Mac and iOS changes are in separate checkouts, set `STRATA_TEST_BRIDGE_MODULE` to the matching checkout's `apps/companion-bridge/bridge.mjs`. The default import is relative to this repository. `STRATA_TEST_DERIVED_DATA` optionally selects a build directory; the default is `apps/ios/build`.

For a test runner that manages Xcode itself, run the fixture without a test flag. It prints only the path of a private temporary `connection.json` containing `invitation` and `control` values. Pass the invitation as `STRATA_TEST_INVITATION`, and the control URL as `STRATA_SHARED_FIXTURE_CONTROL` for chat or `STRATA_MODEL_MANAGEMENT_FIXTURE_CONTROL` for downloads. With command-line `xcodebuild`, use the `TEST_RUNNER_` prefix; both test commands handle this forwarding automatically. The loopback control endpoints are synthetic test controls, not Mac API routes. Stop the fixture with Control-C when finished; normal termination removes the temporary files.

Pairing invitations expire after five minutes and work once. Start a fresh fixture for each UI run. Keep XCTest result bundles private: UI automation can record the values entered into the pairing form. No TLS keys, invitations, tokens, or result bundles belong in source control.


`--test-computer "platform=iOS Simulator,id=<dedicated-scratch-simulator>"` runs the actual sample avatar and isolated-computer workflow. Its separately generated `computer-fixture.png` is an explicit synthetic screen, never a captured Mac/VM screen. The scenario checks enum-only avatar saving, the locked CUA `/workspace` folder, read-only opening, explicit Start, confirmed takeover, aspect-fit tap mapping, text/key input, release on leaving/background, and confirmed Stop. The fixture does not prepare CUA, start any VM, open SSH, or send provider/model prompts. `--test-bots` uses a host-mode bot to retain coverage for a selected remote workspace; `--test-computer` uses CUA mode.


For capability-aware team creation with fourteen selected members from fifteen saved bots:

```sh
node apps/ios/test-support/companion-fixture.mjs --test-unrestricted-teams \
  'platform=iOS Simulator,id=<dedicated-scratch-simulator>'
```

This opt-in fixture runs `CompanionSmokeTests/testLargeTeamCreationUsesAllAvailableTeammates`.
It verifies the actual native picker, all selected IDs in the authenticated bridge request,
and canonical `maxParallel: 0` (“All available teammates”). It creates only an inert saved
team. It starts no model turn, SSH request, browser or CUA guest. Default fixture modes
continue advertising the legacy twelve-member/positive-parallel contract.

For continuous team work on a capable host:

```sh
node apps/ios/test-support/companion-fixture.mjs --test-continuous-teams \
  'platform=iOS Simulator,id=<dedicated-scratch-simulator>'
```

This runs `CompanionSmokeTests/testContinuousTeamWorkHasNoNumericStopLimits`.
It selects saved teammates in the native form, shows “Until finished or stopped”
without numeric work controls, and verifies all five saved team-limit values are
zero. The team remains disabled and no work starts. This capability is separate
from unrestricted membership; older fixture modes retain their numeric work limits.

`--test-team-compact` runs
`CompanionSmokeTests/testCompactTeamAssignmentsAndReportsExpandWithoutChangingHistory`.
An inert runtime first writes a real assignment and long report to the private
fixture journal. The native test expands and collapses their previews, verifies
the complete text remains accessible, and checks history is unchanged. No external
provider, SSH, browser or guest computer is involved.

`--test-harness` runs
`CompanionSmokeTests/testHarnessReadinessDiagnosticsAndReviewWithoutExecutingWork`
on an explicit scratch simulator. It uses the real private action journal and
paired TLS bridge. An inert callback creates an uncertain local receipt; an SSH
receipt is a read-only synthetic mirror. The test inspects timing details,
acknowledges only the exact local receipt, keeps readable receipts visible when
the journal is unavailable, and edits and clears reusable-tool requirements.
Only that acknowledgement and configuration edits may write. No saved tool
command, provider prompt, SSH connection, CUA guest, retry or task resume runs.

`--test-team-workflows` runs
`CompanionSmokeTests/testTeamWorkflowRolesEvidenceOwnerReviewAndExplicitContinuation`
on an explicit disposable iOS simulator. It exercises the actual native workflow
form and paired TLS boundary: saved planner/builder/evaluator roles, observable
criteria, first-load errors, stage evidence, evaluator findings separate from
owner acceptance, exact revision/proof writes, inspected continuation, Stop and
older-host read-only fallback. Workflow stage records are explicit synthetic UI
fixtures; no provider, verification command, browser, SSH connection or guest
computer runs. Backend workflow tests separately validate real stage execution
and evaluator verification requirements. The only host mutations in this native
scenario are one workflow creation and explicit owner review, resume and stop.
Pairing is changed only inside the named disposable simulator.
