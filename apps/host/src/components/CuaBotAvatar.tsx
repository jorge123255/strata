// SPDX-License-Identifier: FSL-1.1-MIT
// Copyright (c) 2026 Cua AI, Inc.
// React/SVG adaptation of the actual CUA Bots KoalaRenderer and AvatarPicker.
// Source pin, attribution and license: ./CuaBotAvatar.NOTICE.md
import { useCallback, useEffect, useId, useRef, useState, type PointerEvent } from 'react'
import './CuaBotAvatar.css'

export const CUA_BOT_COLORS = ['cloud', 'violet', 'orange', 'sky', 'graphite', 'slate'] as const
export const CUA_BOT_EYES = ['star', 'round', 'happy', 'calm', 'plus', 'delight'] as const
export const CUA_BOT_EARS = ['scalloped', 'round', 'small'] as const
export const CUA_BOT_KINDS = ['koala', 'fox', 'cat', 'robot'] as const
export const CUA_BOT_SHAPES = ['orb', 'pebble', 'tile', 'diamond', 'spark', 'hexagon'] as const
export type CuaBotAvatarConfig = {
  /** Missing on legacy faces; keep their serialized form unchanged. */
  kind?: typeof CUA_BOT_KINDS[number]
  /** Classic explicitly clears a geometric face when editing a saved profile. */
  shape?: typeof CUA_BOT_SHAPES[number] | 'classic'
  color: typeof CUA_BOT_COLORS[number]
  eyes: typeof CUA_BOT_EYES[number]
  ears: typeof CUA_BOT_EARS[number]
}
export type CuaBotMood = 'idle' | 'thinking' | 'working' | 'needsApproval' | 'done' | 'paused' | 'error'

const palette = {
  cloud: { face: '#E3E7EC', nose: '#7D8793', eye: '#0B0E13' },
  violet: { face: '#8B5CF6', nose: '#5B2FC9', eye: '#0B0E13' },
  orange: { face: '#FF7A2F', nose: '#C24E10', eye: '#0B0E13' },
  sky: { face: '#61BCFF', nose: '#2A7FC4', eye: '#0B0E13' },
  graphite: { face: '#262A31', nose: '#4B525E', eye: '#F3F6FA' },
  slate: { face: '#8E98A3', nose: '#5B6571', eye: '#0B0E13' },
} as const

