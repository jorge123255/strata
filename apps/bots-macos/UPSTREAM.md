# CUA Bots source provenance

Adapted from `jorge123255/cua` (parent `trycua/cua`), commit `ef61a985d58958c6b9bc392f0ea0da785aa36ce9`, `examples/cua-bots-macos`.

The original Core avatars, reusable UI and Mac screens are retained under FSL-1.1-MIT. Their original copyright and SPDX headers are retained. See LICENSE. Koala geometry and design originate with Cua AI; this adaptation does not imply endorsement or ownership of Cua trademarks.

Strata replaces the sample engine, local history, pairing, volume and routine clock with its existing host APIs. The feature window links only Apple frameworks; it does not link or bundle `cua-spaces-ffi`, the Cua Keyvault or the Cua native streaming decoder. Provider credentials stay with the Strata execution host.

The optional computer backend separately installs the MIT official cua SDK and downloads the official desktop image containing FSL cua-spacesd when the user starts a computer.

The shipped Mac interface now adapts this design inside Strata’s existing main window. This SwiftUI prototype remains a source reference and is not part of the desktop package; its standalone launch routes were removed. The embedded avatar port retains the original geometry and full shipped license/notice.
