"""One explicitly granted host folder. Never a shell, guest mount or directory sync."""
import json
import os
import stat
import sys
import uuid

READ_LIMIT = 1024 * 1024
WRITE_LIMIT = 2 * READ_LIMIT
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def require(condition, message):
    if not condition:
        raise ValueError(message)


def root_path(value):
    require(isinstance(value, str) and 0 < len(value.encode('utf-8')) <= 4000 and not any(ord(character) < 32 or ord(character) == 127 for character in value), 'Choose a valid host folder.')
    require(os.path.isabs(value) and value != '/', 'Choose a specific absolute host folder, not the filesystem root.')
    return value


def open_root(path):
    require(path == os.path.normpath(path), 'The host folder path changed. Select it again.')
    fd = os.open('/', DIRECTORY)
    try:
        for part in path.split('/')[1:]:
            next_fd = os.open(part, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def binding(fd):
    value = os.fstat(fd)
    require(stat.S_ISDIR(value.st_mode), 'Choose a regular host folder.')
    return {'device': str(value.st_dev), 'inode': str(value.st_ino)}


def components(value, directory=False):
    require(isinstance(value, str) and len(value.encode('utf-8')) <= 4000 and not any(ord(character) < 32 or ord(character) == 127 for character in value) and '\\' not in value, 'Use a relative path inside the granted host folder.')
    if directory and value == '.':
        return []
    require(value and not value.startswith('/') and all(part not in ('', '.', '..') for part in value.split('/')), 'Use a relative path inside the granted host folder.')
    return value.split('/')


def walk(root, parts, create=False):
    fd = os.dup(root)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, 0o755, dir_fd=fd)
                except FileExistsError:
                    pass
            next_fd = os.open(part, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def file_state(fd, name):
    try:
        value = os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    require(stat.S_ISREG(value.st_mode), 'Only regular files are supported; symbolic links and special files are not shared.')
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_mode)


def authorize(phase='access'):
    print(json.dumps({'ready': True, 'phase': phase}), flush=True)
    line = sys.stdin.buffer.readline(4097)
    require(len(line) <= 4096 and line.endswith(b'\n') and json.loads(line) == {'authorized': True}, 'Host folder access was cancelled or revoked.')


def run(request):
    grant = request.get('grant')
    require(isinstance(grant, dict) and grant.get('access') in ('read', 'read-write'), 'Choose a host folder access mode.')
    path = root_path(grant.get('path'))
    operation = request.get('operation')
    require(operation in ('validate', 'host_list_files', 'host_read_file', 'host_write_file'), 'This host folder operation is unavailable.')
    if operation == 'validate':
        path = os.path.realpath(path)
        require(path != '/', 'Choose a specific host folder, not the filesystem root.')
    root = open_root(path)
    try:
        identity = binding(root)
        if operation == 'validate':
            return {'path': path, 'access': grant['access'], 'binding': identity}
        require(request.get('binding') == identity, 'The granted host folder was moved or replaced. Select it again.')
        args = request.get('args', {})
        require(isinstance(args, dict), 'Choose valid host folder arguments.')
        allowed = ('path', 'content') if operation == 'host_write_file' else ('path',)
        require(all(key in allowed for key in args), 'This host folder tool has unsupported arguments.')
        parts = components(args.get('path', '.') if operation == 'host_list_files' else args.get('path'), operation == 'host_list_files')
        if operation == 'host_write_file':
            require(grant['access'] == 'read-write', 'This host folder is read-only.')
            content = args.get('content')
            require(isinstance(content, str), 'Write a UTF-8 text file.')
            content = content.encode('utf-8', errors='strict')
            require(len(content) <= WRITE_LIMIT, 'Write a UTF-8 text file of at most 2 MB.')
        authorize()
        # Confirm that the public root still names the same selected directory.
        check = open_root(path)
        try:
            require(binding(check) == identity, 'The granted host folder changed. Select it again.')
        finally:
            os.close(check)
        if operation == 'host_list_files':
            folder = walk(root, parts)
            try:
                entries = []
                with os.scandir(folder) as iterator:
                    for item in iterator:
                        require(len(entries) < 1000, 'This folder has more than 1,000 entries. Choose a smaller subfolder.')
                        kind = 'link' if item.is_symlink() else 'directory' if item.is_dir(follow_symlinks=False) else 'file' if item.is_file(follow_symlinks=False) else 'special'
                        entries.append((item.name, kind))
                return {'text': '\n'.join(kind + '\t' + name for name, kind in sorted(entries))}
            finally:
                os.close(folder)
        parent = walk(root, parts[:-1], create=operation == 'host_write_file')
        try:
            name = parts[-1]
            original = file_state(parent, name)
            if operation == 'host_read_file':
                require(original is not None, 'This host file does not exist.')
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    value = os.fstat(fd)
                    require(stat.S_ISREG(value.st_mode) and value.st_size <= READ_LIMIT, 'Read a regular UTF-8 text file of at most 1 MB.')
                    require((value.st_dev, value.st_ino) == original[:2], 'This host file changed. Try again.')
                    with os.fdopen(os.dup(fd), 'rb') as stream:
                        data = stream.read(READ_LIMIT + 1)
                    require(len(data) <= READ_LIMIT, 'Read a UTF-8 text file of at most 1 MB.')
                    require(file_state(parent, name) == original, 'This host file changed while reading. Try again.')
                    return {'text': data.decode('utf-8', errors='strict')}
                finally:
                    os.close(fd)
            temporary = '.strata-host-folder-' + uuid.uuid4().hex + '.tmp'
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(content)
                    stream.flush()
                    os.fchmod(stream.fileno(), (original[5] & 0o777) if original else 0o644)
                    os.fsync(stream.fileno())
                authorize('commit')
                check = open_root(path)
                try:
                    require(binding(check) == identity, 'The granted host folder changed. Select it again.')
                finally:
                    os.close(check)
                current_parent = walk(root, parts[:-1])
                try:
                    require(binding(current_parent) == binding(parent), 'The host file parent folder moved. Try again.')
                finally:
                    os.close(current_parent)
                require(file_state(parent, name) == original, 'This host file changed while writing. Try again.')
                os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
                os.fsync(parent)
            finally:
                try:
                    os.unlink(temporary, dir_fd=parent)
                except FileNotFoundError:
                    pass
            return {'text': 'Saved ' + '/'.join(parts)}
        finally:
            os.close(parent)
    finally:
        os.close(root)


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.readline(8 * WRITE_LIMIT + 1)
        require(len(raw) <= 8 * WRITE_LIMIT and raw.endswith(b'\n'), 'Host folder request exceeded its size limit.')
        request = json.loads(raw)
        require(isinstance(request, dict), 'Choose a valid host folder request.')
        print(json.dumps({'result': run(request)}), flush=True)
    except Exception as error:
        if isinstance(error, (ValueError, UnicodeError)):
            message = str(error) if not isinstance(error, UnicodeError) else 'This file is not valid UTF-8 text.'
        elif isinstance(error, FileNotFoundError):
            message = 'This host folder or file no longer exists.'
        elif isinstance(error, PermissionError):
            message = 'This execution account cannot access the selected host folder or file.'
        else:
            message = 'Host folder access failed. Symbolic links and special files are not shared.'
        print(json.dumps({'error': message[:1500]}), flush=True)
        sys.exit(1)