// These path strings are copied byte for byte from KoalaGeometry.swift.
const geometry = {
  head: 'M0.2216 0.8572C0.3254 0.8460 0.4282 0.8329 0.5279 0.7991C0.6277 0.7654 0.7386 0.7173 0.8201 0.6548C0.9016 0.5923 0.9719 0.5134 1.0168 0.4239C1.0618 0.3344 1.0870 0.2218 1.0896 0.1176C1.0923 0.0134 1.0666 -0.1023 1.0328 -0.2012C0.9990 -0.3002 0.9479 -0.3917 0.8870 -0.4761C0.8261 -0.5605 0.7477 -0.6423 0.6673 -0.7076C0.5869 -0.7729 0.5002 -0.8271 0.4047 -0.8679C0.3091 -0.9087 0.1992 -0.9414 0.0939 -0.9521C-0.0114 -0.9629 -0.1260 -0.9552 -0.2272 -0.9324C-0.3284 -0.9097 -0.4242 -0.8684 -0.5133 -0.8154C-0.6024 -0.7624 -0.6901 -0.6891 -0.7619 -0.6143C-0.8336 -0.5395 -0.8938 -0.4580 -0.9438 -0.3664C-0.9939 -0.2748 -1.0400 -0.1685 -1.0621 -0.0646C-1.0841 0.0394 -1.0930 0.1575 -1.0760 0.2575C-1.0589 0.3575 -1.0200 0.4555 -0.9597 0.5354C-0.8995 0.6153 -0.8051 0.6869 -0.7144 0.7367C-0.6236 0.7865 -0.5183 0.8126 -0.4150 0.8342C-0.3117 0.8559 -0.2009 0.8627 -0.0948 0.8666C0.0113 0.8704 0.1178 0.8685 0.2216 0.8572Z',
  ear: 'M-0.4380 0.4512C-0.4425 0.4275 -0.4057 0.3372 -0.4029 0.2892C-0.4001 0.2412 -0.4179 0.2039 -0.4213 0.1633C-0.4246 0.1227 -0.4252 0.0832 -0.4229 0.0456C-0.4207 0.0081 -0.4156 -0.0281 -0.4077 -0.0620C-0.3999 -0.0960 -0.3891 -0.1282 -0.3758 -0.1580C-0.3625 -0.1878 -0.3464 -0.2156 -0.3279 -0.2408C-0.3094 -0.2660 -0.2882 -0.2889 -0.2650 -0.3091C-0.2417 -0.3293 -0.2159 -0.3470 -0.1885 -0.3618C-0.1610 -0.3765 -0.1312 -0.3887 -0.1002 -0.3979C-0.0692 -0.4070 -0.0362 -0.4134 -0.0024 -0.4167C0.0313 -0.4200 0.0668 -0.4204 0.1023 -0.4177C0.1379 -0.4150 0.1747 -0.4092 0.2110 -0.4004C0.2473 -0.3916 0.2908 -0.3753 0.3202 -0.3648C0.3496 -0.3543 0.3712 -0.3463 0.3875 -0.3375C0.4039 -0.3286 0.4095 -0.3209 0.4182 -0.3115C0.4270 -0.3022 0.4342 -0.2918 0.4401 -0.2812C0.4459 -0.2706 0.4504 -0.2594 0.4533 -0.2480C0.4562 -0.2367 0.4577 -0.2249 0.4577 -0.2133C0.4576 -0.2017 0.4561 -0.1898 0.4531 -0.1783C0.4501 -0.1668 0.4459 -0.1552 0.4395 -0.1442C0.4332 -0.1333 0.4183 -0.1231 0.4151 -0.1125C0.4119 -0.1018 0.4172 -0.0914 0.4205 -0.0804C0.4237 -0.0693 0.4316 -0.0575 0.4347 -0.0460C0.4378 -0.0346 0.4391 -0.0229 0.4391 -0.0117C0.4391 -0.0004 0.4376 0.0108 0.4346 0.0215C0.4317 0.0322 0.4273 0.0427 0.4215 0.0524C0.4157 0.0621 0.4087 0.0715 0.4001 0.0800C0.3915 0.0884 0.3776 0.0945 0.3700 0.1029C0.3623 0.1114 0.3565 0.1200 0.3542 0.1309C0.3520 0.1417 0.3573 0.1562 0.3565 0.1680C0.3557 0.1797 0.3531 0.1910 0.3493 0.2016C0.3456 0.2121 0.3404 0.2221 0.3340 0.2311C0.3276 0.2401 0.3198 0.2485 0.3110 0.2558C0.3021 0.2630 0.2919 0.2695 0.2807 0.2747C0.2694 0.2800 0.2501 0.2785 0.2435 0.2872C0.2369 0.2959 0.2439 0.3150 0.2412 0.3268C0.2385 0.3386 0.2333 0.3489 0.2272 0.3581C0.2211 0.3673 0.2135 0.3755 0.2046 0.3821C0.1958 0.3887 0.1861 0.3948 0.1741 0.3979C0.1622 0.4011 0.1387 0.3989 0.1329 0.4011C0.1271 0.4032 0.1489 0.4109 0.1393 0.4107C0.1297 0.4105 0.0966 0.4027 0.0752 0.3997C0.0537 0.3967 0.0321 0.3943 0.0105 0.3925C-0.0111 0.3908 -0.0329 0.3897 -0.0545 0.3893C-0.0762 0.3889 -0.0979 0.3891 -0.1196 0.3899C-0.1413 0.3908 -0.1630 0.3923 -0.1845 0.3945C-0.2061 0.3967 -0.2277 0.3995 -0.2491 0.4029C-0.2705 0.4064 -0.2918 0.4105 -0.3130 0.4152C-0.3342 0.4200 -0.3552 0.4253 -0.3761 0.4313C-0.3969 0.4373 -0.4336 0.4749 -0.4380 0.4512Z',
  nose: 'M0.23296 0.42779 C0.19057 0.46486 0.13275 0.48043 0.07633 0.48521 C0.02310 0.48973 -0.02903 0.48893 -0.08195 0.48281 C-0.14414 0.47564 -0.20747 0.45523 -0.24825 0.40734 C-0.26455 0.38820 -0.27439 0.36660 -0.27688 0.34165 C-0.27937 0.31670 -0.27812 0.29295 -0.27349 0.26758 C-0.25603 0.17211 -0.22610 0.08040 -0.18333 -0.00704 C-0.15783 -0.05918 -0.12021 -0.10971 -0.06567 -0.13415 C-0.01019 -0.15902 0.05222 -0.15085 0.09856 -0.11253 C0.11725 -0.09708 0.13279 -0.07983 0.14626 -0.05964 C0.16023 -0.03871 0.17253 -0.01777 0.18263 0.00543 L0.23245 0.11996 C0.25548 0.17287 0.28518 0.27454 0.28114 0.33176 C0.27848 0.36935 0.26162 0.40272 0.23295 0.42779 H0.23296 Z',
}

