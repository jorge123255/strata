import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOT_AVATAR_SHAPES, normalizeBotAvatar } from '../server/bots.mjs';
import { botAvatarConfig, BOT_AVATAR_SHAPES as bridgeShapes } from '../../companion-bridge/bots-lifecycle.mjs';
import { publicBots } from '../../companion-bridge/bridge.mjs';

const spec = JSON.parse(readFileSync(new URL('./fixtures/strata-geometric-avatars.json', import.meta.url)));
const face = { color: 'sky', eyes: 'round', ears: 'small' };
test('geometric appearance is optional and keeps every legacy animal wire configuration unchanged', () => {
  let combinations = 0;
  for (const kind of spec.wire.kinds) for (const color of spec.wire.colors) for (const eyes of ['star','round','happy','calm','plus','delight']) for (const ears of ['scalloped','round','small']) {
    const original = { color, eyes, ears, ...(kind === 'koala' ? {} : { kind }) };
    assert.equal(JSON.stringify(normalizeBotAvatar(original)), JSON.stringify(original));
    assert.deepEqual(botAvatarConfig(original), original);
    combinations++;
  }
  assert.equal(combinations, 432);
  assert.deepEqual(BOT_AVATAR_SHAPES, spec.shapes.map(value => value.id));
  assert.deepEqual(bridgeShapes, BOT_AVATAR_SHAPES);
  for (const shape of BOT_AVATAR_SHAPES) {
    assert.deepEqual(normalizeBotAvatar({ ...face, shape }), { ...face, shape });
    assert.deepEqual(botAvatarConfig({ ...face, shape }), { ...face, shape });
  }
});
test('old paired writers retain geometric identity; explicit classic or another animal clears it', () => {
  const old = { ...face, shape: 'orb' }, recolored = { ...face, color: 'orange' };
  assert.deepEqual(normalizeBotAvatar(recolored, old), { ...recolored, shape: 'orb' });
  assert.deepEqual(normalizeBotAvatar({ ...recolored, shape: 'classic' }, old), recolored);
  assert.deepEqual(normalizeBotAvatar({ ...recolored, kind: 'fox' }, old), { ...recolored, kind: 'fox' });
  assert.deepEqual(old, { ...face, shape: 'orb' }, 'Normalization must not mutate the saved snapshot.');
});
test('geometric values cannot add fields, unknown enums or ambiguous animal geometry', () => {
  for (const invalid of [{ ...face, shape: null }, { ...face, shape: 'external' }, { ...face, shape: 'orb', kind: 'fox' }, { ...face, shape: 'orb', image: 'https://external.invalid' }, { ...face, kind: null }, { ...face, color: 'unknown' }]) {
    assert.throws(() => normalizeBotAvatar(invalid), { status: 400 });
    assert.throws(() => botAvatarConfig(invalid), { status: 400 });
  }
});
test('paired shape capability is advertised only from a supporting host and contains public shape IDs', () => {
  const catalog = { bots: [], providers: [], computers: [], models: [] };
  assert.equal(Object.hasOwn(publicBots(catalog), 'avatarShapes'), false);
  assert.deepEqual(publicBots({ ...catalog, avatarShapes: ['orb', 'private-value', 'orb'] }).avatarShapes, ['orb']);
  const withFace = publicBots({ ...catalog, avatarShapes: BOT_AVATAR_SHAPES, bots: [{ id: 'bot_fixture', name: 'Fixture', provider: 'codex', avatarConfig: { ...face, shape: 'tile' } }] });
  assert.deepEqual(withFace.bots[0].avatarConfig, { ...face, shape: 'tile' });
  assert.deepEqual(withFace.avatarShapes, BOT_AVATAR_SHAPES);
});
