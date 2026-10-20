# Strata Bots for Mac

The actual CUA Bots SwiftUI sample, adapted as a feature window inside Strata. It keeps the original koala avatar drawing and editor, sidebar, chat and profile inspector, computer frame, memory, outputs, rules and scheduled-work screens. See [UPSTREAM.md](UPSTREAM.md) and [LICENSE](LICENSE) for provenance and FSL-1.1-MIT terms.

Strata owns profiles, conversations, provider thinking, tool approvals, memory, outputs and schedules. The window uses the existing loopback host API. It does not create a separate history, pairing system or model account. Claude Code, Codex, Grok, Kimi, Ollama Cloud and saved Models connections are supported. Maya remains a separate connection. Each new conversation can choose its own saved model and local or SSH execution computer.

The native UI uses only Apple frameworks. It does not require a Rust build, Cua Spaces FFI or Cua Keyvault. The optional CUA computer backend is prepared explicitly on the chosen computer; preparing does not start a VM. A separate Start button creates the bot’s isolated Ubuntu computer. Computer input uses Strata’s short-lived takeover lease. Closing or backgrounding the feature window releases control.

Routines run while the Strata host is open. Permission modes enforce tool approvals; custom rules are standing instructions. Removing a bot profile retains its shared conversations and work files.

## Build

Requires macOS 14 or later and Xcode’s Swift toolchain.

```sh
apps/bots-macos/scripts/build-app.sh
open -a apps/bots-macos/build/StrataBots.app --args --strata-host http://127.0.0.1:47831
```

The build script produces `build/StrataBots.app`, including the original license and source attribution. It builds Swift only. `STRATA_BOTS_BUILD_DIR` selects a scratch directory, `STRATA_BOTS_CONFIGURATION=debug` selects a debug build, and `STRATA_BOTS_SIGN_IDENTITY` selects a signing identity. Strata’s desktop packager places the app inside its resources and signs the combined bundle.

## Validation

```sh
swift test --package-path apps/bots-macos --scratch-path /private/tmp/strata-native-bots-build -j 2
node apps/bots-macos/test-support/fixture.mjs
```

The fixture prints its loopback origin. Open the built feature window with that origin using `--strata-host`. It serves synthetic profiles, transcripts and computer frames in memory. It never runs a provider, SSH session or VM and does not use production Strata data.
