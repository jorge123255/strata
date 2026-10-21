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

## Installed result — October 21, 2026

Product source is `c69e8f68b83b7cf6b30f0a30083a126594813eba` on `feature/iphone-companion`. The team/host-folder changes were first activated at `dab336f5` at 20:43 UTC. A final host-only companion navigation correction was activated at **2026-10-21T21:04:33.629473+00:00** after the user saved the open model connection and bot setup. Both activations used native Quit, verified unique backups and atomic application renames. The existing CUA guest and its original disk stayed in place; the extra live VM copy is not claimed coherent or restore-validated.

The final two complete idle snapshots were **22.94 seconds apart**, followed by native draft inspection and an immediate pre-Quit snapshot. All 13 checks passed, including every conversation's goal between rounds. The final installed app passed all 42 artifact checks, exact comparison of **42,681 resources**, source/native hash checks and strict recursive signing after launch. Independent activation review reported zero P1/P2 findings. The prior app is preserved at `/Users/gszulc/Projects/Strata-iphone-evidence/backups/strata-companion-navigation-20261021T210404Z-9557f3ef`.

Strict before/after preservation matched **92 conversations, 436 messages, two paired devices, eight model connections and five durable pairing files**, including the newly saved bot and connection. Bot/team files, public journals, connectors, skills, notification settings and the existing CUA process/disk identities also matched. Maya was not changed or restarted. Receipts are under `activation-attempts/attempt-nav-kh_8bskf` in the private evidence directory: `activation-move.json`, `artifact-gate-after-launch.json`, `after-preservation-checks.json` and `independent-activation-acceptance.json`.

The first staged package was withdrawn because generated bridge staging deleted tracked `.gitignore` metadata; `dab336f5` fixes that behavior and passed eight staging regressions. That withdrawn package was never activated. Raw failed attempts and every earlier accepted package remain preserved.

The native companion's initial production check exposed a host filter dropping Activity and chat destinations. The final correction passed 40 notification/APNs/browser/companion checks, 23 independent service/private-adapter checks, a fresh production compiler and 29 Rust tests. Five checks against the actual installed host module also passed with disposable synthetic inputs. Whole-app native Activity/chat clicks were held when the owner resumed an unsaved New bot setup; those clicks are not claimed accepted. The temporary companion setting was restored to its original off/main value without navigating away from that draft. See `STRATA-NATIVE-COMPANION-VALIDATION.md` for the native scope.

**iPhone build 25 is installed and its installed version verified.** The existing development profile, bundle and Keychain identity were retained. No physical-phone launch or UI acceptance is claimed. The simulator grant/revoke workflow passed and its owned QA simulator is shut down. Live remote SSH execution and VM execution are outside these synthetic regression results; remote folder access still requires preparing the updated private SSH worker.
