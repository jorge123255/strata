import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('typing and shimmer follow the theme instead of a fixed gray', async () => {
  const css = await read('../src/styles/chat-motion.css');
  assert.match(css, /\.typing i \{[^}]*background:\s*var\(--st-ink-muted\)/);
  assert.match(css, /\.shimmer \{[^}]*var\(--st-ink-muted\)[^}]*var\(--st-ink\)/);
  assert.equal(css.includes('#6b7079'), false);
  assert.equal(css.includes('#f2f3f5'), false);
  assert.match(css, /opacity:\s*0\.72/);
});

test('room, activity, and member controls show a hover and the error notice stays in the column', async () => {
  const channel = await read('../src/screens/BotTeamChannel.css');
  const bots = await read('../src/screens/Bots.css');
  const settings = await read('../src/screens/BotTeamSettings.css');
  const work = await read('../src/screens/BotTeamWorkOverview.css');
  const app = await read('../src/styles/app.css');
  assert.match(channel, /\.bot-room-tabs > button:hover/);
  assert.match(channel, /\.bot-room-choice-actions button:hover:not\(:disabled\)/);
  assert.match(channel, /\.bot-room-choice-actions button\[data-style='primary'\]:hover:not\(:disabled\)/);
  assert.match(channel, /\.bot-room-send:hover:not\(:disabled\)/);
  assert.match(channel, /\.bot-room-add:hover/);
  assert.match(channel, /\.bot-room-to:hover/);
  assert.match(bots, /\.bots-activity-tabs button:hover/);
  assert.match(bots, /\.bot-team-cap-note button:hover/);
  assert.match(settings, /\.bot-team-member-grid\.bots-member-picker label:hover/);
  assert.match(settings, /\.bot-team-member-briefing summary::after/);
  assert.match(work, /\.bot-work-disclosure > summary:hover/);
  assert.match(app, /\.error-notice \{[^}]*flex-wrap:\s*wrap/);
  assert.match(app, /\.error-notice \{[^}]*color-mix\(in srgb, var\(--st-danger\)/);
});

test('copying a chat message or a tunnel address tells you it worked', async () => {
  const chat = await read('../src/screens/Chat.tsx');
  const serving = await read('../src/screens/Serving.tsx');
  const tunnel = await read('../src/components/CloudflareDialog.tsx');
  assert.match(chat, /function copyChatText/);
  assert.match(chat, /pushToast\('success', tr\('Copied'\)\)/);
  assert.equal(chat.includes('navigator.clipboard.writeText(m.content)'), false);
  assert.equal(serving.includes('navigator.clipboard.writeText(serving.tunnel'), false);
  assert.match(serving, /copyConnectionValue\(serving\.tunnel!\.url!, 'Cloudflare tunnel URL'\)/);
  assert.match(tunnel, /function copyTunnel/);
  assert.match(tunnel, /copyTunnel\(tunnel\.url!/);
  assert.match(tunnel, /copyTunnel\(tunnel!\.originUrl/);
  assert.equal((tunnel.match(/navigator\.clipboard\.writeText/g) ?? []).length, 1);
});
