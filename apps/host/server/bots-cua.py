#!/usr/bin/env python3
"""Private bridge to official cua==0.5.0 (MIT). The separately downloaded
official desktop image includes FSL-1.1-MIT cua-spacesd. No host fallback."""
import asyncio
import base64
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import signal
import subprocess
import sys

VERSION = "0.5.0"
IMAGE = "ghcr.io/trycua/linux:24.04"
WORKSPACE = "/workspace"
GUEST_REBOOT_TIMEOUT = 90
WORKSPACE_SETUP = r'''
import os,sys
parts=sys.argv[1].split('/')[1:]; uid,gid=int(sys.argv[2]),int(sys.argv[3]); fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
try:
 for part in parts:
  try: os.mkdir(part,0o755,dir_fd=fd)
  except FileExistsError: pass
  child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); os.close(fd); fd=child
 os.fchown(fd,uid,gid)
finally: os.close(fd)
'''


# These programs run inside the owned guest, never on the selected host.
FILE_SCRIPT = r'''
import json,os,pathlib,sys,tempfile
op,a=json.loads(sys.argv[1]); root=pathlib.Path(sys.argv[2]); resolved_root=root.resolve(strict=True); p=a.get('path','.')
if root!=resolved_root or not resolved_root.is_relative_to(pathlib.Path(sys.argv[3]).resolve(strict=True)): raise ValueError('Choose a contained CUA workspace without symlinks.')
root=resolved_root
if not isinstance(p,str) or '\0' in p or len(p)>4000 or pathlib.Path(p).is_absolute(): raise ValueError('Use a workspace-relative path.')
target=root/p; resolved=target.resolve()
if not resolved.is_relative_to(root): raise ValueError('This file points outside the CUA workspace.')
if op=='read_file':
 if resolved.stat().st_size>1048576: raise ValueError('Read a file of at most 1 MB.')
 print(json.dumps({'text':resolved.read_text()}))
elif op=='list_files':
 print(json.dumps({'text':'\n'.join(('link' if c.is_symlink() else 'directory' if c.is_dir() else 'file')+'\t'+c.name for c in sorted(resolved.iterdir())[:1000])}))
elif op=='write_file':
 data=a.get('content')
 if not isinstance(data,str) or len(data.encode())>2097152: raise ValueError('Write a UTF-8 file of at most 2 MB.')
 if target.is_symlink() and not target.exists(): raise ValueError('Choose a regular workspace file.')
 resolved.parent.mkdir(parents=True,exist_ok=True)
 if not resolved.parent.resolve().is_relative_to(root): raise ValueError('This file points outside the CUA workspace.')
 fd,tmp=tempfile.mkstemp(prefix='.strata-',dir=str(resolved.parent))
 try:
  with os.fdopen(fd,'w') as f: f.write(data)
  os.replace(tmp,resolved)
 finally:
  if os.path.exists(tmp): os.unlink(tmp)
 print(json.dumps({'text':'Saved '+str(resolved.relative_to(root))}))
'''
CLEANUP_SCRIPT = r'''
import json,os,signal,sys,time
group=int(sys.argv[1]); marker=('STRATA_CUA_RUN='+sys.argv[2]).encode()
def members():
 found=[]
 for entry in os.scandir('/proc'):
  if not entry.name.isdigit(): continue
  try:
   raw=open(entry.path+'/stat').read(); fields=raw[raw.rfind(')')+2:].split()
   if int(fields[2])!=group or fields[0]=='Z': continue
   if marker not in open(entry.path+'/environ','rb').read().split(b'\0'): raise RuntimeError('Command group identity changed.')
   found.append(int(entry.name))
  except (FileNotFoundError,ProcessLookupError): pass
 return found
if members():
 try: os.killpg(group,signal.SIGKILL)
 except ProcessLookupError: pass
deadline=time.monotonic()+5
while members() and time.monotonic()<deadline: time.sleep(.05)
if members(): raise RuntimeError('The sandbox command is still running.')
print(json.dumps({'cleanupConfirmed':True}))
'''

def content(value):
    return {"content": [{"type": "text", "text": str(value)}]}

def safe_error(error):
    if isinstance(error, (ValueError, PermissionError)):
        return str(error)[:500]
    return "CUA could not complete this operation. Check the execution computer’s runtime and sandbox status."

