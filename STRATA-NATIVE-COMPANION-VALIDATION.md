# Native Mac bot companion

October 21, 2026. This slice adds an optional native panel to Strata's existing Mac process and bundle. It keeps the Bots workspace, shared Mac/iPhone conversations and thinking, team coordination, providers, SSH execution, model management, Connectors, notifications and CUA controls. Maya stays separate. The iPhone application is unchanged by this Mac-only slice.

## Behavior and scope

- Settings → Appearance → Bot companion enables the panel and selects a display. It starts off, retains a disconnected display choice and uses the main display until that display returns.
- Compact mode highlights an actual urgent bot conversation. Expansion shows at most six bounded rows. Explicit clicks open the exact existing conversation or Bots → Activity. Automatic presentation does not take keyboard focus. View → Focus Bot Companion provides keyboard access.
- Original Strata vector characters blink, breathe, glance and react to activity. One focused character moves; dense list faces are static. Freshly observed work finishing can trigger a brief response; historical completion and polling do not replay it. Interacting with the face is cosmetic.
- Reduced motion, hidden/disabled state, stale activity, screen sleep and inactive/locked sessions stop character motion. The native controller cancels requests and invalidates stale callbacks during lifecycle changes.
- A private per-launch loopback read credential carries up to 8,192 bytes of status. It does not carry transcript, approval identifiers, tool arguments/results or profile credentials. Neither this feed nor a character interaction can start work, approve tools or open an arbitrary URL.
- Hiding the companion disables that panel. Strata retains its existing main-window close/Quit behavior. No second production app, sound, remote artwork, extra Apple identity or Coucou character asset is added.

## Validation and delivery

Source/UI validation, the fresh Rust/Swift compiler output, signed packaging and activation are separate checks. Private receipts are retained under `/Users/gszulc/Projects/Strata-iphone-evidence/coucou-companion-20261021-wuaj9b5n`.

The actual Settings component passed 25 browser checks covering native canonical state, opt-in settings, keyboard/display controls, disconnected/reconnected displays, light/dark and narrow layouts, reduced motion, timeout and cancellation races. The focused host and retained notification/supervision suite passed 18 tests. TypeScript and the production UI build passed. Final native motion, source review, package and activation results are recorded after their corresponding checks finish.

Native tests and a disposable, distinctly named fixture use synthetic status and a separate preferences suite. They do not prompt owner bots, run tools, approve work, authenticate connectors or change production settings. Screen geometry and simulated lifecycle tests do not imply physical multi-monitor, notch, lock, sleep, Spaces or full-screen acceptance.
