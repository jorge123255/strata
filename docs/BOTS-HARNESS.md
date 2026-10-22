# Strata's bot harness

The harness connects each bot's model to its instructions, conversation, tools and selected computer. Strata keeps provider accounts, model serving and execution separate. Maya's connection and services stay independent.

This update extends the existing Bots runtime. It does not replace the native Claude, Codex, Grok, Kimi or Devin sessions, the Ollama/configured-model adapters, or CUA's computer backend.

Public team chat keeps the speaking bot's own saved instructions and personality. It does not load private work memory or another bot's profile. Chat and volunteer replies still use conversation tools only; keeping a bot's identity does not grant computer or connector access.

## Long conversations

Configured model and Ollama requests share a context budget. Instructions, tool definitions, the current request and the latest complete tool exchange remain together. Older exchanges can leave the model request as complete groups. A small digest quotes incomplete source excerpts with hashes; it is not a verified task summary. Large plain tool results can become explicit head/tail excerpts. Native signed or opaque protocol blocks and images are never cut apart.

A notice records compaction. Stored chat history is not rewritten. Existing tool activity has its own output bounds; a context excerpt does not promise that an unlimited original result was saved. Bots should read smaller file or output chunks when exact content is needed. Team assignments and public result reports remain in the existing work ledger.

Token counts are estimates based on UTF-8 bytes, framing and an image allowance, with headroom. The configured model's advertised context and output limits are checked on the Mac before sending. Unknown limits use a 32,768-token fallback; a remote configured bot's first request uses that fallback until the host returns its actual budget. Native resumed sessions retain their provider's own context management. An immutable request that cannot fit produces an explanation before inference. This does not make a model's context window unlimited.

## Interrupted actions

A private action journal reserves an identity before dispatch and writes an outcome afterward. Identities bind the conversation, authority, turn, execution plane and provider call. Raw arguments, command results, account credentials and transcripts are not copied into receipts. Local/CUA actions and host integrations use the host journal; SSH computer tools use a private journal on the execution account and send a read-only receipt to the Mac.

An unconfirmed mutation is not automatically retried, including the same action with another call ID during the same turn. An error may have happened after partial effects. Inspect the exact conversation and the affected files or service before continuing. Independent actions, bots and computers remain available. Existing uncertain computer-cleanup holds still apply.

Bots → Activity on either app shows interrupted receipts. Recording review acknowledges inspection of the exact current local receipt. It does not certify success, execute a command, approve an action, resume a task or clear a computer-cleanup hold. SSH receipts remain read-only in this view. A new explicit owner turn is separate work and still needs judgment about partial effects.

Receipts cannot promise business-level exactly-once execution. A provider that changes a call's arguments or loses its native identity can describe a different action. Anonymous calls, explicit new turns and settled identities beyond retention are outside exact-call deduplication. Unresolved receipts are retained; the settled journal retains 1,000 receipts with at most 31 extra entries between pruning passes. Corrupt or unexpectedly public files are left untouched and reported unavailable rather than repaired or hidden.

## Tools that work on the selected computer

A reviewed command tool can declare supported platforms, required program names and relative workspace files. `check_created_tool` checks those declarations using the bot's actual local, SSH or CUA command adapter and normal command permissions. It does not run the saved body, install dependencies or grant access. Using the selected CUA command adapter can start an already-prepared guest under the normal permission and lifecycle rules. A failed declared-requirement check can be repeated after repair because the saved body did not start; this does not clear a separate cleanup hold. Run and test check requirements again after approval, immediately before the command body. A failed check prevents that body from starting.

Presence checks do not prove program versions, script correctness or successful execution. Tools still need their files on the selected computer. No operation falls back from an SSH or isolated computer to the Mac.

Approval cards show a target for recognized file, command and browser actions, so you can see which file or command is requested. These are bounded previews; recognized credential values and some URL details are hidden. Arbitrary connector arguments and file contents are not added to the target. A shortened or redacted preview is not a complete inspection of an action.

## Understanding slow or blocked work

Activity has an expandable timing record for each observed conversation: preparation, provider wait, approvals, tools, cleanup, time to first output, tool calls/errors and context compactions. Provider wait includes startup and connection time. These are measured host-session timings, not generated thinking, completion verification or a claim about model quality. They reset when the host restarts; durable action receipts do not. Timing counters keep a bounded recent-ID window, so a very late repeated display event can be counted again; these counters never authorize or deduplicate execution.

Independent team work keeps the existing fair scheduler and unrestricted continuous-team settings. A shared desktop is still exclusive while it is used. A chat-only exchange does not reserve that desktop. This update adds no parallel-team slot cap.

## Planned work and saved stage checkpoints

Teams can opt into [Plan and verify](BOTS-WORKFLOWS.md): a planner, builder and separate reviewer work against explicit success criteria. Completed stages are saved before the next stage starts. A restart leaves unfinished work for inspection and explicit continuation; it does not replay commands. Reviewer findings can drive repair rounds, while final owner acceptance remains separate from a model's reported pass.

The team Work view includes planned workflows alongside assigned tasks. It identifies the saved stage and bot, shows known approval waits, and links to the exact conversation. Counts distinguish partial or unavailable records from an empty team. During repairs, earlier evaluator findings remain inspectable as previous results while new checks are pending.

## References

- [Anthropic: effective harnesses for long-running agents](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents): persistent progress and explicit completion checks.
- [Anthropic: harness design for long-running applications](https://www.anthropic.com/research/harness-design-long-running-apps): planning, independent evaluation and testable success criteria.
- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence): durable checkpoints and shared stores. Strata does not add this framework as a dependency in this update.
