/** Optional fsynced workflow checkpoints. Read-only/unused controllers create nothing. */
import { openSync, closeSync, fsyncSync, fstatSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, readdirSync, linkSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const fault = message => Object.assign(new Error(message), { status: 503 });
const hash = data => createHash('sha256').update(data).digest('hex');
const missing = p => { try { return lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const same = (a, b) => ['dev','ino','size','mtimeMs','ctimeMs','mode'].every(k => a[k] === b[k]);
function privateBytes(path, maxBytes) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes || process.platform !== 'win32' && (before.mode & 0o077)) throw fault('Workflow storage is not a private regular file. It was left unchanged.');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try { const opened = fstatSync(fd); if (!same(before, opened)) throw fault('Workflow storage changed while opening.'); const bytes = readFileSync(fd); if (!same(opened,fstatSync(fd)) || !same(opened,lstatSync(path))) throw fault('Workflow storage changed while reading.'); return bytes; }
  finally { closeSync(fd); }
}
function syncDirectory(directory) {
  let fd; try { fd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)); fsyncSync(fd); }
  catch (e) { if (process.platform !== 'win32' || !['EINVAL','EPERM','EISDIR'].includes(e.code)) throw e; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function workflowStore(directory, { file = 'bot-workflows.json', maxBytes = 32 * 1024 * 1024 } = {}) {
  directory = resolve(directory); const path = join(directory,file), lock = `${path}.lock`, token = randomUUID(), claim = join(lock,`${token}.json`); let expected, claimed = false, failed, lockInode, ticket;
  function lockDirectory() { const s = lstatSync(lock); if (!s.isDirectory() || s.isSymbolicLink() || process.platform !== 'win32' && (s.mode & 0o077) || lockInode !== undefined && s.ino !== lockInode) throw fault('Workflow writer ownership changed.'); lockInode = s.ino; }
  function contenders() {
    lockDirectory(); const result = [];
    for (const name of readdirSync(lock)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw fault('Workflow writer ownership is unavailable.');
      let bytes; try { bytes = privateBytes(join(lock,name),1024); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      const v = JSON.parse(bytes);
      if (!v || !Number.isSafeInteger(v.pid) || v.pid < 1 || v.token+'.json' !== name || typeof v.choosing !== 'boolean' || !Number.isSafeInteger(v.ticket) || v.ticket < 0) throw fault('Workflow writer ownership could not be verified.');
      // A reused PID is conservatively live. Unknown ownership never permits takeover.
      if (alive(v.pid)) result.push(v);
    }
    return result;
  }
  function removeClaim() { try { if (JSON.parse(privateBytes(claim,1024)).token === token) unlinkSync(claim); } catch {} claimed = false; }
  function own() {
    if (failed) throw failed;
    const parent = missing(directory); if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) throw fault('The workflow directory is unavailable.');
    mkdirSync(directory,{recursive:true,mode:0o700}); mkdirSync(lock,{recursive:true,mode:0o700}); lockDirectory();
    if (!claimed) {
      // Fail-fast Lamport bakery election. Publish choosing before selecting a
      // ticket, then reject if another choosing/lower ticket exists. Never
      // unlink/reclaim another process's claim, including stale/corrupt claims.
      const temporary = `${path}.${token}.claim.tmp`;
      const publishClaim = value => {
        const fd = openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
        try { writeFileSync(fd,JSON.stringify(value));fsyncSync(fd); } finally { closeSync(fd); }
      };
      try {
        publishClaim({pid:process.pid,token,choosing:true,ticket:0});
        try { linkSync(temporary,claim); } finally { unlinkSync(temporary); }
        claimed = true;
        ticket = Math.max(0,...contenders().filter(v=>v.token!==token).map(v=>v.ticket))+1;
        if (!Number.isSafeInteger(ticket)) throw fault('Workflow writer tickets are unavailable.');
        publishClaim({pid:process.pid,token,choosing:false,ticket}); renameSync(temporary,claim);
        const others = contenders();
        if (others.some(v=>v.token!==token&&(v.choosing||v.ticket<ticket||v.ticket===ticket&&v.token<token))) throw fault('Workflow checkpoints are owned by another live controller.');
      } catch (e) { try { unlinkSync(temporary); } catch {} removeClaim(); throw e; }
    }
    const all = contenders(), owner = all.find(v=>v.token===token);
    if (!owner || owner.choosing || owner.ticket!==ticket || all.some(v=>v.token!==token&&!v.choosing&&(v.ticket<ticket||v.ticket===ticket&&v.token<token))) throw fault('Workflow writer ownership was lost.');
    const current = missing(path) ? hash(privateBytes(path,maxBytes)) : undefined;
    if (current!==expected) throw fault('Workflow checkpoints changed in another controller. Refresh before continuing.');
  }
  return { read() { if (!missing(path)) return null; const bytes=privateBytes(path,maxBytes); expected=hash(bytes); return JSON.parse(bytes); }, save(value) {
    const bytes=Buffer.from(JSON.stringify(value)); if(bytes.length>maxBytes)throw fault('Workflow checkpoint storage is full. Existing progress was retained.');
    own(); const temp=`${path}.${token}.tmp`;let renamed=false;
    try { const fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);if(!fstatSync(fd).isFile())throw fault('Workflow checkpoint is not regular.');}finally{closeSync(fd);}own();renameSync(temp,path);renamed=true;syncDirectory(directory);expected=hash(bytes); }
    catch(e){if(renamed)failed=fault('Workflow checkpoint durability could not be confirmed. Inspect existing progress; nothing will be replayed.');throw failed??e;}
    finally{try{unlinkSync(temp);}catch{}}
  }, assertOwner:own, close:removeClaim };
}
