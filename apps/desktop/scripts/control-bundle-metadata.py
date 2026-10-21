"""Bounded metadata and streamed references for an existing Control BUNDLE.

Legacy overlays may contain multi-GB recursive source_overlay ancestry. That
ancestry is opaque provenance: bind its bytes, never parse or embed it again.
The standalone runtime, installed packages and new source hashes are verified
separately by the Mac packager.
"""
from __future__ import annotations

import codecs
import hashlib
import json
import os
import re
import stat
from pathlib import Path

HEADER_LIMIT = 1 << 20
HASH_CHUNK = 1 << 20
PYTHON_METADATA_LIMIT = 1 << 14


def _stable(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def _header(prefix: bytes, size: int) -> dict:
    # A bounded prefix may end inside a UTF-8 code point in opaque ancestry.
    text = codecs.getincrementaldecoder('utf-8-sig')().decode(prefix, final=False)
    decoder = json.JSONDecoder()
    position = 0

    def whitespace():
        nonlocal position
        while position < len(text) and text[position] in ' \t\r\n': position += 1

    def value():
        nonlocal position
        whitespace()
        try: item, position = decoder.raw_decode(text, position)
        except (ValueError, RecursionError) as cause:
            raise ValueError('Control BUNDLE metadata is invalid or exceeds the bounded header; ancestry was not read.') from cause
        return item

    whitespace()
    if position >= len(text) or text[position] != '{': raise ValueError('Control BUNDLE metadata must begin with an object.')
    position += 1
    result = {}; after_comma = False
    while True:
        whitespace()
        if position < len(text) and text[position] == '}':
            if after_comma: raise ValueError('Control BUNDLE metadata has a trailing separator.')
            position += 1; whitespace()
            if size > len(prefix) or position != len(text): raise ValueError('Control BUNDLE has data after its metadata object.')
            return result
        key = value()
        if not isinstance(key, str) or key in result: raise ValueError('Control BUNDLE metadata has invalid or repeated keys.')
        whitespace()
        if position >= len(text) or text[position] != ':': raise ValueError('Control BUNDLE metadata has no value separator.')
        position += 1
        # It is deliberately unnecessary to decode, skip or traverse this
        # value. Required runtime metadata precedes it in official bundles.
        if key == 'source_overlay': return result
        result[key] = value()
        whitespace()
        if position < len(text) and text[position] == ',': position += 1; after_comma = True; continue
        after_comma = False
        if position < len(text) and text[position] == '}': continue
        raise ValueError('Control BUNDLE metadata is invalid or exceeds the bounded header.')


def read_header(path: Path) -> dict:
    """Read at most HEADER_LIMIT bytes; useful even for a legacy 5+ GB record."""
    with path.open('rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode): raise ValueError('Control BUNDLE must be a regular file.')
        result = _header(stream.read(HEADER_LIMIT), before.st_size)
        if _stable(before) != _stable(os.fstat(stream.fileno())) or _stable(before) != _stable(path.stat()): raise ValueError('Control BUNDLE changed during metadata reading.')
        return result


def capture_bundle(folder: Path) -> dict | None:
    """Return only a small identity reference and bounded Python metadata.

    Size and SHA256 cover every parent byte, including opaque old ancestry.
    Full JSON validity of old ancestry is not claimed or needed for this hash.
    """
    path = folder / 'BUNDLE.json'
    if path.is_symlink(): raise ValueError('Control BUNDLE must not be a symbolic link.')
    try: stream = path.open('rb')
    except FileNotFoundError: return None
    with stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode): raise ValueError('Control BUNDLE must be a regular file.')
        metadata = _header(stream.read(HEADER_LIMIT), before.st_size)
        reference = {'file': 'BUNDLE.json', 'bytes': before.st_size}
        for key in ['schema_version', 'component', 'version', 'target']:
            if key not in metadata: continue
            item = metadata[key]
            if key == 'schema_version':
                if type(item) is not int or not 1 <= item <= 100: raise ValueError('Control BUNDLE schema version is invalid.')
            elif not isinstance(item, str) or len(item) > 200 or any(ord(char) < 32 for char in item): raise ValueError('Control BUNDLE identity metadata is invalid.')
            reference[key] = item
        python = metadata.get('python')
        if python is not None and (not isinstance(python, dict) or len(json.dumps(python).encode('utf-8')) > PYTHON_METADATA_LIMIT): raise ValueError('Control BUNDLE Python metadata is invalid or too large.')
        stream.seek(0)
        digest = hashlib.sha256(); total = 0
        for chunk in iter(lambda: stream.read(HASH_CHUNK), b''):
            digest.update(chunk); total += len(chunk)
        if total != before.st_size or _stable(before) != _stable(os.fstat(stream.fileno())) or _stable(before) != _stable(path.stat()): raise ValueError('Control BUNDLE changed during provenance hashing.')
        reference['sha256'] = digest.hexdigest()
        return {'reference': reference, 'python': python}


def python_metadata(donor: dict | None, carrier: dict | None, expected_version: str) -> dict:
    """Preserve the verified donor's Python identity without prior bundle trees."""
    python = (donor or carrier or {}).get('python') or {'version': expected_version}
    if not isinstance(python, dict) or python.get('version') != expected_version: raise ValueError('Control BUNDLE Python version differs from the verified runtime build contract.')
    if 'build' in python and (not isinstance(python['build'], str) or len(python['build']) > 200): raise ValueError('Control BUNDLE Python build metadata is invalid.')
    if 'sha256' in python and (not isinstance(python['sha256'], str) or not re.fullmatch('[0-9a-fA-F]{64}', python['sha256'])): raise ValueError('Control BUNDLE Python digest is invalid.')
    return python
