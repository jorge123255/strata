# Bots provider runtime

`createBotRuntime({ stateDir, env?, fetch?, commands? })` returns:

- `providers()`: installed CLI versions, public readiness and account help. CLI presence does not prove a signed-in account or model entitlement. No credentials are returned.
- `run({ bot, sessionId, message, history, signal, onFrame, requestPermission, executeTool, checkpoint, onCheckpoint, tools })`: one provider turn. Returns `{ text, checkpoint, tokensIn, tokensOut }` and throws on provider failure or Stop.
- `close()`: stops this runtime's owned runs. It does not attach to or stop a user's existing CLI processes.

Frames use the existing conversation reducer: `delta`/`reasoning` have `text`; `agent-tool` has a `tool` card; `stats`/`done` have token counts; `error` has `message`. Providers only supply thinking events they actually emit. A status indicator is not synthesized reasoning.

`tools` are MCP definitions (`name`, `description`, `inputSchema`). `executeTool(name, args, id)` must enforce the bot's current policy and capability and return an MCP result, including image blocks where relevant. The host owns the workspace boundary, tool ledger, tool cards and approvals. The private MCP stdio bridge only exposes this allowlist. Its socket and definitions live in a private temporary directory and are removed after the run.

Claude uses the official pinned Agent SDK and installed `claude` executable, with built-ins and inherited MCP settings disabled. Grok and Kimi use ACP with a generated tool profile that permits only Strata MCP tools; no native shell, edit, subagent or automatic approval flags are enabled. These profiles are private files under `stateDir/profiles` and remain available for native session restoration. ACP session restoration replays old messages, so projection starts only after loading finishes. Codex uses app-server, a native read-only sandbox and host-owned dynamic tools. Native command/file approval is always denied: coding mutations must use the host tools. Resolved inherited MCP servers are each explicitly disabled (an empty table would only deep-merge), and the thread MCP inventory must contain no tools before sending a model prompt. Native shell, hooks, plugins, apps and multi-agent features are disabled. Broader permission grants and unsupported server requests fail closed.

Ollama Cloud uses its OpenAI-compatible streaming endpoint or an explicitly selected cloud alias in the signed-in local daemon. It never sends a cloud key to the loopback daemon. It performs no automatic alias download and never silently falls back to local Strata or Maya inference. HTTP retries never replay a completed tool mutation. The host transcript supplies stateless history; native providers persist resume identifiers through `onCheckpoint`.

The adapters currently execute on this Mac. SSH and sandbox execution targets fail with an explicit explanation. An inference API connection is not an execution transport. Native resume errors also remain visible; the runtime does not silently start another session and lose native context.

For a Mac app production package, install host dependencies with `npm ci --omit=dev --omit=optional`. The SDK's optional platform CLI binary is unnecessary because Strata uses the user's installed CLI. Keep `node_modules` beside the packaged host server; it includes the SDK and production browser driver library. Browser binaries are managed separately by the host computer tool implementation.

Validation: `node --test tests/bots-runtime.test.mjs` exercises isolated protocol fixtures, stream parsing, approval denial, native session ownership and replay, image tool results, tool allowlists, credential redaction and Stop. An actual harmless descendant that ignores TERM verifies group escalation after its leader exits. These tests do not send model prompts or prove provider entitlement. Installed Codex, Grok and Kimi initialization handshakes were also checked without creating a model turn. An ephemeral Codex thread verified zero inherited MCP tools with the isolation overrides and no model prompt.

Protocol references:

- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Claude Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Kimi agent tool profiles](https://moonshotai.github.io/kimi-code/en/customization/agents)
- [Grok agent definition and tool policy](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-agent/src/config.rs)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
