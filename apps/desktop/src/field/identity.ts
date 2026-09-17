/**
 * Cuttlefish identity allocation — TypeScript port of the shipped Python
 * allocator (cuttlefish-theme color/identity.py, PR#1 head 7409e67).
 *
 * WHY PORT AT ALL: the v18 engine's `paletteForSession` derived hue from an
 * FNV hash with no live-peer allocation and no reserved alarm arcs. Two
 * sessions could land perceptually identical colours, and one could land in
 * the amber/red arcs the acute channel owns. The Python allocator solves this
 * with farthest-point selection against the live set; Desktop must solve it
 * the SAME way so a session is the same colour family on both surfaces.
 *
 * The port is pinned to Python output by fixtures/identity-vectors.json
 * (200 vectors, mixed live-set sizes). Drift fails the build.
 */
import { blake2b } from '@noble/hashes/blake2.js'

import { deltaEOk, gamutMap, hexToOklch, inSrgbGamut, type OKLCh, oklchToHex } from './oklab'

export const MIN_IDENTITY_DISTANCE = 0.155

// Identity band: lightness/chroma chosen to stay legible on dark and light
// surfaces and survive 8-bit quantisation (see identity.py for the sweeps).
const L_MIN = 0.48
const L_MAX = 0.82
const C_MIN = 0.135
const C_MAX = 0.24

// Hue arcs reserved for the acute channel (amber INPUT, red FAULT); identity
// may never impersonate them. Degrees, same widened margins as identity.py.
const RESERVED: ReadonlyArray<readonly [number, number]> = [
  [5.0, 48.0],
  [62.0, 102.0],
]

const GOLDEN_ANGLE = 137.50776405003785

export interface IdentityColor {
  sessionId: string
  oklch: OKLCh
  hex: string
  /** OKLab distance to nearest live identity; Infinity when alone. */
  separation: number
  /** True when the floor could not be met — surfaced, never hidden. */
  crowded: boolean
  distanceTo(other: IdentityColor): number
}

export function isReservedHue(h: number): boolean {
  const x = ((h % 360) + 360) % 360
  return RESERVED.some(([lo, hi]) => lo <= x && x <= hi)
}

/** Deterministic 64-bit words from the session id (blake2b, 32-byte digest). */
function seedWords(sessionId: string): bigint[] {
  const digest = blake2b(new TextEncoder().encode(sessionId), { dkLen: 32 })
  const words: bigint[] = []
  for (let i = 0; i < 32; i += 8) {
    let w = 0n
    for (let j = i; j < i + 8; j++) w = (w << 8n) | BigInt(digest[j]!)
    words.push(w)
  }
  return words
}

const wordToUnit = (w: bigint, mod: bigint): number => Number(w % mod) / Number(mod)

/**
 * Deterministic, well-spread candidate colours: golden-angle hue walk with
 * van-der-Corput-style additive recurrences in L and C. Rejected candidates
 * (reserved hue, gamut-crushed chroma) are dropped; we over-generate 12x.
 */
export function candidates(sessionId: string, count: number): OKLCh[] {
  const [w0, w1, w2] = seedWords(sessionId)
  const h0 = Number(w0 % 360_000n) / 1000
  const l0 = Number(w1 % 1_000_000n) / 1_000_000
  const c0 = Number(w2 % 1_000_000n) / 1_000_000

  const out: OKLCh[] = []
  let i = 0
  while (out.length < count && i < count * 12) {
    const h = (h0 + i * GOLDEN_ANGLE) % 360
    i++
    if (isReservedHue(h)) continue
    const L = L_MIN + (L_MAX - L_MIN) * ((l0 + 0.6180339887498949 * i) % 1.0)
    const C = C_MIN + (C_MAX - C_MIN) * ((c0 + 0.7548776662466927 * i) % 1.0)
    const cand = gamutMap({ L, C, h })
    if (cand.C >= C_MIN * 0.95 && inSrgbGamut(cand)) out.push(cand)
  }
  return out
}

function toIdentity(sessionId: string, oklch: OKLCh, separation: number, minDistance: number): IdentityColor {
  return {
    sessionId,
    oklch,
    hex: oklchToHex(oklch),
    separation,
    crowded: separation < minDistance,
    distanceTo(other) {
      return deltaEOk(this.oklch, other.oklch)
    },
  }
}

export function allocate(sessionId: string, live: ReadonlyArray<string | OKLCh> = [], opts: { minDistance?: number; candidateCount?: number } = {}): IdentityColor {
  const minDistance = opts.minDistance ?? MIN_IDENTITY_DISTANCE
  const candidateCount = opts.candidateCount ?? 96
  if (!sessionId.trim()) throw new Error('sessionId must be a non-empty string')

  const others = live.map(c => (typeof c === 'string' ? hexToOklch(c) : c))
  if (others.length === 0) {
    const [best] = candidates(sessionId, 1)
    if (!best) throw new Error('no in-gamut candidates; identity colour bands are invalid')
    return toIdentity(sessionId, best, Infinity, minDistance)
  }

  const cands = candidates(sessionId, candidateCount)
  let best = cands[0]!
  let bestSep = -Infinity
  for (const c of cands) {
    let nearest = Infinity
    for (const o of others) nearest = Math.min(nearest, deltaEOk(c, o))
    // Farthest-point selection, tie-break the SMALLER hue (identity.py: max(key=(sep, -h))).
    if (nearest > bestSep || (nearest === bestSep && c.h < best.h)) {
      bestSep = nearest
      best = c
    }
  }
  return toIdentity(sessionId, best, bestSep, minDistance)
}

/** Allocate in order, each aware of the ones before it (mirrors reality). */
export function allocateMany(sessionIds: readonly string[], opts?: { minDistance?: number; candidateCount?: number }): IdentityColor[] {
  const out: IdentityColor[] = []
  for (const sid of sessionIds) {
    out.push(allocate(sid, out.map(c => c.oklch), opts))
  }
  return out
}
