# Bots

Open **Bots** on the Mac to make a coding bot, a computer-control bot, or a bot with both abilities. Give it a name, avatar, instructions, provider, workspace and permission mode. Saving a profile starts no work. **New chat** creates an empty shared conversation; sending a message starts the bot.

Native providers are Claude Code, Codex, Grok, Kimi and Ollama Cloud. Native providers use the installed CLI and signed-in account on the selected execution computer. You can also choose **Configured Models** to use a saved model API or a currently serving local model from Models. Ollama Cloud uses a private API key or the signed-in local Ollama app. The provider list distinguishes an installed program from a verified account. It reports sign-in or model errors when they occur; it does not silently switch providers.

Provider accounts, model-serving APIs and execution computers have separate roles. Adding a Strata or Maya model API does not grant shell or desktop access to that computer. Bots do not replace, restart or reconfigure those model services.

## Start a conversation

1. Choose **This Mac** or an SSH computer, the full path to a workspace on that computer, and a provider or configured model. A blank native model uses that provider's default. Ollama requires a cloud model name. Downloaded or imported local models must already be serving before they appear as bot choices.
2. Start with **Ask before changes**. The bot can read its workspace, but a change or computer action waits for an Allow or Deny decision. **Plan first** exposes read-only tools. **Automatic** permits the selected bot's enabled tools without questions.
3. Choose **New chat**, review the computer, model and workspace, then send the task. The same conversation appears in the Mac's chat history and in the paired iPhone's **Bots** tab.

The phone can read the history and provider-exposed Thinking, continue the conversation, answer an approval and stop that exact conversation. It can select a computer prepared on the Mac, a configured model and its workspace for a new chat. It cannot retrieve credentials or change SSH connection settings. Leaving the conversation does not stop it. Closing the host interrupts the run and retains partial output.

Each conversation keeps the avatar, execution computer, model and profile settings it started with. Later profile edits apply to new conversations. Removing a profile keeps its existing chat history; create another bot and conversation to start new work.

## Tools and computer access

Coding tools read, list and write files in the chosen workspace on the execution computer. Shell commands run there after approval in Manual mode; a shell command can access other files the Mac account permits, so inspect the command before allowing it. The command environment excludes the host's API keys. Configured-model keys stay on the Mac and are never copied to the phone or SSH worker.

Computer tools use a separate browser per bot. SSH Linux computers use a headless browser and return page text and screenshots; native desktop input currently requires macOS. Browser results contain visible page text and a screenshot. Mac desktop tools can capture the main display, click, type and press supported keys. macOS requires Screen Recording for screenshots and Accessibility for input. A requested action explains how to enable the missing permission; merely opening Bots requests neither permission.

One running conversation owns a bot browser, and only one conversation at a time can use the Mac desktop. Stop revokes tool authority, cancels pending approvals, closes a browser with pending input and drains the owned processes before releasing that control.

## SSH computers

Saved SSH settings from model-management connections appear as execution choices. You can also enter another host or SSH alias, its optional user, and optional port. Leaving the user or port blank uses your SSH configuration; no account name is hardcoded. Model API keys do not provide SSH access. System SSH keys and known-host verification remain in charge of authentication.

**Check SSH computer** reads readiness. **Prepare SSH computer** installs a private versioned worker and its pinned dependencies in that SSH account's `~/.local/share/strata/` folder. If Node is missing, Prepare installs a checksum-verified private Node runtime. It does not change system packages, install or sign in native providers, change the model server, or load a model. Native providers must be installed and signed in on that computer. Configured Models use inference from the selected saved API, with all bot tools running on the chosen execution computer.

Approvals return to the same shared chat on Mac and iPhone. **Stop** revokes remote tool authority and waits for cleanup. A disconnected worker also has a heartbeat lease. Strata never replays a disconnected turn or falls back to the Mac. If cleanup cannot be confirmed, the target is blocked until an explicit readiness check confirms no worker remains. A native conversation also pins the remote machine and account identity; a changed SSH alias cannot resume a session on another machine.

