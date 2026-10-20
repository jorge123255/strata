# Work with a team of bots

Open **Bots** in Strata on Mac or in the paired iPhone app. The workspace has four views: **Team**, **Activity**, **Skills** and **Connections**. Individual bot conversations and their computers remain available in Team.

## Create a team

Choose **New team**, give it a name, select its members and choose a coordinator. Each member keeps its own saved model, permission mode, workspace and execution computer. Creating a team starts no model work.

Write a request and choose **Send to team**. The coordinator receives it in a shared conversation. It can ask a teammate for help or delegate a child task using Strata’s tools. These assignments run asynchronously in separate shared conversations. A completion report returns to the assigning conversation, within the team’s limits.

The default limits are two parallel tasks, two child levels, eight message hops, 24 model turns and ten minutes per request. Team settings expose these limits. A bot does not inherit another member’s private conversation history, memory or credentials. Temporary child work uses a selected existing member’s profile; it does not create an unlimited collection of saved bots.

**Activity** shows queued, running, completed, failed, interrupted and stopped work. Open a task to follow its actual chat, thinking, tool cards and approvals. **Stop team** cancels queued assignments and requests cancellation of its running work and descendants. Strata shows unconfirmed cleanup instead of reporting success. Restarted work remains in history and is marked interrupted; Strata does not replay it automatically.

## Choose effort

Effort controls how much reasoning a supported model uses. It is separate from team task and time limits. Strata shows only effort options verified for the selected provider and model. Otherwise use **Provider default**. New conversations retain the chosen effort; an existing conversation keeps its saved settings.

## Let bots propose skills

A bot can save reusable instructions with `draft_skill`. The result appears in **Skills** as a draft. Review or edit the instructions, choose **Enable skill**, then select the bots that may use it. Editing an enabled draft returns it to review.

You can also assign instructions from Strata’s existing Skills library. These bot assignments are separate from the main chat’s enable toggle; assigning a skill does not change that toggle. Workspace restrictions still apply. Assignments and instruction versions are frozen when a bot conversation is created. Start a new conversation to use a newly assigned or revised skill. Enabling a draft requires the exact version you reviewed. If another device changed it, refresh and review the new instructions first.

Skills grant no new tool permissions, install no programs and enable no schedules.

## Connect MCP tools

In **Connections** on Mac, add an MCP server URL, a local program or import a configuration. Server URLs support HTTPS and loopback HTTP, with an optional bearer API key. Local programs use their explicitly configured environment for credentials. Programs run on the Strata Mac, including when a bot’s coding or computer tools run over SSH. Saving a connection does not start the program.

Choose **Check & discover tools** to connect and read the inventory. Then choose the allowed bots and individual tools. New connections enable no tools automatically. The iPhone can inspect connections, check them and change bot/tool access. Program setup and credentials stay on Mac.

External tool calls follow the bot’s permission mode. A server’s claim that a tool is read-only does not grant access. In Plan mode, only tools deliberately classified as read-only by the owner on Mac, both when the conversation was created and at the time of the call, can run. Classify a tool only after reviewing what it actually does.

Removing access takes effect for existing conversations. Adding tools or changing a connection requires a new conversation to gain that authority. A changed tool inventory also removes approval for changed tools. Access changes must match the version displayed in the editor, so a stale phone cannot undo a newer Mac revocation or enable an unseen tool change. Stop cancels the owned request and waits for local process cleanup; an external server may already have performed a requested action. Strata does not automatically retry a submitted mutation.

OAuth sign-in and a hosted plugin marketplace are not included. Existing model connections and model serving are managed in **Models**, independently from these bot tools.
