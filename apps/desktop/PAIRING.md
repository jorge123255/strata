# Pair an iPhone from Strata on Mac

Choose **Pair iPhone** in the sidebar, or **Settings → iPhone**, then **Enable iPhone pairing**. Scan the QR code from the Strata iPhone app and confirm the connection. Use the same trusted Wi-Fi network for the initial QR connection, or enter the Mac's Tailscale address manually when both devices are connected to your Tailscale network.

Pairing stays off until enabled. Once enabled, Strata restores the connection service on subsequent launches. **Disable pairing** closes its listeners without forgetting paired phones. **Remove device** revokes that phone's access. New invitation codes expire after five minutes and work once. The panel also provides copyable connection details for manual setup.

The desktop app uses the same private certificate, device sessions, and phone conversations as the older standalone helper. Quit **Strata Companion** before enabling the built-in service; only one service can own the pairing ports at a time. The Mac's existing inference host remains on loopback, and the phone receives only the companion's narrow authenticated HTTPS controls.

## Connect over Tailscale

Keep Tailscale connected on the Mac and iPhone. The Mac must remain awake with Strata open and iPhone pairing enabled. **Pair iPhone → Connect away from home** shows this Mac's detected Tailscale address. Strata discovers its own address; it does not change Tailscale settings, open a public tunnel or expose the inference host.

An updated paired iPhone learns the Mac's available addresses while connected. It can switch between those addresses for read requests using the same pinned certificate and saved pairing. If the phone is already away and knows only the old Wi-Fi address, choose **Connection → Update Mac address** and enter the Tailscale address shown on the Mac. The app checks that it reaches the same trusted Mac before saving. Pairing, conversations and model settings are retained.

The Mac refreshes detected addresses while pairing is enabled, including when Tailscale connects after Strata starts. An older Mac without address discovery remains compatible with manual address updates. If Tailscale is connected but the Mac is unreachable, check that your tailnet access policy allows the iPhone to reach the companion's HTTPS port (8787 by default), and that the Mac accepts incoming Tailscale connections. Tailscale on the iPhone needs its VPN connection enabled.

Strata never automatically resends a message, approval, model operation or computer action on another address after a connection failure. Check the task's current state before retrying an interrupted operation. A read-only connection check does not establish that a previous command failed to run.

On iPhone, open **Chat → History** to reopen a Mac conversation and continue its work. The same messages and browser/tool activity appear on both screens. Existing conversations keep their model, folder and permission mode. Pending tool requests can be allowed or denied on the phone. Closing the phone app leaves Mac work running; **Stop** ends the selected turn explicitly.

The updated Mac app imports existing desktop chat history into a private conversation store. If you enable pairing for the first time while a Mac reply is already running, that conversation is shared after the current reply finishes; keep its Mac window open until then. Earlier phone-only chats remain available separately. Existing paired phones stay paired through this update. The iPhone includes the Mac's Thinking text in an expandable section and keeps progress text and activity summaries in their original order. Browser action cards show addresses, progress and text results; they do not stream the browser's screen.

The iPhone's **Models → Download models** can prepare models on the paired Mac or its saved Strata connections. Review the named destination, storage and preparation warnings before starting. Downloads continue on that computer when the phone closes. See [models on another computer](../host/REMOTE-MODELS.md) for remote downloads and GGUF imports from the Mac app.

## Build using an installed Mac carrier

Install dependencies under `apps/host`, then from `apps/desktop`:

```sh
./scripts/build-mac-companion-app.sh /path/to/new/Strata.app
```

The output path must be new. The script copies the installed `/Applications/Strata.app` carrier, builds the UI, stages the shared pairing service and Core Image QR helper, and updates the copied host. It preserves the existing engine, Control, Harness, and Node binaries and their signatures. It signs the outer local app ad hoc; distribution to other Macs requires Developer ID signing and notarization. Set `STRATA_BASE_APP` to use another installed base.

The normal `npm run build:app` and `npm run dmg` commands also stage the pairing resources. When invoking Cargo directly, run `node scripts/stage-companion.mjs` first.

The running app must be relaunched to load a newly installed host. Finish active Strata tasks before quitting; its existing shutdown path ends app-owned agent turns and models. The fixed desktop origin is preserved to retain desktop conversation storage.
