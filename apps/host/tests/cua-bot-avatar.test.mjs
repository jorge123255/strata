// SPDX-License-Identifier: FSL-1.1-MIT
// Copyright (c) 2026 Cua AI, Inc.
// Geometry and interaction regressions for the CUA-derived React adapter.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { transform } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)
const component = new URL('../src/components/CuaBotAvatar.tsx', import.meta.url)
const source = await readFile(component, 'utf8')
const { code } = await transform(source.replace(/^import '\.\/CuaBotAvatar.css'\n/m, ''), { loader: 'tsx', format: 'esm', jsx: 'automatic' })
const resolved = code.replace(/from "(react(?:\/jsx-runtime)?)"/g, (_, name) => `from ${JSON.stringify(pathToFileURL(require.resolve(name)).href)}`)
const { CuaBotAvatar, CuaBotAvatarPicker, CUA_BOT_COLORS, CUA_BOT_EYES, CUA_BOT_EARS, CUA_BOT_KINDS, CUA_BOT_SHAPES, STRATA_GEOMETRIC_PATHS, STRATA_GEOMETRIC_EYE_GRID, defaultCuaBotAvatar, normalizeCuaBotAvatarConfig } = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`)
const svg = (config, rest = {}) => renderToStaticMarkup(createElement(CuaBotAvatar, { config, animated: false, ...rest }))

test('React uses every exact original Swift head, ear and nose path with native radius and clipping', async () => {
  const swift = await readFile(new URL('../../bots-macos/Sources/CuaBotsCore/Avatar/KoalaGeometry.swift', import.meta.url), 'utf8')
  const output = svg({ color: 'sky', eyes: 'star', ears: 'scalloped' })
  for (const name of ['head', 'ear', 'nose']) {
    const path = new RegExp(`static let ${name} = "([^"]+)"`).exec(swift)[1]
    assert.ok(output.includes(`d="${path}"`), `${name} geometry differs from the actual CUA design`)
  }
  assert.match(output, /viewBox="-1\.425 -1\.485 2\.85 2\.85"/)
  assert.match(output, /clip-path="url\(#cua-koala-/)
  assert.doesNotMatch(output, /<(?:filter|linearGradient|radialGradient)\b/)
})

test('all 108 native configurations render distinct complete SVGs with supported colors and eyes', () => {
  const outputs = new Set()
  for (const color of CUA_BOT_COLORS) for (const eyes of CUA_BOT_EYES) for (const ears of CUA_BOT_EARS) {
    const output = svg({ color, eyes, ears }).replace(/cua-koala-[a-zA-Z0-9_-]+/g, 'clip')
    assert.doesNotMatch(output, /NaN|undefined|Infinity|__CUA_/)
    assert.match(output, /<svg[^>]+role="img"/)
    outputs.add(output)
  }
  assert.equal(outputs.size, 108)
  assert.match(svg({ color: 'graphite', eyes: 'round', ears: 'round' }), /stroke="#F3F6FA"/)
  assert.match(svg({ color: 'sky', eyes: 'round', ears: 'round' }), /rx="\.165" ry="\.2"/)
})

test('ear shapes retain mirrored fan, native small-ear pull and equal-area round discs', () => {
  const config = { color: 'sky', eyes: 'star', ears: 'scalloped' }
  assert.match(svg(config), /translate\(-0\.9023 -0\.4916\) scale\(-1 1\)/)
  assert.match(svg({ ...config, ears: 'small' }), /scale\(-0\.72 0\.72\)/)
  const round = svg({ ...config, ears: 'round' })
  assert.equal((round.match(/<circle /g) ?? []).length, 2)
  assert.ok(round.includes(`r="${Math.sqrt(.598 / Math.PI)}"`))
})

test('name defaults match native Unicode scalar palette ordering and invalid data falls back safely', () => {
  const nativeOrder = ['violet', 'orange', 'sky', 'cloud', 'slate', 'graphite']
  for (const name of ['', 'Ada', 'Maya', '🧑‍💻', 'Koala ☁️']) {
    const sum = Array.from(name).reduce((total, point) => total + point.codePointAt(0), 0)
    assert.deepEqual(defaultCuaBotAvatar(name), { color: nativeOrder[sum % 6], eyes: 'star', ears: 'scalloped' })
  }
  assert.deepEqual(normalizeCuaBotAvatarConfig({ color: 'unknown', eyes: 'happy', ears: 'untrusted' }, 'Ada'), { ...defaultCuaBotAvatar('Ada'), eyes: 'happy' })
  assert.match(svg(undefined, { name: 'Ada', size: 22 }), /width="22" height="22"/)
  assert.match(svg(undefined, { name: 'Ada', size: NaN }), /width="48" height="48"/)
})

