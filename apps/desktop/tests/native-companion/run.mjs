#!/usr/bin/env node
// Disposable loopback-only fixture. No production host, settings or user data.
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
const evidence = mkdtempSync(join(tmpdir(), 'strata-native-companion-tests-'));
const sources = ['CompanionAvatar.swift', 'KoalaGeometry.swift', 'AvatarCharacterGeometry.swift', 'SVGPath.swift', 'CompanionModel.swift', 'CompanionFeed.swift', 'CompanionMotion.swift'].map(name => join(root, 'src-tauri/src/companion', name));
const native = join(evidence, 'CompanionTests');
const processRun = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
  child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited ${code}: ${stderr}\n${stdout}`)));
});
const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const compile = await processRun('/usr/bin/xcrun', ['swiftc', '-target', `${arch}-apple-macosx15.0`, '-O', '-o', native, ...sources, join(here, 'CompanionTests.swift')]);
writeFileSync(join(evidence, 'compile.log'), compile.stderr, { flag: 'wx', mode: 0o600 });
let redirected = 0, cookies = 0, badTokens = 0;
const fixture = { supported: true, sessions: [{ id: 'chat_1', botId: 'bot_1', name: 'TEST 👩‍💻', title: 'A real conversation', state: 'approval', approvalCount: 1, avatarConfig: { color: 'sky', eyes: 'star', ears: 'scalloped' } }], counts: { waiting: 1, working: 0, completed: 0, errors: 0 }, hasMore: false, updatedAt: new Date().toISOString() };
const server = createServer((request, response) => {
  if (request.headers['x-strata-companion'] !== 'fixture-token-private') badTokens++;
  if (request.headers.cookie) cookies++;
  if (request.url === '/target') { redirected++; response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(fixture)); return; }
  if (request.url === '/redirect') { response.writeHead(302, { location: '/target' }); response.end(); return; }
  if (request.url === '/auth') { response.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"' }); response.end(); return; }
  if (request.url === '/wrong-type') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('{}'); return; }
  if (request.url === '/slow') { response.writeHead(200, { 'content-type': 'application/json' }); response.flushHeaders(); const timer = setTimeout(() => response.end('{}'), 7000); response.on('close', () => clearTimeout(timer)); return; }
  if (request.url === '/oversized-length') { response.writeHead(200, { 'content-type': 'application/json', 'content-length': 999999 }); response.end('x'); return; }
  if (request.url === '/oversized-chunked') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('x'.repeat(8192)); response.end('x'); return; }
  response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'fixture=private; Path=/' }); response.end(JSON.stringify(fixture));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const result = await processRun(native, [String(server.address().port)]);
  const report = JSON.parse(result.stdout);
  if (redirected || cookies || badTokens) throw new Error(`Feed isolation failed: ${JSON.stringify({ redirected, cookies, badTokens })}`);
  const final = { ...report, feedIsolation: { redirectsFollowed: redirected, cookiesSent: cookies, missingOrWrongTokens: badTokens }, native, evidence };
  writeFileSync(join(evidence, 'results.json'), JSON.stringify(final, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(final, null, 2) + '\n');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
