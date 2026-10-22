# Current work overview — delivery record

Product source: `cf6c8e0b2e7f09f4f2cf44e9c92fda1e34775407` on
`feature/iphone-companion`. Mac activation completed October 21, 2026,
at 20:05 CT. The matching iPhone application is **0.1.0 (29)**.

## Changes

- Current team work shows tasks needing the owner and working assignments first.
  Channel controls show attention and working counts without starting work.
- Cards show the owner, update time, reported evidence and requested corrections.
  Verified results and explicitly identified older task records remain accessible
  in expandable history. Active tasks, pending cleanup and tasks still marked
  Working remain current, including contradictory historical metadata.
- Earlier results with a continuation remain visible without claiming the
  continuation succeeded. Missing historical metadata never hides a task.
- Failed refreshes show Last known or Unavailable. An initial failed read cannot
  claim an empty current workload. Existing review and recovery actions remain
  explicit and revision protected. Request history says Turn finished instead
  of implying a verified task result.
- The host's historical marker is a read-only projection. Persisted task records,
  execution authority and model-serving connections are unchanged.

## Validation

| Check | Result |
| --- | --- |
| Focused host/bridge and retained team regressions | 144 passed |
| New Mac overview checks | 4 passed, including actual 390/1440 browser workflow |
| Retained Mac channel and explicit review/recovery browser workflows | 2 passed |
| TypeScript check and production UI build | Passed; existing chunk-size advisory |
| Fresh native Mac build | Locked release build and 29 Rust tests passed |
| Release/provenance/preservation guards | 46 passed |
| iOS units | 204 passed, 1 optional live-TLS check skipped, 0 failed |
| iOS native overview workflow | 1 passed; actual TLS bridge, 197 GETs, 0 host writes |
| Independent source, signed artifact and Mac activation reviews | 0 P1 / 0 P2 |

Fixtures use synthetic tasks and start no real model, SSH or computer work.
These checks do not claim the entire repository suite or every live provider
was exercised. The iOS native run records a frame-dimension runtime warning;
navigation assertions passed and the inspected work/history screens were readable.
Its channel screenshot was taken before the room body settled, so it supports
the count control and details entry rather than settled room-content acceptance.
No separate maximum-Dynamic-Type workflow or physical-phone UI test is claimed.

## Installed applications and preserved data

The exact accepted iPhone build 28 was installed first, then build 29 after its
new overview passed review. Fresh CoreDevice inventories confirmed each version;
the final installed version is **29**. Both updates used the existing bundle
identity and signing/keychain scope. No uninstall, pairing reset or physical
iPhone launch was performed.

The signed Mac candidate passed full resource, source, native compiler and
signature checks. Two idle snapshots plus an immediate pre-quit check passed all
13 work checks, including every conversation goal. Strata quit through native UI,
its old application and data were backed up uniquely, and the candidate was
atomically moved to `/Applications/Strata.app` and reopened at the same origin.

Post-launch verification retained **141 conversations, 570 messages, three paired
devices and nine model connections**, including owner changes made during this
work. Bot files, profiles, team jobs/runs, public history, connectors, skills,
notification records, pairing files and CUA runtime/disk identity matched the
pre-update snapshot. No data migration occurred. Maya remained separate; no Maya
service, credential, proxy or deployment action was performed. The CUA runtime
backup is a best-effort copy, not a validated VM restore.

Installed resource manifest SHA-256:
`993ad5f684c20deda39e41286d7a869d57ab2e481d6648228c53d2fdb25f4bc5`
(42,683 entries). Full signed application aggregate:
`60aa1f75b4be6add54a33439a9f237640898e9e4fc28f0e84d59730b208c41fa`.
Strict recursive signature verification passed after launch.

After the independent preservation checkpoint, native navigation verified
Channel counts, Current work and the 32 earlier records in the retained team.
History was closed afterward. Navigation may mark viewed notices read; no owner
task was reviewed, resumed or sent a model prompt.

Private evidence root:
`/Users/gszulc/Projects/Strata-iphone-evidence/strata-task-clarity-vycrb6sm`.
Key receipts: `product-source.json`, `host-focused-current.json`,
`independent-final-source-association.json`, `independent-ios29-acceptance.json`,
`phone29-installed.json`, `independent-activation-acceptance.json` and
`installed-native-ui-check.json`. Activation receipts and the unique backup path
are in `activation-attempts/attempt-134d0111`.

This delivery adds no upstream PR, merge or release publication.
