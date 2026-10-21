"""Control overlays keep bounded metadata while parent bytes remain hash-bound.

These tests execute only the packager's Python overlay in disposable fixtures,
with synthetic packaging/package metadata. No app, installer or compiler runs.
"""
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'apps/desktop/scripts/build-mac-companion-app.sh'
HELPER = ROOT / 'apps/desktop/scripts/control-bundle-metadata.py'
spec = importlib.util.spec_from_file_location('control_bundle_metadata_tests', HELPER)
bundle = importlib.util.module_from_spec(spec); spec.loader.exec_module(bundle)
VERSION = '.'.join(map(str, sys.version_info[:3]))
PYTHON = {'version': VERSION, 'build': 'synthetic-standalone-build', 'sha256': 'a' * 64}


def record(ancestry=None):
    return {'schema_version': 1, 'component': 'strata-control', 'version': '0.1.46', 'target': 'darwin-arm64', 'python': PYTHON, 'lock': {'file': 'old.lock', 'sha256': 'b' * 64}, 'installed': {'old-package': '0.1'}, 'acquires_at_runtime': False, 'installer': {'files': ['old-file']}, 'source_overlay': ancestry or {}}


class BoundedReader:
    def __init__(self, stream, reads, maximum): self.stream, self.reads, self.maximum = stream, reads, maximum
    def __enter__(self): self.stream.__enter__(); return self
    def __exit__(self, *args): return self.stream.__exit__(*args)
    def fileno(self): return self.stream.fileno()
    def seek(self, *args): return self.stream.seek(*args)
    def read(self, amount=-1):
        if not 0 < amount <= self.maximum: raise AssertionError('An unbounded or oversized metadata read was attempted.')
        self.reads.append(amount); return self.stream.read(amount)


class BundleMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name); self.path = self.folder / 'BUNDLE.json'

    def guarded_reads(self):
        reads = []; original = Path.open
        def opened(path, *args, **kwargs):
            stream = original(path, *args, **kwargs)
            return BoundedReader(stream, reads, max(bundle.HEADER_LIMIT, bundle.HASH_CHUNK)) if path == self.path and args and args[0] == 'rb' else stream
        return reads, mock.patch.object(Path, 'open', opened)

    def test_valid_large_legacy_ancestry_is_streamed_and_never_projected(self):
        payload = json.dumps(record({'donor_bundle': {'ancestry': 'x' * (8 << 20)}, 'carrier_bundle': {'private_previous_object': True}})).encode()
        self.path.write_bytes(payload)
        reads, guarded = self.guarded_reads()
        with guarded, mock.patch.object(Path, 'read_text', side_effect=AssertionError('Whole file read')), mock.patch.object(Path, 'read_bytes', side_effect=AssertionError('Whole file read')):
            captured = bundle.capture_bundle(self.folder)
        self.assertGreater(len(reads), 8); self.assertLessEqual(max(reads), 1 << 20)
        self.assertEqual(captured['reference']['bytes'], len(payload))
        self.assertEqual(captured['reference']['sha256'], hashlib.sha256(payload).hexdigest())
        self.assertEqual(captured['python'], PYTHON)
        self.assertNotIn('ancestry', json.dumps(captured)); self.assertLess(len(json.dumps(captured)), 1000)

    def test_more_than_five_gb_declared_file_has_only_a_bounded_header_read(self):
        prefix = json.dumps(record()).removesuffix('}}').encode() + b'{'
        # A sparse opaque tail represents the legacy declared size without a
        # multi-GB allocation or disk write. Only metadata-prefix reading is
        # tested here; the separate large valid fixture verifies full hashing.
        with self.path.open('wb') as stream:
            stream.write(prefix); stream.truncate((5 << 30) + 123)
        self.assertGreater(self.path.stat().st_size, 5_000_000_000)
        reads, guarded = self.guarded_reads()
        with guarded, mock.patch.object(Path, 'read_text', side_effect=AssertionError('Whole file read')), mock.patch.object(Path, 'read_bytes', side_effect=AssertionError('Whole file read')):
            header = bundle.read_header(self.path)
        self.assertEqual(header['python'], PYTHON); self.assertEqual(reads, [bundle.HEADER_LIMIT])

    def test_source_overlay_value_is_not_decoded_even_if_deep_or_incomplete(self):
        self.path.write_text(json.dumps(record()).removesuffix('}}') + '[' * 10000)
        self.assertEqual(bundle.read_header(self.path)['version'], '0.1.46')

    def test_duplicate_metadata_key_is_rejected(self):
        self.path.write_text('{"version":"1","version":"2","source_overlay":{}}')
        with self.assertRaisesRegex(ValueError, 'repeated keys'): bundle.capture_bundle(self.folder)

    def test_malformed_or_trailing_header_separator_is_rejected(self):
        for text in ['{"version":"1" "python":{}}', '{"version":"1",}', '[]']:
            with self.subTest(text=text):
                self.path.write_text(text)
                with self.assertRaises(ValueError): bundle.capture_bundle(self.folder)

    def test_oversized_metadata_header_is_rejected_without_reading_more(self):
        self.path.write_text(json.dumps({'version': 'x' * (bundle.HEADER_LIMIT + 1024), 'source_overlay': {}}))
        reads, guarded = self.guarded_reads()
        with guarded, self.assertRaisesRegex(ValueError, 'bounded header'): bundle.capture_bundle(self.folder)
        self.assertEqual(reads, [bundle.HEADER_LIMIT])

    def test_python_identity_is_bounded_and_must_match_actual_runtime(self):
        self.path.write_text(json.dumps(record()))
        captured = bundle.capture_bundle(self.folder)
        self.assertEqual(bundle.python_metadata(captured, None, VERSION), PYTHON)
        with self.assertRaisesRegex(ValueError, 'version differs'): bundle.python_metadata(captured, None, '99.0.0')
        excessive = record(); excessive['python']['extra'] = 'x' * bundle.PYTHON_METADATA_LIMIT
        try:
            self.path.write_text(json.dumps(excessive))
            with self.assertRaisesRegex(ValueError, 'too large'): bundle.capture_bundle(self.folder)
        finally: PYTHON.pop('extra', None)

    def test_changed_input_during_hashing_is_rejected(self):
        self.path.write_text(json.dumps(record()))
        original = os.fstat; calls = 0
        def changed(fd):
            nonlocal calls
            calls += 1; value = original(fd)
            return types.SimpleNamespace(st_dev=value.st_dev, st_ino=value.st_ino, st_size=value.st_size + (1 if calls > 1 else 0), st_mtime_ns=value.st_mtime_ns, st_mode=value.st_mode)
        with mock.patch.object(bundle.os, 'fstat', changed):
            with self.assertRaisesRegex(ValueError, 'changed during provenance'): bundle.capture_bundle(self.folder)

    def test_absent_record_preserves_verified_runtime_fallback(self):
        self.assertIsNone(bundle.capture_bundle(self.folder))
        self.assertEqual(bundle.python_metadata(None, None, VERSION), {'version': VERSION})

    def test_bom_and_non_ascii_metadata_remain_valid(self):
        self.path.write_bytes(b'\xef\xbb\xbf' + json.dumps({**record(), 'component': 'strata-contrôle'}, ensure_ascii=False).encode())
        self.assertEqual(bundle.capture_bundle(self.folder)['reference']['component'], 'strata-contrôle')


