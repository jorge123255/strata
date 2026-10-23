import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/lib/mention-picker.ts', import.meta.url));
const compiled = await build({ entryPoints: [source], bundle: true, write: false, format: 'esm', platform: 'node' });
const picker = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

const members = [
  { id: 'bot_dev', name: 'Bot Strata Dev' },
  { id: 'bot_helper', name: 'Bot Strata Helper' },
  { id: 'bot_short', name: 'A' },
  { id: 'bot_mark', name: 'Bot (Dev)' },
];

function serverMentionHits(content, roster = members) {
  if (/^@(?:everyone|all)\b/i.test(content)) return [];
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hits = [];
  for (const member of roster) {
    const name = member.name.trim();
    const byId = new RegExp(`(?:^|\\s)@${escape(member.id)}\\b`, 'i').test(content);
    const byName = name.length > 1 && new RegExp(`(?:^|\\s)@${escape(name)}\\b`, 'i').test(content);
    if (byId || byName) hits.push(member.id);
  }
  return hits;
}

test('an @ after the start or whitespace opens a query, and a finished or embedded @ does not', () => {
  const phrase = 'U try there a ui flaw there should be a @';
  assert.deepEqual(picker.mentionQuery('@', 1), { start: 0, query: '' });
  assert.deepEqual(picker.mentionQuery(phrase, phrase.length), { start: phrase.length - 1, query: '' });
  assert.deepEqual(picker.mentionQuery('hello @bot', 'hello @bot'.length), { start: 6, query: 'bot' });
  assert.deepEqual(picker.mentionQuery('hello\n@Bo', 'hello\n@Bo'.length), { start: 6, query: 'Bo' });
  assert.equal(picker.mentionQuery('hello @bot ', 12), null);
  assert.equal(picker.mentionQuery('email@bot', 9), null);
  assert.equal(picker.mentionQuery('say email@everyone', 18), null);
  assert.equal(picker.mentionQuery('hello @bot more', 15), null);
  assert.deepEqual(picker.mentionQuery('a @b @c', 7), { start: 5, query: 'c' });
  assert.equal(picker.mentionQuery('', 0), null);
});

test('the list leads with everyone, then roster order, and filters by name or id', () => {
  const open = picker.roomMentionChoices(members, '');
  assert.deepEqual(open.map(choice => choice.label), ['everyone', 'Bot Strata Dev', 'Bot Strata Helper', 'A', 'Bot (Dev)']);
  assert.equal(open[0].kind, 'everyone');
  assert.equal(open[0].id, 'everyone');
  assert.deepEqual(picker.roomMentionChoices(members, 'helper').map(choice => choice.id), ['bot_helper']);
  assert.deepEqual(picker.roomMentionChoices(members, 'BOT STRATA').map(choice => choice.label), ['Bot Strata Dev', 'Bot Strata Helper']);
  assert.deepEqual(picker.roomMentionChoices(members, 'bot_dev').map(choice => choice.id), ['bot_dev']);
  assert.deepEqual(picker.roomMentionChoices(members, 'eve').map(choice => choice.label), ['everyone']);
  assert.deepEqual(picker.roomMentionChoices(members, 'all').map(choice => choice.label), ['everyone']);
  assert.deepEqual(picker.roomMentionChoices([{ id: 'missing', name: '' }], '').map(choice => choice.label), ['everyone', 'Unavailable bot']);
  assert.deepEqual(picker.roomMentionChoices(members, 'zzzz'), []);
});

test('arrow keys move inside the list, Enter and Tab pick, and Escape or space closes', () => {
  assert.equal(picker.mentionKeyAction('ArrowDown'), 'down');
  assert.equal(picker.mentionKeyAction('ArrowUp'), 'up');
  assert.equal(picker.mentionKeyAction('Enter'), 'pick');
  assert.equal(picker.mentionKeyAction('Tab'), 'pick');
  assert.equal(picker.mentionKeyAction('Escape'), 'close');
  assert.equal(picker.mentionKeyAction(' '), 'close');
  assert.equal(picker.mentionKeyAction('a'), 'noop');
  assert.equal(picker.mentionKeyStops('ArrowDown'), true);
  assert.equal(picker.mentionKeyStops('Enter'), true);
  assert.equal(picker.mentionKeyStops('Tab'), true);
  assert.equal(picker.mentionKeyStops('Escape'), true);
  assert.equal(picker.mentionKeyStops(' '), false);
  assert.equal(picker.moveMentionIndex(0, 3, 'down'), 1);
  assert.equal(picker.moveMentionIndex(2, 3, 'down'), 2);
  assert.equal(picker.moveMentionIndex(0, 3, 'up'), 0);
  assert.equal(picker.moveMentionIndex(4, 3, 'up'), 1);
  assert.equal(picker.moveMentionIndex(0, 0, 'down'), 0);
});

