# Shared team conversations

Team members now share a persistent Channel on Mac and iPhone. Each message shows its real author and avatar. The coordinator interprets the owner's request: a greeting can invite everyone to answer; a question can invite a relevant peer; a request for volunteers collects public bids before assigning work. Assignments, peer questions and final reports remain visible in the room. Thinking and tool details open only when selected.

The default recipient is Team. Choosing Everyone or an individual supplies addressing context to the coordinator; it does not change a task into a conversation. Both apps accept further messages while bounded team work runs. Work retains its existing view and Stop controls. A host without channel support retains the previous coordinator-work view.

## Boundaries

- Teams remain opt-in. Enabling a team does not start a model, computer or assignment. Ordinary chat and existing team-run routes retain their behavior.
- Routing, bid and conversation turns have only public team speech and coordination tools. They cannot use shell, files, browser, computer, skills or external MCP tools. Their context excludes private profile instructions, memory, previous private chats and provider checkpoints.
- Only an authorized assignment begins real work. It keeps the selected bot's frozen model, computer and approval policy. The SSH worker enforces the same conversation restriction; no remote worker was deployed or prepared during this update.
- Existing turn, parallel, hop, depth and duration limits still apply. Retries retain request identity. Stop and restart do not replay accepted work. Public error messages and coordinator completion context exclude private provider diagnostics.
- Maya services, connections and credentials were not changed. Existing phone pairing, model connections, bot files and conversation history must pass preservation checks before activation is accepted.

## Source and automated checks

Mac/host source: `37bbcee962482ff667c72dea7899cee951e1ad20`.

The final combined host, conversation, bridge and SSH suite passed **115/115 tests**, with no skips. It includes actual pinned TLS bridge to HostClient to HTTP routes to durable team and conversation stores. The model in that wire test is inert. It checks public attribution, matching Mac/phone message IDs, stable model/policy selection, bids, reports, retries, conflicts and Stop.

Mac component/browser checks passed **8/8** on final source. Typecheck and production UI build passed. Cases include more than one page of missed messages, a POST returning a later window, immutable message sequence validation, stale navigation, preserving a failed-send draft, old-host fallback, paused members, active work and Stop. Browser fixtures replace transport; they do not prove model decisions.

Independent backend and bridge/worker reviews finished with **0 unresolved P1 / 0 unresolved P2**. Fresh fault probes confirmed private runtime errors stay out of public history, later coordinator context and peer-tool results. Review found and closed two issues: private error diagnostics leaking into shared context, and Everyone rejecting paused members. Paused members remain addressable but are not woken; an unavailable coordinator cannot start a new route.

## Real provider smoke

A fresh synthetic two-member team used the installed Codex adapter and a verified available model. A real coordinator invited its teammate and both models greeted the team publicly. The following volunteer workflow did not complete. A second bounded attempt returned provider **429 Too Many Requests** before greeting; no further requests were attempted. The complete volunteer/assignment/report behavior is covered by inert model workflows, not a completed live-provider acceptance run. No production conversation, SSH operation or external execution tool was used by this smoke test.

## Failure and scope notes

Early bridge and paired test failures were fixture setup/assertion mistakes and were corrected before the final pass. Initial native UI runs exposed fixture streaming and lazy-row locator problems, followed by real Stop reachability and large-text layout issues; final native results are recorded below when accepted. Failed attempts remain in private evidence.

A forced failure of the separate bot-profile file after conversation creation can leave one empty private chat. It starts no model work and writes no public message; this existing cross-file persistence limitation was not expanded into a transaction refactor. Room history is bounded and refuses new writes when full rather than deleting existing messages.

Private evidence, provider output, device identifiers, pairing records and user conversation content are kept outside the repository. No new pull request or merge was requested for this update.

## Whole Mac app and activation

The complete production UI passed **38/38 checks** against a disposable real HTTP host, team scheduler, journals and conversations. The test-only provider brain was inert. Dark and light desktop plus a 390-pixel layout were captured and visually inspected. All nine tested HTML/JS/CSS files match the signed application exactly. The isolated host and temporary data were removed after the check.

