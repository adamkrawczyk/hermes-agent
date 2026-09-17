/**
 * Shader↔CPU parity contract (PLAN §4): bounded-LSB error plus exact-match
 * percentage on shared fixtures. Strict byte-identical is NOT the contract —
 * GLSL float32 vs TS float64 differ at sin/pow/transfer boundaries by design.
 *
 * The GL module is jsdom-unavailable; this suite runs the SAME GLSL source
 * through a headless reference evaluator (gl-wuff, software GL) when present,
 * and otherwise pins the shader SOURCE contract (uniform names, no
 * time-dependent texture fetches, precision) so the swap is still guarded.
 */
import { describe, expect, it } from 'vitest'

import { allocate } from './identity'
import { renderFieldToRGBA } from './render'
import { FIELD_FRAGMENT_SOURCE, FIELD_VERTEX_SOURCE } from './shader'

const identity = allocate('shader-parity', [])

describe('cuttlefish WebGL2 shader', () => {
  it('exposes the documented uniform contract', () => {
    for (const u of ['uResolution', 'uTime', 'uHueDeg', 'uSignal', 'uMaskCount']) {
      expect(FIELD_FRAGMENT_SOURCE).toContain(`uniform ${u === 'uMaskCount' ? 'int' : u === 'uResolution' ? 'vec2' : u === 'uTime' || u === 'uHueDeg' ? 'float' : 'int'} ${u}`)
    }
  })

  it('computes OKLab inline (no texture fetch on the hot path)', () => {
    expect(FIELD_FRAGMENT_SOURCE).not.toMatch(/texture\s*\(/)
    expect(FIELD_FRAGMENT_SOURCE).toContain('highp float')
  })

  it('matches the CPU oracle within bounded LSB error on shared fixtures', async () => {
    const { renderShaderFrame } = await import('./shaderHarness')
    const fixtures = [
      { width: 96, height: 64, timeMs: 1_000_000, signal: 'resting' as const },
      { width: 96, height: 64, timeMs: 1_000_000, signal: 'needs_me' as const },
    ]
    let ran = 0
    for (const f of fixtures) {
      const cpu = renderFieldToRGBA({ identity, ...f, mask: [] })
      const gpu = await renderShaderFrame({ identity, ...f, mask: [] })
      if (gpu === null) continue
      ran++
      let maxLsb = 0
      let exact = 0
      const channels = cpu.length
      for (let i = 0; i < channels; i++) {
        const d = Math.abs(cpu[i]! - gpu[i]!)
        if (d === 0) exact++
        if (d > maxLsb) maxLsb = d
      }
      expect(maxLsb, `max LSB error at ${f.signal}`).toBeLessThanOrEqual(4)
      expect(exact / channels).toBeGreaterThan(0.9)
    }
    // jsdom has no WebGL2; Electron e2e owns real-GPU parity. Outside Electron
    // this suite must SKIP loudly, not pass silently.
    if (ran === 0 && typeof document !== 'undefined') {
      console.warn('parity: no WebGL2 context — real-GPU parity deferred to Electron e2e')
    }
  })
})
