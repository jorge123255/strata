# Live group test — October 22, 2026

This exercise used the installed Mac app, real Codex provider turns and a new three-bot team. It was not a scripted model-response fixture. Follow-up source fixes and their regression checks are recorded separately below.

## What ran

Team: **Studio QA · Live group test**. Iris coordinated and planned, Nova implemented, and Pip independently reviewed. All three used the installed Codex adapter, its provider default model, low effort and manual approvals. The team shared this Mac and a dedicated disposable working folder. No configured model connection, Maya service, SSH computer, connector or CUA guest was used.

The task was deliberately small enough to inspect completely: fix an incorrect open-task count in a JavaScript function, add dependency-free Node tests and document the behavior.

| Exercise | Observed result |
| --- | --- |
| Public introductions | All three bots answered. The coordinator also posted a public question; no continuing greeting loop was observed. |
| Planning | Iris read the sandbox files and saved a concrete plan. No implementation was performed by the planner. |
| Building | Nova changed the function, added four tests and updated the README. Its actual `node --test` run passed 4/4. |
| Independent review | Pip read the files and separately ran `node --test`: 4/4 passed. The workflow waited for owner review. |
| Concurrent conversation | A normal group message received Iris's reply while Pip's review was underway. No computer-in-use rejection occurred. The visible timestamps were 09:12:06 and 09:12:11 Central. |
| Requested changes | A request for a missing-status test started round two with Nova. Completed planning was retained. |
| Repair and second review | Nova added the fifth test and documentation clarification. Nova and Pip each ran the tests successfully: 5/5. |
| Final verification | The test operator inspected the actual files and independently ran `node --test`: 5 passed, 0 failed. Acceptance was recorded only for this disposable exercise. |

The final workflow has five completed stages across two rounds. The test team has no active run. Existing bot profiles, model catalog and existing team records compared equal to the pre-test API snapshots. Test conversations and files remain available for inspection.

Manual approvals accounted for part of the elapsed time. This exercise does not establish provider throughput, a long-running workload benchmark, simultaneous computer execution or the quality of every supported provider.

## Findings

| Priority | Finding and evidence | Improvement |
| --- | --- | --- |
| P2 | Work said **0 working** during the live workflow, then **0 need you** and **No current tasks are tracked** while independent checks awaited owner review. | Include durable workflows in the Work view and counts, with direct review navigation. Mark partial, stale or unavailable lists honestly. |
| P2 | Nova's saved implementation-role preference was absent from its greeting turn. Source tracing confirmed conversation-only turns omitted the speaking bot's saved instructions. No shared native session was demonstrated. | Include only that bot's own saved instructions while retaining conversation-only tools and excluding private work memory, skills and peer profiles. |
| P2 | Expanded write and command approval cards showed only a generic question. The exact path or command was present in the API but invisible in the card. | Project a bounded target for recognized file, command and browser tools. Do not dump arbitrary connector arguments, file contents or typed secrets. |
| P2 | During repair round two, prior green checks remained visible without identifying them as the previous evaluation. | Label earlier findings as previous checks while a fresh evaluation is pending. Preserve their history. |
| P2 | iPhone team chat did not follow incoming replies or use its saved read sequence for a new-message count. The first native regression run also exposed programmatic scroll movement being mistaken for the user scrolling away. | Track actual user scrolling, follow incoming messages only at the latest messages, otherwise retain reading position and show a new-message count. |

## Design direction

Keep the group conversation as the main surface. A compact progress card should answer **who is doing what, what is waiting, and what happens next**. Use the assigned bot's avatar and name, a readable stage label and a direct link to the exact stage conversation. Approval waits should be explicit rather than appearing as an indefinitely working bot.

The Work view should be the dependable place to find both delegated tasks and planned workflows. Older findings and logs belong behind progressive disclosure; an incomplete list or failed refresh must not look like an empty healthy team.

