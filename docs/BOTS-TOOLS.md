# Tools that bots can build

Bots can write scripts, test them, and save reusable command tools. A tool can check a project, transform a file, or wrap a command that a team uses often. Skills remain reusable instructions; executable tools have their own library.

Ask a coding bot, or a team in **Work** mode, to build what it needs. For example:

> Build a tool that checks this project's build output. Test it on this computer and save a reusable draft. Keep the current folder and approval settings.

The bot can use its existing file and command tools to build the script, call `draft_tool` to save its command and input definition, and use `test_created_tool` to test its own exact draft. A failed command or denied approval remains a failure. Saving a draft never runs it.

Open **Bots → Tools** on Mac, or **Skills → Tools** on iPhone, to review the command, inputs, timeout, creator and version. Enable a reviewed tool and choose the bots or teams that may use it. A content change returns it to Draft. Saving or sharing does not start a task.

Assigned versions are captured when a conversation starts. Start a new bot conversation or team task after granting access. A bot discovers its assigned tools with `list_created_tools`, reads their definitions with `read_created_tool`, and calls `run_created_tool`. Revoking, changing or deleting a tool immediately prevents further calls to the old version.

## Computers and permissions

Tools run on the conversation's selected computer and in its selected working folder. That can be this Mac, an SSH computer, or an isolated CUA computer. A team using a shared computer keeps using that computer. There is no fallback to running an SSH or isolated tool on the Mac host.

Each call uses the bot's existing command permission. Manual mode requests approval, bypass mode uses its saved policy, and Plan mode cannot create or execute command tools. Ordinary team Chat messages retain their existing restrictions; choose Work to carry out a task. Tools do not change accounts, folder shares, capabilities or approval settings. A missing dependency must be prepared through the bot's existing tools and permissions.

Stopping a bot also cancels its tool command through the existing local, SSH or isolated-computer cleanup path. Tool activity and results use the shared conversation history, so Mac and iPhone show the same work.

## Inputs are data

A tool declares a small JSON object of text, number, integer or boolean inputs. The command receives the complete input object in the `STRATA_TOOL_INPUT` environment variable. Inputs are not substituted into the command text.

For a Python script:

```python
import json
import os

inputs = json.loads(os.environ["STRATA_TOOL_INPUT"])
print(inputs["project"])
```

The command might be `python3 scripts/check_project.py`, with this input definition:

```json
{
  "type": "object",
  "properties": {
    "project": { "type": "string", "maxLength": 200 }
  },
  "required": ["project"],
  "additionalProperties": false
}
```

Keep passwords and API keys out of saved commands and input definitions. Use the configured connector or the execution computer's existing account setup when a service requires credentials.

Tools save commands, not copies of workspace files or installed dependencies. A script-based tool needs its script in the selected workspace. Shared commands should fit the operating system and dependencies of the computer where they run. Test results in a conversation describe that execution; enabling a tool does not certify that it works on every computer.
