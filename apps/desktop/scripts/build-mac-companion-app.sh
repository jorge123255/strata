#!/bin/zsh
set -euo pipefail
task_desktop="${0:A:h:h}"
task_repo="${task_desktop:h:h}"
task_source="${STRATA_BASE_APP:-/Applications/Strata.app}"
task_output="${1:-${task_desktop}/build/Strata.app}"
if [[ ! -d "$task_source/Contents/Resources/host" ]]; then
  print -u2 -- 'Install the official Strata Mac app first, or set STRATA_BASE_APP.'
  exit 1
fi
if [[ -e "$task_output" ]]; then
  print -u2 -- 'Choose a new output path; existing applications are never overwritten by this build script.'
  exit 1
fi
node "$task_desktop/scripts/stage-companion.mjs"
npm --prefix "$task_repo/apps/host" run build
mkdir -p "${task_output:h}"
# APFS clones avoid duplicating hundreds of MB of unchanged engines on a full disk.
if ! /bin/cp -cRX "$task_source" "$task_output" 2>/dev/null; then
  /usr/bin/ditto --noqtn "$task_source" "$task_output"
fi
task_resources="$task_output/Contents/Resources"
# Only the new copy's UI and host are replaced. Its engines and signed components stay byte-identical.
rm -rf "$task_resources/host/dist" "$task_resources/host/server"
/usr/bin/ditto "$task_repo/apps/host/dist" "$task_resources/host/dist"
/usr/bin/ditto "$task_repo/apps/host/server" "$task_resources/host/server"
cp "$task_repo/apps/host/package.json" "$task_resources/host/package.json"
/usr/bin/ditto "$task_desktop/src-tauri/resources/companion-bridge" "$task_resources/companion-bridge"
/usr/libexec/PlistBuddy -c 'Add NSLocalNetworkUsageDescription string Pair your iPhone with Strata on this Mac over an encrypted connection.' "$task_output/Contents/Info.plist" 2>/dev/null || /usr/libexec/PlistBuddy -c 'Set NSLocalNetworkUsageDescription Pair your iPhone with Strata on this Mac over an encrypted connection.' "$task_output/Contents/Info.plist"
# Do not use --deep here: changing an engine signature would invalidate its component manifest.
/usr/bin/codesign --force --sign - --preserve-metadata=identifier,entitlements,flags "$task_output"
/usr/bin/codesign --verify --deep --strict "$task_output"
print -r -- "$task_output"
