# Pair an iPhone from Strata on Mac

Choose **Pair iPhone** in the sidebar, or **Settings → iPhone**, then **Enable iPhone pairing**. Scan the QR code from the Strata iPhone app and confirm the connection. Both devices must be on the same trusted network.

Pairing stays off until enabled. Once enabled, Strata restores the connection service on subsequent launches. **Disable pairing** closes its listeners without forgetting paired phones. **Remove device** revokes that phone's access. New invitation codes expire after five minutes and work once. The panel also provides copyable connection details for manual setup.

The desktop app uses the same private certificate, device sessions, and phone conversations as the older standalone helper. Quit **Strata Companion** before enabling the built-in service; only one service can own the pairing ports at a time. The Mac's existing inference host remains on loopback, and the phone receives only the companion's narrow authenticated HTTPS controls.

## Build using an installed Mac carrier

Install dependencies under `apps/host`, then from `apps/desktop`:

```sh
./scripts/build-mac-companion-app.sh /path/to/new/Strata.app
```

The output path must be new. The script copies the installed `/Applications/Strata.app` carrier, builds the UI, stages the shared pairing service and Core Image QR helper, and updates the copied host. It preserves the existing engine, Control, Harness, and Node binaries and their signatures. It signs the outer local app ad hoc; distribution to other Macs requires Developer ID signing and notarization. Set `STRATA_BASE_APP` to use another installed base.

The normal `npm run build:app` and `npm run dmg` commands also stage the pairing resources. When invoking Cargo directly, run `node scripts/stage-companion.mjs` first.

The running app must be relaunched to load a newly installed host. Finish active Strata tasks before quitting; its existing shutdown path ends app-owned agent turns and models. The fixed desktop origin is preserved to retain desktop conversation storage.
