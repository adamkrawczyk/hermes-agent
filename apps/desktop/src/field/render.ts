/**
 * Cuttlefish field renderer — CPU reference (TypeScript).
 *
 * Port of the v18 engine's fieldAt with the v20 identity swap: palette comes
 * from the ported allocator (identity.ts), not FNV. This is the CPU oracle
 * the WebGL2 shader is judged against (bounded-LSB error + exact-match %,
 * not strict byte equality — PLAN §4).
 *
 * One responsibility: pixels. No React, no canvas, no stores.
 */
import type { IdentityColor } from './identity'

export type Signal = 'resting' | 'needs_me' | 'fault'
export const ACUTE_SIGNALS = ['needs_me', 'fault'] as const

export interface Box { x0: number; x1: number; y0: number; y1: number }

export interface RenderArgs {
  identity: IdentityColor
  width: number
  height: number
  timeMs: number
  signal: Signal
  mask: Box[]
}

// --- hash noise: identical to the v18 engine (the shader must match where float32 allows) ---

export function hash2(seed: number, x: number, y: number): number {
  let n = (seed ^ Math.imul(x, 0x45d9f3b) ^ Math.imul(y, 0x119de1f3)) >>> 0
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b) >>> 0
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b) >>> 0
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295
}

const smooth = (t: number): number => t * t * (3 - 2 * t)

export function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = smooth(x - x0), fy = smooth(y - y0)
  const a = hash2(seed, x0, y0), b = hash2(seed, x0 + 1, y0)
  const c = hash2(seed, x0, y0 + 1), d = hash2(seed, x0 + 1, y0 + 1)
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy
}

export function fractal(seed: number, x: number, y: number): number {
  let total = 0, amp = .5, freq = 1, norm = 0
  for (let i = 0; i < 5; i++) {
    total += valueNoise(seed + i * 1013, x * freq, y * freq) * amp
    norm += amp
    amp *= .5
    freq *= 2
  }
  return total / norm
}

// --- contraction mask (v18: 48px finite-support feather) ---

export function contractionMask({ width, height, mask }: { width: number; height: number; mask: Box[] }): Float32Array {
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let best = 0
    for (const b of mask) {
      const dx = x < b.x0 ? b.x0 - x : x > b.x1 ? x - b.x1 : 0
      const dy = y < b.y0 ? b.y0 - y : y > b.y1 ? y - b.y1 : 0
      const d = Math.hypot(dx, dy)
      const t = Math.max(0, Math.min(1, 1 - d / 48))
      best = Math.max(best, t * t * (3 - 2 * t))
    }
    out[y * width + x] = best
  }
  return out
}

// --- colour pipeline (linear-light OKLab like v18 color.ts) ---

interface RGB { r: number; g: number; b: number }

function oklch(L: number, C: number, h: number): RGB {
  const rad = h * Math.PI / 180
  const a = C * Math.cos(rad), bb = C * Math.sin(rad)
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  }
}

const blend = (a: RGB, b: RGB, t: number): RGB => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t })

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

function toByte(c: RGB): { r: number; g: number; b: number } {
  const e = (v: number): number => (v = clamp01(v)) <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
  return { r: Math.round(e(c.r) * 255), g: Math.round(e(c.g) * 255), b: Math.round(e(c.b) * 255) }
}

// --- the field itself ---

function seedOf(_s: string): number {
  // v20: the numeric seed no longer derives from the session id (FNV is gone);
  // it is a fixed constant so the field's TEXTURE is session-independent and
  // only the palette carries identity.
  return 20260917
}

/**
 * Acute-state 45-45-10 class masks: three deterministic disjoint partitions of
 * the open-field noise space (identity / signal / accent), stable in topology
 * between INPUT and FAULT — only the palette changes.
 */
const ACUTE_TINT: Record<'needs_me' | 'fault', RGB> = {
  needs_me: { r: 1.0, g: 0.7, b: 0.14 },
  fault: { r: 0.96, g: 0.14, b: 0.2 },
}

