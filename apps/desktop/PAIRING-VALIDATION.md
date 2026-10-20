# Built-in pairing validation — October 19, 2026

The update adds **Pair iPhone** to Strata's own sidebar and **Settings → iPhone**. It reuses the existing carrier and keeps the desktop host on its original loopback origin. Pairing is opt-in and restores on launch only after the user enabled it.

## Passed

- TypeScript checking and production UI build.
- Twenty-seven bridge, manager, and route tests, independently repeated with the shipped Node v24.12.0. These cover exact local origin/Host restrictions, opt-in persistence across launches, certificate/token reuse, renewal/revocation, and bounded shutdown that saves interrupted phone chats.
- Isolated browser UI: opening the panel without starting a listener; enabling; decoding the actual Core Image QR; pairing over certificate-pinned TLS; code renewal; remembered devices after disabling; re-enabling; cancelling and confirming device removal; immediate revocation; no polling after panel closure; dark/light layouts and widths from 420 to 1512 pixels. No browser exceptions were observed.
- Packaged app signature verification before launch and exact source matching of the new host and bridge. The existing Node, Control, Harness, and engine component files were preserved. Native executable code matched the original after excluding signature metadata.
- The launch check caught Control refreshing Python bytecode inside the signed bundle. Packaged Control now disables bytecode writes. Three regression tests include a real bundled-Python positive control and prove signed bytecode stays unchanged. The original bytecode was restored, and the installed app was re-signed and relaunched for another integrity check.
- Installed app: a fresh idle check showed zero active turns, approvals, inference requests, and native jobs before graceful restart. **Pair iPhone** opened the built-in Settings section; enabling displayed a real QR code and retained the existing simulator pairing. The simulator reconnected through the integrated service.
- The iPhone received build 2 with instructions for the built-in Mac screen. It was not opened remotely, following the user's preference.

## Broader test suite

The full host test run reported 839 tests: 743 passed, 8 failed, and 88 skipped. All eight failing test names also failed in a clean, dependency-matched baseline at `f161516f`; the baseline additionally had one transient gateway failure. The unchanged failing areas were chat folder paths, native settings paths, packaged Control path fixtures, request cancellation timing, and descendant process termination. The new pairing tests passed.

## Limits

Physical iPhone QR scanning remains for the user to perform. The existing certificate and saved pairing were exercised with the simulator. Native model load/unload routing has fixture coverage; no downloaded native model was available for real inference. This is a locally signed development package, without a new distribution notarization ticket.
