# CUA koala avatar provenance

The SVG geometry, palette, eye marks, expressions and picker are adapted from
`examples/cua-bots-macos/Sources/CuaBotsCore/Avatar/{BotAvatar,KoalaGeometry}.swift`
and `CuaBotsUI/Components.swift` in `jorge123255/cua` (parent `trycua/cua`), pinned
at commit `ef61a985d58958c6b9bc392f0ea0da785aa36ce9`.

Copyright (c) 2026 Cua AI, Inc. SPDX-License-Identifier: FSL-1.1-MIT.
The full [Functional Source License 1.1 with MIT Future License](../../public/cua-bots-LICENSE.txt)
applies to these adapted components. The full license and source notice ship
as `/cua-bots-LICENSE.txt` and `/cua-bots-NOTICE.txt`. Koala geometry and design originate with Cua AI; this adaptation
does not imply endorsement or ownership of Cua trademarks.

The component keeps the original paths, six palettes, six eye styles, three ear
shapes (108 configurations), normalized drawing coordinates, clipped nose,
glyph strokes, right-eye delay and mood expression timing. It uses SVG instead
of SwiftUI Canvas. It respects reduced motion. The picker is controlled by its
parent and does not perform requests or write configuration itself.

Strata adds a subtle highlight to the retained koala and original fox, cat and
robot vector characters using the same palette, eye grid and expressions. The
optional `kind` field defaults to koala; legacy three-field faces stay unchanged.

The optional `shape` field adds six original Strata geometric characters: orb,
pebble, tile, diamond, spark and hexagon. Their paths are drawn from basic
geometric forms and recorded in `tests/fixtures/strata-geometric-avatars.json`.
They use a separate eye grid and no animal ears, nose or highlight. No BotAI
or recovered third-party character paths are included.
