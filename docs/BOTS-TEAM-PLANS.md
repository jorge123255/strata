# Durable team work plans

On an updated Mac or iPhone, open a team, select **Work**, and send a concrete goal. Strata saves that request as a work plan. The coordinator plans the work before the team starts executing it. Ordinary **Chat**, older clients, and the separate **Plan & verify** workflow keep their existing behavior.

This is a shared controller for every team. It does not install rules for a particular project or change a bot's provider, model, folder, computer, tools or approval policy. Maya remains a separate model connection.

## How the team works

The coordinator assigns concrete tasks and success criteria. Each saved member gets a role and an explanation of its participation. A member can help with implementation, independent review or another useful part of the goal. The controller does not invent busywork to make every bot appear active.

Tasks form a dependency graph. Independent tasks can run together when their saved bot and computer are available. Work on the same folder or overlapping folders waits its turn. Separate working copies can run concurrently. A shared desktop still has its existing exclusive control rules. Unverified SSH filesystem aliases are treated conservatively; naming two connections differently does not prove that they use separate filesystems.

Workers can save useful progress and a concrete next step, then continue in a fresh scoped turn after cleanup. There is no fixed work-turn or repair-round limit. Repeating an unchanged checkpoint does not count as progress. Provider failures, unavailable permissions, unsafe cleanup or unwritable checkpoint storage remain visible blockers.

For a team with multiple members, implementation needs a separate review task. A reviewer cannot review work it contributed to, including through a collaborator role or an earlier dependency. Review requires findings for every criterion and an actual successful artifact check in that review turn. A worker's result and a reviewer's pass remain reported evidence, not final owner acceptance.

Once the graph is finished, the coordinator prepares one report and the plan becomes **Ready for your review**. Accept it or request specific changes. Requested changes append repair tasks; they do not erase the completed work or the earlier owner feedback.

## Inspecting and continuing

The team's Work view shows each task's owner, collaborators, dependencies, criteria, evidence and current state. Conversation links open the exact task attempt, including its Thinking and tools. Large plans use task pages; older plan records are kept separately from the current channel window.

Stop revokes unfinished work before cleanup. Restarting Strata leaves an active plan interrupted. It does not resume a model or replay a command automatically. Inspect the saved task, its conversation and actual files, then choose **Resume** and confirm inspection. A scoped task resume keeps healthy and completed sibling tasks intact. Changed team or execution settings require restoring the saved configuration or starting a new explicitly scoped plan.

Action receipts are a separate safeguard. A lost or interrupted command can already have changed files or services. Inspect its effects before acknowledging an unresolved receipt. Receipt acknowledgement itself does not execute, resume or certify work. The controller does not clear those receipts to make a graph advance.

## Checkpoints and compatibility

The private `bot-team-plans.json` store saves execution intent before dispatch and results before advancing. Checkpoints are task boundaries, not full filesystem snapshots. The store retains immutable goal, roster and access fingerprints, structured task results and bounded attempt summaries. Detailed history remains in the existing conversations.

Plan controls bind the exact revision and proof that the owner reviewed. A stale or lost response calls for a refresh, not an automatic retry. Mac and iPhone display last-known state and report unavailable reads instead of presenting them as an empty team. Report size, paging and storage bounds do not create a work deadline.

Clients request this path only when the host advertises `teamWorkPlansSupported: true`. A legacy host continues to use its existing Work request. Installing the updated clients alone does not enable durable plans on an older host.

## Design references

This controller uses Strata's existing provider adapters, action journal and scheduler; it does not add a LangGraph dependency.

- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) informed the distinction between execution checkpoints and shared long-term stores.
- [Anthropic's harness design](https://www.anthropic.com/research/harness-design-long-running-apps) informed task decomposition, independent evaluation, explicit criteria and testing against a working application.
