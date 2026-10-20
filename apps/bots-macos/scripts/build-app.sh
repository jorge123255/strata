#!/bin/bash
set -euo pipefail
strata_bots_dir="$(cd "$(dirname "$0")/.." && pwd)"
strata_bots_scratch="${STRATA_BOTS_BUILD_DIR:-/private/tmp/strata-native-bots-build}"
strata_bots_configuration="${STRATA_BOTS_CONFIGURATION:-release}"
swift build --package-path "$strata_bots_dir" --scratch-path "$strata_bots_scratch" -c "$strata_bots_configuration" -j 2
strata_bots_binary="$(swift build --package-path "$strata_bots_dir" --scratch-path "$strata_bots_scratch" -c "$strata_bots_configuration" --show-bin-path)/StrataBots"
strata_bots_app="$strata_bots_dir/build/StrataBots.app"
mkdir -p "$strata_bots_app/Contents/MacOS" "$strata_bots_app/Contents/Resources"
cp "$strata_bots_binary" "$strata_bots_app/Contents/MacOS/StrataBots"
cp "$strata_bots_dir/LICENSE" "$strata_bots_app/Contents/Resources/CUA-Bots-LICENSE"
cp "$strata_bots_dir/UPSTREAM.md" "$strata_bots_app/Contents/Resources/CUA-Bots-UPSTREAM.md"
cat > "$strata_bots_app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.strata.bots</string>
<key>CFBundleName</key><string>Strata Bots</string>
<key>CFBundleDisplayName</key><string>Strata Bots</string>
<key>CFBundleExecutable</key><string>StrataBots</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
codesign --force --sign "${STRATA_BOTS_SIGN_IDENTITY:--}" "$strata_bots_app"
printf '%s\n' "$strata_bots_app"