test('mood glyphs preserve native vocabulary and working plus tilt', () => {
  const config = { color: 'violet', eyes: 'delight', ears: 'small' }
  for (const [mood, glyph] of [['thinking', 'slash'], ['working', 'plus'], ['needsApproval', 'round'], ['done', 'caret'], ['paused', 'dash'], ['error', 'cross']]) {
    const output = svg(config, { mood })
    assert.equal((output.match(new RegExp(`data-glyph="${glyph}"`, 'g')) ?? []).length, 2)
    if (mood === 'working') assert.match(output, /rotate\(15\)/)
    if (mood === 'error') assert.match(output, /rotate\(45\)/)
  }
  const resting = svg(config)
  assert.match(resting, /data-eye="left" data-glyph="greater"/)
  assert.match(resting, /data-eye="right" data-glyph="less"/)
})

test('avatars in the same React tree have independent head clipping IDs', () => {
  const output = renderToStaticMarkup(createElement('div', null, createElement(CuaBotAvatar, { name: 'A', animated: false }), createElement(CuaBotAvatar, { name: 'B', animated: false })))
  const ids = Array.from(output.matchAll(/<clipPath id="([^"]+)"/g), match => match[1])
  assert.equal(new Set(ids).size, 2)
  for (const id of ids) assert.ok(output.includes(`clip-path="url(#${id})"`))
})

test('picker changes one field only, remains controlled, and exposes labeled pressed buttons', () => {
  const value = { color: 'sky', eyes: 'star', ears: 'scalloped' }, before = structuredClone(value), changes = []
  const tree = CuaBotAvatarPicker({ value, onChange: config => changes.push(config), name: 'Ada' })
  const buttons = []
  function walk(node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.type === 'button') buttons.push(node)
    walk(node.props?.children)
  }
  walk(tree)
  assert.equal(buttons.length, 19)
  assert.equal(buttons.filter(button => button.props['aria-pressed']).length, 4)
  for (const button of buttons) { assert.equal(button.props.type, 'button'); assert.ok(button.props['aria-label']) }
  buttons.find(button => button.props['aria-label'] === 'Orange').props.onClick()
  buttons.find(button => button.props['aria-label'] === 'Happy').props.onClick()
  buttons.find(button => button.props['aria-label'] === 'Small').props.onClick()
  assert.deepEqual(changes, [{ ...value, color: 'orange' }, { ...value, eyes: 'happy' }, { ...value, ears: 'small' }])
  assert.deepEqual(value, before)
})

test('four character families render distinct faces and preserve legacy koala configuration', () => {
  const outputs = new Set()
  for (const kind of CUA_BOT_KINDS) for (const color of CUA_BOT_COLORS) for (const eyes of CUA_BOT_EYES) for (const ears of CUA_BOT_EARS) {
    const output = svg({ kind, color, eyes, ears }).replace(/cua-koala-[a-zA-Z0-9_-]+/g, 'clip')
    assert.match(output, new RegExp(`data-character="${kind}"`))
    assert.doesNotMatch(output, /NaN|undefined|Infinity/)
    outputs.add(output)
  }
  assert.equal(outputs.size, 432)
  const legacy = { color: 'sky', eyes: 'calm', ears: 'round' }
  assert.deepEqual(normalizeCuaBotAvatarConfig(legacy), legacy)
  assert.deepEqual(normalizeCuaBotAvatarConfig({ ...legacy, kind: 'koala' }), legacy)
  assert.deepEqual(normalizeCuaBotAvatarConfig({ ...legacy, kind: 'fox' }), { ...legacy, kind: 'fox' })
  const changes = []
  const tree = CuaBotAvatarPicker({ value: { ...legacy, kind: 'robot' }, onChange: config => changes.push(config) })
  function find(node, label) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.map(item => find(item, label)).find(Boolean)
    if (node.type === 'button' && node.props['aria-label'] === label) return node
    return find(node.props?.children, label)
  }
  find(tree, 'Fox').props.onClick()
  find(tree, 'Koala').props.onClick()
  assert.deepEqual(changes, [{ ...legacy, shape: 'classic', kind: 'fox' }, { ...legacy, shape: 'classic' }])
})

