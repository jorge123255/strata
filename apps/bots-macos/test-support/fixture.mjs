/** Disposable native-window QA only. No provider, SSH session or VM runs. */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const stamp = '2026-10-20T12:00:00.000Z';
const image = readFileSync(new URL('../../ios/test-support/computer-fixture.png', import.meta.url)).toString('base64');
const bots = [{ id: 'native-fixture-bot', name: 'Ada', avatar: '🤖', avatarConfig: { color: 'violet', eyes: 'star', ears: 'scalloped' }, provider: 'codex', model: 'Provider default', computerMode: 'cua', execution: { kind: 'ssh', host: 'fixture-alias', user: 'arbitrary-user' }, workspace: '/workspace', capabilities: 'both', policy: 'manual', instructions: '', createdAt: stamp, updatedAt: stamp, detail: 'Synthetic native UI fixture · no model or computer is running' }];
let messages = [
  { id: 'fixture-u1', role: 'user', content: 'Continue the work from my Mac on my iPhone.', at: stamp },
  { id: 'fixture-a1', role: 'assistant', reasoning: 'This fixture displays the provider’s user-visible thinking in the shared transcript.', content: 'Your shared history, thinking and activity are here. The same conversation is available on Mac and iPhone.', at: stamp, tools: [{ id: 'fixture-tool', name: 'browser_open', state: 'done', preview: 'Open the isolated browser', result: 'Synthetic activity card for native UI testing.' }] },
];
let pending = [{ id: 'fixture-approval', name: 'run_command', preview: 'Allow the test command inside Ada’s computer?' }];
let running = false, lease = null;
let memory = '# What Ada remembers\n\nThis is a disposable UI fixture. No model, SSH session or VM runs.\n';
let rules = [], routines = [];
const calls = [];
const chat = id => ({ id, title: id === 'native-fixture-chat' ? 'Shared Mac and iPhone work' : 'Earlier shared conversation', preferences: { botId: bots[0].id, botName: 'Ada', botComputerMode: 'cua', botModel: 'Codex · Provider default', botComputer: 'Fixture SSH computer' }, createdAt: stamp, updatedAt: stamp, active: false, messages });
const computer = () => ({ available: true, running, cleanupConfirmed: true, detail: running ? 'Synthetic CUA screen · no VM is running' : 'Start the synthetic fixture computer', ...(running ? { image: { mimeType: 'image/png', data: image }, width: 640, height: 400 } : {}), control: { active: !!lease, owned: !!lease, ...(lease ? { expiresAt: Date.now() + 30000 } : {}) } });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1'); let body = ''; for await (const chunk of req) body += chunk; const value = body ? JSON.parse(body) : {};
  calls.push({ method: req.method, path: url.pathname, body: value });
  let result, status = 200;
  if (url.pathname === '/__fixture') result = { calls, messages, pending, bots, memory, rules, routines, running, controlled: !!lease };
  else if (url.pathname === '/api/bots' && req.method === 'GET') result = { bots, providers: ['claude', 'codex', 'grok', 'kimi', 'ollama'].map(id => ({ id, name: id, available: true, detail: 'Synthetic provider; never contacted' })), computers: [{ id: 'local', name: 'This Mac', kind: 'local', execution: { kind: 'local' }, available: true }, { id: 'ssh_fixture', name: 'Fixture SSH computer', kind: 'ssh', execution: { kind: 'ssh', host: 'fixture-alias', user: 'arbitrary-user' }, available: true }], models: [{ id: 'fixture-maya', connectionId: 'maya', connectionName: 'Maya', name: 'Maya-S24', model: 'maya', available: true }, { id: 'fixture-strata', connectionId: 'strata', connectionName: 'Strata remote', name: 'Coder', model: 'coder', available: true }] };
  else if (url.pathname === '/api/bots' && req.method === 'POST') { const bot = { ...bots[0], ...value, id: randomUUID() }; bots.push(bot); result = { bot }; }
  else if (url.pathname === '/api/companion/conversations') result = { available: true, conversations: [chat('native-fixture-chat'), chat('native-fixture-old')] };
  else if (url.pathname.endsWith('/messages')) { messages.push({ id: randomUUID(), role: 'user', content: value.message, at: stamp }); result = { accepted: true }; }
  else if (url.pathname.endsWith('/approval')) { pending = pending.filter(p => p.id !== value.toolId); result = { approved: true }; }
  else if (url.pathname.includes('/api/companion/conversations/')) result = { conversation: chat(url.pathname.split('/').pop()), pending };
  else if (url.pathname.endsWith('/conversations')) result = { conversation: chat('native-fixture-chat'), pending };
  else if (url.pathname.includes('/computer')) {
    const action = url.pathname.split('/').pop();
    if (action === 'start') running = true;
    if (action === 'stop') { running = false; lease = null; }
    if (action === 'takeover') lease = 'fixture-control-token';
    if (action === 'release') lease = null;
    result = { ...computer(), ...(action === 'takeover' ? { leaseToken: lease } : {}), ...(action === 'stop' ? { stopped: true } : {}), ...(action === 'release' ? { released: true } : {}) };
  } else if (url.pathname.endsWith('/work/file')) result = { text: '# Summary\n\nSynthetic output for native UI QA.' };
  else if (url.pathname.endsWith('/work')) { if (req.method === 'PATCH') { memory = value.memory ?? memory; rules = value.rules ?? rules; } result = { memory, rules, routines, outputs: [{ path: 'outputs/summary.md', name: 'summary.md', size: 57, modified: stamp }], files: [] }; }
  else if (url.pathname.includes('/routines')) { if (req.method === 'POST') routines.push({ ...value, id: 'fixture-routine', nextRun: stamp }); result = { routines }; }
  else if (req.method === 'PATCH' && url.pathname === '/api/bots/native-fixture-bot') { Object.assign(bots[0], value); result = { bot: bots[0] }; }
  else { status = 404; result = { error: 'Unknown fixture route' }; }
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ origin: `http://127.0.0.1:${server.address().port}`, pid: process.pid })));