class Bridge:
    def __init__(self, request, sdk):
        self.request, self.sdk = request, sdk
        self.directory = Path(request["directory"]).resolve()
        self.workdir = request.get("workspace", WORKSPACE)
        if not isinstance(self.workdir, str) or len(self.workdir) > 4000 or "\0" in self.workdir or not (self.workdir == WORKSPACE or self.workdir.startswith(WORKSPACE + "/")) or any(part in (".", "..") for part in self.workdir.split("/")) or str(PurePosixPath(self.workdir)) != self.workdir:
            raise ValueError("Use /workspace or a contained subfolder inside the isolated CUA computer.")
        self.name = request.get("sandbox")
        if self.name is not None and not re.fullmatch(r"strata-bot-[a-f0-9]{24}", self.name):
            raise ValueError("Choose an owned Strata CUA computer.")
        self.cleanup_confirmed = True
        self.runs = self.directory / "pending-commands" / (self.name or "runtime")
        # These names are from the published 0.5.0 wheel, not unreleased main
        # (whose CuaConfig has since renamed the account fields).
        self.client = sdk.Cua.embedded(sdk.CuaConfig(state_dir=str(self.directory / "sandboxes"), spaces_home=str(self.directory / "spaces"), teleport_home=str(self.directory / "teleport"), fleet_from_env=False, fleet_from_session=False))

    async def metadata(self):
        if not self.name:
            raise ValueError("Choose a bot’s CUA computer.")
        try:
            return await self.client.sandboxes().get("local:" + self.name)
        except self.sdk.CuaError.NotFound:
            return None

    @staticmethod
    def status(info):
        return str(info.status).split(".")[-1].lower()

    async def resume_owned(self):
        # The published Python connect() rejects a suspended QEMU computer
        # before returning its resumable handle. Use only the official CLI
        # shipped in this exact pinned wheel, never PATH's cua or a daemon.
        executable = Path(self.sdk.__file__).resolve().parent / "bin" / "cua"
        if not executable.is_file():
            raise ValueError("Prepare the supported CUA SDK again to restore its private resume helper.")
        environment = {
            "HOME": str(self.directory / "home"),
            # VMM state uses CUA_HOME independently of --state-dir. Match
            # the Python SDK process so resume finds this exact VM.
            "CUA_HOME": str(self.directory / "home" / ".cua"),
            "PATH": str(self.directory / "home" / ".cua" / "bin") + os.pathsep + "/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG": "C.UTF-8", "CUA_DEFAULT_ON": "local",
            "CUA_SPACES_AGENT_CREDENTIALS_HOME": "none",
            "CUA_SPACES_TELEPORT_HOME": str(self.directory / "teleport"),
            "CUA_DAEMON_NO_RELAY": "1", "CUA_DAEMON_DRIVE": "0",
            "CUA_TELEMETRY": "0", "DO_NOT_TRACK": "1",
        }
        spec = importlib.util.spec_from_file_location("strata_cua_process_cleanup", Path(__file__).parent / "bots-runtime" / "cua-qemu-prepare.py")
        cleanup = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cleanup)
        previous_cleanup = self.cleanup_confirmed
        self.cleanup_confirmed = False
        child = subprocess.Popen([str(executable), "--embedded", "--state-dir", str(self.directory / "sandboxes"), "--json", "sandbox", "resume", "local:" + self.name], env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        communicating = asyncio.create_task(asyncio.to_thread(child.communicate, timeout=45))
        try:
            stdout, stderr = await asyncio.shield(communicating)
            if child.returncode != 0 or len(stdout) + len(stderr) > 1024 * 1024:
                raise ValueError("The private CUA computer could not resume. Its disk was retained.")
        finally:
            # Even a leader that exited can leave descendants. This reviewed
            # helper always cleans the entire group owned by this CLI call.
            try:
                cleanup.stop_group(child)
                await asyncio.wait_for(asyncio.shield(communicating), 1)
            except BaseException:
                self.cleanup_confirmed = False
                raise
        for attempt in range(20):
            info = await self.metadata()
            if info is not None and self.status(info) == "running":
                self.cleanup_confirmed = previous_cleanup
                return
            await asyncio.sleep(.25)
        raise ValueError("CUA could not confirm that this private computer resumed. Its disk was retained.")

    async def sandbox(self, start=False, resume=False):
        boxes = self.client.sandboxes()
        info = await self.metadata()
        if info is None:
            if not start:
                return None
            if shutil.disk_usage(self.directory).free < 12 * 1024**3:
                raise ValueError("Starting a CUA computer needs at least 12 GB of free disk space. Choose a remote computer or free disk space.")
            creating = asyncio.create_task(boxes.create(self.sdk.SandboxCreateOptions(on="local", kind="vm", runtime="qemu", image=IMAGE, name=self.name, os="linux", cpus=2, memory_mb=4096, ready_timeout_ms=180000, keep_on_failure=False)))
            try:
                box = await asyncio.shield(creating)
            except asyncio.CancelledError:
                try:
                    await boxes.cancel_create(self.name)
                    made = await asyncio.wait_for(asyncio.shield(creating), 8)
                    await made.suspend()
                except self.sdk.CuaError.NotFound:
                    pass
                except BaseException:
                    self.cleanup_confirmed = False
                raise
            return box
        state = self.status(info)
        if state == "stopped":
            raise ValueError("This CUA computer stopped unexpectedly. Its disk is retained. Create another bot to start a new isolated computer; this SDK cannot resume a stopped QEMU computer.")
        if state == "suspended":
            if not (start or resume):
                raise ValueError("Start this bot’s paused CUA computer before using its tools.")
            await self.resume_owned()
        elif state != "running":
            raise ValueError("This CUA computer is not ready. Check its status before continuing.")
        return await boxes.connect("local:" + self.name)

    async def environment(self, start=False):
        box = await self.sandbox(start)
        if box is None:
            raise ValueError("Start this bot’s CUA computer first.")
        return box, await box.spacesd(10000)

    async def cleanup_group(self, env, process, nonce, user=None):
        run = await env.run(self.sdk.SpacesdCommand(program="python3", args=["-c", CLEANUP_SCRIPT, str(process.pid()), nonce], timeout_ms=8000, user=user))
        if not run.exit.success or json.loads(bytes(run.stdout)).get("cleanupConfirmed") is not True:
            raise RuntimeError("CUA command cleanup was not confirmed.")

    async def command(self, env, program, args, timeout=30000, user=None):
        nonce = secrets.token_hex(24)
        self.runs.mkdir(parents=True, exist_ok=True, mode=0o700)
        marker = self.runs / nonce
        # Write before the spawn RPC: a lost client cannot erase uncertainty
        # about a guest command that may have started after its channel died.
        with marker.open("x") as file:
            os.chmod(marker, 0o600)
            json.dump({"nonce": nonce}, file)
        wrapper = "import os,sys; os.getpgrp()==os.getpid() or os.setsid(); os.execvp(sys.argv[1],sys.argv[1:])"
        starting = asyncio.create_task(env.spawn(self.sdk.SpacesdCommand(program="python3", args=["-c", wrapper, program, *args], env={"STRATA_CUA_RUN": nonce}, timeout_ms=timeout, tag="strata-" + nonce, user=user)))
        process = None
        try:
            try:
                process = await asyncio.shield(starting)
            except asyncio.CancelledError:
                try:
                    process = await asyncio.wait_for(asyncio.shield(starting), 5)
                except BaseException:
                    self.cleanup_confirmed = False
                raise
            return await process.wait()
        finally:
            if process is not None:
                try:
                    await asyncio.wait_for(self.cleanup_group(env, process, nonce, user), 10)
                except BaseException:
                    self.cleanup_confirmed = False
                    raise RuntimeError("CUA command cleanup was not confirmed.")
                else:
                    marker.unlink(missing_ok=True)
            else:
                self.cleanup_confirmed = False

    async def frame(self, env):
        shot = await env.screenshot(self.sdk.ScreenshotOptions(format=self.sdk.ImageFormat.PNG))
        image = bytes(shot.image)
        if len(image) > 8 * 1024 * 1024 or not 0 < shot.width <= 16384 or not 0 < shot.height <= 16384:
            raise ValueError("The CUA computer returned an unsupported screenshot size.")
        return {"data": base64.b64encode(image).decode(), "mimeType": "image/png", "width": shot.width, "height": shot.height, "scale": shot.scale}

    async def boot_id(self, env):
        result = await env.run(self.sdk.SpacesdCommand(program="cat", args=["/proc/sys/kernel/random/boot_id"], timeout_ms=3000))
        value = bytes(result.stdout).decode().strip()
        if not result.exit.success or not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", value):
            raise ValueError("CUA could not verify this guest’s boot identity. Pending commands were preserved.")
        return value

    async def reboot_and_pause(self, box):
        # QEMU suspend freezes old commands, and SDK 0.5.0 cannot cold-restart
        # a stopped QEMU instance. A reboot inside this exact owned guest must
        # prove a changed kernel boot UUID before we clear any pending command.
        self.cleanup_confirmed = False
        env = await box.spacesd(10000)
        previous = await self.boot_id(env)
        try:
            # This fixed command is sent to the owned guest RPC, never the
            # execution host. It cannot alter host sudo or KVM permissions.
            result = await asyncio.wait_for(env.run(self.sdk.SpacesdCommand(program="/bin/sh", args=["-c", 'if [ "$(id -u)" -eq 0 ]; then exec /sbin/reboot; else exec sudo -n /sbin/reboot; fi'], timeout_ms=5000)), 8)
            if not result.exit.success:
                raise ValueError("The owned CUA guest could not restart. Its files and pending command records were preserved.")
        except ValueError:
            raise
        except Exception:
            # The accepted reboot can close its own RPC before returning.
            # A disconnect is never proof; only a different boot UUID is.
            pass
        deadline = asyncio.get_running_loop().time() + GUEST_REBOOT_TIMEOUT
        while asyncio.get_running_loop().time() < deadline:
            try:
                current = await self.boot_id(await box.spacesd(2500))
                if current != previous:
                    break
            except Exception:
                pass
            await asyncio.sleep(.25)
        else:
            raise ValueError("CUA could not confirm a fresh guest boot. Its files and pending command records were preserved.")
        await box.suspend()
        for attempt in range(20):
            info = await self.client.sandboxes().get("local:" + self.name)
            if self.status(info) == "suspended":
                return
            await asyncio.sleep(.25)
        raise ValueError("The fresh CUA guest could not confirm that it paused. Pending command records were preserved.")

    async def input(self, env, action, args):
        if action == "click":
            frame = await self.frame(env)
            x, y = args.get("x"), args.get("y")
            if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float)) or not isinstance(y, (int, float)) or not (0 <= x < frame["width"] and 0 <= y < frame["height"]):
                raise ValueError("Click inside the CUA screenshot’s image pixel bounds.")
            scale = frame["scale"]
            if not isinstance(scale, (int, float)) or scale <= 0:
                raise ValueError("The CUA screenshot has no valid coordinate scale.")
            await env.click(x / scale, y / scale)
        elif action == "type":
            value = args.get("text")
            if not isinstance(value, str) or len(value) > 32000:
                raise ValueError("Type at most 32,000 characters.")
            await env.type_text(value)
        elif action == "key":
            value = args.get("key")
            if not isinstance(value, str) or not value.strip() or len(value) > 100:
                raise ValueError("Enter a valid key or shortcut.")
            aliases = {"enter": "Return", "return": "Return", "esc": "Escape", "escape": "Escape", "tab": "Tab", "backspace": "Backspace", "control": "ctrl", "ctrl": "ctrl", "command": "cmd", "cmd": "cmd", "option": "alt", "alt": "alt", "shift": "shift"}
            keys = [aliases.get(key.lower(), key) for key in value.split("+")]
            if len(keys) > 1:
                await env.hotkey(keys)
            else:
                await env.press(keys[0])
        else:
            raise ValueError("Choose a supported CUA action.")

    async def workspace(self, env):
        identifiers = []
        for option in ("-u", "-g"):
            value = await env.run(self.sdk.SpacesdCommand(program="id", args=[option], timeout_ms=3000))
            value = bytes(value.stdout).decode().strip() if value.exit.success else ""
            if not value.isdigit() or int(value) > 2147483647:
                raise ValueError("The CUA guest could not identify its workspace owner.")
            identifiers.append(value)
        # The published guest RPC forbids user='root'. These fixed synchronous
        # setup commands use only the owned guest's passwordless sudo. Their
        # durable record remains on cancel/failure until explicit Stop proves
        # a new guest boot; sudo may clear nonce variables, so these are not
        # arbitrary command-group jobs.
        self.runs.mkdir(parents=True, exist_ok=True, mode=0o700)
        marker = self.runs / ("workspace-" + secrets.token_hex(24))
        with marker.open("x") as file:
            os.chmod(marker, 0o600)
            json.dump({"operation": "prepare-owned-workspace"}, file)
        previous_cleanup = self.cleanup_confirmed
        self.cleanup_confirmed = False
        program, args = "python3", ["-c", WORKSPACE_SETUP, self.workdir, *identifiers]
        if identifiers[0] != "0":
            program, args = "sudo", ["-n", program, *args]
        setup = await asyncio.wait_for(env.run(self.sdk.SpacesdCommand(program=program, args=args, timeout_ms=5000)), 8)
        if not setup.exit.success:
            raise ValueError("The CUA guest could not prepare its contained working folder. Stop this bot’s computer before retrying.")
        marker.unlink()
        self.cleanup_confirmed = previous_cleanup

    async def handle(self):
        op = self.request.get("operation")
        if op in ("probe", "prepare"):
            # SDK setup may invoke Homebrew, sudo/apt or KVM group changes.
            # Preparation of this private adapter never changes the system.
            # A separate private-prefix installer can supply QEMU on PATH.
            report = await self.client.local().doctor()
            checks = [{"name": row.name, "status": str(row.status).split(".")[-1], "detail": row.detail} for row in report.checks]
            qemu = next((row for row in checks if "qemu" in row["name"].lower()), None)
            ready = qemu is not None and qemu["status"] == "OK"
            if not ready and qemu and "permission denied" in qemu["detail"].lower() and "kvm" in qemu["detail"].lower():
                detail = "QEMU is installed, but this account cannot use hardware virtualization with the supported CUA SDK. Choose another execution computer. No system permissions were changed."
                qemu["detail"] = detail
            else:
                detail = "The private CUA runtime is ready. Start a bot’s computer when needed." if ready else "QEMU is not ready on this account. Prepare the private runtime or choose another execution computer. No sandbox was started."
            return {"available": ready, "prepared": ready, "version": VERSION, "checks": checks, "detail": detail}
        if op == "state":
            info = await self.metadata()
            pending = self.runs.exists() and any(self.runs.iterdir())
            if info is None:
                return {"available": True, "running": False, "cleanupConfirmed": not pending, "sandboxId": self.name, "detail": "This bot’s CUA computer has not been started."}
            state = self.status(info)
            if state != "running":
                detail = "This bot’s CUA computer is paused. Start it to continue." if state == "suspended" else "This bot’s CUA computer is stopped. Its disk is retained; this SDK cannot resume it." if state == "stopped" else "This bot’s CUA computer is not ready."
                return {"available": state == "suspended", "running": False, "cleanupConfirmed": not pending, "sandboxId": self.name, "detail": detail}
            box = await self.sandbox(False)
            env = await box.spacesd(5000)
            return {"available": True, "running": True, "cleanupConfirmed": not pending, "sandboxId": self.name, "frame": await self.frame(env), "detail": "Connected to this bot’s CUA computer."}
        if op == "stop":
            self.cleanup_confirmed = False
            box = await self.sandbox(False, resume=True)
            if box is not None:
                await self.reboot_and_pause(box)
            elif self.runs.exists() and any(self.runs.iterdir()):
                raise ValueError("CUA cannot find this computer to confirm guest cleanup. Its files and pending command records were preserved.")
            if self.runs.exists():
                for marker in self.runs.iterdir():
                    marker.unlink()
            self.cleanup_confirmed = True
            return {"available": False, "running": False, "stopped": True, "cleanupConfirmed": True, "sandboxId": self.name, "detail": "This bot’s CUA computer is stopped."}
        if op not in ("start", "control", "tool"):
            raise ValueError("Choose a supported CUA operation.")
        if self.runs.exists() and any(self.runs.iterdir()):
            self.cleanup_confirmed = False
            raise ValueError("A previous CUA command may still be running. Stop this bot’s CUA computer before continuing.")
        _, env = await self.environment(op == "start" or op == "tool" and self.request.get("start") is True)
        if op == "tool" and self.request.get("start") is True:
            await self.workspace(env)
        if op == "start":
            await self.workspace(env)
            return {"available": True, "running": True, "sandboxId": self.name, "frame": await self.frame(env), "detail": "The bot’s isolated CUA computer is running."}
        if op == "control":
            await self.input(env, self.request.get("action"), self.request)
            return {"available": True, "running": True, "sandboxId": self.name, "frame": await self.frame(env)}
        name, args = self.request.get("name"), self.request.get("args", {})
        if name in ("read_file", "list_files", "write_file"):
            if name == "write_file":
                setup = await self.command(env, "mkdir", ["-p", self.workdir])
                if not setup.exit.success:
                    raise ValueError("The CUA workspace could not be created.")
            result = await self.command(env, "python3", ["-c", FILE_SCRIPT, json.dumps([name, args]), self.workdir, WORKSPACE])
            if not result.exit.success:
                raise ValueError("The CUA file operation failed. Check the workspace-relative path and permissions inside the sandbox.")
            return content(json.loads(bytes(result.stdout))["text"])
        if name == "run_command":
            command = args.get("command")
            if not isinstance(command, str) or not command.strip() or len(command) > 32000:
                raise ValueError("Enter a command of at most 32,000 characters.")
            setup = await self.command(env, "mkdir", ["-p", self.workdir])
            if not setup.exit.success:
                raise ValueError("The CUA workspace could not be created.")
            seconds = args.get("timeoutSeconds", 30)
            if isinstance(seconds, bool) or not isinstance(seconds, (int, float)):
                seconds = 30
            script = "import os,pathlib,sys; p=pathlib.Path(sys.argv[2]); r=p.resolve(strict=True);\nif r!=p or not r.is_relative_to(pathlib.Path('/workspace')): raise ValueError('Choose a contained CUA workspace without symlinks.')\nos.chdir(r); os.execv('/bin/sh',['/bin/sh','-c',sys.argv[1]])"
            result = await self.command(env, "python3", ["-c", script, command, self.workdir], int(min(120, max(1, seconds)) * 1000))
            output = bytes(result.stdout) + b"\n" + bytes(result.stderr)
            if len(output) > 2 * 1024 * 1024:
                raise ValueError("The command produced too much output. Run a smaller command.")
            return {**content("Exit " + str(result.exit.code) + "\n" + output.decode(errors="replace")), "isError": not result.exit.success}
        if name == "browser_open":
            from urllib.parse import urlsplit
            url = args.get("url")
            parsed = urlsplit(url) if isinstance(url, str) and len(url) <= 8000 else None
            if parsed is None or parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError("Open an HTTP or HTTPS URL without embedded credentials.")
            # WindowsService owns the browser lifecycle. A shell-launched
            # browser would be a descendant of a short tool command and must
            # otherwise be killed when that command's group is cleaned up.
            await env.call_json("WindowsService/Open", json.dumps({"url": url}))
        elif name in ("browser_click", "computer_click"):
            await self.input(env, "click", args)
        elif name in ("browser_type", "computer_type"):
            await self.input(env, "type", args)
        elif name in ("browser_key", "computer_key"):
            await self.input(env, "key", args)
        elif name not in ("browser_snapshot", "computer_screenshot"):
            raise ValueError("Choose an available CUA tool.")
        frame = await self.frame(env)
        return {"content": [{"type": "text", "text": "CUA sandbox desktop: " + str(frame["width"]) + " × " + str(frame["height"]) + " image pixels."}, {"type": "image", "data": frame["data"], "mimeType": frame["mimeType"]}]}

async def main(request):
    bridge = None
    try:
        if importlib.metadata.version("cua") != VERSION:
            raise ValueError("Prepare the supported CUA " + VERSION + " SDK before continuing.")
        import cua
        bridge = Bridge(request, cua)
        task = asyncio.create_task(bridge.handle())
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, task.cancel)
        try:
            return await task
        except asyncio.CancelledError:
            return {"cancelled": True, "cleanupConfirmed": bridge.cleanup_confirmed}
    except BaseException as error:
        return {"error": safe_error(error), "cleanupConfirmed": bridge.cleanup_confirmed if bridge else True}

if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError("The CUA request is too large.")
        answer = asyncio.run(main(json.loads(raw)))
    except BaseException as error:
        answer = {"error": safe_error(error), "cleanupConfirmed": False}
    sys.stdout.write(json.dumps(answer))