The legacy generic Sandbox target remains unavailable; isolated CUA computers use their explicit adapter. Existing remote model downloads, imports and serving controls remain independent. Bot chat attachments and native session rewind are unsupported; ordinary chat attachments and editing are unchanged.

## Implementation

The host owns profiles, private provider settings, per-chat profile snapshots and native session checkpoints in `data/bots.json`, written atomically with private file permissions. Existing shared conversations remain the transcript authority. The companion bridge exposes only its authenticated, explicit bot catalog and conversation routes.

The native provider adapters expose only Strata-owned tools where supported. Codex runs with a read-only native sandbox, disables inherited MCP servers and optional execution features, verifies its external tool inventory, and declines native mutations. Grok and Kimi use restricted agent profiles; Claude uses the Agent SDK with native built-in tools disabled. Root tool calls share one approval and activity identity across Mac and iPhone. Ollama's tool loop stores the same events in the shared conversation.

Thinking means progress or reasoning summaries actually exposed by the selected provider. Providers that do not emit it do not get invented Thinking text.

## Native CUA Bots interface

The packaged Mac app opens a native SwiftUI Bots window adapted from the exact `examples/cua-bots-macos` sample in the user's CUA fork. It retains the sample's bot list, Koala avatar customization, chat/profile split, computer pane, memory, outputs and routine screens. The host remains the authority for conversations, Thinking, approvals and storage; this window does not create a second account, pairing system or transcript. The paired iPhone uses the same avatar configurations and shared conversations.

Choose **Isolated CUA computer** to use a bot-owned Linux desktop instead of host tools. Its workspace is `/workspace`. Merely opening a computer view reads readiness; **Prepare CUA** installs the pinned private SDK, and **Start computer** explicitly creates or resumes that bot's desktop. Linux preparation downloads signed Ubuntu packages and extracts QEMU into the private Strata account folder without running package scripts or changing the system package database. On macOS an existing QEMU installation is required. Starting a desktop downloads the official CUA Linux image and needs sufficient disk space. The selected provider runs on the selected execution computer; enabled coding and computer tools operate inside the isolated desktop. No inference or tool execution silently falls back to another computer.

The computer pane shows refreshed screenshots rather than the sample's native streaming decoder. **Take over** first stops owned bot work and then grants a short-lived control lease. Only the device holding that lease can click, type or send keys. Release control or close the view to relinquish it. Starting another bot turn while a person owns control is refused. **Stop computer** reboots the isolated guest, verifies a changed kernel boot identity, and suspends the fresh guest before acknowledging cleanup, because QEMU suspension alone preserves guest processes. Guest disk files remain. A cleanup failure blocks further bot work until explicit computer Stop confirms recovery.

**Pause** stops all of that bot's active conversations and prevents new turns and routine runs. **Resume** permits future work and starts no task or computer by itself. Stop its isolated computer and release human control before removing a bot profile. Removal retains conversation history and private memory/output files, and disables its routines.

Memory, deliverables and standing instructions are kept in private per-bot volumes under `data/bot-volumes/`. Standing action preferences are prompt guidance; the selected Manual, Plan or Automatic permission mode still controls tools. Only successful completed `write_file` events mirror `memory/MEMORY.md` and `outputs/` into those volumes. Routines are disabled by default. Enabled schedules run while Strata is open, use an explicit time zone, create ordinary shared bot conversations, and retain the bot's permission mode. Restart and Resume do not replay missed intervals.

CUA-derived native UI and avatar files retain FSL-1.1-MIT notices and pinned provenance in `apps/bots-macos/UPSTREAM.md` and `apps/ios/StrataMobile/CuaBots/`. The computer backend uses the official MIT CUA SDK; its desktop image includes separately licensed CUA components. Strata does not bundle the sample's Keyvault or native streaming decoder.

The pinned released CUA SDK requires existing KVM access for Linux hardware virtualization; accounts without it remain unavailable and receive an actionable readiness message. Preparation grants no host permissions. A suspended desktop can resume; this SDK cannot resume a QEMU desktop that has fully powered off. Strata retains that disk and reports the limitation instead of deleting or silently replacing it.