class RealOverlayTests(unittest.TestCase):
    def test_thirty_actual_writer_overlays_stay_bounded_and_preserve_runtime_contract(self):
        text = SCRIPT.read_text()
        code = text.split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary); repo = folder / 'repo'; control = folder / 'control'; carrier = folder / 'carrier'
            for path in [repo / 'apps/desktop/scripts', repo / 'packaging/locks', control, carrier]: path.mkdir(parents=True)
            (repo / 'apps/desktop/scripts/control-bundle-metadata.py').write_bytes(HELPER.read_bytes())
            lock = repo / 'packaging/locks/runtime-darwin-arm64-cp312.txt'; lock.write_text('fixture-runtime==1.0\n')
            (repo / 'strata.py').write_text('# Synthetic current source\n'); (control / 'strata.py').write_text('# Old source\n')
            (control / 'VERSION').write_text('0.1.46\n')
            parent = json.dumps(record({'legacy': 'x' * (2 << 20)})).encode()
            (control / 'BUNDLE.json').write_bytes(parent); (carrier / 'BUNDLE.json').write_bytes(parent)
            packaging = types.SimpleNamespace(PYTHON_VERSION=VERSION, PAYLOAD=['strata.py'], TOOLS_SUBSET=[], _source_version=lambda: '0.1.47', source_commit=lambda: 'c' * 40, add_installer=lambda control, repo: {'files': []})
            sizes = []
            for _ in range(30):
                donor_before = (control / 'BUNDLE.json').read_bytes(); carrier_before = (carrier / 'BUNDLE.json').read_bytes()
                with mock.patch.object(sys, 'argv', ['overlay-fixture', str(repo), str(control), str(carrier)]), mock.patch.object(sys, 'path', list(sys.path)), mock.patch.dict(sys.modules, {'package_terminal': packaging}), mock.patch('importlib.metadata.version', return_value='1.0'), mock.patch('builtins.print'):
                    exec(compile(code, str(SCRIPT) + ':python-overlay', 'exec'), {'__name__': '__main__'})
                output = (control / 'BUNDLE.json').read_bytes(); fresh = json.loads(output); sizes.append(len(output))
                self.assertLess(len(output), 8192)
                self.assertEqual(fresh['python'], PYTHON); self.assertEqual(fresh['version'], '0.1.47')
                self.assertEqual(fresh['installed'], {'fixture-runtime': '1.0'}); self.assertEqual(fresh['installer'], {'files': []})
                self.assertFalse(fresh['acquires_at_runtime'])
                self.assertEqual(fresh['lock'], {'file': 'packaging/locks/runtime-darwin-arm64-cp312.txt', 'sha256': hashlib.sha256(lock.read_bytes()).hexdigest()})
                self.assertEqual(fresh['source_overlay']['commit'], 'c' * 40)
                self.assertEqual(fresh['source_overlay']['files_sha256']['strata.py'], hashlib.sha256((repo / 'strata.py').read_bytes()).hexdigest())
                for key, data in [('donor_bundle', donor_before), ('carrier_bundle', carrier_before)]:
                    reference = fresh['source_overlay'][key]
                    self.assertEqual(reference['bytes'], len(data)); self.assertEqual(reference['sha256'], hashlib.sha256(data).hexdigest())
                    self.assertNotIn('source_overlay', reference); self.assertNotIn('installed', reference); self.assertNotIn('python', reference)
                self.assertEqual((carrier / 'BUNDLE.json').read_bytes(), carrier_before, 'The parent record was never modified by staging.')
                (carrier / 'BUNDLE.json').write_bytes(output)
            self.assertLess(max(sizes) - min(sizes), 32, sizes)


if __name__ == '__main__': unittest.main()
