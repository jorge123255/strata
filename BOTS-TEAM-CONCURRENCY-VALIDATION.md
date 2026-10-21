# Team concurrency and isolated host folders

User-requested fork update, October 21, 2026. Maya model connections and serving configuration are separate from this feature.

## Behavior

- Shared host teams no longer reserve an entire Mac or SSH account for a model turn. Independent teams, private coding chats and separate bot browser contexts may overlap. Actual physical desktop input remains exclusively leased after approval until the turn finishes.
- An isolated CUA desktop remains exclusive to its exact owner and execution computer. Teams sharing that guest queue; distinct guests may run concurrently on the same SSH account. Manual takeover and uncertain-cleanup checks remain enforced.
- Failed admission after a team message was accepted now settles the exact pending assignment. Stop waits for all integration cleanups, including when another cleanup fails early; durable reporting failures cannot leave Stop waiting forever.
- Team reports and coordinator deliveries show bounded, fixed explanations for account/access failures, usage limits, step limits and computer contention. Raw provider diagnostics are not copied to peers. HTTP 401/402/403 blocks automatic reassignment to that same bot within the run; a new explicit user request can retry.

The inspected Rule Breakers history had three configured-model HTTP 402 failures and one 32-step limit. Those are recorded causes, not evidence of a broken browser. A provider account rejection still requires its owner to review credits/access in Models; this update does not change accounts or pay for credits.

## Explicit host-folder share

Open an isolated bot's profile → **Shared host folder** on Mac or iPhone. Enable sharing, choose a full folder path on the execution computer, select **Read only** (default) or **Read and write**, then save. Mac can choose a local directory; the phone accepts the host path and does not share iPhone files. Remote folders require the updated private SSH worker, prepared through the existing Mac controls.

Only `host_list_files`, `host_read_file` and, for a writable grant, `host_write_file` access the selected directory. These are bounded UTF-8 file tools: 1 MB reads and 2 MB atomic writes. They do not mount/synchronize a folder, provide a host shell, or move guest browser/command execution onto the host. Plan excludes writes; Ask requires approval; Bypass respects the selected grant.

New chats freeze the explicit grant's owner, revision, directory identity and execution account. Shared-guest teams inherit the anchor bot's grant. Changing execution clears it; old conversations do not acquire new authority. Changing/removing a grant revokes older snapshots, including when an identical directory is later re-added. Removal aborts and awaits pending owned file operations. Directory descriptors, symlink checks, root/parent identity checks and a fresh precommit authorization bound each operation. SSH checks also bind the actual remote machine/account identity, track fresh folder workers in the existing activity registry, and retain unknown cleanup until a verified idle check succeeds.

Authenticated phone grants are narrow/versioned, bounded in flight, cancelled on pairing revocation, disconnect and bridge shutdown, and rechecked before the Mac saves them. No folder is shared merely by opening settings or creating a bot.

Parallel host coding is not separate filesystem worktrees. Coordinators must still assign non-overlapping file ownership when teammates edit one project.

## Validation and activation

Private evidence: `/Users/gszulc/Projects/Strata-iphone-evidence/strata-team-concurrency-49eoj00o`.

All 513 bot/bridge and desktop bridge-staging checks passed. Focused backend/paired TLS checks, actual Chromium settings navigation and simulator grant/revoke navigation use disposable files and synthetic providers. They start no owner model turns, VM, remote SSH session or user approval. The simulator workflow successfully saved a read-only grant and removed it using explicit null; opening settings issued reads only. iOS unit checks: 171 executed, one existing skip, zero failures. TypeScript checking and production UI build passed.

Initial broad checks exposed a compatibility regression in optional folder recovery and two older browser fixture gaps. Recovery now leaves ordinary probes unchanged when no folder cleanup is unknown; actual recovery still requires exact account/idleness proof. Browser fixtures now use the canonical build directory and implement the existing read-only supervision poll. Raw failed attempts are retained with the successful reruns.

Source/packaging acceptance and final activation receipts are recorded separately. At this document's initial commit the installed Mac remains the accepted `d1aab24c` carrier; the animated native companion and this update are not claimed installed. Existing iPhone build 24, pairing and conversation data remain unchanged until explicit installation.