export function defaultCuaBotAvatar(name: string): CuaBotAvatarConfig {
  const colors: CuaBotAvatarConfig['color'][] = ['violet', 'orange', 'sky', 'cloud', 'slate', 'graphite']
  let sum = 0
  for (const scalar of name) sum = (sum + scalar.codePointAt(0)!) % colors.length
  return { color: colors[sum], eyes: 'star', ears: 'scalloped' }
}

export function normalizeCuaBotAvatarConfig(value: unknown, name = ''): CuaBotAvatarConfig {
  const fallback = defaultCuaBotAvatar(name)
  if (!value || typeof value !== 'object') return fallback
  const config = value as Record<string, unknown>
  return {
    ...(CUA_BOT_KINDS.includes(config.kind as typeof CUA_BOT_KINDS[number]) && config.kind !== 'koala' ? { kind: config.kind as CuaBotAvatarConfig['kind'] } : {}),
    ...(CUA_BOT_SHAPES.includes(config.shape as typeof CUA_BOT_SHAPES[number]) || config.shape === 'classic' ? { shape: config.shape as CuaBotAvatarConfig['shape'] } : {}),
    color: CUA_BOT_COLORS.find(item => item === config.color) ?? fallback.color,
    eyes: CUA_BOT_EYES.find(item => item === config.eyes) ?? fallback.eyes,
    ears: CUA_BOT_EARS.find(item => item === config.ears) ?? fallback.ears,
  }
}

// Original Strata characters. Coordinates deliberately share the koala eye grid
// so expressions, six palettes and reduced-motion behavior stay consistent.
const characterHeads = {
  fox: 'M-.95 -.47Q-.96 -.86-.66-.91Q0-1.03.66-.91Q.96-.86.95-.47L.9 .23Q.75 .65 0 .9Q-.75 .65-.9 .23Z',
  cat: 'M-.98 -.44Q-.98-.88-.56-.92Q0-1 .56-.92Q.98-.88.98-.44L.95 .27Q.87 .83 0 .87Q-.87 .83-.95 .27Z',
  robot: 'M-.73-.87H.73Q1-.87 1-.6V.57Q1 .84.73 .84H-.73Q-1 .84-1 .57V-.6Q-1-.87-.73-.87Z',
} as const

// Original Strata geometric faces; parity fixture: tests/fixtures/strata-geometric-avatars.json.
export const STRATA_GEOMETRIC_PATHS = {
  orb: "M0-1.04C.58-1.04 1.04-.58 1.04 0C1.04.58.58 1.04 0 1.04C-.58 1.04-1.04.58-1.04 0C-1.04-.58-.58-1.04 0-1.04Z",
  pebble: "M-.81-.65C-.47-1.09.21-1.12.68-.77C1.09-.46 1.15.19.83.67C.53 1.12-.18 1.15-.65.87C-1.12.59-1.16-.19-.81-.65Z",
  tile: "M-.65-1.02H.65Q1.02-1.02 1.02-.65V.65Q1.02 1.02.65 1.02H-.65Q-1.02 1.02-1.02.65V-.65Q-1.02-1.02-.65-1.02Z",
  diamond: "M-.19-1.01Q0-1.2.19-1.01L1.01-.19Q1.2 0 1.01.19L.19 1.01Q0 1.2-.19 1.01L-1.01.19Q-1.2 0-1.01-.19Z",
  spark: "M0-1.13L.31-.74L.8-.8L.74-.31L1.13 0L.74.31L.8.8L.31.74L0 1.13L-.31.74L-.8.8L-.74.31L-1.13 0L-.74-.31L-.8-.8L-.31-.74Z",
  hexagon: "M-.43-1H.43Q.59-1 .67-.86L1.1-.14Q1.18 0 1.1.14L.67.86Q.59 1 .43 1H-.43Q-.59 1-.67.86L-1.1.14Q-1.18 0-1.1-.14L-.67-.86Q-.59-1-.43-1Z",
} as const
export const STRATA_GEOMETRIC_EYE_GRID = { leftX: -.37, rightX: .37, y: -.06 } as const

