# Native bot companion checks

`node apps/desktop/tests/native-companion/run.mjs` compiles the actual portable
native model, drawing and transport sources for macOS 15. It exercises strict
projection bounds, avatar compatibility, negative-origin/notched/tiny-screen
placement, opt-in lifecycle and a private loopback HTTP fixture. The transport
checks declared and streamed oversized bodies, redirects, authentication,
content types, timeout and cookie isolation. It creates no windows and reads no
production Strata data or settings. The printed temporary folder contains its
native executable and measured results.

`node apps/desktop/tests/native-companion/panel-fixture.mjs` launches a separate
**test executable**, which is never packaged into Strata. It uses a fresh
`strata.companion.fixture.UUID` defaults suite and synthetic conversations. Its
editor tests focus preservation while the real native panel refreshes. Expand,
hide, keyboard navigation, View → Focus Bot Companion and exact callback IDs
can be checked through native accessibility controls. Closing the fixture editor
quits the fixture. It does not open the production Strata application.

The runner prints its private folder and loopback port. `status.json` records
actual panel state and editor focus. Explicit conversation/Activity clicks append
typed destinations to `callbacks.jsonl`. The private fixture-only route
`/__fixture/state/approval|working|thinking|completed|error|offline|oversized`
changes synthetic state. `__fixture/status` reports request counts, allowing a
hidden-panel check without creating model work.

Pure geometry tests are not physical acceptance of multiple monitors, a hardware
notch, Spaces, fullscreen, display removal, screen lock or sleep. Those need
separate native checks and should be reported separately.
