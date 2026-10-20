#!/bin/zsh
set -euo pipefail
companion_root="${0:A:h}"
companion_repo="${companion_root:h:h}"
companion_output="${1:-${companion_root}/build/Strata Companion.app}"
companion_node="${STRATA_COMPANION_NODE:-/Applications/Strata.app/Contents/Resources/node/node}"
if [[ ! -x "$companion_node" ]]; then
  companion_node="$(command -v node)"
fi
mkdir -p "$companion_output/Contents/MacOS" "$companion_output/Contents/Resources/bridge"
/usr/bin/swiftc -O -parse-as-library -target arm64-apple-macosx14.0 "$companion_root/CompanionApp.swift" -o "$companion_output/Contents/MacOS/StrataCompanion" -framework AppKit -framework SwiftUI -framework WebKit
/usr/bin/swiftc -O "$companion_repo/apps/companion-bridge/qr.swift" -o "$companion_output/Contents/Resources/bridge/qr-helper"
cp "$companion_node" "$companion_output/Contents/Resources/node"
cp "$companion_repo/apps/companion-bridge/"*.mjs "$companion_output/Contents/Resources/bridge/"
cp "$companion_repo/apps/companion-bridge/qr.swift" "$companion_output/Contents/Resources/bridge/"
cp "$companion_repo/apps/desktop/src-tauri/icons/icon.icns" "$companion_output/Contents/Resources/Strata.icns"
cp "$companion_root/Info.plist" "$companion_output/Contents/Info.plist"
/usr/bin/codesign --force --deep --sign - "$companion_output"
print -r -- "$companion_output"
