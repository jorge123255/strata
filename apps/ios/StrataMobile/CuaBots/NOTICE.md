The avatar renderer (BotAvatar.swift, KoalaGeometry.swift, SVGPath.swift),
AvatarBadge and AvatarPicker are copied from Cua AI's Cua Bots sample at
commit ef61a985d58958c6b9bc392f0ea0da785aa36ce9:
https://github.com/jorge123255/cua/tree/ef61a985d58958c6b9bc392f0ea0da785aa36ce9/examples/cua-bots-macos

Copyright (c) 2026 Cua AI, Inc. SPDX-License-Identifier: FSL-1.1-MIT.
The included LICENSE.txt applies to these copied sources and adaptations.
AvatarPicker uses adaptive eye-option columns to fit smaller iPhones.
Strata adds original fox, cat and robot characters with geometry shared by
the embedded Mac SVG renderer. The original koala paths and three-field
koala configuration are retained. All four families share the CUA palette,
eye vocabulary and ear choices; animation respects Reduce Motion.
BotsView's native List and profile sections are adapted from the iOS sample's
PhoneViews.swift at the same commit. CompanionStore, pairing, shared history,
Thinking and explicit computer-control ownership remain Strata's implementation.