type Glyph = 'star' | 'round' | 'dash' | 'caret' | 'plus' | 'cross' | 'greater' | 'less' | 'slash' | 'backslash'
const restingEyes: Record<CuaBotAvatarConfig['eyes'], readonly [Glyph, Glyph]> = {
  star: ['star', 'star'], round: ['round', 'round'], happy: ['caret', 'caret'],
  calm: ['dash', 'dash'], plus: ['plus', 'plus'], delight: ['greater', 'less'],
}

function eyesForMood(mood: CuaBotMood, eyes: CuaBotAvatarConfig['eyes']): readonly [Glyph, Glyph] {
  switch (mood) {
    case 'idle': return restingEyes[eyes]
    case 'thinking': return ['slash', 'slash']
    case 'working': return ['plus', 'plus']
    case 'needsApproval': return ['round', 'round']
    case 'done': return ['caret', 'caret']
    case 'paused': return ['dash', 'dash']
    case 'error': return ['cross', 'cross']
  }
}

// Same stroke widths, tilt, scale and glyph coordinates as KoalaRenderer.
const glyphs: Record<Glyph, { path?: string; width: number; rotate: number; scale: number }> = {
  star: { path: 'M-.17 0H.17M-.085 -.147L.085 .147M.085 -.147L-.085 .147', width: .066, rotate: 0, scale: 1.1 },
  round: { width: .085, rotate: -12, scale: 1.2 },
  dash: { path: 'M-.225 0H.225', width: .075, rotate: 0, scale: 1.15 },
  caret: { path: 'M-.17 .12Q0-.2.17 .12', width: .08, rotate: 0, scale: 1.1 },
  plus: { path: 'M-.22 0H.22M0 -.22V.22', width: .085, rotate: 0, scale: 1.1 },
  cross: { path: 'M-.22 0H.22M0 -.22V.22', width: .085, rotate: 45, scale: 1.1 },
  greater: { path: 'M-.17 -.17L.17 0L-.17 .17', width: .075, rotate: 0, scale: 1.1 },
  less: { path: 'M.17 -.17L-.17 0L.17 .17', width: .075, rotate: 0, scale: 1.1 },
  slash: { path: 'M-.11 .21L.11 -.21', width: .08, rotate: 0, scale: 1.1 },
  backslash: { path: 'M-.11 -.21L.11 .21', width: .08, rotate: 0, scale: 1.1 },
}

function Eye({ glyph, side, spin, geometric = false }: { glyph: Glyph; side: 'left' | 'right'; spin: number; geometric?: boolean }) {
  const eye = geometric ? { x: side === 'left' ? STRATA_GEOMETRIC_EYE_GRID.leftX : STRATA_GEOMETRIC_EYE_GRID.rightX, y: STRATA_GEOMETRIC_EYE_GRID.y } : side === 'left' ? { x: -.53029, y: -.04019 } : { x: .53510, y: -.04055 }
  if (glyph === 'round') return <g data-eye={side} data-glyph={glyph} transform={`translate(${eye.x} ${eye.y}) rotate(-12)`}><rect className="cua-avatar-eye-glyph" x="-.08" y="-.17" width=".16" height=".34" rx=".08" fill="currentColor" stroke="none"/></g>
  const style = glyphs[glyph]
  const angle = style.rotate + (glyph === 'plus' ? spin : 0)
  return <g data-eye={side} data-glyph={glyph} transform={`translate(${eye.x} ${eye.y}) rotate(${angle}) scale(${style.scale * .94409} ${style.scale})`} strokeWidth={style.width}>
    <g className="cua-avatar-eye-glyph"><path d={style.path} /></g>
  </g>
}

