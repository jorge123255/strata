#!/bin/zsh
set -euo pipefail
task_desktop="${0:A:h:h}"
task_repo="${task_desktop:h:h}"
task_source="${STRATA_BASE_APP:-/Applications/Strata.app}"
task_control="${STRATA_CONTROL_DONOR:-${task_source}/Contents/Resources/control}"
task_output="${1:-${task_desktop}/build/Strata.app}"
if [[ ! -d "$task_source/Contents/Resources/host" ]]; then
  print -u2 -- 'Install the official Strata Mac app first, or set STRATA_BASE_APP.'
  exit 1
fi
if [[ ! -x "$task_control/python/bin/python3" || ! -f "$task_control/strata.py" || ! -f "$task_control/VERSION" ]]; then
  print -u2 -- 'STRATA_CONTROL_DONOR must contain a complete, verified Mac Control runtime.'
  exit 1
fi
if [[ -e "$task_output" ]]; then
  print -u2 -- 'Choose a new output path; existing applications are never overwritten by this build script.'
  exit 1
fi
task_app_version="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$task_desktop/package.json")"
task_carrier_version="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$task_source/Contents/Info.plist")"
if [[ "$task_app_version" != "$task_carrier_version" ]]; then
  print -u2 -- "The carrier is Strata ${task_carrier_version}; this checkout needs ${task_app_version}. Set STRATA_BASE_APP to the matching verified app."
  exit 1
fi
/usr/bin/codesign --verify --deep --strict "$task_source"
/usr/bin/codesign --verify --strict "$task_control/python/bin/python3.12"
node "$task_desktop/scripts/stage-companion.mjs"
npm --prefix "$task_repo/apps/host" run build
mkdir -p "${task_output:h}"
# APFS clones avoid duplicating hundreds of MB of unchanged engines on a full disk.
if ! /bin/cp -cR "$task_source" "$task_output" 2>/dev/null; then
  /usr/bin/ditto --noqtn "$task_source" "$task_output"
fi
task_resources="$task_output/Contents/Resources"
# Keep the carrier's native shell and engines. Use a verified Control donor for its signed Python runtime,
# then stage ALL of this checkout's Control sources, including the shared-chat/remote lifecycle runtime guards.
# A host/UI-only overlay would silently leave the installed Control on the carrier's older version.
if [[ "${task_control:A}" != "${task_resources}/control" ]]; then
  rm -rf "$task_resources/control"
  /usr/bin/ditto --noqtn "$task_control" "$task_resources/control"
fi
# Do not execute a nested binary inside the copied app before its changed enclosing bundle is re-signed.
"$task_control/python/bin/python3" -I -B - "$task_repo" "$task_resources/control" "$task_source/Contents/Resources/control" <<'PY'
from pathlib import Path
import hashlib
import json
import re
import shutil
import sys

repo, control, carrier_control = map(Path, sys.argv[1:])
sys.path.insert(0, str(repo / 'packaging'))
import package_terminal as packaging

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def read_record(folder):
    try:
        return json.loads((folder / 'BUNDLE.json').read_text())
    except FileNotFoundError:
        return None

donor_version = (control / 'VERSION').read_text().strip()
donor_record = read_record(control)
carrier_record = read_record(carrier_control)
source_version = packaging._source_version()
# The standalone Python and locked packages must match the build contract. Never install anything here.
if sys.version_info[:3] != tuple(map(int, packaging.PYTHON_VERSION.split('.'))):
    raise SystemExit('the verified Control donor has a different Python version from the source build contract')
from importlib import metadata
lock = repo / 'packaging/locks/runtime-darwin-arm64-cp312.txt'
locked = dict(re.findall(r'^([A-Za-z0-9_.-]+)==([^\s]+)', lock.read_text(), re.MULTILINE))
if not locked:
    raise SystemExit('the runtime package lock is empty or unreadable')
