# Bot harness validation

Source: `9ba99f33ed9de2ef37c576fd4b382c05a85efae5`, on the fork's `feature/iphone-companion` branch. This includes the earlier coordinator Work tools, compact conversation loading and reusable command-tool library from `c62fa684`.

## Behavior

- Configured-model and Ollama requests keep instructions, the current request and complete tool exchanges within a shared estimated context budget. Compaction leaves stored conversations intact. Native resumed sessions keep their provider's context management.
- A private durable journal records tool dispatch and outcome without storing arguments, results or credentials. An action that may have partly completed is not silently retried. Activity can show and acknowledge an exact local receipt; acknowledgement never resumes or retries work. SSH receipts are read-only here.
- Reviewed command tools can declare platforms, executables and workspace files. Checks run through the selected Mac, SSH or CUA executor. Run/test checks again immediately before the saved command body. There is no fallback to the Mac.
- Both apps show observed preparation, provider wait, approval, tool and cleanup timings. These diagnose waits; they do not certify successful work or faster inference.

Existing pairing, chat/team history, model selection, connectors, permissions and execution targets remain in place. Maya stays separate. The update adds no parallel-team slot or turn limit.

## Passed source and workflow checks

- 358 targeted host checks, 128 companion-bridge checks and 29 native Rust checks.
- TypeScript checking and production UI build.
- Chromium workflows using the actual supervision, recovery and tool-library components with inert fixtures. Covered exact review proofs, unavailable-journal errors, keyboard/chat navigation, layout, readiness editing and older-host capability handling. No external requests or browser errors in the accepted recovery run.
- iOS units: 239 passed, one existing optional test skipped, zero failed. Native simulator workflow: one passed. Its actual TLS bridge and journal fixture recorded 421 reads, one exact acknowledgement and two tool-configuration edits. No model prompt, command execution, retry or resume was sent.
- Separate authors and reviewers checked context, recovery, readiness, bridge, Mac UI and Swift changes. Final committed source acceptance has zero open P1/P2 findings. All 36 changed files match the accepted commit.
- Fresh Mac production compilation at the accepted commit, with all 75 native input files and generated UI inputs recorded before and after compilation. The Rust/Swift native source graph is unchanged from `c62fa684`; the executable was freshly built with this UI.
- Fresh signed iOS build 34 compiled successfully. The simulator workflow compiled build 33 with the same Swift logic; only the approved project version metadata changed for build 34. Device compilation is separate from physical-device acceptance.
- Independent signed-artifact acceptance passed for both builds. The Mac review checked strict signatures, the fresh executable, 163 host sources, 26 SSH runtime assets, eight bridge files, 258 Control sources, 424 lifecycle archive entries and 42,687 resource entries. Engine/Python donors remain exact. iPhone 34 retains the exact bundle identity, signing profile, certificate, entitlements and pairing keychain scope from 33.

Release-helper checks are separate from product tests: 50 passed, including file-identity and journal snapshot races. Independent action-journal measurements concern its local storage operations only, not whole-app or provider speed.

## Limits

Context sizes use estimates with headroom, not each provider's tokenizer. Compacted source excerpts are not a verified semantic task summary. Existing tool-output storage bounds still apply. Signed protocol blocks and images are not sliced.

Action identities do not promise business-level exactly-once execution. A new explicit user turn is new work; review any possible partial effects before asking for it again. Unresolved receipts are retained. A corrupt or unexpectedly public journal is reported unavailable and left untouched. Tool checks prove declared dependency presence, not versions or command correctness.

The owner’s conversations, bot tasks and computers were not used to generate acceptance prompts or commands. Actual provider/account health, SSH execution and model quality are outside these fixture checks. No physical-phone test is claimed for build 34.

## Activation

Pending. The signed Mac candidate is independently accepted, including its complete application aggregate. The installed Mac app still runs the earlier `de96c71b` source. The first harness readiness snapshot passed all 13 runtime checks, but the native app has an open Import MCP configuration editor. No quit, app replacement or draft discard was performed. A fresh idle/draft check is required before activation.

The physical iPhone has not been replaced or launched for this harness update. Build 34 has passed its final signature/identity review and is staged for the owner's interruption decision.

The prepared postactivation verifier also passed a separate review and 26 synthetic checks. It has not run against the owner app. It will check signatures, exact installed source, complete owner-data preservation, receipt-store bytes or absence, pairing, guest disk/process identity and all 13 runtime idle checks before any subsequent owner UI navigation. This preparation is not activation evidence.

Private evidence: `/Users/gszulc/Projects/Strata-iphone-evidence/strata-harness-20261022`. See `docs/BOTS-HARNESS.md` for behavior and operating limits.