test('shipped public assets retain the full original license and pinned source attribution', async () => {
  const original = await readFile(new URL('../../bots-macos/LICENSE', import.meta.url), 'utf8')
  const shipped = await readFile(new URL('../public/cua-bots-LICENSE.txt', import.meta.url), 'utf8')
  const notice = await readFile(new URL('../public/cua-bots-NOTICE.txt', import.meta.url), 'utf8')
  assert.equal(shipped, original)
  assert.match(notice, /Copyright \(c\) 2026 Cua AI, Inc\./)
  assert.match(notice, /ef61a985d58958c6b9bc392f0ea0da785aa36ce9/)
  assert.match(notice, /FSL-1\.1-MIT/)
})


test('six original geometric faces match the shared native fixture without animal features', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/strata-geometric-avatars.json', import.meta.url), 'utf8'))
  assert.deepEqual(CUA_BOT_SHAPES, fixture.shapes.map(row => row.id))
  assert.deepEqual(STRATA_GEOMETRIC_EYE_GRID, fixture.eyeGrid)
  for (const {id, path} of fixture.shapes) {
    assert.equal(STRATA_GEOMETRIC_PATHS[id], path)
    const config = {color:'sky', eyes:'round', ears:'scalloped', shape:id}
    const output = svg(config)
    assert.match(output, new RegExp(`data-character="${id}" data-shape="${id}"`))
    assert.ok(output.includes(`data-face="${id}" d="${path}"`))
    assert.match(output, /translate\(-0\.37 -0\.06\) rotate\(-12\)/)
    assert.match(output, /translate\(0\.37 -0\.06\) rotate\(-12\)/)
    assert.equal((output.match(/width="\.16" height="\.34" rx="\.08"/g) ?? []).length, 2)
    assert.equal((output.match(/<path /g) ?? []).length, 2, 'Only the head and its clip path remain; no animal ears, nose or highlight.')
    assert.equal((output.match(/<circle /g) ?? []).length, 0)
    assert.deepEqual(normalizeCuaBotAvatarConfig(config), config)
    assert.equal(svg({...config, ears:'small'}).replace(/cua-koala-[a-zA-Z0-9_-]+/g,'clip'), output.replace(/cua-koala-[a-zA-Z0-9_-]+/g,'clip'), 'Ears are retained in data but do not change a geometric face.')
  }
})

test('geometric character selection is capability gated and animal selection explicitly clears it', () => {
  const face = {color:'orange', eyes:'calm', ears:'small'}
  function buttons(value, shapes) {
    const tree = CuaBotAvatarPicker({value,shapes,onChange: config => changes.push(config)})
    const result=[]
    function walk(node) { if(!node||typeof node!=='object') return; if(Array.isArray(node)) return node.forEach(walk); if(node.type==='button') result.push(node); walk(node.props?.children) }
    walk(tree); return result
  }
  const changes=[]
  assert.equal(buttons(face).some(row => row.props['aria-label']==='Orb'), false)
  const geometric = {...face, kind:'koala', shape:'orb'}
  const supported = buttons(geometric, CUA_BOT_SHAPES)
  assert.equal(supported.filter(row=>row.props['aria-pressed']).length, 3, 'Character, color and eyes; ear controls are hidden.')
  assert.equal(supported.some(row=>row.props['aria-label']==='Small'), false)
  supported.find(row=>row.props['aria-label']==='Fox').props.onClick()
  supported.find(row=>row.props['aria-label']==='Koala').props.onClick()
  buttons(face, CUA_BOT_SHAPES).find(row=>row.props['aria-label']==='Tile').props.onClick()
  assert.deepEqual(changes, [{...face,shape:'classic',kind:'fox'}, {...face,shape:'classic'}, {...face,kind:'koala',shape:'tile'}])
  const unavailable = buttons(geometric)
  assert.equal(unavailable.find(row=>row.props['aria-label']==='Orb').props.disabled, true)
  assert.equal(unavailable.some(row=>row.props['aria-label']==='Tile'), false)
  assert.equal(unavailable.some(row=>row.props['aria-label']==='Classic'), false)
  const decodedFuture = normalizeCuaBotAvatarConfig({...face,shape:'untrusted'})
  assert.deepEqual(decodedFuture,face)
  buttons(decodedFuture, CUA_BOT_SHAPES).find(row=>row.props['aria-label']==='Koala').props.onClick()
  assert.deepEqual(changes.at(-1),{...face,shape:'classic'},'An explicit animal choice clears future geometry even after its unknown field was dropped during normalization.')
})