installed = {}
for name, version in locked.items():
    actual = metadata.version(name)
    if actual != version:
        raise SystemExit(f'the verified Control donor does not match the locked package {name}')
    installed[name] = actual

ignore = shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store')
for item in packaging.PAYLOAD:
    source, destination = repo / item, control / item
    if destination.is_dir():
        shutil.rmtree(destination)
    elif destination.exists() or destination.is_symlink():
        destination.unlink()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, destination, ignore=ignore)
    else:
        shutil.copy2(source, destination)
if (control / 'tools').exists():
    shutil.rmtree(control / 'tools')
for name in packaging.TOOLS_SUBSET:
    (control / 'tools').mkdir(exist_ok=True)
    shutil.copy2(repo / 'tools' / name, control / 'tools' / name)
installer = packaging.add_installer(control, repo)
(control / 'VERSION').write_text(source_version + '\n')
commit = packaging.source_commit()
if re.fullmatch(r'[0-9a-f]{40}', commit):
    (control / 'COMMIT').write_text(commit + '\n')

source_paths = set(packaging.PAYLOAD) | {'VERSION', 'COMMIT', 'data'}
source_paths.update(f'tools/{name}' for name in packaging.TOOLS_SUBSET)
source_paths.update(installer['files'])
files = {}
for item in sorted(source_paths):
    path = control / item
    for file in sorted(path.rglob('*')) if path.is_dir() else [path]:
        if file.is_file() and '__pycache__' not in file.parts:
            files[file.relative_to(control).as_posix()] = digest(file)
record = {
    'schema_version': 1, 'component': 'strata-control', 'version': source_version, 'target': 'darwin-arm64',
    'python': (donor_record or carrier_record or {}).get('python', {'version': packaging.PYTHON_VERSION}),
    'lock': {'file': lock.relative_to(repo).as_posix(), 'sha256': digest(lock)},
    'installed': installed, 'acquires_at_runtime': False, 'installer': installer,
    'source_overlay': {'commit': commit, 'files_sha256': files, 'donor_control_version': donor_version,
                       'donor_bundle': donor_record, 'carrier_bundle': carrier_record},
}
(control / 'BUNDLE.json').write_text(json.dumps(record, indent=1) + '\n')
print(f'Staged Control {source_version}: {len(files)} source files; verified Python and locked packages retained.')
PY
rm -rf "$task_resources/host/dist" "$task_resources/host/server" "$task_resources/host/python"
/usr/bin/ditto "$task_repo/apps/host/dist" "$task_resources/host/dist"
/usr/bin/ditto "$task_repo/apps/host/server" "$task_resources/host/server"
mkdir -p "$task_resources/host/python"
cp "$task_repo/apps/host/python/remote_model_manager.py" "$task_resources/host/python/remote_model_manager.py"
cp "$task_repo/apps/host/python/remote_model_lifecycle.py" "$task_resources/host/python/remote_model_lifecycle.py"
cp "$task_repo/apps/host/python/remote-lifecycle-source.json.gz" "$task_resources/host/python/remote-lifecycle-source.json.gz"
cp "$task_repo/apps/host/package.json" "$task_resources/host/package.json"
/usr/bin/ditto "$task_desktop/src-tauri/resources/companion-bridge" "$task_resources/companion-bridge"
/usr/libexec/PlistBuddy -c 'Add NSLocalNetworkUsageDescription string Pair your iPhone with Strata on this Mac over an encrypted connection.' "$task_output/Contents/Info.plist" 2>/dev/null || /usr/libexec/PlistBuddy -c 'Set NSLocalNetworkUsageDescription Pair your iPhone with Strata on this Mac over an encrypted connection.' "$task_output/Contents/Info.plist"
# Do not use --deep here: changing an engine signature would invalidate its component manifest.
/usr/bin/codesign --force --sign - --preserve-metadata=identifier,entitlements,flags "$task_output"
/usr/bin/codesign --verify --deep --strict "$task_output"
print -r -- "$task_output"
