# Strata Companion for Mac

A small native Mac app that displays the secure pairing page for the iPhone companion. It launches the companion bridge, keeps a menu bar item available, and stops the bridge when you quit. Strata itself remains independent.

Requires Apple Silicon and macOS 14 or later. Build with Xcode command line tools:

```sh
cd apps/companion-mac
./build.sh
```

The result is `build/Strata Companion.app`. The build uses the Node runtime from `/Applications/Strata.app` or `node` on your path. Set `STRATA_COMPANION_NODE` to choose another Node 20+ executable. It bundles the runtime, bridge, and compiled Core Image QR helper, so normal use needs no terminal or QR service.

To build directly into Applications:

```sh
./build.sh '/Applications/Strata Companion.app'
```

Open **Strata Companion** while the desktop Strata app is running, then scan its QR code with the iPhone app. The HTTPS pairing listener uses port 8787. The pairing window is served only on loopback port 8788 with a random page capability and CSRF protection. Device sessions and TLS identity are stored privately under `~/Library/Application Support/Strata Companion`.

The local development app is ad hoc signed; distributing it to other Macs requires your own Developer ID signing and notarization. The existing Strata installer and engine are not replaced.