// A single observer gates every face. Idle roster faces have no frame loop or
// timer; only visible large faces schedule an occasional blink or ear greeting.
const observedFaces = new Map<Element, (visible: boolean) => void>()
let faceObserver: IntersectionObserver | undefined
function observeFace(node: SVGSVGElement, update: (visible: boolean) => void) {
  if (typeof IntersectionObserver === 'undefined') { update(true); return () => {} }
  faceObserver ??= new IntersectionObserver(entries => {
    for (const entry of entries) observedFaces.get(entry.target)?.(entry.isIntersecting)
  })
  observedFaces.set(node, update); faceObserver.observe(node)
  return () => {
    faceObserver?.unobserve(node); observedFaces.delete(node)
    if (!observedFaces.size) { faceObserver?.disconnect(); faceObserver = undefined }
  }
}

function useAvatarMotion(mood: CuaBotMood, animated: boolean, size: number, messageSignal?: string | number) {
  const ref = useRef<SVGSVGElement>(null), flourishAnimation = useRef<Animation | undefined>(undefined), blinkAnimation = useRef<Animation | undefined>(undefined), earAnimations = useRef<Animation[]>([])
  const [visible, setVisible] = useState(false), [hidden, setHidden] = useState(false), [reduced, setReduced] = useState(true)
  const previousSignal = useRef(messageSignal), previousMood = useRef(mood)
  const active = animated && visible && !hidden && !reduced
  useEffect(() => {
    const node = ref.current
    if (!animated || !node) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const preference = () => setReduced(document.documentElement.dataset.motion === 'reduced' || document.documentElement.dataset.motion !== 'full' && motion.matches), visibility = () => setHidden(document.hidden)
    preference(); visibility()
    motion.addEventListener('change', preference); document.addEventListener('visibilitychange', visibility)
    const preferenceObserver = new MutationObserver(preference)
    preferenceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] })
    const stopObserving = observeFace(node, setVisible)
    return () => { stopObserving(); preferenceObserver.disconnect(); motion.removeEventListener('change', preference); document.removeEventListener('visibilitychange', visibility) }
  }, [animated])
  const blink = useCallback(() => {
    const eyes = ref.current?.querySelector<SVGGElement>('.cua-avatar-blink')
    if (!active || !eyes?.animate || ['paused', 'error'].includes(mood)) return
    blinkAnimation.current?.cancel()
    const double = Math.random() < .22
    blinkAnimation.current = eyes.animate(double ? [
      { transform: 'scaleY(1)' }, { transform: 'scaleY(.08)', offset: .18 }, { transform: 'scaleY(1)', offset: .38 },
      { transform: 'scaleY(1)', offset: .6 }, { transform: 'scaleY(.08)', offset: .8 }, { transform: 'scaleY(1)' },
    ] : [{ transform: 'scaleY(1)' }, { transform: 'scaleY(.08)', offset: .45 }, { transform: 'scaleY(1)' }], { duration: double ? 410 : 170 + Math.random() * 40, easing: 'ease-in-out' })
  }, [active, mood])
  const greet = useCallback(() => {
    if (!active || mood === 'paused' || mood === 'error') return
    earAnimations.current.forEach(animation => animation.cancel())
    earAnimations.current = Array.from(ref.current?.querySelectorAll<SVGGElement>('.cua-avatar-ear') ?? []).map((ear, index) => ear.animate([
      { transform: 'rotate(0deg)' }, { transform: `rotate(${index ? 5 : -5}deg)`, offset: .38 }, { transform: 'rotate(0deg)' },
    ], { duration: 640, easing: 'ease-in-out', delay: index * 80 }))
  }, [active, mood])
  const flourish = useCallback(() => {
    const node = ref.current
    if (!active || !node?.animate || ['paused', 'error'].includes(mood)) return
    flourishAnimation.current?.cancel()
    flourishAnimation.current = node.animate([
      { transform: 'scale(1) rotate(0)' }, { transform: 'translateY(-1px) scale(1.055,.97) rotate(-3deg)', offset: .3 },
      { transform: 'scale(.985,1.025) rotate(2deg)', offset: .64 }, { transform: 'scale(1) rotate(0)' },
    ], { duration: 540, easing: 'cubic-bezier(.2,.8,.25,1)' })
    blink(); greet()
  }, [active, blink, greet, mood])
  useEffect(() => {
    const arrived = messageSignal !== undefined && previousSignal.current !== messageSignal
    const completed = mood === 'done' && previousMood.current !== mood
    previousSignal.current = messageSignal; previousMood.current = mood
    if (arrived || completed) flourish()
  }, [messageSignal, mood, flourish])
  useEffect(() => {
    if (!active || size < 64 || !['idle', 'thinking', 'working'].includes(mood)) return
    let timer: ReturnType<typeof setTimeout>
    const next = () => { timer = setTimeout(() => { blink(); if (mood === 'idle' && Math.random() < .3) greet(); next() }, 4600 + Math.random() * 3600) }
    next(); return () => clearTimeout(timer)
  }, [active, size, mood, blink, greet])
  useEffect(() => {
    if (active) return
    flourishAnimation.current?.cancel(); blinkAnimation.current?.cancel(); earAnimations.current.forEach(animation => animation.cancel())
    ref.current?.style.removeProperty('--cua-gaze-x'); ref.current?.style.removeProperty('--cua-gaze-y')
  }, [active])
  useEffect(() => () => { flourishAnimation.current?.cancel(); blinkAnimation.current?.cancel(); earAnimations.current.forEach(animation => animation.cancel()) }, [])
  const gaze = (event: PointerEvent<SVGSVGElement>) => {
    if (!active || event.pointerType !== 'mouse') return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    const x = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1))
    const y = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1))
    event.currentTarget.style.setProperty('--cua-gaze-x', `${x * .075}px`)
    event.currentTarget.style.setProperty('--cua-gaze-y', `${y * .055}px`)
  }
  const resetGaze = () => {
    ref.current?.style.removeProperty('--cua-gaze-x'); ref.current?.style.removeProperty('--cua-gaze-y')
  }
  return { ref, active, gaze, resetGaze, blink, flourish }
}

