#!/usr/bin/env python3
"""Install QEMU only in an owned private CUA folder; never run package scripts.

The extraction/wrapper approach follows MIT-licensed trycua/cua
libs/cua/crates/cua-vmm/src/qemu/install-local.sh at ef61a985d58958c6b9bc392f0ea0da785aa36ce9.
APT configuration here is isolated before global config is loaded. Only signed
official Ubuntu archives are used. No sudo, package installation or KVM changes.

MIT License — Copyright (c) 2025 Cua AI, Inc.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

VERSION = "ubuntu-private-qemu-v1"
CODENAMES = {"jammy", "noble", "resolute"}
KEYRING = Path("/usr/share/keyrings/ubuntu-archive-keyring.gpg")
ACTIVE = set()


def group_active(child):
    child.poll()  # Reap our own leader before checking its remaining group.
    if sys.platform.startswith("linux"):
        for item in Path("/proc").iterdir():
            if not item.name.isdigit():
                continue
            try:
                fields = (item / "stat").read_text().rsplit(") ", 1)[1].split()
                if int(fields[2]) == child.pid and fields[0] != "Z":
                    return True
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                pass
        return False
    try:
        os.killpg(child.pid, 0)
        return True
    except ProcessLookupError:
        return False


def stop_group(child):
    # A group remains owned after its leader exits; always escalate the group.
    if not group_active(child):
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    began = time.monotonic()
    killed = False
    while group_active(child):
        if not killed and time.monotonic() - began >= .2:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            killed = True
        if time.monotonic() - began >= .7:
            raise RuntimeError("Private QEMU preparation could not confirm subprocess cleanup.")
        time.sleep(.01)
    child.wait(timeout=.1)


def cancelled(signum, frame):
    for child in list(ACTIVE):
        stop_group(child)
    raise InterruptedError("Private QEMU preparation was cancelled; no system packages were installed.")


def private(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    for ancestor in [path, *path.parents]:
        info = ancestor.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise ValueError("CUA preparation needs an owned private directory without symlinks.")
        if ancestor == Path.home():
            break
    if path.stat().st_uid != os.getuid():
        raise ValueError("CUA preparation needs an owned private directory.")
    path.chmod(0o700)
    return path


def distro(path=Path("/etc/os-release")):
    values = {}
    for line in path.read_text().splitlines():
        if "=" in line:
            name, value = line.split("=", 1)
            values[name] = value.strip('"\'')
    codename = values.get("VERSION_CODENAME", "")
    if values.get("ID") != "ubuntu" or codename not in CODENAMES:
        raise ValueError("Private CUA QEMU preparation currently supports Ubuntu 22.04, 24.04 and 26.04. An existing QEMU can still be used on other systems.")
    machine = platform.machine()
    if machine == "x86_64":
        return codename, "amd64", "qemu-system-x86_64", ["qemu-system-x86", "seabios", "ipxe-qemu", "ovmf"]
    if machine in ("aarch64", "arm64"):
        return codename, "arm64", "qemu-system-aarch64", ["qemu-system-arm", "qemu-efi-aarch64"]
    raise ValueError("Private CUA QEMU preparation supports x64 and arm64 computers.")


def apt_configuration(stage, codename, architecture, keyring=KEYRING):
    # APT_CONFIG is parsed before apt.conf.d and apt.conf. Disable both first;
    # otherwise even a download-only update may run a system Post-Invoke hook.
    base = "https://archive.ubuntu.com/ubuntu" if architecture == "amd64" else "https://ports.ubuntu.com/ubuntu-ports"
    source = stage / "sources.list"
    source.write_text("\n".join(f"deb [arch={architecture} signed-by={keyring}] {base} {suite} main universe" for suite in (codename, codename + "-updates")) + "\n" + f"deb [arch={architecture} signed-by={keyring}] {'https://security.ubuntu.com/ubuntu' if architecture == 'amd64' else base} {codename}-security main universe\n")
    quoted = lambda value: '"' + str(value).replace('\\', '\\\\').replace('"', '\\"') + '"'
    config = stage / "apt.conf"
    config.write_text("\n".join([
        'Dir::Etc::parts "-";', 'Dir::Etc::main "/dev/null";',
        f'Dir::Etc::sourcelist {quoted(source)};', 'Dir::Etc::sourceparts "-";',
        'Dir::Etc::trusted "/dev/null";', 'Dir::Etc::trustedparts "-";',
        f'Dir::State {quoted(stage / "state")};', 'Dir::State::status "/var/lib/dpkg/status";',
        f'Dir::State::lists {quoted(stage / "lists")};', f'Dir::State::extended_states {quoted(stage / "extended_states")};',
        f'Dir::Cache {quoted(stage / "cache")};', f'Dir::Cache::archives {quoted(stage / "archives")};',
        f'Dir::Cache::pkgcache {quoted(stage / "pkgcache.bin")};', f'Dir::Cache::srcpkgcache {quoted(stage / "srcpkgcache.bin")};',
        f'Dir::Log {quoted(stage / "log")};', 'Debug::NoLocking "true";',
        f'APT::Architecture "{architecture}";', 'APT::Install-Recommends "false";', 'APT::Install-Suggests "false";',
        f'APT::Sandbox::User "{pwd.getpwuid(os.getuid()).pw_name}";', 'Acquire::Languages "none";', 'Acquire::Retries "1";',
        'Acquire::AllowInsecureRepositories "false";', 'APT::Get::AllowUnauthenticated "false";',
    ]) + "\n")
    for name in ("lists/partial", "archives/partial", "cache", "state", "log"):
        (stage / name).mkdir(parents=True, mode=0o700)
    return config


def run(program, args, env, timeout=120):
    child = subprocess.Popen([program, *map(str, args)], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    ACTIVE.add(child)
    try:
        output, _ = child.communicate(timeout=timeout)
        if child.returncode or len(output) > 2 * 1024 * 1024:
            raise ValueError("The private QEMU download or verification failed. Check access to the official Ubuntu archives; system packages were not changed.")
        return output.decode(errors="replace")
    except subprocess.TimeoutExpired:
        raise ValueError("The private QEMU preparation command timed out; system packages were not changed.")
    finally:
        try:
            stop_group(child)
        finally:
            child.stdout.close()
            ACTIVE.discard(child)


def wrapper(root, binary):
    lines = ["#!/bin/sh", "root=" + shlex.quote(str(root)),
        'export LD_LIBRARY_PATH="$root/usr/lib:$(find "$root/usr/lib" -mindepth 1 -maxdepth 1 -type d | paste -sd: -)"',
        'export QEMU_MODULE_DIR="$(find "$root/usr/lib" -mindepth 2 -maxdepth 2 -type d -path "*-linux-gnu*/qemu" | head -n 1)"']
    lines.append('exec "$root/usr/bin/' + binary + '" ' + ('-L "$root/usr/share/qemu" ' if binary != "qemu-img" else '') + '"$@"')
    return "\n".join(lines) + "\n"


def activate(home, target, system):
    prefix = home / "qemu"
    # Ubuntu separates SeaBIOS from QEMU's data directory. Supplying -L would
    # hide that compiled secondary search path, so expose only private files
    # through relative links in the private QEMU data directory.
    data = target / "usr/share/qemu"
    data.mkdir(parents=True, exist_ok=True)
    for folder in (target / "usr/share/seabios", target / "usr/lib/ipxe/qemu", target / "usr/share/ipxe/qemu"):
        if folder.is_dir():
            for item in folder.iterdir():
                link = data / item.name
                if item.is_file() and not link.exists() and not link.is_symlink():
                    link.symlink_to(os.path.relpath(item, data))
    # CUA's firmware discovery checks <CUA_HOME>/qemu/usr/share/OVMF
    # and AAVMF next to its bin wrappers. Keep that private layout.
    firmware = prefix / "usr"
    if firmware.exists() and not firmware.is_symlink():
        raise ValueError("An existing private QEMU firmware folder was preserved; repair this private runtime before continuing.")
    temporary_link = prefix / ".usr.prepare"
    temporary_link.unlink(missing_ok=True)
    temporary_link.symlink_to(Path(target.name) / "usr", target_is_directory=True)
    os.replace(temporary_link, firmware)
    binaries = private(home / "bin")
    # Never delegate to the system sudo: this private helper's PATH explicitly
    # has no privilege escalation, even for an account with passwordless sudo.
    # This does not grant KVM access or imply a software-emulation fallback;
    # the released SDK's actual doctor readiness remains authoritative.
    denial = binaries / "sudo"
    denied = "#!/bin/sh\n# Strata CUA helpers never escalate privileges.\nexit 1\n"
    if denial.exists() and denial.read_text() != denied:
        raise ValueError("An unexpected private CUA privilege wrapper was preserved; repair this private runtime before continuing.")
    temp = binaries / ".sudo.prepare"; temp.write_text(denied); temp.chmod(0o700); os.replace(temp, denial)
    for name in (system, "qemu-img"):
        temp = binaries / (name + ".prepare")
        temp.write_text(wrapper(target, name)); temp.chmod(0o700)
        run(str(temp), ["--version"], os.environ.copy(), 15)
        os.replace(temp, binaries / name)


def prepare(home):
    if platform.system() != "Linux":
        raise ValueError("This private QEMU installer supports Linux. Prepare an existing QEMU installation on this computer.")
    home = private(home.absolute())
    codename, architecture, system, packages = distro()
    key = KEYRING.lstat()
    if not stat.S_ISREG(key.st_mode) or key.st_uid != 0 or key.st_mode & 0o022:
        raise ValueError("The system Ubuntu archive keyring must be a regular root-owned read-only trust anchor.")
    for program in ("apt-get", "apt-config", "dpkg-deb"):
        item = Path("/usr/bin") / program
        metadata = item.stat()
        if not item.is_file() or metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise ValueError("Private QEMU preparation requires the standard Ubuntu APT and dpkg-deb tools.")
    lock = home / ".qemu-prepare.lock"
    with open(lock, "a") as owned:
        os.chmod(lock, 0o600)
        try:
            fcntl.flock(owned, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another private QEMU preparation is running on this account.")
        prefix = private(home / "qemu")
        target = prefix / f"{VERSION}-{codename}-{architecture}"
        if (target / "manifest.json").is_file():
            manifest = json.loads((target / "manifest.json").read_text())
            if manifest.get("version") != VERSION or manifest.get("codename") != codename or manifest.get("architecture") != architecture:
                raise ValueError("The existing private QEMU manifest changed. Its files were preserved.")
            for name in (system, "qemu-img"):
                if hashlib.sha256((target / "usr/bin" / name).read_bytes()).hexdigest() != manifest.get("executables", {}).get(name):
                    raise ValueError("The existing private QEMU executable changed. Its files were preserved.")
            activate(home, target, system)
            return {"prepared": True, "detail": "The private QEMU runtime is already prepared."}
        if target.exists():
            raise ValueError("The private QEMU version is incomplete. Existing files were preserved; choose another execution computer or repair this private runtime.")
        if shutil.disk_usage(home).free < 2 * 1024**3:
            raise ValueError("Preparing private QEMU needs at least 2 GB of free disk space.")
        with tempfile.TemporaryDirectory(prefix=".qemu-prepare-", dir=prefix) as temporary:
            stage = Path(temporary); stage.chmod(0o700)
            config = apt_configuration(stage, codename, architecture)
            environment = dict(os.environ, APT_CONFIG=str(config))
            effective = run("/usr/bin/apt-config", ["dump"], environment, 15)
            if re.search(r"(?:Pre-Invoke|Post-Invoke|Pre-Install-Pkgs)", effective):
                raise ValueError("APT configuration isolation could not be confirmed; no download was started.")
            run("/usr/bin/apt-get", ["update"], environment, 90)
            run("/usr/bin/apt-get", ["--download-only", "--reinstall", "--no-install-recommends", "-y", "install", *packages, "qemu-system-common", "qemu-system-data", "qemu-utils"], environment, 180)
            archives = sorted((stage / "archives").glob("*.deb"))
            if not archives or len(archives) > 250 or sum(p.stat().st_size for p in archives) > 1024**3:
                raise ValueError("The private QEMU package download exceeded its limit.")
            root = stage / "root"; root.mkdir(mode=0o700); manifest = []
            for archive in archives:
                run("/usr/bin/dpkg-deb", ["-x", archive, root], environment, 30)
                manifest.append({"file": archive.name, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()})
            for item in root.rglob("*"):
                if item.is_symlink():
                    link = os.readlink(item)
                    if link.startswith("/") and (root / link.lstrip("/")).exists():
                        item.unlink(); item.symlink_to(os.path.relpath(root / link.lstrip("/"), item.parent))
            for name in (system, "qemu-img"):
                path = stage / name; path.write_text(wrapper(root, name)); path.chmod(0o700)
                run(str(path), ["--version"], environment, 20)
            (root / "manifest.json").write_text(json.dumps({"version": VERSION, "codename": codename, "architecture": architecture, "ubuntuKeyringSHA256": hashlib.sha256(KEYRING.read_bytes()).hexdigest(), "packages": manifest, "executables": {name: hashlib.sha256((root / "usr/bin" / name).read_bytes()).hexdigest() for name in (system, "qemu-img")}}, indent=2) + "\n")
            os.rename(root, target)
            activate(home, target, system)
            return {"prepared": True, "detail": "QEMU was downloaded, verified and extracted into this private CUA account folder. No system packages were installed."}


if __name__ == "__main__":
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, cancelled)
    try:
        result = prepare(Path(sys.argv[1]))
    except Exception as error:
        result = {"error": str(error)[:1000]}; print(json.dumps(result)); sys.exit(1)
    print(json.dumps(result))
