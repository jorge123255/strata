"""Private QEMU source-boundary fixtures; no APT commands or downloads run."""
import importlib.util
from pathlib import Path
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

source = Path(__file__).parent.parent / "server/bots-runtime/cua-qemu-prepare.py"
spec = importlib.util.spec_from_file_location("private_qemu", source)
qemu = importlib.util.module_from_spec(spec); spec.loader.exec_module(qemu)


class PrivateQEMU(unittest.TestCase):
    def test_configuration_disables_global_parts_main_hooks_sources_and_all_writable_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            stage = Path(temporary)
            config = qemu.apt_configuration(stage, "noble", "amd64")
            text = config.read_text()
            self.assertTrue(text.startswith('Dir::Etc::parts "-";\nDir::Etc::main "/dev/null";'))
            self.assertIn('Dir::Etc::sourceparts "-";', text)
            self.assertIn('Dir::State::status "/var/lib/dpkg/status";', text)
            for key in ["lists", "extended_states", "archives", "pkgcache.bin", "srcpkgcache.bin", "log"]:
                self.assertIn(str(stage / key), text)
            self.assertNotIn("/var/cache", text); self.assertNotIn("/var/log", text)
            repos = (stage / "sources.list").read_text()
            self.assertIn("https://archive.ubuntu.com/ubuntu noble", repos)
            self.assertIn("https://security.ubuntu.com/ubuntu noble-security", repos)
            self.assertIn("signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg", repos)
            self.assertNotIn("trusted=yes", repos)

    def test_distro_allowlist_never_accepts_a_shell_value_or_other_distribution(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "os-release"
            with patch.object(qemu.platform, "machine", return_value="x86_64"):
                path.write_text('ID=ubuntu\nVERSION_CODENAME="resolute"\n')
                self.assertEqual(qemu.distro(path)[:3], ("resolute", "amd64", "qemu-system-x86_64"))
                for invalid in ['ID=debian\nVERSION_CODENAME=noble', 'ID=ubuntu\nVERSION_CODENAME="noble; touch bad"']:
                    path.write_text(invalid)
                    with self.assertRaises(ValueError): qemu.distro(path)

    def test_private_wrappers_quote_space_and_apostrophe_paths_and_limit_library_environment_to_child(self):
        with tempfile.TemporaryDirectory(prefix="strata qemu's ") as temporary:
            root = Path(temporary); (root / "usr/bin").mkdir(parents=True); (root / "usr/lib/x86_64-linux-gnu").mkdir(parents=True)
            binary = root / "usr/bin/qemu-img"; binary.write_text('#!/bin/sh\nprintf "%s\\n%s" "$LD_LIBRARY_PATH" "$1"\n'); binary.chmod(0o700)
            wrapper = root / "wrapper"; wrapper.write_text(qemu.wrapper(root, "qemu-img")); wrapper.chmod(0o700)
            original = os.environ.get("LD_LIBRARY_PATH")
            result = subprocess.check_output([str(wrapper), "literal $() argument"], text=True)
            self.assertIn(str(root / "usr/lib"), result); self.assertTrue(result.endswith("literal $() argument"))
            self.assertEqual(os.environ.get("LD_LIBRARY_PATH"), original)

    def test_download_only_never_invokes_install_scripts_sudo_or_system_setup(self):
        text = source.read_text()
        self.assertIn('["--download-only", "--reinstall", "--no-install-recommends"', text)
        self.assertIn('["-x", archive, root]', text)
        self.assertNotIn('run("sudo"', text); self.assertNotIn('"dpkg",', text)
        self.assertNotIn('"apt",', text); self.assertNotIn('"usermod"', text)
        self.assertIn('re.search(r"(?:Pre-Invoke|Post-Invoke|Pre-Install-Pkgs)"', text)

    def test_activation_denies_privilege_escalation_only_in_its_private_prefix(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); target = home / "qemu/version"; raw = target / "usr/bin"; raw.mkdir(parents=True)
            (target / "usr/lib").mkdir()
            firmware = target / "usr/share/seabios"; firmware.mkdir(parents=True)
            (firmware / "bios-256k.bin").write_bytes(b"fixture BIOS")
            for name in ("qemu-system-x86_64", "qemu-img"):
                binary = raw / name; binary.write_text("#!/bin/sh\nexit 0\n"); binary.chmod(0o700)
            original = os.environ.get("PATH")
            qemu.activate(home, target, "qemu-system-x86_64")
            result = subprocess.run([str(home / "bin/sudo"), "-n", "true"], check=False)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn("exec", (home / "bin/sudo").read_text())
            self.assertEqual(os.environ.get("PATH"), original)
            self.assertEqual((home / "qemu/usr").resolve(), target / "usr")
            self.assertEqual((target / "usr/share/qemu/bios-256k.bin").read_bytes(), b"fixture BIOS")
            self.assertFalse(os.path.isabs(os.readlink(target / "usr/share/qemu/bios-256k.bin")))

    def test_timeout_kills_and_reaps_owned_command_group(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "pid"
            code = "import os,pathlib,time; pathlib.Path(" + repr(str(path)) + ").write_text(str(os.getpid())); time.sleep(30)"
            with self.assertRaisesRegex(ValueError, "timed out"):
                qemu.run(sys.executable, ["-c", code], os.environ.copy(), .2)
            with self.assertRaises(ProcessLookupError): os.kill(int(path.read_text()), 0)
            self.assertFalse(qemu.ACTIVE)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux descendant state proof uses /proc")
    def test_leader_exit_does_not_skip_TERM_resistant_descendant_group_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "descendant"
            code = "import os,signal,pathlib,time\np=os.fork()\nif p==0:\n os.close(1);os.close(2);signal.signal(signal.SIGTERM,signal.SIG_IGN);pathlib.Path(" + repr(str(path)) + ").write_text(str(os.getpid()));time.sleep(30)\nelse:\n while not pathlib.Path(" + repr(str(path)) + ").exists():time.sleep(.01)\n"
            qemu.run(sys.executable, ["-c", code], os.environ.copy(), 2)
            pid = int(path.read_text())
            try: fields = (Path('/proc') / str(pid) / 'stat').read_text().split(') ', 1)[1].split()
            except FileNotFoundError: fields = ['gone']
            self.assertIn(fields[0], ('gone', 'Z')); self.assertFalse(qemu.ACTIVE)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux descendant state proof uses /proc")
    def test_helper_TERM_forwards_to_its_detached_child_group_and_escalates(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "descendant"
            childcode = "import os,signal,pathlib,time\np=os.fork()\nif p==0:\n signal.signal(signal.SIGTERM,signal.SIG_IGN);pathlib.Path(" + repr(str(path)) + ").write_text(str(os.getpid()));time.sleep(30)\nelse:time.sleep(30)"
            code = "import importlib.util,signal,os,sys\ns=importlib.util.spec_from_file_location('q'," + repr(str(source)) + ");q=importlib.util.module_from_spec(s);s.loader.exec_module(q);signal.signal(signal.SIGTERM,q.cancelled);q.run(sys.executable,['-c'," + repr(childcode) + "],os.environ.copy(),30)"
            helper = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            try:
                deadline = time.monotonic() + 3
                while not path.exists() and time.monotonic() < deadline: time.sleep(.01)
                self.assertTrue(path.exists())
                helper.send_signal(signal.SIGTERM); helper.communicate(timeout=2)
                pid = int(path.read_text())
                try: fields = (Path('/proc') / str(pid) / 'stat').read_text().split(') ', 1)[1].split()
                except FileNotFoundError: fields = ['gone']
                self.assertIn(fields[0], ('gone', 'Z'))
            finally:
                if helper.poll() is None:
                    os.killpg(helper.pid, signal.SIGKILL); helper.communicate(timeout=2)


if __name__ == "__main__": unittest.main()
