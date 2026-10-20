import { createServer } from 'node:net';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { redact } from './process.mjs';
export function toolResult(value) {
  if (value && Array.isArray(value.content)) return value;
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null) }] };
}
export async function startToolBridge({ tools, executeTool, signal }) {
  signal?.throwIfAborted();
  const dir = await mkdtemp(join(tmpdir(), 'strata-bot-')); await chmod(dir, 0o700);
  const path = join(dir, 'm.sock'), definitions = join(dir, 'tools.json'), sockets = new Set();
  await writeFile(definitions, JSON.stringify(tools), { mode: 0o600 });
  const server = createServer(socket => {
    sockets.add(socket); socket.setEncoding('utf8'); let buffer = '';
    socket.on('close', () => sockets.delete(socket)); socket.on('error', () => sockets.delete(socket));
    socket.on('data', chunk => { buffer += chunk; if (buffer.length > 8 * 1024 * 1024) { socket.destroy(); return; }
      for (let end; (end = buffer.indexOf('\n')) >= 0;) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); let m; try { m = JSON.parse(line); } catch { continue; }
        void (async () => { let result; try {
          signal?.throwIfAborted(); if (!tools.some(t => t.name === m.name)) throw new Error('Unknown Strata bot tool.');
          result = toolResult(await executeTool(m.name, m.args ?? {}));
        } catch (error) { result = { content: [{ type: 'text', text: redact(error) }], isError: true }; }
        if (!socket.destroyed) socket.write(`${JSON.stringify({ id: m.id, result })}\n`);
        })();
      }
    });
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); }); await chmod(path, 0o600); }
  catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  let closePromise;
  const close = () => closePromise ??= (async () => { for (const socket of sockets) socket.destroy(); server.close(); await rm(dir, { recursive: true, force: true }); signal?.removeEventListener('abort', close); })();
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) { await close(); signal.throwIfAborted(); }
  const command = process.execPath, args = [fileURLToPath(new URL('./mcp-stdio.mjs', import.meta.url))];
  const env = { STRATA_BOT_SOCKET: path, STRATA_BOT_TOOLS: definitions };
  return { command, args, env, acp: { name: 'strata', command, args, env: Object.entries(env).map(([name, value]) => ({ name, value })) }, close };
}
