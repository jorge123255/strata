import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, linkSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { companionRuntimeFiles, stageCompanionRuntime } from '../scripts/companion-runtime-files.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'strata-companion-stage-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
function fixture() {
  const source = mkdtempSync(join(scratch, 'source-')), staged = join(scratch, `stage-${readdirSync(scratch).length}`);
  for (const name of ['bridge.mjs', 'index.mjs', 'package.json', 'qr.swift']) writeFileSync(join(source, name), `fixture ${name}`);
  return { source, staged };
}
test('inventory includes every direct runtime module, including a newly added folder bridge', () => {
  const { source, staged } = fixture();
  writeFileSync(join(source, 'bots-folders.mjs'), 'export const folderBridge = true;');
  writeFileSync(join(source, 'README.md'), 'source reference'); mkdirSync(join(source, 'test')); writeFileSync(join(source, 'test', 'fixture.mjs'), 'not runtime');
  const files = stageCompanionRuntime(source, staged);
  assert.deepEqual(files, ['bots-folders.mjs', 'bridge.mjs', 'index.mjs', 'package.json', 'qr.swift']);
  assert.deepEqual(readdirSync(staged).sort(), files);
  for (const name of files) assert.equal(readFileSync(join(staged, name), 'utf8'), readFileSync(join(source, name), 'utf8'));
  assert.equal(readFileSync(join(source, 'README.md'), 'utf8'), 'source reference'); assert.equal(existsSync(join(source, 'test', 'fixture.mjs')), true);
});
test('restaging removes retired modules and nonruntime content and removes the generated helper before recompiling', () => {
  const { source, staged } = fixture(); mkdirSync(staged); writeFileSync(join(staged, 'retired.mjs'), 'old'); writeFileSync(join(staged, 'README.md'), 'old'); mkdirSync(join(staged, 'test')); writeFileSync(join(staged, 'test', 'old.mjs'), 'old'); writeFileSync(join(staged, 'qr-helper'), 'existing compiled helper');
  const files = stageCompanionRuntime(source, staged);
  assert.deepEqual(readdirSync(staged).sort(), files);
  assert.equal(existsSync(join(staged, 'qr-helper')), false);
});
test('source symlinks and incomplete inventories are rejected before staging changes', () => {
  const { source, staged } = fixture(); const outside = join(scratch, 'external.mjs'); writeFileSync(outside, 'external'); symlinkSync(outside, join(source, 'linked.mjs'));
  assert.throws(() => stageCompanionRuntime(source, staged), /regular file/); assert.equal(existsSync(staged), false);
  rmSync(join(source, 'linked.mjs')); rmSync(join(source, 'qr.swift'));
  assert.throws(() => companionRuntimeFiles(source), /incomplete/);
});
test('a dangling destination link is replaced rather than followed', () => {
  const { source, staged } = fixture(); mkdirSync(staged); const outside = join(scratch, 'must-not-create'); symlinkSync(outside, join(staged, 'bridge.mjs'));
  stageCompanionRuntime(source, staged);
  assert.equal(existsSync(outside), false); assert.equal(lstatSync(join(staged, 'bridge.mjs')).isSymbolicLink(), false);
  assert.equal(readFileSync(join(staged, 'bridge.mjs'), 'utf8'), 'fixture bridge.mjs');
});
test('linked staging roots and overlapping source/destination paths preserve source contents', () => {
  const { source, staged } = fixture(); symlinkSync(source, staged);
  assert.throws(() => stageCompanionRuntime(source, staged), /regular directory/);
  assert.throws(() => stageCompanionRuntime(source, source), /separate directories/);
  assert.throws(() => stageCompanionRuntime(source, join(source, 'stage')), /separate directories/);
  assert.equal(readFileSync(join(source, 'bridge.mjs'), 'utf8'), 'fixture bridge.mjs');
});

test('a symlinked ancestor cannot alias staging onto source or prune its contents', () => {
  const { source } = fixture(); writeFileSync(join(source, 'README.md'), 'must retain'); mkdirSync(join(source, 'test')); writeFileSync(join(source, 'test', 'fixture.mjs'), 'must retain test');
  const sourceParent = join(source, '..'), alias = join(scratch, 'source-parent-alias'); symlinkSync(sourceParent, alias);
  const stageAlias = join(alias, source.split('/').at(-1));
  const before = readdirSync(source).sort().map(name => [name, lstatSync(join(source, name)).isDirectory() ? 'directory' : readFileSync(join(source, name), 'utf8')]);
  assert.throws(() => stageCompanionRuntime(source, stageAlias), /separate directories/);
  assert.deepEqual(readdirSync(source).sort().map(name => [name, lstatSync(join(source, name)).isDirectory() ? 'directory' : readFileSync(join(source, name), 'utf8')]), before);
  assert.equal(readFileSync(join(source, 'test', 'fixture.mjs'), 'utf8'), 'must retain test');
  assert.throws(() => stageCompanionRuntime(source, join(stageAlias, 'new-staging')), /separate directories/);
});

test('stale module and QR helper hard links cannot mutate external files during copying or recompilation', () => {
  const { source, staged } = fixture(); mkdirSync(staged);
  const moduleOutside = join(scratch, 'module-hardlink-sentinel'), helperOutside = join(scratch, 'helper-hardlink-sentinel');
  writeFileSync(moduleOutside, 'external module'); writeFileSync(helperOutside, 'external helper');
  linkSync(moduleOutside, join(staged, 'bridge.mjs')); linkSync(helperOutside, join(staged, 'qr-helper'));
  stageCompanionRuntime(source, staged); writeFileSync(join(staged, 'qr-helper'), 'new compiler output');
  assert.equal(readFileSync(moduleOutside, 'utf8'), 'external module'); assert.equal(readFileSync(helperOutside, 'utf8'), 'external helper');
  assert.equal(readFileSync(join(staged, 'bridge.mjs'), 'utf8'), 'fixture bridge.mjs');
});
