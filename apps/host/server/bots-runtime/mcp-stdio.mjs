/** Private stdio adapter. Its parent socket exists only for the lifetime of a bot run. */
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
const tools = JSON.parse(await readFile(process.env.STRATA_BOT_TOOLS, 'utf8'));
const socket = createConnection(process.env.STRATA_BOT_SOCKET);
let input = '', replies = '', next = 0;
const pending = new Map();
const output = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
socket.setEncoding('utf8');
socket.on('data', chunk => { replies += chunk; for (let end; (end = replies.indexOf('\n')) >= 0;) { const line = replies.slice(0, end); replies = replies.slice(end + 1); try { const m = JSON.parse(line); if (pending.has(m.id)) { const id = pending.get(m.id); pending.delete(m.id); output({ id, result: m.result }); } } catch { /* malformed */ } } });
socket.on('error', () => process.exit(1)); socket.on('close', () => process.exit(0));
process.stdin.setEncoding('utf8'); process.stdin.on('end', () => socket.destroy());
process.stdin.on('data', chunk => { input += chunk; for (let end; (end = input.indexOf('\n')) >= 0;) { const line = input.slice(0, end); input = input.slice(end + 1); if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; }
  if (m.method === 'initialize') output({ id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'strata-bot-tools', version: '1.0.0' } } });
  else if (m.method === 'tools/list') output({ id: m.id, result: { tools } });
  else if (m.method === 'tools/call') {
    const requested = m.params?.name;
    const prefixed = typeof requested === 'string' && requested.startsWith('mcp__strata__') ? requested.slice('mcp__strata__'.length) : '';
    const name = tools.some(tool => tool.name === requested) ? requested : (prefixed && tools.some(tool => tool.name === prefixed) ? prefixed : requested);
    const id = ++next; pending.set(id, m.id); socket.write(`${JSON.stringify({ id, name, args: m.params?.arguments ?? {} })}\n`);
  }
  else if (m.id !== undefined) output({ id: m.id, error: { code: -32601, message: 'Method not found' } });
} });
