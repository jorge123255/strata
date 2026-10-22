# Plan and verify team work

Open a team on Mac or iPhone and choose **Plan & verify**. Enter a goal and specific success criteria. Choose a planner, builder and reviewer from that team's saved bots. The reviewer must be a different bot from the builder. A planner can also fill one of the other roles when its saved permissions allow it.

Starting a workflow starts model work. Each bot keeps its configured provider, model, computer, folder, connectors and approval policy. A shared team computer remains shared; its normal control and cleanup rules still apply. Maya's connection and services remain separate.

## The work cycle

The planner submits a concrete plan. The builder implements it and submits labeled evidence. The independent reviewer inspects the result against every criterion. It can use its supplied file, command, browser, computer and connector tools under the same saved permissions.

The reviewer must perform a successful artifact check in its own turn before reporting a pass. Reading the builder's report, a skill or a tool description does not count as that check. A reported pass is still a model assessment. It does not prove that every claim is correct, and it does not mark the task accepted by you.

When the reviewer asks for changes, the builder receives the findings and the cycle continues. There is no fixed round or parallel-team limit. Repeated unchanged builder evidence and unchanged reviewer findings produce a visible blocker instead of an acknowledgement loop. The work can also stop for a real provider, permission, storage or computer problem.

A passing assessment moves the task to **Ready for your review**. You can accept it or request changes. Earlier owner feedback remains part of later stage instructions. A teammate's report cannot change the goal, criteria, saved permissions or owner acceptance.

The team channel shows the original goal and stage updates. The workflow view has the plan, criterion findings, checkpoint summaries and links to the exact stage conversations. Other bots can keep working while a role is idle; the existing scheduler admits work when the required bot and computer are available.

## Saved progress and continuation

Strata saves stage intent before dispatch and saves stage results before advancing. Checkpoints belong to this workflow and team. They contain public work artifacts and access fingerprints, not copies of private teammate conversations or account credentials.

An interrupted host does not automatically restart model work. Completed stage records remain available. Open the latest checkpoint, inspect its conversation and the current files, then explicitly continue the unfinished stage. The continuation uses a new conversation and retains the original saved access. It does not replay old tool calls or rerun completed planning merely because the app restarted.

You can Stop and later inspect and continue unfinished work. Unconfirmed cleanup must be resolved before continuation. If the team, model, folder, computer, instructions or granted tools change, restore the original settings or start a fresh task with the new settings.

Action receipts remain a separate safeguard. A failed command may already have changed files or an external service. An unresolved receipt can block automatic progression, including a test command that exited with an error. Inspect its actual effects before acknowledging the exact receipt and choosing a continuation. Acknowledgement itself does not retry, resume or certify success.

## Storage and limits

These are stage checkpoints, not snapshots after every command, operating-system restore points or a general time-travel debugger. An unfinished long build still requires inspection of its current files. The latest plan, build report and review are retained. The operational checkpoint store compacts old stage entries; the view shows the latest 12 stages with an explicit total. Conversation and public-channel history are not rewritten by that compaction.

Lists and reports are bounded so the apps do not reload an entire project history on every refresh. Bounds on report size and storage do not set a work-turn deadline. If storage cannot be written safely, Strata reports the failure and does not silently run ahead or reset the saved file.

The goal, criteria and earlier owner feedback must fit the next stage's message budget together. If they grow beyond it, Strata blocks with the feedback preserved. Start a new explicitly scoped workflow after reviewing those holds. Optional report excerpts may be shortened; inspect the linked conversations and actual files for complete evidence.

## Design references

This feature implements a controller within Strata's existing runtime. It does not install LangGraph or replace the native provider adapters.

- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) distinguishes saved execution checkpoints from shared long-term stores. This feature adds workflow-scoped stage checkpoints; it does not add a general cross-team memory store.
- [Anthropic's harness design for long-running applications](https://www.anthropic.com/research/harness-design-long-running-apps) describes planning, separate generation and evaluation, concrete criteria, and feedback from testing a working application. Strata applies those ideas to owner-selected bot roles and existing computer tools. Its reviewer remains a model and final acceptance stays explicit.
