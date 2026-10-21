import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRemoteBotSSH, botSSHBundle } from '../server/bots-ssh.mjs';
import { bootstrapSource, SSH_BOTS_COMMAND } from '../server/bots-ssh-bootstrap.mjs';
import { createBotHostFolderTools, botHostFolderAuthority } from '../server/bots-host-folder.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'strata-folder-ssh-'));
test.after(() => rm(scratch, { recursive: true, force: true }));

test('fresh verified SSH channel grants and edits the selected account folder with no guest or provider start', async () => {
  const account = join(scratch, 'account'), folder = join(scratch, 'remote project'); await mkdir(account); await mkdir(folder); await writeFile(join(folder, 'file.txt'), 'remote original');
  const bundle = await botSSHBundle(), installed = join(account, '.local/share/strata/bot-workers', bundle.hash);
  for (const [name, encoded] of Object.entries(bundle.assets)) { const path = join(installed, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, Buffer.from(encoded, 'base64')); }
  for (const [name, version] of Object.entries(bundle.dependencies)) { const path = join(installed, 'node_modules', name, 'package.json'); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify({ version })); }
  await writeFile(join(installed, '.prepared.json'), JSON.stringify({ hash: bundle.hash }));
  let calls = 0, authorizations = 0;
  const ssh = createRemoteBotSSH({ bundle: async () => bundle, spawnProcess: (_command, args, options) => { calls++; assert.equal(args.at(-1), SSH_BOTS_COMMAND); return spawn(process.execPath, ['-e', bootstrapSource], { ...options, env: { ...process.env, HOME: account } }); }, heartbeatMs: 20, leaseMs: 100, leaseCleanupGraceMs: 100 });
  let current;
  const bridge = createBotHostFolderTools({ remoteSSH: ssh, currentGrant: () => { authorizations++; return current; } });
  const execution = { kind: 'ssh', host: 'saved-alias' }; // account comes from system SSH config, never a static root/user.
  try {
    const verified = await bridge.validate({ path: folder, access: 'read-write' }, { execution });
    assert.match(verified.remoteIdentity, /^[a-f0-9]{64}$/);
    const bot = { id: 'bot_remote', computerMode: 'cua', execution, policy: 'manual', hostFolder: { path: verified.path, access: verified.access }, hostFolderBinding: verified.binding, hostFolderRevision: 'r1', hostFolderRemoteIdentity: verified.remoteIdentity };
    current = botHostFolderAuthority(bot);
    const context = { bot, chatId: 'remote-folder-chat', requestPermission: async () => true };
    assert.equal((await bridge.execute('host_read_file', { path: 'file.txt' }, context)).content[0].text, 'remote original');
    await bridge.execute('host_write_file', { path: 'file.txt', content: 'remote updated' }, context);
    assert.equal(await readFile(join(folder, 'file.txt'), 'utf8'), 'remote updated');
    assert.equal(calls, 3); assert.ok(authorizations >= 9);
    await assert.rejects(access(join(account, '.local/share/strata/bot-workers/state/cua-runtime')), { code: 'ENOENT' }, 'file actions must not prepare runtime, launch providers, create guests or write VM state');
    await assert.rejects(ssh.hostFolder(execution, { operation: 'host_write_file', grant: bot.hostFolder, binding: verified.binding, args: { path: 'file.txt', content: 'must not write' }, expectedIdentity: 'b'.repeat(64) }, { authorize: async () => true }), /different computer or account/);
    await assert.rejects(ssh.hostFolder(execution, { operation: 'host_write_file', grant: bot.hostFolder, binding: verified.binding, args: { path: 'file.txt', content: 'must not write' }, expectedIdentity: verified.remoteIdentity }, { authorize: async () => false }), /revoked/);
    assert.equal(await readFile(join(folder, 'file.txt'), 'utf8'), 'remote updated');
    await bridge.finish(context.chatId); await bridge.close();
  } finally { await ssh.close(); }
});
