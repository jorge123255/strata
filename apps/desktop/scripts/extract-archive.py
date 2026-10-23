#!/usr/bin/env python3
"""Extract a tar or zip archive into one directory.

Refuses absolute paths, `..`, and links. Used by the desktop bundler so a
release archive cannot write outside the staging folder.
"""
from __future__ import annotations

import sys
import tarfile
import zipfile
from pathlib import Path


def cleaned(name: str) -> str:
    # removeprefix, not lstrip: lstrip('./') would eat the '..' in '../secret'.
    while name.startswith('./'):
        name = name[2:]
    return name


def unsafe(name: str) -> bool:
    text = cleaned(name)
    parts = Path(text).parts
    return (not text or text.startswith('/') or text.startswith('\\') or '..' in parts
            or ':' in Path(text).drive or '..' in Path(name).parts)


def main() -> None:
    archive, dest = Path(sys.argv[1]), Path(sys.argv[2])
    prefix = sys.argv[3].strip('/') if len(sys.argv) > 3 else ''
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    if archive.suffix == '.zip' or archive.name.endswith('.zip'):
        chosen = extract_zip(archive, dest, prefix)
    else:
        chosen = extract_tar(archive, dest, prefix)
    for path in dest.rglob('*'):
        resolved = path.resolve()
        if resolved != root and root not in resolved.parents:
            raise SystemExit(f'unsafe extract: {path} left {dest}')
        if path.is_symlink():
            raise SystemExit(f'unsafe extract: refusing link {path}')
    print(chosen)


def extract_tar(archive: Path, dest: Path, prefix: str) -> int:
    with tarfile.open(archive) as bundle:
        chosen = []
        for member in bundle.getmembers():
            name = cleaned(member.name)
            if prefix and name != prefix and not name.startswith(prefix + '/'):
                continue
            if unsafe(name) or member.issym() or member.islnk():
                raise SystemExit(f'unsafe path in {archive.name}: {member.name}')
            chosen.append(member)
        if prefix and not chosen:
            raise SystemExit(f'archive has no {prefix}')
        bundle.extractall(dest, members=chosen, filter='data')
    return len(chosen)


def extract_zip(archive: Path, dest: Path, prefix: str) -> int:
    with zipfile.ZipFile(archive) as bundle:
        names = []
        for info in bundle.infolist():
            name = cleaned(info.filename)
            if prefix and name != prefix and not name.startswith(prefix + '/'):
                continue
            if unsafe(name):
                raise SystemExit(f'unsafe path in {archive.name}: {info.filename}')
            names.append(info.filename)
        if prefix and not names:
            raise SystemExit(f'archive has no {prefix}')
        bundle.extractall(dest, names)
    return len(names)


if __name__ == '__main__':
    main()