test('a pick inserts the exact name, the id for a short name, or @everyone', () => {
  const dev = picker.roomMentionChoices(members, 'Dev')[0];
  assert.equal(picker.mentionInsertion(dev, members), '@Bot Strata Dev ');
  const short = picker.roomMentionChoices(members, 'bot_short')[0];
  assert.equal(picker.mentionInsertion(short, members), '@bot_short ');
  const everyone = picker.roomMentionChoices(members, '')[0];
  assert.equal(picker.mentionInsertion(everyone, members), '@everyone ');
  const marked = picker.roomMentionChoices(members, 'Bot (Dev)')[0];
  assert.equal(picker.mentionInsertion(marked, members), '@bot_mark ');
  const partial = 'there should be a @he';
  const placed = picker.insertMention(partial, { start: partial.lastIndexOf('@'), query: 'he' }, partial.length, '@Bot Strata Helper ');
  assert.equal(placed.text, 'there should be a @Bot Strata Helper ');
  assert.equal(placed.cursor, placed.text.length);
  assert.deepEqual(serverMentionHits('@Bot Strata Dev please look'), ['bot_dev']);
  assert.deepEqual(serverMentionHits('ask @bot_short now'), ['bot_short']);
  assert.deepEqual(serverMentionHits('see @bot_mark next'), ['bot_mark']);
  assert.deepEqual(serverMentionHits('@everyone hi'), []);
  assert.equal(picker.messageAddressesEveryone('@everyone hi'), true);
  assert.equal(picker.messageAddressesEveryone('please @all now'), true);
  assert.equal(picker.messageAddressesEveryone('email@everyone'), false);
  assert.equal(picker.messageAddressesEveryone('@everyoneish'), false);
});

test('Escape keeps the same @ closed, and an empty recipient list still addresses @everyone', () => {
  const active = { start: 4, query: 'ev' };
  assert.equal(picker.mentionListVisible(active, null, 1), true);
  assert.equal(picker.mentionListVisible(active, 4, 1), false);
  assert.equal(picker.mentionListVisible(null, 4, 1), false);
  assert.equal(picker.mentionListVisible({ start: 8, query: '' }, 4, 2), true);
  assert.equal(picker.mentionListVisible(active, null, 0), false);
  const room = ['bot_dev', 'bot_helper'];
  assert.deepEqual(picker.roomMessageAudience('@everyone hi', [], room), { everyone: true });
  assert.deepEqual(picker.roomMessageAudience('mid @all thanks', [], room), { everyone: true });
  assert.deepEqual(picker.roomMessageAudience('@Bot Strata Dev hi', [], room), {});
  assert.deepEqual(picker.roomMessageAudience('@everyone hi', ['bot_dev'], room), { recipientIds: ['bot_dev'] });
  assert.deepEqual(picker.roomMessageAudience('hello', room, room), { recipientIds: room, everyone: true });
  assert.deepEqual(picker.roomMessageAudience('email@everyone', [], room), {});
});

test('the room composer shows the floating mention list with the coucou spring', async () => {
  const channel = await readFile(new URL('../src/screens/BotTeamChannel.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/styles/chat-motion.css', import.meta.url), 'utf8');
  const channelCss = await readFile(new URL('../src/screens/BotTeamChannel.css', import.meta.url), 'utf8');
  assert.match(channel, /mentionQuery/);
  assert.match(channel, /roomMentionChoices/);
  assert.match(channel, /mentionInsertion/);
  assert.match(channel, /insertMention/);
  assert.match(channel, /mentionKeyStops/);
  assert.match(channel, /roomMessageAudience/);
  assert.match(channel, /role="listbox"/);
  assert.match(channel, /aria-activedescendant/);
  assert.match(channel, /bot-room-mentions/);
  assert.match(channel, /bot-room-mention-group/);
  assert.match(css, /@keyframes mentionIn/);
  assert.match(css, /mentionIn 0\.3s var\(--ease-pop\)/);
  assert.match(css, /translateY\(8px\) scale\(0\.98\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.bot-room-mentions/);
  assert.match(css, /\[data-motion='reduced'\] \.bot-room-mentions/);
  assert.match(channelCss, /\.bot-room-composer \{[^}]*position:\s*relative/);
  assert.match(channelCss, /\.bot-room-mentions \{[^}]*position:\s*absolute[^}]*bottom:\s*100%/);
  assert.match(channelCss, /\.bot-room-mentions \{[^}]*border-radius:\s*16px/);
  const ios = await readFile(new URL('../../ios/StrataMobile/Views/BotWorkspaceViews.swift', import.meta.url), 'utf8');
  const components = await readFile(new URL('../../ios/StrataMobile/Views/Components.swift', import.meta.url), 'utf8');
  assert.match(ios, /RoomMention\.query/);
  assert.match(ios, /RoomMention\.audience/);
  assert.match(ios, /RoomMentionList/);
  assert.match(ios, /\.onKeyPress\(\.upArrow\)/);
  assert.match(ios, /\.onKeyPress\(\.downArrow\)/);
  assert.match(ios, /\.onKeyPress\(\.escape\)/);
  assert.match(ios, /\.onKeyPress\(\.return\)/);
  assert.match(ios, /\.onKeyPress\(\.tab\)/);
  assert.match(components, /person\.2\.fill/);
  assert.match(components, /teamMentionList/);
  assert.match(components, /teamMention-everyone/);
  assert.match(components, /CoucouMotion\.springResponse/);
  assert.match(components, /CoucouMotion\.springDamping/);
  assert.match(components, /CoucouMotion\.messageRise/);
});
