# Companion validation — October 19, 2026

Source base: upstream and fork `main` at `e88ee39d1d6be6e3364183af3b39b62a7ed6f211`. Companion changes are opt-in and live in separate app folders; the existing desktop host and engine are not modified.

## Passed

- Native iOS build and launch on iPhone 17 Pro simulator, iOS 26.5, Xcode 26.6.
- Nine iOS unit tests: invitation validation, exact certificate digest, bounded request construction, and four delayed-response state-race regressions. Race fixtures use isolated URLProtocol responses and never use the saved pairing Keychain.
- Four UI flows through the actual app: unpaired navigation and manual pairing rejection of insecure addresses, invalid fingerprints, and invalid codes.
- Live TLS test against the Mac companion: the invited certificate reaches the authenticated endpoint; a different fingerprint fails before an HTTP response.
- Live UI flow: actual Mac pairing, configured API model library, streamed `STRATA_PHONE_OK` model reply, app relaunch, saved Keychain pairing, and conversation history restoration.
- Native Mac companion build and launch, local Core Image QR generation, secure listener, existing Strata host discovery, and normal Quit stopping its child bridge.
- Development-signed iPhone build and installation on the connected iPhone 15 Pro. Installed bundle `com.strata.companion.ios`, version 0.1.0 (1), verified through CoreDevice. A separate development profile was created for Strata using the already registered phone and existing signing certificate.

All fourteen bridge Node tests passed. They cover pairing, TLS identity stability, token hashing/revocation, admin restrictions, narrow controls, secret filtering, streaming/truncation, concurrent turns, selected native-instance consistency, and revocation while a model action awaits a snapshot. These use temporary identities and a mock desktop host. See `apps/companion-bridge/test/bridge.test.mjs`.

## Limits

The iPhone was locked when a remote launch was attempted, so this record confirms physical installation, not an accepted physical pairing/camera flow. Unlock the phone, open Strata, and scan the Mac companion QR code to complete that check.

The Mac has configured API models but no downloaded local native model. The real chat test used a configured API model through the Mac. Native load/unload and multiple-instance routing were verified with fixtures; native inference was not exercised. Desktop conversation synchronization and desktop agent tools are outside this companion's scope. No model download or live engine restart was performed.

Result bundles, screenshots, signing materials, device data, and live invitations are kept outside tracked source files.
