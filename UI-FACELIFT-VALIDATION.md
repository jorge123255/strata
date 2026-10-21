# Mac and iPhone appearance update — October 20, 2026

The interface takes its direction from the user's actual local BotAI desktop and mobile designs. Strata now uses system typography, neutral light/dark surfaces, blue selection, monochrome primary actions, clearer bot identities and a floating composer. The mint Strata mark and existing character avatars are retained. The implementation uses Strata's own components; BotAI was inspected read-only.

## Mac

Source: `ea14977ee366d8ffd0ed0b6530cff38f26c6d39c`. The main navigation puts Bots, Models, Skills and Monitor above the workspace folders and adds access to the existing command palette. Bots has a compact roster, shared conversation, optional inspector and consistent Team, Activity, Skills and Connections surfaces. The inspector starts closed in compact windows and can still be opened explicitly. Model controls wrap inside their cards in narrow windows.

- Typecheck and production UI build passed. The existing embedded-Bots and teamwork browser suites passed, including configured-model/SSH boundaries, skill review/access controls, shared chat selection and explicit compact-window inspector controls.
- Twenty-six targeted chat, navigation, model and preview checks passed. Independent review found zero unresolved P1/P2 issues. It independently verified corrections to user-message Markdown link/table contrast and reran the browser workflows.
- The actual compiled App passed **138 checks**, with 38 screenshots across light/dark at 1440, 1024 and 390 pixels. These check navigation, real keyboard focus, model-control bounds, reading size, interface scaling, reduced motion, increased contrast and targeted rendered text contrast. The targeted minimum ratio was 5.01:1; this is not a blanket WCAG audit. The private harness used disposable data and synthetic cached messages, with no model prompt or production request.
- Two further issues were corrected during validation: old styles overriding keyboard focus/accent contrast, and a default inspector covering the conversation in a narrow native window. Earlier successful evidence remains retained separately from the final compact-window follow-up.

The final signed package passed 32 artifact checks and was activated at `2026-10-20T23:50:09Z`. All nine compiled HTML/JS/CSS assets match the actual-App acceptance build. After launch, all **42,661 resource entries** matched the staged manifest and strict recursive code-signature verification passed. Resource manifest SHA-256: `688a02f38241ae9872a96580583eb4ffce2da4564ee38cc115265dd99b9b971d`.

Two complete idle snapshots more than ten seconds apart and a fresh prequit check passed before the native quit. The host restarted at the same local origin. The preserved state matched exactly: **8 conversations, 136 messages, 2 paired devices, 7 model connections**, all bot/workspace files, and five durable pairing files. TEST's original running CUA guest, canonical runtime and disk identities remained in place. Read-only computer discovery reported This Mac and both saved SSH Strata computers available. No model prompt was sent.

The previous app and verified non-CUA owner/pairing data were preserved in the unique private backup `strata-facelift-20261020T235007Z-81abc12a`. The separate live CUA-runtime copy is best effort; restoring it as a coherent VM backup has not been validated. Activation used same-volume atomic renames with a rollback path. Native inspection confirmed the integrated Bots workspace, retained TEST history, Thinking and browser-tool activity.

## iPhone

Product source: `bf3533d1e00334155eab74ba77f6197e367cb7f4`. Build **0.1.0 (11)** refreshes Home, Bots, shared chat/Thinking, tools, models/downloads, computer controls and connection/pairing screens. Native material has an opaque fallback when unavailable or reduced transparency is requested. Large-text identity/status headers stack instead of squeezing the hostname.

- The final Swift suite executed **75 tests: 74 passed, one optional live TLS test skipped, zero failures**. The additional contrast check covers ordinary and increased-contrast text, bubbles, buttons and status colors in both themes.
- The read-only native appearance workflow passed in light mode, normal dark mode, and dark mode with accessibility text size and increased contrast. It visited the principal screens, all four Bots workspace destinations and older shared history/Thinking. All recorded host calls were GET. Early offscreen-history test lookup failures were repaired in the test helper; initial failing runs are retained privately.
- The signed device artifact passed **17 artifact/source checks**, including strict recursive signature, the exact retained profile/certificate, unchanged pairing Keychain entitlements and all 33 product/project/resource/scheme inputs matching the committed tree. Input aggregate SHA-256: `732dbc34cd44a454d84bb099acdd16a6c609abe26dd1567caad00aa46d7c29dc`. Executable SHA-256: `c61347b06032a6f2e1558f84fe5c49d0ad31489eb7407cd96e5af073eb82146d`.

All **seven final native interaction regressions passed**, with zero failures/skips: Skills (75.740 s), Connections (62.850 s), Teams (92.489 s), Bots shared history/configured model/SSH target/continuation (99.506 s), avatars and computer controls (90.305 s), shared chat/browser/approvals (77.405 s), and model-download review/progress/cancel/retry/remote target (77.325 s). These use actual native UI and the loopback bridge with synthetic host/computer fixtures. Independent review found zero P1/P2 in the new test flow and confirmed existing assertions were retained.

The exact-source native appearance passes also completed in light mode (84.617 s), normal dark mode (90.284 s), and dark mode with accessibility text size plus increased contrast (99.105 s). All three made nonempty, GET-only host-call ledgers. The final run covers ten native workflows in total. Safe synthetic screenshots were inspected; visual checkpoints are distinct from interaction assertions and the separate unit contrast checks.

After the user explicitly requested installation, the exact gated build **0.1.0 (11)** was installed on the existing iPhone. Fresh CoreDevice application inventory confirmed the installed bundle and version. Strict signature, all 33 source inputs, artifact/profile hashes and fresh device/profile eligibility were rechecked before installation; artifact hashes were unchanged afterward. The existing signing setup and Keychain access were retained, and build 10 remains available privately for recovery. The app was **not launched** and no physical UI automation was run; the user will test it themselves. Physical UI acceptance is not claimed.

## Preservation and evidence

The facelift does not change the host/bridge APIs, domain stores, model management or provider implementations. Existing shared chat/Thinking, teams, skill/MCP review, avatars, local/SSH execution and computer controls remain in place. Maya and the separate Strata connections remain distinct. No production model prompt, new MCP grant, model-service restart or credential rotation was part of this work.

Private evidence is outside the repository under `Strata-iphone-evidence/facelift-20261020`, `bots-facelift-20261020`, `bots-responsive-20261020`, `bots-facelift-ios-20261020` and the source-pinned Mac activation directories. Simulator fixtures do not prove live-provider, SSH or physical-phone behavior. The three existing broad host failures recorded in [Bots teamwork validation](BOTS-TEAMWORK-VALIDATION.md) were not claimed repaired by this appearance update.