The Mac application was activated after two complete idle snapshots **14.3 seconds apart**, followed by an immediate pre-quit check. All twelve work checks passed, including every conversation goal, team queues, pending approvals and computer controllers. Native Quit was used; the host exited before replacement. The prior application and verified quiescent owner data were preserved in a unique private backup before atomic app renames.

After launch, strict recursive signature verification passed and **42,663 resource entries** matched the staged manifest with no changes. All **139 host sources**, the bridge, the Control source overlay, the lifecycle archive and retained engine/Python components had passed the source gate. The host is healthy at the same origin, and every existing team channel opens without creating work.

Preservation checks passed for **16 conversations / 168 messages**, **2 paired devices**, **7 model connections**, five durable pairing files, bot profiles/files and both team journals. The original CUA runtime, guest disk identity and existing guest process were retained. A separate copy of the live CUA runtime is best effort and is not claimed as a coherent, tested VM restore. The old update heartbeat remains paused.

## iPhone source and simulator

Native product source: `12fcc6b73bdceebe2e30dfc5a82a06b93096b890`.

Final Swift checks executed **102 tests: 101 passed, 1 optional live TLS probe skipped, 0 failed**. The full simulator team workflow passed against the actual private team service and pinned TLS bridge with inert models. It exercised greetings, attributed peer replies, bids, assignment, visible peer exchange, reports, explicit Thinking navigation, Stop confirmation and history after relaunch. Its thirteen postchecks passed; no active fixture work remained.

A separate read-only layout workflow passed in normal Light/Dark and accessibility XXXL. Its UI host calls were all GET. Visual review found and closed large-text author/time overlap, oversized system/send icons and recipient wrapping. Stop is reachable in the toolbar during long conversations; failed-send feedback stays with the pinned composer. Final native source/capture review finished with **0 P1 / 0 P2** findings. Original-resolution captures were used to settle an ambiguous resized-image observation; no extra source change was needed.

A final interaction review also found that the transparent middle of the new Team settings and Previous tasks rows did not respond to taps. A two-line content-shape fix gives both labels a full-width target. The 102-test service run and layout captures precede only this touch-shape change; the final app is rebuilt and its center-tap workflow is checked separately. The superseded signed candidate was retained privately.

Build **0.1.0 (14)** was signed using the retained development profile and certificate. All **18 offline artifact checks** passed. Root independently passed **16 checks**, deriving all **35 build inputs** from the accepted Git tree and matching the frozen manifest and working bytes. Strict recursive signature, profile seal, entitlements, Keychain groups, signing leaf and build 13 recovery were verified. No new account, provisioning change or permission was required.

The rebuilt final app passed the original coordinator-work simulator workflow with default center taps on both disclosure rows (**1 test passed, 0 failed/skipped; 7 postchecks passed**). It retained team creation/reviewed enablement, task submission, Thinking, foreground updates, Stop, cancelled history and Activity. The independent reviewer closed the hit-area finding with **0 unresolved P1 / P2**. The earlier label-edge tap was a diagnostic workaround and is not used as final acceptance.

The final core Bots workflow also passed (**1 test, 0 failed/skipped**), including saved provider/model/computer/workspace selections, shared history, Thinking, one explicit continuation, exact Stop and history after relaunch. All four native workflow receipts passed. The owned fixture processes were stopped and the dedicated QA simulator was shut down.

## Physical iPhone installation

Fresh CoreDevice inventory confirmed the same previously paired iPhone had **0.1.0 (13)** installed and was eligible for the retained profile. The exact gated final artifact was installed, then inventory verified **0.1.0 (14)**. Source and artifact hashes remained unchanged. Build 13 recovery remains available. The app was **not launched**: no physical UI automation, re-pairing, Keychain reset, provisioning change or model prompt was performed. Physical iPhone UI acceptance is left to the owner, as requested.
