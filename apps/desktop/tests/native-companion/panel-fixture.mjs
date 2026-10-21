#!/usr/bin/env node
// Prepare and launch a disposable native panel with synthetic status only.
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url)), desktop = resolve(here, '../..');
const directory = mkdtempSync(join(tmpdir(), 'strata-companion-panel-'));
const app = join(directory, 'StrataCompanionFixture.app');
mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
const native = join(app, 'Contents/MacOS/StrataCompanionFixture');
writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>strata.companion.fixture.${randomUUID()}</string><key>CFBundleName</key><string>Strata Companion Fixture</string><key>CFBundleExecutable</key><string>StrataCompanionFixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSMinimumSystemVersion</key><string>15.0</string><key>NSHighResolutionCapable</key><true/></dict></plist>`);
const sources = ['CompanionAvatar.swift', 'KoalaGeometry.swift', 'AvatarCharacterGeometry.swift', 'SVGPath.swift', 'CompanionModel.swift', 'CompanionFeed.swift', 'CompanionMotion.swift', 'CompanionPanel.swift'].map(name => join(desktop, 'src-tauri/src/companion', name));
const args = ['swiftc', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx15.0`, '-O', '-o', native, ...sources, join(here, 'PanelFixture.swift')];
await new Promise((resolve, reject) => { const child = spawn('/usr/bin/xcrun', args, { stdio: 'inherit' }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Swift exited ${code}`))); });
let state = 'approval', requestCount = 0;
const kinds = ['koala', 'fox', 'cat', 'robot', 'koala', 'koala'];
const names = ['TEST 👩‍💻', 'Fern', 'Pip', 'Atlas', 'Pebble', 'Spark'];
const makeSnapshot = () => ({ supported: true, sessions: names.map((name, index) => ({ id: `fixture_chat_${index}`, botId: `fixture_bot_${index}`, name, title: index === 0 ? 'Project Openflix and Tunner' : 'A shared conversation', state: index === 0 ? state : ['thinking', 'working', 'completed', 'thinking', 'completed'][index - 1], approvalCount: index === 0 && state === 'approval' ? 1 : 0, avatarConfig: { color: ['sky', 'orange', 'violet', 'slate', 'cloud', 'graphite'][index], eyes: 'round', ears: 'scalloped', kind: kinds[index], ...(index >= 4 ? { shape: index === 4 ? 'pebble' : 'spark' } : {}) } })), counts: { waiting: state === 'approval' ? 1 : 0, working: 3 + (['working', 'thinking'].includes(state) ? 1 : 0), completed: 2 + (state === 'completed' ? 1 : 0), errors: state === 'error' ? 1 : 0 }, hasMore: true, updatedAt: new Date().toISOString() });
const server = createServer((req, res) => {
  if (req.url === '/__fixture/status') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ requestCount, state })); return; }
  if (req.url?.startsWith('/__fixture/state/')) {
    const next = req.url.split('/').at(-1); if (!['approval', 'thinking', 'working', 'completed', 'error', 'offline', 'oversized'].includes(next)) { res.writeHead(400).end(); return; }
    state = next; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ state })); return;
  }
  if (req.url !== '/api/bots/companion/snapshot' || req.headers['x-strata-companion'] !== 'f'.repeat(64)) { res.writeHead(403).end(); return; }
  requestCount++;
  if (state === 'offline') { res.writeHead(503).end(); return; }
  res.setHeader('content-type', 'application/json'); res.end(state === 'oversized' ? 'x'.repeat(9000) : JSON.stringify(makeSnapshot()));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port, suite = `strata.companion.fixture.${randomUUID()}`;
const info = { app, native, directory, port, suite, source: 'synthetic fixture only' };
writeFileSync(join(directory, 'fixture.json'), JSON.stringify(info, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify(info) + '\n');
const child = spawn(native, [String(port), directory, suite], { stdio: 'inherit' });
const stop = () => { child.kill('SIGTERM'); server.closeAllConnections(); server.close(); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
await new Promise(resolve => child.once('exit', resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
