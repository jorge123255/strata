# Work with a team of bots

Open **Bots** in Strata on Mac or in the paired iPhone app. The workspace has four views: **Team**, **Activity**, **Skills** and **Connections**. Individual bot conversations and their computers remain available in Team.

## Talk to a bot

Tap or click a bot to open its latest personal conversation. If it has none, Strata creates one empty conversation using the bot's saved settings. Opening a chat starts no model or computer work; send a message when ready. Team assignments remain in team history and are excluded from this personal shortcut.

Use the profile or info control to review settings and earlier conversations. **New conversation** inside a bot chat keeps that bot selected and opens its conversation setup. Existing conversations retain their saved model, computer, working folder and permissions. A paused bot's existing history remains readable; resume the bot before starting new work.

## Create a team

Choose **New team**, give it a name, select at least two members and choose a coordinator. There is no fixed member limit on an updated Strata host. By default, **Each bot’s computer** keeps every member’s saved computer and working folder. You can instead choose a shared computer and folder. Each member keeps its own model, permission mode and assigned tools. Creating or saving a team starts no model work. Review and enable the team before sending its first request.

Write a request and choose **Send to team**. The coordinator receives it in a shared conversation. It can ask a teammate for help or delegate a child task using Strata’s tools. These assignments run asynchronously in separate shared conversations. Results appear in the team channel as they finish. The coordinator resumes after its current assignments and their delegated work have replied, so it can bring that round together in one response.

On an updated Mac and iPhone, choose **Work** in the team composer for a [durable team plan](BOTS-TEAM-PLANS.md). The coordinator first saves task owners, participation reasons, dependencies and review criteria. Ready tasks use each assigned bot's files, commands, browser and authorized connectors under its saved permissions, computer and folder. A shared team computer and folder still apply. The request is labeled **Work request** in history, and the team's Work tab shows its saved plan, evidence and recovery controls. Older clients and hosts keep their existing direct Work behavior. For a volunteer round, use **Chat** so the coordinator gathers offers before assigning work.

**Chat** is the default for discussion and team routing. It keeps greetings from reserving a computer. After a successful send, the composer returns to Chat. Changing the selection or typing starts no work; only sending does. Older hosts keep their existing composer until updated. Work does not grant new connector or skill access, change permissions, or make a guest's filesystem the same as its host's.

**All available teammates** can work concurrently. There is no fixed parallel-task limit within a team or fixed limit on simultaneously active teams. An occupied bot waits until its current work and cleanup finish; bots sharing a physical desktop or isolated guest still take turns controlling it. Independent work can continue on other computers. Provider capacity and machine resources still affect throughput.

On an updated Strata host, team work continues **until finished or stopped**. There is no automatic team turn, time, message-hop or delegation-depth cutoff. The displayed turn count records usage. Individual tools still have their own execution timeouts, and model providers can return context, access or usage limits. Older hosts keep their existing work controls until updated. A bot does not inherit another member’s private conversation history, memory or credentials. Temporary child work uses a selected existing member’s profile.

A clear whole-team greeting, such as “hi everyone,” invites each available member once. Explicitly addressed members and volunteer requests also receive a useful opening round. Paused members and accounts that failed verification are not retried automatically. An existing real assignment counts as that member’s participation. Ordinary tasks go to suitable owners and collaborators.

Assignments appear as compact cards. Open one to read its full instructions. Long reports have **Read full report**; their full text remains available. Public failure messages identify model settings, provider limits or missing access without exposing private provider diagnostics. The coordinator can read public reports; private chat links are for the owner.

When you ask to continue, the coordinator can inspect the team's public task ledger across requests with `read_team_work`. It distinguishes an ended provider turn from a result awaiting review or verified work. It can read the corresponding public assignment and report, identify a specific next step, and direct you to recovery for an unfinished tracked task. Reading the ledger starts no work and exposes no private evidence or review notes. It cannot replay an old task or restore consumed approvals. A new bounded check uses a separate assignment with the current request's scope and holds.

The originating request is supplied in full as scope context for team turns. A selected continuation keeps its own bounded scope; historical requests never restore old permissions. Shortened history previews are labeled, with the full public message available to read before acting. For an ongoing preference, such as changing the team's notification instructions, the coordinator must save it through the existing team-instructions control before claiming it is saved for future turns. Saving preserves the team's other instructions and requires the current revision and the bot's approval policy. Running turns keep their existing instructions.

**Activity** shows queued, running, completed, failed, interrupted and stopped work. Open a task to follow its actual chat, thinking, tool cards and approvals. **Stop team** cancels queued assignments and requests cancellation of its running work and descendants. Strata shows unconfirmed cleanup instead of reporting success. Restarted work remains in history and is marked interrupted; Strata does not replay it automatically.

## Review results and continue unfinished tasks

In a team's **Work** tab, **Current work** puts tasks needing you and working assignments first. The Work control shows attention and working counts while you read the channel. Each card shows the owner, latest update, reported evidence and requested corrections. **Working** means the task is still running. Bots submit a summary and labeled files, checks, links or notes as evidence. A submitted result becomes **Ready for review**. The evidence is the bot's report; Strata does not claim that a provider ending its response proves the work succeeded.

Verified results and earlier tasks without structured results stay in expandable history. Active tasks and pending cleanup stay visible, including older tasks. A previous result with a continuation is labeled **Continuation created**; that label does not claim its continuation has finished. Team members and earlier team requests can also be expanded. **Turn finished** in request history records that a conversation turn ended; task verification is recorded separately. If a refresh fails, **Last known** labels the saved state and review or recovery actions wait for a successful refresh.

An empty current-work list does not establish that earlier work succeeded. When earlier records lack a verified result, the overview shows their count and a **Review earlier work** control. This expands their existing history without starting work or changing their recorded status.

