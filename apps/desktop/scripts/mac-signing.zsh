# Sourced by the companion builder. Capture the verified carrier's identity
# before replacing its executable; the new binary's ad-hoc metadata is not the
# application's signing contract.
strata_capture_carrier_signing() {
  local task_signature task_identifier task_flags task_bundle_identifier
  task_signature="$(/usr/bin/codesign -d --verbose=4 "$1" 2>&1)" || return 1
  task_identifier="$(print -r -- "$task_signature" | /usr/bin/sed -n 's/^Identifier=//p')"
  task_flags="$(print -r -- "$task_signature" | /usr/bin/sed -nE 's/^CodeDirectory .* flags=(0x[0-9a-fA-F]+).*/\1/p')"
  task_bundle_identifier="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$1/Contents/Info.plist")" || return 1
  if [[ -z "$task_identifier" || "$task_identifier" != "$task_bundle_identifier" || ! "$task_flags" =~ '^0x[0-9a-fA-F]+$' ]]; then
    print -u2 -- 'The verified carrier has no matching native signing identity.'
    return 1
  fi
  # Ad-hoc and hardened runtime are the carrier flags this local overlay can
  # faithfully reproduce. Refuse to silently remove an unfamiliar signing flag.
  if (( task_flags & ~(0x2 | 0x10000) )); then
    print -u2 -- 'The carrier uses signing options this local overlay cannot preserve.'
    return 1
  fi
  typeset -ga task_carrier_signing_arguments
  task_carrier_signing_arguments=(--identifier "$task_identifier")
  if (( task_flags & 0x10000 )); then task_carrier_signing_arguments+=(--options runtime); fi
  task_signing_entitlements="$(/usr/bin/mktemp -t strata-carrier-entitlements)" || return 1
  /usr/bin/codesign -d --entitlements :- "$1" > "$task_signing_entitlements" 2>/dev/null || return 1
  if [[ -s "$task_signing_entitlements" ]]; then task_carrier_signing_arguments+=(--entitlements "$task_signing_entitlements"); fi
}
strata_sign_carrier_app() {
  /usr/bin/codesign --force --sign - --timestamp=none "${task_carrier_signing_arguments[@]}" "$1"
}
