/**
 * CPU field renderer contracts — the acceptance outcomes the WebGL2 shader
 * will be judged against (PLAN §3/§4), amended for v20 semantics:
 *
 * SUPERSEDED (v18 oracle): "signal-invariant field" — v20 deliberately
 * recolours the field during acute states (45-45-10). This suite asserts the
 * NEW contract instead.
 */
import { describe, expect, it } from 'vitest'

import { allocate } from './identity'
import { contractionMask, renderFieldToRGBA, type Box, type RenderArgs } from './render'

const W = 96
const H = 64

const identity = allocate('field-test-session', [])
const base: RenderArgs = { identity, width: W, height: H, timeMs: 1_000_000, signal: 'resting', mask: [] }

function render(over: Partial<typeof base>) {
  return renderFieldToRGBA({ ...base, ...over })
}

describe('cuttlefish CPU field', () => {
  it('renders deterministic frames: same instant, same bytes', () => {
    const a = render({})
    const b = render({})
    expect([...a]).toEqual([...b])
  })

  it('ambient field is near-dark: p95 luminance close to ground', () => {
    const frame = render({})
    const GROUND_OKLAB_L = 0.155 // #0B0C10
    const lums: number[] = []
    for (let i = 0; i < frame.length; i += 4) {
      const lin = (v: number) => { const c = v! / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
      const r = lin(frame[i]), g = lin(frame[i + 1]), b = lin(frame[i + 2])
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
      lums.push(0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s)
    }
    lums.sort((x, y) => x - y)
    const p95 = lums[Math.floor(lums.length * 0.95)]!
    // 10% rest rule in the plan's unit: p95 OKLab L within +0.03 of ground
    expect(p95).toBeLessThanOrEqual(GROUND_OKLAB_L + 0.03)
  })

  it('different identities paint visibly different fields', () => {
    const a = render({})
    const id2 = allocate('field-test-session-2', [identity.hex])
    const b = render({ identity: id2 })
    let diff = 0
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i]! - b[i]!) > 8) diff++
    }
    expect(diff / (a.length / 4)).toBeGreaterThan(0.05)
  })

  it('acute state recolours the field (v20 amendment: NOT signal-invariant)', () => {
    const rest = render({})
    const acute = render({ signal: 'needs_me' })
    let changed = 0
    for (let i = 0; i < rest.length; i += 4) {
      if (Math.abs(rest[i]! - acute[i]!) > 8 || Math.abs(rest[i + 1]! - acute[i + 1]!) > 8) changed++
    }
    expect(changed / (rest.length / 4)).toBeGreaterThan(0.2)
  })

  it('contraction mask has ≥6 continuous levels and finite support', () => {
    const mask: Box[] = [{ x0: 56, x1: 88, y0: 40, y1: 56 }]
    const cm = contractionMask({ width: W, height: H, mask })
    const levels = new Set<number>()
    let farUntouched = true
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = cm[y * W + x]!
      if (v > 0 && v < 1) levels.add(Math.round(v * 100))
      if (x < 5 && cm[y * W + x]! !== 0) farUntouched = false
    }
    expect(levels.size).toBeGreaterThanOrEqual(6)
    expect(farUntouched).toBe(true)
  })

  it('motion happens only in open field: masked pixels hold still', () => {
    const mask: Box[] = [{ x0: 20, x1: 70, y0: 20, y1: 44 }]
    const t1 = render({ timeMs: 1_000_000, mask })
    const t2 = render({ timeMs: 1_050_000, mask })
    let maskedChanged = 0
    let maskedPixels = 0
    const cm = contractionMask({ width: W, height: H, mask })
    for (let i = 0; i < t1.length; i += 4) {
      const px = i / 4
      if (cm[px] === 1) {
        maskedPixels++
        if (t1[i]! !== t2[i]! || t1[i + 1]! !== t2[i + 1]! || t1[i + 2]! !== t2[i + 2]!) maskedChanged++
      }
    }
    expect(maskedPixels).toBeGreaterThan(100)
    expect(maskedChanged).toBe(0)
  })
})