Choose **Review task** to read the complete result. Check the deliverables, then choose **Mark verified**, or **Request changes** with a correction note. Verification records your review of that exact result. It starts no model work. Earlier results and reviews remain attached to the task. You can review a finished task while independent teammates keep working; its own delegated work must finish first.

For a tracked task that is **Blocked** or **Interrupted**, choose **Review recovery** on Mac or iPhone. Review the saved bot, model, computer, working folder, requested corrections and earlier completed reports. Opening this preview starts no work. Choose **Resume unfinished work** to create one new continuation for that selected task. It begins by inspecting current files and reported progress, with the original task scope and release holds retained. Native provider checkpoints and previous tool calls are not replayed automatically. Other failed tasks and completed teammates do not restart.

Recovery checks the original saved settings and current access again before starting. Changed team instructions, membership, model, folder, connectors or skills require a new explicit request with the current settings. Unconfirmed cleanup or a computer under human control also blocks recovery. A failed response can be retried with the same recovery selection without duplicating its continuation.

Older tasks retain their original history. They were created without the new access receipt, so they are not automatically marked verified or given invented recovery settings. Read their conversation and send a new explicit request to continue that older work. Individual casual bot chats remain conversations; these task states apply to concrete assignments in Teams.

## Change members, computer and working folder

Open the team’s **Team details** menu. On Mac, choose **Edit members**, **Change** beside **Computer & working folder**, or **Team settings**. On iPhone, expand **Team settings** and choose **Edit team members & settings**. Add or remove members and choose the coordinator there. Earlier public messages and completed work stay in the same team when its roster changes. Members keep their private chats, memory, credentials and identities; joining a team does not share those with teammates.

Choose **Shared team computer** when everyone should work in the same place:

- **This Mac** uses an existing folder directly on the Strata Mac. On Mac, **Choose folder** opens its folder picker. On iPhone, enter or paste that folder’s full path on the Mac.
- A saved **SSH computer** uses a full folder path on that computer. Enter the path on either device; the Mac folder picker cannot browse the remote host. The saved connection is checked when work starts.
- A member’s **isolated CUA computer** uses that member’s existing guest, browser and desktop. Choose `/workspace` or a folder inside it, such as `/workspace/project`. Keep the member hosting that guest in the team, or select another computer before removing them. Selecting a guest does not mount folders from the Mac or SSH host into it.

For example, to let the team work on a `~/botai` checkout on the Mac, choose **This Mac** and use **Choose folder** to select `botai` in your home folder. From iPhone, paste the checkout’s full absolute path on that Mac. If the checkout lives on an SSH computer, choose that saved computer and enter its full path there. A CUA guest has its own `/workspace`; selecting a host folder does not copy the checkout into the guest.

Finish or stop active team work before saving changes. If another device has changed the settings, your draft stays open. Choose **Reload latest** on Mac or **Reload latest team** on iPhone to replace the draft with the current settings, then review and save again. Earlier conversations and completed tasks retain their original settings.

Team details shows the saved computer and working folder. For a shared CUA guest, choose **Open team computer** to use its existing viewer and controls; returning leaves the team channel available. **Stop** or **Take over** cancels team runs using that guest, including queued sibling assignments. Taking over waits for running work to stop before granting control. Releasing control leaves canceled work stopped; it does not resume the team automatically. Direct Mac and SSH choices show the host and folder without a CUA desktop viewer.

## Choose effort

Effort controls how much reasoning a supported model uses. It is separate from the team’s usage count. Strata shows only effort options verified for the selected provider and model. Otherwise use **Provider default**. New conversations retain the chosen effort; an existing conversation keeps its saved settings.

## Let bots propose skills

A bot can save reusable instructions with `draft_skill`. The result appears in **Skills** as a draft. Review or edit the instructions, choose **Enable skill**, then select the bots that may use it. Editing an enabled skill returns it to review. You can still remove its existing bot assignments while it is a draft.

You can also assign instructions from Strata’s existing Skills library. These bot assignments are separate from the main chat’s enable toggle; assigning a skill does not change that toggle. Workspace restrictions still apply. Assignments and instruction versions are frozen when a bot conversation is created. Start a new conversation to use a newly assigned or revised skill. Enabling a draft requires the exact version you reviewed. If another device changed it, refresh and review the new instructions first.

Skills grant no new tool permissions, install no programs and enable no schedules.

## Connect MCP tools

In **Connections** on Mac, add an MCP server URL, a local program or import a configuration. Server URLs support HTTPS and loopback HTTP, with an optional bearer API key. Local programs use their explicitly configured environment for credentials. Programs run on the Strata Mac, including when a bot’s coding or computer tools run over SSH. Saving a connection does not start the program.

Choose **Check & discover tools** to connect and read the inventory. Then choose the allowed bots and individual tools. New connections enable no tools automatically. The iPhone can inspect connections, check them and change bot/tool access. Program setup and credentials stay on Mac.

External tool calls follow the bot’s permission mode. A server’s claim that a tool is read-only does not grant access. In Plan mode, only tools deliberately classified as read-only by the owner on Mac, both when the conversation was created and at the time of the call, can run. Classify a tool only after reviewing what it actually does.

Removing access takes effect for existing conversations. Adding tools or changing a connection requires a new conversation to gain that authority. A changed tool inventory also removes approval for changed tools. Access changes must match the version displayed in the editor, so a stale phone cannot undo a newer Mac revocation or enable an unseen tool change. Stop cancels the owned request and waits for local process cleanup; an external server may already have performed a requested action. Strata does not automatically retry a submitted mutation.

OAuth sign-in and a hosted plugin marketplace are not included. Existing model connections and model serving are managed in **Models**, independently from these bot tools.
