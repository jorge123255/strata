# Continuous team work and readable rooms

The Project Openflix and Tunner room was inspected read-only. Long assignments repeated their instructions in replies, progress appeared inside public reports, and the coordinator resumed separately for each result. Some Devin members failed native model verification before receiving a prompt. One provider ending its turn with an intention was not evidence that its assigned work had happened.

Updated teams use five zero sentinels for parallel work, delegation depth, message hops, turns and duration, with the explicit `teamContinuousSupported` capability. Team work continues until completed, blocked or stopped. Existing saved team settings migrate to those values; historical runs and jobs retain their original records. Older hosts keep their existing controls. Runtime continuation beyond the former 32-step and 30-minute whole-turn limits is granted only to a current host-bound continuous team job, including over SSH. Individual tool, setup, heartbeat and cleanup timeouts remain.

A clear human whole-team greeting or explicit recipient selection receives one opening response per available addressed member. A real assignment satisfies that member’s participation. Volunteer requests collect bids; a bid does not authorize wider work. Ordinary requests retain coordinator task selection. Paused or failed-account members are not retried automatically.

Each public result remains visible immediately. The coordinator resumes once after its current work round and descendants settle. Paged result references retain every child identity, and read-only team tools retrieve complete public reports without exposing private chats or another team. Exact failed assignments cannot automatically repeat in the same request; a new human request can authorize another attempt.

Mac and iPhone show compact expandable assignment cards, expandable long reports and short reply references. Full stored text and linked conversations remain. Configured models, Ollama and Claude use their explicit terminal answer for the public report; Codex retains its existing final-phase support. Providers without an explicit final-versus-progress distinction retain compatibility behavior. Strata does not guess success or automatically replay work from phrases such as “I’ll start.”

## Validation status

Independent review passed with **0 P1 / 0 P2** in the backend, runtime, web/bridge and release-helper slices. Reproduced checks include **116 backend/settings/paired checks**, **98 runtime checks**, **115 bridge checks**, **eight web checks including both actual browser workflows**, and a successful TypeScript typecheck and production UI build. These scopes overlap and are not an aggregate test total.

Final iOS source passed **184 unit tests: 183 passed and one optional live TLS test skipped**. Both actual native workflows passed: continuous team creation saved five zero values and stayed disabled without starting work; compact room cards expanded their complete text and preserved exact history with 43 reads and zero writes. Screenshots were inspected. The owned simulator was shut down. Existing localization/AppIntents warnings remain; compilation had no errors.

The broad host run completed **1,576 tests: 1,476 passed, 96 skipped and four failed** under a short canonical temporary path and concurrency four. Demo request cancellation, two simultaneous demo model requests and Time-skip grandchild liveness also failed on an unmodified archive of the task base. The other failure was fixture directory cleanup; its focused rerun passed. These are retained failures, not a full-suite pass. An initial run also exposed stale test fixtures; the paired tool allowlist now includes the two public read tools and the packaged bridge fixture copies its existing host-folder module. No production assertion was weakened.

Current checks use disposable stores and inert provider/SSH fixtures. No model prompt was sent to an owner conversation. Existing running work was left alone. Maya remains separate. Final signed artifact, exact source and activation evidence will be recorded after their gates finish.


## Devin isolation diagnostic

An existing resumed Devin conversation had stopped before its model prompt with the generic isolated-tool-configuration error. A private metadata-only clone of that exact native session passed all original configuration, rules, hooks, MCP endpoint/schema, plugin and skill checks with a fresh inert Strata bridge. No prompt, tool execution or client operation occurred. The original native database and WAL were unchanged; cloned history was removed after the check. This does not establish the original failing stage. Two fresh metadata session creations separately timed out in the CLI before verification and are retained as failed probes.

Verification errors now identify a fixed, human-readable check while retaining every isolation requirement. Raw metadata, sockets, environment values and account responses are excluded. The generic recommendation to update the CLI was removed because an update was not established as the remedy. No CLI, account, saved bot provider or model was changed. Model execution in this owner conversation remains untested.

The final diagnostic and retained runtime/model/SSH/public-reply regression set passed **149 checks**, zero failures. The first diagnostic test run exposed a short admission-poll fixture race; it now awaits the existing recorded prompt event with the real test deadline. No production acceptance rule was relaxed.
