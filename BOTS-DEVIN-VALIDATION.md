# Devin CLI bot provider validation

## Result and source

Devin CLI is available alongside Claude Code, Codex, Grok, Kimi and Ollama Cloud in bot creation and settings on Mac and iPhone. It uses the account on the selected execution computer, existing shared conversations, provider-emitted Thinking, Strata tools, team coordination and the existing SSH worker. Existing configured model connections remain separate.

- Mac/backend/bridge source: `2762e21a86db599adc52fab03bbe8cfddb2bf4b3`.
- iPhone source: `b972d682c7e69c0a3b0a5ca2c92c5d2789c02336`, build 19.

The installed Devin CLI is 3000.11.92. Read-only account checks reported signed in and returned 240 verified model variant IDs. Model variants retain the CLI's IDs; the app invents no effort options. A saved explicit effort is checked against the actual session before a prompt. The existing provider-model catalog endpoint is local to the Mac; SSH execution verifies the selected model on its execution computer.

## Runtime and isolated validation

Devin uses ACP with private per-conversation HOME, configuration, cache, working directory and session storage. Its native account storage stays on the execution computer; credentials are not copied to the phone or remote worker. The current known native tool inventory is explicitly disabled and denied. The adapter verifies effective configuration, exact current Strata MCP commands/environment/schemas/resources, empty plugins/rules/hooks and only the known built-in skill entries before sending a prompt. Unknown or native client requests are denied.

Native ACP `accept-edits` is confirmed through advertised settings and readback. Strata's host broker remains the authority for Ask, Plan and Bypass. Tools are not falsely marked read-only. Permission requests bind to exact preceding same-session, current-turn MCP metadata and consume one tool-call identity. Restoring a conversation retains its native session and installs a fresh private Strata bridge; history replay does not produce duplicate replies or tool cards.

These checks cover the validated current CLI and documented configuration behavior, rather than guaranteeing that every future CLI tool remains compatible. Changed or unrecognized effective configuration produces an error before a model prompt. The tool-disable and deny behavior is documented in Devin's [configuration changelog](https://docs.devin.ai/cli/changelog/stable) and [permissions reference](https://docs.devin.ai/cli/reference/permissions).

- Backend/runtime/profile/SSH focused regressions: 82 passed, zero failed or skipped.
- Companion bridge: 30 passed, including Devin catalog/profile/model admission and private account/SSH field exclusion.
- Mac UI/helper regressions: 14 passed. Wizard selection, host model/effort metadata, profile save and configured-model separation were exercised.
- Mac typecheck and production build passed.
- Complete compiled App with disposable actual HTTP stores: 13 checks passed, including Devin's empty personal chat, reuse and exact personal/team history retention. Provider execution was inert in this App test. All 67 compiled assets match the packaged build.

The accepted live r3 adapter check sent exactly one scratch prompt and executed exactly one inert Strata echo callback. Reply, three Thinking frames, usage, completion, native checkpoint and process-group exit were observed. Only Strata MCP discovery and the echo appeared. All ten backend source hashes matched before and after. Earlier scratch attempts exposed ACP permission-ID, dedicated MCP-file and native Ask-mode compatibility details; those failures were retained and corrected before acceptance. Real coding, browser, desktop, remote execution and live mid-turn cancellation were not exercised. Cancellation and policy behavior were covered by synthetic regressions.

Independent source review found zero P1 and zero P2 findings. Narrow read-only shipped-CLI inspection used the reverse-engineer-anything skill to check configuration behavior omitted from the integration documentation. No owner conversation, Maya service, SSH account, credential, model-serving configuration or cloud computer was changed for validation.

## Mac activation

The signed carrier passed 37 packaging checks. Host/bridge/Control sources, lifecycle archive, compiled assets and dependencies match the accepted source. Native code matches retained compiler provenance, and engine/Python components are unchanged. The resource manifest contains 42,668 entries, SHA256 `8d219c4de1a24087b1d850909babea56420b5c8ef8e57cc2a9bcb415a53b0973`.

Activation completed on 2026-10-21 after two full idle observations separated by 41 seconds and an immediate prequit check. Native Quit stopped only Strata. A unique verified backup retained the prior application and non-CUA owner data/pairing before atomic replacement. The original live CUA process, runtime and disk identities stayed in place. Its separate copied backup remains best effort; coherent guest restore was not validated.

Postlaunch resource and strict recursive signature checks passed. All 27 conversations / 198 messages, bot files/profiles, team settings and public journal, seven model connections, two paired devices, five durable pairing files and notification state are unchanged. The installed native provider picker visibly includes Devin CLI. Its settings dialog was closed without saving. The installed host reports Devin available and returns the 240-model catalog without a prompt. Preservation was checked again after navigation.

## iPhone acceptance and artifact

Full Swift suite: 139 total, 138 passed, zero failed, one existing optional live TLS test skipped. The final native workflow passed one test and eight durable checks against a pinned TLS fixture. It selected Devin and a host-reported model, retained default effort and Ask, saved only the profile, then opened and reused one empty chat by tapping the bot's roster entry. No inference or computer action occurred. Both captures were inspected.

Original unit inputs and compiled app were retained separately from later test-only corrections. The first native attempt failed a locator for a sole menu item that iOS did not expose as a button. A later UI pass lacked the fixture's final chat-state export and was not accepted as durable evidence. Both attempts remain retained; final acceptance uses a fresh complete raw result, unchanged before/after source inputs and eight recomputed state checks. Independent review found zero P1 and zero P2 findings.

All 39 product inputs match the tested committed source, aggregate `2110c09e61d7f19f64f858a165c94e00df46197a43963cdf0a40dc2de6ea33be`. The signed artifact passed 19 author checks and 17 independent checks, with executable SHA256 `a98b4242d450e9e26d7a4a6d75b34a01a6a7d0f47c96a0eb23547c89da755107`. Build 19 retains build 18's signing identity, development profile, entitlements, application identifier and Keychain groups. The build 18 recovery artifact is retained. No APNs capability or provisioning/account change is included.

Physical installation status is recorded after the owner chooses whether to replace the currently running build 18. The prepared update is install-only; it does not launch the phone app, uninstall it, reset Keychain, re-pair or send a model prompt. Physical UI acceptance is left to the owner.

## Private evidence

Mac/runtime receipts are under `bots-devin-20261021`: backend r3 manifest and log, actual catalog readiness, live adapter report/postchecks, independent source/policy reviews, complete App acceptance, packaging/activation/resource/signature gates and postlaunch preservation/API/UI observations.

iPhone receipts are under `bots-devin-ios-20261021`: original unit and final native source manifests, raw result bundles and custody receipts, retained failed/incomplete attempts, captures, committed source pins and signing/artifact/install helpers. Raw owner data, credentials and physical device identifiers are not published.
