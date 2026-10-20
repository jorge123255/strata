"""Offline tests of the actual CUA helper. No SDK install or VM is started."""
import asyncio
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace as NS
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("strata_cua", Path(__file__).parent.parent / "server/bots-cua.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class Missing(Exception):
    pass

class FakeSDK:
    CuaError = NS(NotFound=Missing)
    CuaConfig = staticmethod(lambda **kwargs: NS(**kwargs))
    SandboxCreateOptions = CuaConfig
    SpacesdCommand = CuaConfig
    ScreenshotOptions = CuaConfig
    ImageFormat = NS(PNG="png")

    def __init__(self):
        self.Cua = self
        self.calls = []
        self.exists = False
        self.status = "RUNNING"
        self.boot = "11111111-1111-1111-1111-111111111111"
        self.reboot_changes_identity = True
        self.fail_cleanup = False
        self.process_started = asyncio.Event()
        self.allow_finish = asyncio.Event()
        self.hold_command = False
        self.process = NS(pid=lambda: 987)
        self.process.wait = self.wait

    def embedded(self, config):
        self.config = config
        return self

    def sandboxes(self):
        return self

    def local(self):
        return self

    async def connect(self, name):
        self.calls.append(("connect", name))
        if not self.exists:
            raise Missing()
        return self

    async def create(self, options):
        self.calls.append(("create", options))
        self.exists = True
        return self

    def info(self):
        return NS(status=self.status)

    async def resume(self):
        self.calls.append(("resume",))
        self.status = "RUNNING"

    async def suspend(self):
        self.calls.append(("suspend",))
        self.status = "SUSPENDED"

    async def restart(self):
        self.calls.append(("restart",))
        self.status = "RUNNING"

    async def get(self, name):
        self.calls.append(("get", name))
        if not self.exists:
            raise Missing()
        return self.info()

    async def spacesd(self, timeout):
        return self

    async def doctor(self):
        self.calls.append(("doctor",))
        return NS(checks=[NS(name="qemu", status="RuntimeCheckStatus.OK", detail="ready")])

    async def setup(self, components, dry):
        self.calls.append(("setup", components, dry))

    async def screenshot(self, options):
        return NS(image=b"png", width=800, height=600, scale=2)

    async def click(self, x, y):
        self.calls.append(("click", x, y))

    async def type_text(self, value):
        self.calls.append(("type", value))

    async def press(self, value):
        self.calls.append(("key", value))

    async def hotkey(self, value):
        self.calls.append(("hotkey", value))

    async def call_json(self, method, value):
        self.calls.append(("rpc", method, json.loads(value)))

    async def spawn(self, command):
        self.calls.append(("spawn", command))
        self.last_command = command
        self.process_started.set()
        return self.process

    async def wait(self):
        if self.hold_command:
            await self.allow_finish.wait()
        return NS(exit=NS(success=True, code=0), stdout=b"1000" if "id" in getattr(self, "last_command", NS(args=[])).args else b"done", stderr=b"")

    async def run(self, command):
        if command.program == "id":
            self.calls.append(("guest-setup", command))
            return NS(exit=NS(success=True), stdout=b"1000")
        if command.program == "sudo":
            self.calls.append(("guest-setup", command))
            return NS(exit=NS(success=True), stdout=b"")
        if command.program == "cat" and command.args == ["/proc/sys/kernel/random/boot_id"]:
            self.calls.append(("boot-id", self.boot))
            return NS(exit=NS(success=True), stdout=self.boot.encode())
        if command.program == "/bin/sh" and "reboot" in command.args[-1]:
            self.calls.append(("guest-reboot", command))
            if self.reboot_changes_identity: self.boot = "22222222-2222-2222-2222-222222222222"
            return NS(exit=NS(success=True), stdout=b"")
        self.calls.append(("cleanup", command))
        return NS(exit=NS(success=not self.fail_cleanup), stdout=b'{"cleanupConfirmed":true}')

def instance(sdk, directory, **request):
    return bridge.Bridge({"directory": directory, "sandbox": "strata-bot-" + "a" * 24, **request}, sdk)

class HelperTests(unittest.IsolatedAsyncioTestCase):
    async def test_probe_and_state_never_create_resume_or_install(self):
        with tempfile.TemporaryDirectory() as root:
            sdk = FakeSDK()
            result = await instance(sdk, root, operation="probe").handle()
            self.assertTrue(result["available"])
            result = await instance(sdk, root, operation="state").handle()
            self.assertFalse(result["running"])
            self.assertEqual([c[0] for c in sdk.calls], ["doctor", "get"])
            self.assertFalse(sdk.config.fleet_from_env)
            self.assertFalse(sdk.config.fleet_from_session)

    async def test_prepare_never_invokes_system_qemu_installer_or_starts_a_vm(self):
        with tempfile.TemporaryDirectory() as root:
            sdk = FakeSDK()
            await instance(sdk, root, operation="prepare").handle()
            self.assertEqual(sdk.calls, [("doctor",)])

    async def test_kvm_denial_is_unavailable_with_actionable_detail_without_terminal_commands(self):
        with tempfile.TemporaryDirectory() as root:
            sdk = FakeSDK()
            async def denied():
                return NS(checks=[NS(name="qemu", status="RuntimeCheckStatus.ERROR", detail='permission denied opening /dev/kvm; sudo usermod -aG kvm "$USER"')])
            sdk.doctor = denied
            result = await instance(sdk, root, operation="prepare").handle()
            self.assertFalse(result["available"])
            self.assertIn("Choose another execution computer", result["detail"])
            self.assertNotIn("sudo", json.dumps(result))
            self.assertFalse(any(c[0] in ("setup", "create", "resume") for c in sdk.calls))

    async def test_start_fixed_vm_image_and_bounds_after_explicit_request(self):
        with tempfile.TemporaryDirectory() as root:
            sdk = FakeSDK()
            with patch.object(bridge.shutil, "disk_usage", return_value=NS(free=40 * 1024**3)):
                result = await instance(sdk, root, operation="start", image="attacker", cpus=100).handle()
            self.assertTrue(result["running"])
            options = next(c[1] for c in sdk.calls if c[0] == "create")
            self.assertEqual((options.on, options.kind, options.runtime, options.image, options.cpus, options.memory_mb), ("local", "vm", "qemu", bridge.IMAGE, 2, 4096))
            command = next(c[1] for c in sdk.calls if c[0] == "guest-setup" and "mkdir" in c[1].args)
            self.assertIn("/workspace", command.args)
            self.assertEqual(command.program, "sudo")
            self.assertEqual(command.args, ["-n", "mkdir", "-p", "/workspace"])
            self.assertFalse(hasattr(command, "user"))
            self.assertEqual(result["frame"]["width"], 800)

    async def test_reading_missing_space_does_not_start_and_low_disk_blocks_vm(self):
        with tempfile.TemporaryDirectory() as root:
            sdk = FakeSDK()
            with self.assertRaisesRegex(ValueError, "Start"):
                await instance(sdk, root, operation="tool", name="read_file", args={}, start=False).handle()
            with patch.object(bridge.shutil, "disk_usage", return_value=NS(free=1000)):
                with self.assertRaisesRegex(ValueError, "12 GB"):
                    await instance(sdk, root, operation="start").handle()
            self.assertFalse(any(c[0] == "create" for c in sdk.calls))

    async def test_stopped_qemu_disk_is_retained_with_actionable_start_error(self):
        with tempfile.TemporaryDirectory() as root:
            sdk = FakeSDK(); sdk.exists = True; sdk.status = "STOPPED"
            with self.assertRaisesRegex(ValueError, "disk is retained"):
                await instance(sdk, root, operation="start").handle()
            self.assertFalse(any(c[0] in ("create", "delete", "resume", "restart") for c in sdk.calls))

    async def test_readonly_paused_and_stopped_state_never_connects_or_resumes(self):
        with tempfile.TemporaryDirectory() as root:
            for state in ("SandboxStatus.SUSPENDED", "SandboxStatus.STOPPED"):
                sdk = FakeSDK(); sdk.exists = True; sdk.status = state
                result = await instance(sdk, root, operation="state").handle()
                self.assertFalse(result["running"])
                self.assertEqual([call[0] for call in sdk.calls], ["get"])
                self.assertIn("paused" if state.endswith("SUSPENDED") else "disk is retained", result["detail"])

    async def test_paused_start_resumes_owned_computer_before_connect(self):
        with tempfile.TemporaryDirectory() as root:
            sdk = FakeSDK(); sdk.exists = True; sdk.status = "SandboxStatus.SUSPENDED"
            target = instance(sdk, root, operation="start")
            async def resume():
                sdk.calls.append(("owned-cli-resume",)); sdk.status = "SandboxStatus.RUNNING"
            target.resume_owned = resume
            self.assertTrue((await target.handle())["running"])
            self.assertLess(sdk.calls.index(("owned-cli-resume",)), next(i for i, c in enumerate(sdk.calls) if c[0] == "connect"))
            self.assertFalse(any(c[0] in ("create", "resume", "restart") for c in sdk.calls))

    async def test_workspace_setup_failure_keeps_durable_uncertainty_until_stop(self):
        with tempfile.TemporaryDirectory() as root:
            sdk = FakeSDK(); original = sdk.run
            async def denied(command):
                if command.program == "sudo":
                    return NS(exit=NS(success=False), stdout=b"")
                return await original(command)
            sdk.run = denied
            target = instance(sdk, root)
            with self.assertRaisesRegex(ValueError, "Stop this bot"):
                await target.workspace(sdk)
            self.assertFalse(target.cleanup_confirmed)
            self.assertEqual(len(list(target.runs.iterdir())), 1)

    async def test_workspace_setup_cancellation_keeps_durable_uncertainty(self):
        with tempfile.TemporaryDirectory() as root:
            sdk = FakeSDK(); original = sdk.run; began = asyncio.Event()
            async def delayed(command):
                if command.program == "sudo":
                    began.set(); await asyncio.Event().wait()
                return await original(command)
            sdk.run = delayed
            target = instance(sdk, root)
            task = asyncio.create_task(target.workspace(sdk))
            await began.wait(); task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertFalse(target.cleanup_confirmed)
            self.assertEqual(len(list(target.runs.iterdir())), 1)

    async def test_resume_cli_exact_sdk_binary_private_environment_and_owned_name(self):
        with tempfile.TemporaryDirectory() as root:
            sdk = FakeSDK(); sdk.exists = True; sdk.status = "RUNNING"
            root = str(Path(root).resolve())
            sdk.__file__ = str(Path(root) / "site-packages/cua/__init__.py")
            child = NS(pid=2000000000, returncode=0, communicate=lambda **kw: (b'{}', b''), poll=lambda: 0)
            with patch.object(bridge.Path, "is_file", return_value=True), patch.object(bridge.subprocess, "Popen", return_value=child) as spawn:
                target = instance(sdk, root)
                target.cleanup_confirmed = False
                await target.resume_owned()
                self.assertFalse(target.cleanup_confirmed)
            args = spawn.call_args.args[0]; env = spawn.call_args.kwargs["env"]
            self.assertEqual(args, [str(Path(root) / "site-packages/cua/bin/cua"), "--embedded", "--state-dir", str(Path(root) / "sandboxes"), "--json", "sandbox", "resume", "local:strata-bot-" + "a" * 24])
            self.assertEqual(env["CUA_HOME"], str(Path(root) / "home" / ".cua"))
            self.assertEqual(env["CUA_SPACES_TELEPORT_HOME"], str(Path(root) / "teleport"))
            self.assertNotIn("SSH_AUTH_SOCK", env)
            self.assertEqual(env["CUA_DAEMON_NO_RELAY"], "1")
            self.assertTrue(spawn.call_args.kwargs["start_new_session"])

    async def test_control_scales_pixels_and_rejects_outside_frame(self):
        with tempfile.TemporaryDirectory() as root:
            sdk = FakeSDK(); sdk.exists = True
            target = instance(sdk, root)
            await target.input(sdk, "click", {"x": 400, "y": 300})
            self.assertIn(("click", 200, 150), sdk.calls)
            with self.assertRaises(ValueError):
                await target.input(sdk, "click", {"x": 800, "y": 1})
            await target.input(sdk, "key", {"key": "Control+L"})
            self.assertIn(("hotkey", ["ctrl", "L"]), sdk.calls)

    async def test_browser_open_uses_owned_space_rpc_never_host_process(self):
        with tempfile.TemporaryDirectory() as root:
            sdk = FakeSDK(); sdk.exists = True
            await instance(sdk, root, operation="tool", name="browser_open", args={"url": "https://example.test"}).handle()
            self.assertIn(("rpc", "WindowsService/Open", {"url": "https://example.test"}), sdk.calls)
            self.assertFalse(any(c[0] == "spawn" for c in sdk.calls))
            with self.assertRaises(ValueError):
                await instance(sdk, root, operation="tool", name="browser_open", args={"url": "file:///etc/passwd"}).handle()

    async def test_cancel_waits_independent_nonce_group_cleanup(self):
        with tempfile.TemporaryDirectory() as root:
            sdk = FakeSDK(); sdk.hold_command = True
            target = instance(sdk, root)
            task = asyncio.create_task(target.command(sdk, "/bin/sh", ["-c", "sleep 90"]))
            await sdk.process_started.wait(); task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            spawned = next(c[1] for c in sdk.calls if c[0] == "spawn")
            cleanup = next(c[1] for c in sdk.calls if c[0] == "cleanup")
            self.assertEqual(cleanup.args[-2], "987")
            self.assertEqual(cleanup.args[-1], spawned.env["STRATA_CUA_RUN"])
            self.assertIn("os.setsid()", spawned.args[1])
            self.assertTrue(target.cleanup_confirmed)

    async def test_failed_cleanup_never_reports_confirmed(self):
        with tempfile.TemporaryDirectory() as root:
            sdk = FakeSDK(); sdk.fail_cleanup = True
            target = instance(sdk, root)
            with self.assertRaisesRegex(RuntimeError, "cleanup"):
                await target.command(sdk, "true", [])
            self.assertFalse(target.cleanup_confirmed)

    async def test_stop_requires_a_changed_guest_boot_before_freeze_and_marker_cleanup(self):
        with tempfile.TemporaryDirectory() as root:
            sdk = FakeSDK(); sdk.exists = True; sdk.status = "SUSPENDED"
            target = instance(sdk, root, operation="stop")
            async def resume():
                self.assertFalse(target.cleanup_confirmed)
                sdk.calls.append(("owned-cli-resume",)); sdk.status = "RUNNING"
            target.resume_owned = resume
            target.runs.mkdir(parents=True); marker = target.runs / "owned-command.json"; marker.write_text("pending")
            result = await target.handle()
            self.assertTrue(result["cleanupConfirmed"])
            self.assertTrue(result["stopped"])
            self.assertLess(next(i for i, c in enumerate(sdk.calls) if c[0] == "guest-reboot"), sdk.calls.index(("suspend",)))
            self.assertLess(sdk.calls.index(("boot-id", "22222222-2222-2222-2222-222222222222")), sdk.calls.index(("suspend",)))
            self.assertFalse(marker.exists())
            self.assertFalse(any(c[0] in ("delete", "create", "restart") for c in sdk.calls))

    async def test_unchanged_guest_boot_keeps_marker_and_cleanup_uncertain(self):
        with tempfile.TemporaryDirectory() as root:
            sdk = FakeSDK(); sdk.exists = True
            sdk.reboot_changes_identity = False
            target = instance(sdk, root, operation="stop")
            target.runs.mkdir(parents=True); marker = target.runs / "owned-command.json"; marker.write_text("pending")
            with patch.object(bridge, "GUEST_REBOOT_TIMEOUT", .001):
                with self.assertRaisesRegex(ValueError, "fresh guest boot"):
                    await target.handle()
            self.assertTrue(marker.exists())
            self.assertFalse(target.cleanup_confirmed)
            self.assertFalse(any(c[0] == "suspend" for c in sdk.calls))

    async def test_missing_sandbox_cannot_erase_pending_command_uncertainty(self):
        with tempfile.TemporaryDirectory() as root:
            sdk = FakeSDK(); target = instance(sdk, root, operation="stop")
            target.runs.mkdir(parents=True); marker = target.runs / "owned-command.json"; marker.write_text("pending")
            with self.assertRaisesRegex(ValueError, "cannot find this computer"):
                await target.handle()
            self.assertTrue(marker.exists())
            self.assertFalse(target.cleanup_confirmed)

class FileTests(unittest.TestCase):
    def run_file(self, root, name, args):
        output = io.StringIO()
        with patch.object(sys, "argv", ["guest-file-tool", json.dumps([name, args]), str(root)]), contextlib.redirect_stdout(output):
            exec(compile(bridge.FILE_SCRIPT, "<actual-guest-file-tool>", "exec"), {})
        return json.loads(output.getvalue())

    def test_actual_guest_file_program_confines_symlinks_absolute_and_traversal(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "workspace"; root.mkdir()
            outside = Path(temp) / "outside"; outside.write_text("sentinel")
            (root / "escape").symlink_to(outside)
            for path in ("../outside", str(outside), "escape"):
                with self.assertRaises(ValueError):
                    self.run_file(root, "write_file", {"path": path, "content": "bad"})
            self.assertEqual(outside.read_text(), "sentinel")
            self.run_file(root, "write_file", {"path": "src/main.txt", "content": "inside"})
            self.assertEqual(self.run_file(root, "read_file", {"path": "src/main.txt"})["text"], "inside")

if __name__ == "__main__":
    unittest.main()