Further improvements worth testing separately are clearer Chat/Work follow-up behavior, readable stage names in channel notices instead of values such as `awaiting_review`, less repeated goal text, threaded peer replies, and per-member participation summaries. The roster's Attention filter should also reflect enabled teams that need intervention. These are design recommendations, not claims of completed implementation or measured performance gains.

The native phone screenshots also show the next layout priority: compact the work strip and mode explanation while typing. The keyboard and a four-line draft leave little room for the conversation. Keep review/approval access available through a compact status control rather than occupying several permanent rows.

## Evidence and boundaries

Private local evidence: `/Users/gszulc/Projects/Strata-iphone-evidence/live-group-20261022T140607Z-a2037dd4`.

Key records include `manifest.json`, `greeting-final.json`, `channel-final.json`, the five `stage-ws_*.json` transcripts, `accepted-workflow.json`, `final-workspace-files.json` and `live-test-checks.json`. The final sandbox file hashes are retained with those records.

The installed app under test contained source commit `1937b2829d15e9166d3391f2269caa47484e5538`. The source checkout began this audit at `9fbeab54197fd92c70bc42e1e8922871ce22e503`; its product source was identical. The new fixes require separate source validation and activation. This test did not restart the Mac app, install an iPhone update, launch the physical iPhone app, test every provider or perform work in the owner's existing teams. Maya was kept separate.

## Follow-up source validation

The patch implements the five improvements in the findings table. The Mac Work cards also shorten long goals visually while retaining the full goal in the inspector, and new workflow drafts prefer three distinct role holders when available. Two-bot teams remain supported.

- Backend author checks: **146/146 passed**. Independent source review reran **79/79**, with 0 open P1/P2 in the reviewed backend scope. These counts overlap.
- Post-fix real provider regression: **four actual Codex calls** in isolated new state. Nova answered with an implementation/testing preference and Pip with an independent review/testing preference. Only the conversation invitation tool ran; no computer tool dispatched.
- Mac: **30/30** author pure/component browser cases, typecheck and production UI build passed. Independent review reran **21/21**, with 0 open P1/P2. A partial-page empty-state defect found by that review was reproduced, fixed and retested. One earlier browser-fixture render race was corrected with an explicit state wait, without a product change for that race.
- Paired compatibility: **22/22** conversation and Bots bridge checks passed. No physical iPhone launch or installation was involved.
- Manual preview: CUA navigation through the actual updated Mac components with recorded live data confirmed **1 need you**, a direct **Review result** action, and the explicit **Waiting for your review** handoff. The fixture rejected mutations and made no installed-host or model requests. Screenshot: `improved-work-preview.png` in the private evidence folder. Its saved workflow is the pre-acceptance record; it does not claim the real completed task still needs review.

- iPhone: fresh simulator app/test compilation passed. **8/8 compiled XCTest cases** and **1/1 focused native UI case** passed on iOS 26.5. The native case checked incoming follow at the bottom, preservation of an older row within six points with an unread count, explicit jump/acknowledgement, an incoming reply above a four-line draft and keyboard, visible workflow work/navigation, and previous-check labels without premature acceptance. Its 151 host requests were GET-only fixture requests, with zero provider dispatches.
- Independent iPhone source/model review: **13/13** checks passed, 0 open P1/P2. It reproduced and closed false attention from an old completed stage or a zero-count approval. The first native scrolling failure and all later results are retained separately.
- The new disposable simulator was deleted after testing; preexisting simulator states were unchanged. The iOS 17 fallback compiled and was source-reviewed, but no iOS 17 runtime was available. The physical iPhone was not launched or updated.

Final iPhone receipt: `strata-workflow-20261022/continuations/iphone-team-work-20261022T141904Z-a4544ae7/focused-validation-receipt.json` under the private evidence root; SHA-256 `3a0dac73c9c2323345012661a9aa370e5d0f2a72c5061570428986ed98fcb4ed`.

Installed-app observations above remain distinguished from later source and fixture results. Neither installed app has been replaced by this audit. The temporary Mac preview server was stopped after the screenshot and manual inspection.
