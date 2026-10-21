/** One fresh, account-bound SSH channel for an explicitly granted file operation. */
import { createHash, randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { mkdir, lstat, writeFile, readFile, unlink } from 'node:fs/promises';
import { normalizeBotHostFolder, runBotHostFolderOperation } from './bots-host-folder.mjs';

export const botHostFolderRemoteIdentity = () => createHash('sha256').update(JSON.stringify([hostname(), process.getuid?.(), homedir()])).digest('hex');
export async function hostFolderOperation(input, { reader, send, directory, leaseMs = 12000, python = 'python3', operation = runBotHostFolderOperation } = {}) {
  const controller = new AbortController(), signal = controller.signal;
  let lastBeat = Date.now(), pending, failure, value, record, recordIdentity, nonce, registryFailure;
  const abort = () => { controller.abort(); pending?.reject(new Error('Host folder access was cancelled.')); pending = null; };
  const line = data => {
    let message; try { message = JSON.parse(data); } catch { abort(); return; }
    if (message.type === 'heartbeat') { lastBeat = Date.now(); return; }
    if (message.type === 'cancel') { abort(); return; }
    if (message.type === 'reply' && pending && message.id === pending.id) { const held = pending; pending = null; message.value === true && !message.error ? held.resolve(true) : held.reject(new Error('Host folder access was revoked.')); }
  };
  reader.on('line', line); reader.once('close', abort); process.once('SIGTERM', abort); process.once('SIGHUP', abort);
  const lease = setInterval(() => { if (Date.now() - lastBeat > leaseMs) abort(); }, Math.min(1000, Math.max(5, leaseMs / 3))); lease.unref?.();
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['operation', 'grant', 'binding', 'args', 'expectedIdentity'].includes(key))) throw new Error('Choose a valid remote host folder request.');
    if (!['validate', 'host_list_files', 'host_read_file', 'host_write_file'].includes(input.operation)) throw new Error('This remote host folder action is unavailable.');
    const grant = normalizeBotHostFolder(input.grant); if (!grant) throw new Error('Select a host folder explicitly before using it.');
    const remoteIdentity = botHostFolderRemoteIdentity();
    if (input.expectedIdentity !== undefined && input.expectedIdentity !== remoteIdentity || input.operation !== 'validate' && input.expectedIdentity !== remoteIdentity) throw new Error('The SSH alias now reaches a different computer or account. Select this host folder again.');
    signal.throwIfAborted();
    if (typeof directory !== 'string') throw new Error('The private remote folder worker registry is unavailable.');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const runs = join(directory, 'runs');
    for (const path of [directory, runs]) {
      if (path === runs) await mkdir(path, { recursive: true, mode: 0o700 });
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) throw new Error('The private remote folder worker registry is unavailable.');
    }
    nonce = randomUUID(); record = join(runs, `${process.pid}-${nonce}.json`);
    await writeFile(record, JSON.stringify({ pid: process.pid, nonce, kind: 'host-folder', startedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    recordIdentity = await lstat(record);
    signal.throwIfAborted();
    value = await operation({ operation: input.operation, grant, ...(input.binding ? { binding: input.binding } : {}), ...(input.args ? { args: input.args } : {}) }, { python, signal, authorize: () => {
      signal.throwIfAborted();
      return new Promise((resolve, reject) => { const id = `folder_${randomUUID()}`; pending = { id, resolve, reject }; send({ type: 'folder-authorize', id }); });
    } });
    signal.throwIfAborted();
    if (input.operation === 'validate') value = { ...value, remoteIdentity };
  } catch (error) { failure = error; }
  finally {
    const cancelled = signal.aborted; abort(); clearInterval(lease); reader.removeListener('line', line); reader.removeListener('close', abort); process.removeListener('SIGTERM', abort); process.removeListener('SIGHUP', abort);
    // Keep the worker visible to independent probes until its helper confirms close.
    if (recordIdentity) {
      try {
        const stat = await lstat(record);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.ino !== recordIdentity.ino || stat.size > 4096) throw new Error('The remote folder worker record changed.');
        const value = JSON.parse(await readFile(record, 'utf8'));
        if (value.pid !== process.pid || value.nonce !== nonce) throw new Error('The remote folder worker record changed.');
        await unlink(record);
      } catch (error) { registryFailure = error; }
    }
    // The helper is awaited through process close, including cancellation, before acknowledging cleanup.
    send({ type: 'cleanup', confirmed: !registryFailure });
    if (registryFailure) { send({ type: 'failure', code: 'ssh_cleanup_unconfirmed', message: 'The remote folder worker could not confirm its private activity record cleanup.' }); reader.close(); return; }
    if (failure && !cancelled) send({ type: 'failure', code: 'ssh_host_folder', message: failure.message });
    else send({ type: 'result', value: cancelled ? { cancelled: true } : value });
    reader.close();
  }
}