function fieldAt(a: RenderArgs, x: number, y: number, contraction: number): RGB {
  const seed = seedOf(a.identity.sessionId)
  const nx = x / Math.max(1, a.width), ny = y / Math.max(1, a.height)
  const t = a.timeMs * 0.000018
  const broad = fractal(seed, nx * 3.1 + t, ny * 2.1 - t * 0.6)
  const fine = fractal(seed + 9001, nx * 15 + t * 0.4, ny * 15 - t * 0.2)
  const pearl = fractal(seed + 19007, nx * a.width / 3.7 + t * 0.2, ny * a.height / 3.7 - t * 0.1) + valueNoise(seed + 29011, x / 2.1, y / 2.1) * 0.12
  const wave = 0.5 + 0.5 * Math.sin(nx * 15 + Math.sin(ny * 8 + t) * 1.7 + t * 3)
  const hueDeg = a.identity.oklch.h
  // v20 REST BAND (plan §3): the field rests ~10% above the near-black
  // ground (#0B0C10, OKLab L 0.155). The v18 constants painted L up to 0.9 —
  // v20 keeps only rare dot peaks; p95 stays within ground+0.03.
  const leuc = oklch(0.150 + broad * 0.012, 0.03, hueDeg + 68.8)
  const iri = oklch(0.018 + broad * 0.02 + fine * 0.008, 0.018 + broad * 0.018, hueDeg + 217.7 + wave * 28.6)
  const pigmentL = 0.155 + Math.max(0, broad - 0.74) * 0.28 + Math.max(0, wave - 0.82) * 0.2
  const pigment = oklch(pigmentL, 0.10 + fine * 0.05, hueDeg)
  let out: RGB = { r: 0, g: 0, b: 0 }
  out = blend(out, leuc, 0.55)
  out = blend(out, iri, 0.5)
  out = blend(out, pigment, Math.max(0, Math.min(0.7, broad * 0.9 + wave * 0.5 - 0.42)))
  if (a.signal !== 'resting') {
    // 45-45-10: noise-space partition into three disjoint classes.
    const cls = fine * 0.5 + pearl % 0.5
    const tint = ACUTE_TINT[a.signal]
    if (cls < 0.45) {
      // identity class: keep pigment (already applied)
    } else if (cls < 0.9) {
      out = blend(out, oklch(0.6, 0.18, a.signal === 'needs_me' ? 83 : 27), 0.55)
    } else {
      out = blend(out, { r: tint.r, g: tint.g, b: tint.b }, 0.5)
    }
  }
  if (contraction > 0) {
    // The contracted colour derives from the FROZEN field (t=0), so a fully
    // masked pixel is byte-identical at every instant: no motion under
    // glyphs, ever (plan §3). The feather crossfades live→frozen.
    const frozen = fieldAtFrozen(a, x, y)
    const lab = toOklabLinear(frozen)
    const hue = Math.atan2(lab.b, lab.a)
    const chroma = Math.hypot(lab.a, lab.b)
    const calmL = 0.4 + Math.max(-0.018, Math.min(0.018, (lab.L - 0.4) * 0.06))
    // FROZEN fine too: the chroma cap is part of the contracted colour, so it
    // must come from the frozen instant or masked pixels shimmer.
    const fineFrozen = fractal(20260917 + 9001, (x / Math.max(1, a.width)) * 15, (y / Math.max(1, a.height)) * 15)
    const contracted = oklchRad(calmL, Math.min(chroma, 0.04 + fineFrozen * 0.06), hue)
    return blend(out, contracted, contraction)
  }
  return out
}

/** The same pixel at the frozen instant (timeMs = 0) — no time arguments vary. */
function fieldAtFrozen(a: RenderArgs, x: number, y: number): RGB {
  return fieldAt({ ...a, timeMs: 0, signal: 'resting', mask: [] }, x, y, 0)
}

function toOklabLinear(c: RGB): { L: number; a: number; b: number } {
  const l = Math.cbrt(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b)
  const m = Math.cbrt(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b)
  const s = Math.cbrt(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

function oklchRad(L: number, C: number, hRad: number): RGB {
  const a = C * Math.cos(hRad), bb = C * Math.sin(hRad)
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  }
}

/** Render one full frame to RGBA bytes. Deterministic per (identity, time). */
export function renderFieldToRGBA(a: RenderArgs): Uint8ClampedArray {
  const out = new Uint8ClampedArray(a.width * a.height * 4)
  const cm = contractionMask({ width: a.width, height: a.height, mask: a.mask })
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const c = toByte(fieldAt(a, x, y, cm[y * a.width + x]!))
    const i = (y * a.width + x) * 4
    out[i] = c.r; out[i + 1] = c.g; out[i + 2] = c.b; out[i + 3] = 255
  }
  return out
}