export interface CuaBotAvatarProps {
  config?: CuaBotAvatarConfig | null
  name?: string
  size?: number
  className?: string
  mood?: CuaBotMood
  animated?: boolean
  /** Changes once when a completed shared reply arrives; never on each token. */
  messageSignal?: string | number
}

export function CuaBotAvatar({ config: supplied, name = '', size = 48, className = '', mood = 'idle', animated = true, messageSignal }: CuaBotAvatarProps) {
  const config = normalizeCuaBotAvatarConfig(supplied, name)
  const colors = palette[config.color]
  const clipID = `cua-koala-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const dimension = Number.isFinite(size) && size > 0 ? size : 48
  const motion = useAvatarMotion(mood, animated, dimension, messageSignal)
  const left = eyesForMood(mood, config.eyes)[0], right = eyesForMood(mood, config.eyes)[1]
  const spin = mood === 'working' ? 15 : 0
  const colorName = config.color[0].toUpperCase() + config.color.slice(1)
  const kind = config.kind ?? 'koala'
  const geometric = kind === 'koala' && CUA_BOT_SHAPES.includes(config.shape as typeof CUA_BOT_SHAPES[number])
  const shape = geometric ? config.shape as typeof CUA_BOT_SHAPES[number] : undefined
  const head = shape ? STRATA_GEOMETRIC_PATHS[shape] : kind === 'koala' ? geometry.head : characterHeads[kind]
  const mouthY = geometric ? .43 : kind === 'koala' ? .64 : kind === 'robot' ? .43 : .54
  const mouth = mood === 'error' ? `M-.11 ${mouthY + .04}Q0 ${mouthY - .075} .11 ${mouthY + .04}`
    : mood === 'paused' ? `M-.08 ${mouthY}H.08`
      : mood === 'needsApproval' || mood === 'thinking' ? `M-.07 ${mouthY}Q0 ${mouthY + .025} .07 ${mouthY}`
        : `M-${mood === 'done' ? '.16' : '.12'} ${mouthY}Q0 ${mouthY + (mood === 'done' ? .16 : .1)} ${mood === 'done' ? '.16' : '.12'} ${mouthY}`
  const earSize = config.ears === 'small' ? .78 : config.ears === 'round' ? .92 : 1
  return <svg ref={motion.ref} className={`cua-bot-avatar ${className}`.trim()} width={dimension} height={dimension}
    viewBox="-1.425 -1.485 2.85 2.85" fill="none" role="img"
    data-mood={mood} data-companion={dimension >= 64 || undefined} data-motion={motion.active ? 'active' : 'paused'} onPointerMove={motion.gaze} onPointerLeave={motion.resetGaze} onPointerEnter={motion.blink} onPointerDown={motion.flourish}
    data-character={shape ?? kind} data-shape={shape} aria-label={`${name ? `${name}, ` : ''}${colorName} ${shape ?? kind}, ${mood === 'needsApproval' ? 'needs approval' : mood}`}>
    <defs><clipPath id={clipID}><path d={head} /></clipPath></defs>
    <g className="cua-avatar-body">
    <g fill={colors.face}>
      {!geometric && (kind === 'koala' ? ([-1, 1] as const).map(side => <g key={side} className="cua-avatar-ear">{config.ears === 'round'
        ? <circle cx={side * .9023 * .97} cy={-.4916 * 1.02} r={Math.sqrt(.598 / Math.PI)} />
        : <path d={geometry.ear} transform={`translate(${side * .9023 * (config.ears === 'small' ? .86 : 1)} ${-.4916 * (config.ears === 'small' ? .86 : 1)}) scale(${side * (config.ears === 'small' ? .72 : 1)} ${config.ears === 'small' ? .72 : 1})`} />}</g>)
        : ([-1, 1] as const).map(side => <g key={side} className="cua-avatar-ear"><g transform={`scale(${side} 1)`}>
          {kind === 'robot' ? <><rect x=".96" y="-.29" width=".23" height={.46 * earSize} rx=".1" /><path d="M.53-.83V-1.08" stroke={colors.nose} strokeWidth=".09" /><ellipse cx=".53" cy="-1.13" rx=".105" ry=".105" /></>
            : <g transform={`translate(.67 -.58) scale(${earSize})`}>
              <path d={config.ears === 'round' ? 'M-.33 .15Q-.48-.66-.04-.61Q.44-.61.33 .33Z' : 'M-.34 .15L.22-.69Q.32-.78.34-.59L.4 .36Z'} />
              <path d="M-.13 .05L.2-.44L.25 .2Z" fill={colors.nose} opacity=".4" />
            </g>}
        </g></g>))}
      <path data-face={shape ?? kind} d={head} />
    </g>
    <g clipPath={`url(#${clipID})`}>
      <path className="cua-avatar-shine" d="M-.72-.5Q-.57-.76-.26-.77" stroke="white" strokeOpacity=".2" strokeWidth=".085" strokeLinecap="round" />
      <g className="cua-avatar-cheeks" fill={config.color === 'graphite' ? '#F9B6C2' : '#F7829E'} opacity={mood === 'error' || mood === 'paused' ? .15 : mood === 'done' ? .38 : .25}><ellipse cx={geometric ? -.66 : -.7} cy=".29" rx=".13" ry=".065"/><ellipse cx={geometric ? .66 : .7} cy=".29" rx=".13" ry=".065"/></g>
      {kind === 'fox' && <path d="M-1 .02Q-.59-.04 0 .39Q.59-.04 1 .02L1 .95H-1Z" fill="white" opacity=".52" />}
      {kind === 'cat' && <g stroke={colors.nose} strokeWidth=".045" strokeLinecap="round" opacity=".65"><path d="M-.54 .34L-.88 .25M-.53 .45L-.9 .47M.54 .34L.88 .25M.53 .45L.9 .47" /></g>}
      {!geometric && (kind === 'koala' ? <path d={geometry.nose} fill={colors.nose} />
        : kind === 'robot' ? <g fill={colors.nose} opacity=".65"><rect x="-.8" y=".29" width=".075" height=".17" rx=".037"/><rect x=".725" y=".29" width=".075" height=".17" rx=".037"/></g>
          : <path d="M-.15 .26Q0 .18.15 .26L0 .43Z" fill={colors.nose} />)}
      {mood === 'needsApproval' ? <ellipse className="cua-avatar-mouth" cx="0" cy={mouthY + .035} rx=".06" ry=".075" stroke={colors.eye} strokeOpacity=".68" strokeWidth=".04"/> : <path className="cua-avatar-mouth" d={mouth} stroke={colors.eye} strokeOpacity=".68" strokeWidth=".045" strokeLinecap="round"/>}
      <g className="cua-avatar-gaze"><g className="cua-avatar-blink" color={colors.eye} stroke={colors.eye} strokeLinecap="round" strokeLinejoin="round">
        <Eye glyph={left} side="left" spin={spin} geometric={geometric} />
        <Eye glyph={right} side="right" spin={spin} geometric={geometric} />
      </g></g>
    </g>
    </g>
    {mood === 'done' ? <g className="cua-avatar-delight" stroke={colors.face} strokeWidth=".055" strokeLinecap="round" aria-hidden="true"><path d="M1.08-.97V-.72M.955-.845h.25M-.96.68v.16M-1.04.76h.16"/><ellipse cx=".97" cy=".57" rx=".04" ry=".04" fill={colors.face} stroke="none"/></g> : null}
  </svg>
}

export interface CuaBotAvatarPickerProps {
  value: CuaBotAvatarConfig
  onChange: (config: CuaBotAvatarConfig) => void
  name?: string
  className?: string
  /** Missing on older hosts; their existing faces remain editable. */
  shapes?: readonly string[]
}

const label = (value: string) => value[0].toUpperCase() + value.slice(1)

export function CuaBotAvatarPicker({ value, onChange, name = '', className = '', shapes = [] }: CuaBotAvatarPickerProps) {
  const config = normalizeCuaBotAvatarConfig(value, name)
  const geometric = config.kind === undefined || config.kind === 'koala' ? CUA_BOT_SHAPES.includes(config.shape as typeof CUA_BOT_SHAPES[number]) : false
  const choices = CUA_BOT_SHAPES.filter(shape => shapes.includes(shape) || shape === config.shape)
  const chooseAnimal = (kind: typeof CUA_BOT_KINDS[number]) => {
    const { kind: _, shape: __, ...face } = config
    // An explicit animal choice also clears a future shape dropped by a decoder.
    onChange({ ...face, shape: 'classic', ...(kind !== 'koala' ? { kind } : {}) })
  }
  return <div className={`cua-bot-avatar-picker ${className}`.trim()}>
    <fieldset><legend>Character</legend><div className="cua-avatar-characters">
      {CUA_BOT_KINDS.map(kind => <button type="button" key={kind} className="cua-avatar-option"
        aria-label={label(kind)} aria-pressed={!geometric && (config.kind ?? 'koala') === kind} onClick={() => chooseAnimal(kind)}>
        <CuaBotAvatar config={{ ...config, kind, shape: undefined }} size={46} animated={false} /><span>{label(kind)}</span>
      </button>)}
      {choices.map(shape => <button type="button" key={shape} className="cua-avatar-option"
        aria-label={label(shape)} aria-pressed={geometric && config.shape === shape} disabled={!shapes.includes(shape)} onClick={() => onChange({ ...config, kind: 'koala', shape })}>
        <CuaBotAvatar config={{ ...config, kind: 'koala', shape }} size={46} animated={false}/><span>{label(shape)}</span>
      </button>)}
    </div></fieldset>
    {geometric && !shapes.includes(config.shape!) ? <p className="cua-avatar-unsupported" role="status">This Strata host does not support this character. Choose an animal to save your changes.</p> : null}
    <fieldset><legend>Color</legend><div className="cua-avatar-colors">
      {CUA_BOT_COLORS.map(color => <button type="button" key={color} className="cua-avatar-color"
        aria-label={label(color)} aria-pressed={config.color === color} title={label(color)}
        onClick={() => onChange({ ...config, color })}><span style={{ backgroundColor: palette[color].face }} /></button>)}
    </div></fieldset>
    <fieldset><legend>Eyes</legend><div className="cua-avatar-eyes">
      {CUA_BOT_EYES.map(eyes => <button type="button" key={eyes} className="cua-avatar-option"
        aria-label={label(eyes)} aria-pressed={config.eyes === eyes} onClick={() => onChange({ ...config, eyes })}>
        <CuaBotAvatar config={{ ...config, eyes }} size={46} animated={false} /><span>{label(eyes)}</span>
      </button>)}
    </div></fieldset>
    {!geometric ? <fieldset><legend>Ears</legend><div className="cua-avatar-ears">
      {CUA_BOT_EARS.map(ears => <button type="button" key={ears} className="cua-avatar-option"
        aria-label={label(ears)} aria-pressed={config.ears === ears} onClick={() => onChange({ ...config, ears })}>
        <CuaBotAvatar config={{ ...config, ears }} size={46} animated={false} /><span>{label(ears)}</span>
      </button>)}
    </div></fieldset> : null}
  </div>
}
