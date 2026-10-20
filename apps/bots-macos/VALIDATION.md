# Native Mac Bots validation

Validated on the user's Apple Silicon Mac on 2026-10-20.

- Swift package and native feature app built successfully. The final staged feature app uses the release configuration. The final test and build commands used an explicit minimal environment with no inherited API credentials.
- All 13 focused Swift tests passed. They cover exact host conversation identity, repeated snapshot stability, thinking and tool activity, shared approvals, profile creation without a prompt or VM, all six provider choices, all 108 avatar combinations, persisted Pause and Resume, per-conversation opaque model and computer choices, weekly day translation, stale transcript and catalog responses, delayed conversation creation, late takeover grants, stale computer polling, and frozen conversation computer/model/workspace display after profile edits in both host/CUA directions.
- The actual native app was opened against the disposable loopback fixture. The original CUA-derived layout, koala avatar customizer, thinking disclosure, provider and configured-model pickers, separate Maya selection, shared approval denial, computer start, takeover, keyboard, text and release controls were inspected through native accessibility and screenshots. Fixture requests confirmed the exact avatar and Maya model-source updates.
- The fixture did not run a provider, SSH session or VM. These UI checks do not establish live CUA VM acceptance.
- Strict recursive code-signature verification passed for the final release `build/StrataBots.app`. The executable SHA-256 is `dad2b2c27dab2b6eac0a19d58e2e28192e9ddc761ad7d8cc2a8f07e35dd427c5`.
- The fixture feature window was quit through its native application command and confirmed absent from the app inventory. Production Strata and StrataVM were not quit or changed by these checks.

Local evidence is under `/Users/gszulc/Projects/Strata-iphone-evidence/bots-native-ui/`: `swift-tests-frozen-context.log`, `release-frozen-context.log` and `native-fixture-validation.json`. Native screenshots were inspected through the CUA tool during the earlier fixture run. The final frozen-context change was checked by the focused regression test and release build; it did not launch a production app. No production prompts or bot profiles were created.
