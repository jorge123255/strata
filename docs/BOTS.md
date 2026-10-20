# Bots

Open **Bots** on the Mac to make a coding bot, a computer-control bot, or a bot with both abilities. Give it a name, instructions, provider, workspace and permission mode. Saving a profile starts no work. **New chat** creates an empty shared conversation; sending a message starts the bot.

The providers are Claude Code, Codex, Grok, Kimi and Ollama Cloud. Native providers use their installed CLI and its signed-in account on the Mac. Ollama Cloud uses a private API key or the signed-in local Ollama app. The provider list distinguishes an installed program from a verified account. It reports sign-in or model errors when they occur; it does not silently switch providers.

Provider accounts, model-serving APIs and execution computers have separate roles. Adding a Strata or Maya model API does not grant shell or desktop access to that computer. Bots do not replace, restart or reconfigure those model services.

## Start a conversation

1. Choose **This Mac**, an existing workspace folder and a provider. A blank model uses the native provider's default. Ollama requires a cloud model name.
2. Start with **Ask before changes**. The bot can read its workspace, but a change or computer action waits for an Allow or Deny decision. **Plan first** exposes read-only tools. **Automatic** permits the selected bot's enabled tools without questions.
3. Choose **New chat** and send the task. The same conversation appears in the Mac's chat history and in the paired iPhone's **Bots** tab.

The phone can read the history and provider-exposed Thinking, continue the conversation, answer an approval and stop that exact conversation. It cannot retrieve provider credentials or edit execution configuration. Leaving the conversation does not stop it. Closing the host interrupts the run and retains partial output.

Each conversation keeps the profile settings it started with. Later profile edits apply to new conversations. Removing a profile keeps its existing chat history; create another bot and conversation to start new work.

## Tools and computer access

Coding tools read, list and write files in the chosen workspace. Shell commands run there after approval in Manual mode; a shell command can access other files the Mac account permits, so inspect the command before allowing it. The command environment excludes the host's API keys.

Computer tools use a separate browser per bot. Browser results contain visible page text and a screenshot. Mac desktop tools can capture the main display, click, type and press supported keys. macOS requires Screen Recording for screenshots and Accessibility for input. A requested action explains how to enable the missing permission; merely opening Bots requests neither permission.

One running conversation owns a bot browser, and only one conversation at a time can use the Mac desktop. Stop revokes tool authority, cancels pending approvals, closes a browser with pending input and drains the owned processes before releasing that control.

The first release executes providers on this Mac. SSH and sandbox profile fields are retained for setup, but starting those execution targets is explicitly unavailable until their adapters are configured. Existing remote model downloads, imports and serving controls are independent and remain available. Bot chat attachments and native session rewind are not supported in this release; ordinary chat attachments and editing are unchanged.

## Implementation

The host owns profiles, private provider settings, per-chat profile snapshots and native session checkpoints in `data/bots.json`, written atomically with private file permissions. Existing shared conversations remain the transcript authority. The companion bridge exposes only its authenticated, explicit bot catalog and conversation routes.

The native provider adapters expose only Strata-owned tools where supported. Codex runs with a read-only native sandbox, disables inherited MCP servers and optional execution features, verifies its external tool inventory, and declines native mutations. Grok and Kimi use restricted agent profiles; Claude uses the Agent SDK with native built-in tools disabled. Root tool calls share one approval and activity identity across Mac and iPhone. Ollama's tool loop stores the same events in the shared conversation.

Thinking means progress or reasoning summaries actually exposed by the selected provider. Providers that do not emit it do not get invented Thinking text.
