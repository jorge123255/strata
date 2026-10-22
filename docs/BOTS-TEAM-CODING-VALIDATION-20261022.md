# Team coding access validation — October 22, 2026

## Observed failure

An existing team's coordinator reported that its whole filesystem was read-only. Its actual turn contained successful Strata commands and no attempted file write. File tools had correctly rejected paths outside the selected workspace. The inspected source checkout also had an unrelated, genuine merge conflict. These were separate facts.

## Correction

Source commit: `28855eb51f53bfcb24f1a6d02ea135f117f4be8a`.

- Coding work receives its current selected folder, saved approval policy and assigned tools. `get_execution_context` reports those facts without granting access or claiming OS write access.
- Workspace errors identify the file-tool root. Coding guidance preserves dirty checkouts and uses a clean task checkout inside the selected folder when an authorized committed base is known.
- Native provider sessions refresh when the dynamic-tool catalog changes. Saved Strata history remains intact.
- SSH context comes from the worker's actual filtered catalog. Plan, Manual approval, symlink boundaries, native execution isolation and conversation-only restrictions remain enforced.

## Source and package checks

The root's focused suite passed 79/79 and its compatibility suite passed 45/45. The author tool/worker suite passed 41/41. Independent source review passed a new 4/4 matrix and a 92/92 focused suite, with 0 open P1/P2 findings. These suites overlap; their counts are not additive. Five current Channel/Work browser fixtures passed with no page errors or external requests.

The fresh native build passed 29/29 tests. The signed installed Mac app matches the reviewed source, 166 host files, 26 SSH assets, 67 UI files and retained engine/Python components. Recursive strict signature verification passed after launch.

Activation preserved 167 conversations, 626 messages, 3 paired devices, 9 model connections, existing bot/team history, tools, skills, connectors, workflows, action receipts, notifications and original guest disks. Maya remained separate. The existing iPhone binary was not replaced for this server-side correction. The exact unsent team-composer draft was captured and restored without sending it. It later appeared empty for an unproven reason; it was restored again after the final team update and remained visible on the final native UI check. Future draft persistence is not established by this check.

## Live verification

The first live check used the existing team's saved coordinator (`codex`, `gpt-6-luna`, high effort) and reviewer. The test explicitly assigned implementation to the coordinator to reproduce its reported access failure. It was a capability test, not the intended default team workflow or a restart of a production assignment.

The coordinator used `get_execution_context`, created the required standalone clone inside the selected workspace, reproduced 5 passing/1 failing tests, used `write_file` to change the source, and reran the unchanged suite with 6/6 passing. The separate reviewer inspected the actual diff without editing and independently ran 6/6 passing tests. The coordinator then read the report and submitted its final synthesis. The run completed after three actual provider turns.

Root independently inspected the diff and ran 6/6 tests. All 50 conflicted source-repository files, including `.git`, stayed byte-identical; only the permitted clone module changed, and the tests stayed unchanged. The model's implementation also filters invalid prior rows, so it differs from the reference patch while satisfying the requested behavior. A separate audit compared 200 valid-history cases and verified the saved profiles, team settings and all model connections stayed unchanged during this check. Root accepted only these disposable QA tasks. No production project result was accepted.

After the owner's follow-up, the team's public instructions were updated to revision 18 with delegation first: the coordinator plans, assigns, tracks and synthesizes; a coding teammate implements; a different teammate reviews. Direct coordinator implementation remains available when the owner explicitly assigns it or a necessary support action is explained. Models, computers, permissions, membership and limits were unchanged. The second live check completed with the same saved profiles and a separate clone of the same conflicted fixture. The coordinator read Sol_High_Worker’s public implementation strengths and preference, confirmed availability, and assigned that bot the code change. The builder reproduced 5 passing/1 failing tests, made one `write_file` edit, and reran the unchanged suite with 6/6 passing. Codex-Tunner_Reviwer then inspected the actual diff without editing and independently ran 6/6 passing tests. The coordinator tracked the reports and submitted the final synthesis; it made no implementation edits, clone operations or test calls. Root’s separate diff/test check passed and all 50 source files, including `.git` and the conflicted index, stayed unchanged. The run completed with three bots and six settled job turns. Root accepted only these disposable QA results.

The check also exposed one remaining P2 coordination issue: the coordinator sent a path correction through `send_to_teammate`, which starts executable work, creating an unnecessary second reviewer delivery. That follow-up checked existing public records and did not rerun tests or edit files. This was a separate successful call with different text, not a duplicate retry or callback race. At revision 19, the team’s public instructions now distinguish assignments from correction/status notes: publish a linked correction with `post_team_message`, check current work before assigning review, and do not schedule another review for an unchanged artifact. All other team settings remain unchanged. This is a saved instruction mitigation, not a backend task-amendment feature or proof that future duplicate assignments are impossible. A public note does not guarantee delivery into an already running worker turn.

Private evidence: live run `tr_2d42b148-c7cb-4498-8ed9-beaf24e0ad69`; independent scope audit SHA256 `f8caf72fca38eb44b7bac7360c8557377842fd04f91d506e93e1beb01c0c3e8f`. Exact calls and public assignments are retained in the local evidence directory. No credentials or full private conversation transcripts are included here.

Both checks exclude production repository operations, hotpatches, images, releases, forum posts and ring scripts. They do not establish that a production OpenFlix/Tuner bug is fixed.
