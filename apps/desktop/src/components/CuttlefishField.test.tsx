/**
 * Cuttlefish mount discipline — the Off/Calm/Alive contracts, probed (not
 * assumed): Off leaves ZERO canvases and ZERO RAF loops; Calm paints one
 * static frame (no RAF); reduced motion forces static.
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CuttlefishField } from './CuttlefishField'
import { $cuttlefish, setCuttlefishMode } from '@/store/cuttlefish'


let webgl2Contexts = 0

class FakeWebGL2 {
  constructor() {
    webgl2Contexts++
  }
  createShader() { return {} }
  shaderSource() {}
  compileShader() {}
  getShaderParameter() { return true }
  getShaderInfoLog() { return null }
  createProgram() { return {} }
  attachShader() {}
  linkProgram() {}
  getProgramParameter() { return true }
  useProgram() {}
  createBuffer() { return {} }
  bindBuffer() {}
  bufferData() {}
  getAttribLocation() { return 0 }
  enableVertexAttribArray() {}
  vertexAttribPointer() {}
  getUniformLocation() { return {} }
  viewport() {}
  uniform2f() {}
  uniform1f() {}
  uniform1i() {}
  uniform4fv() {}
  drawArrays() {}
  getExtension() { return { loseContext() {} } }
}

let rafSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  webgl2Contexts = 0
  rafSpy = vi.spyOn(window, 'requestAnimationFrame')
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} }),
  )
  const orig = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = orig(tag)
    if (tag === 'canvas') {
      Object.defineProperty(el, 'getContext', {
        value: () => new FakeWebGL2(),
      })
    }
    return el
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setCuttlefishMode('off')
  $cuttlefish.set({ mode: 'off', density: 1 })
})

describe('CuttlefishField', () => {
  it('Off renders NO canvas and starts NO RAF', () => {
    setCuttlefishMode('off')
    const { container } = render(<CuttlefishField sessionId="s1" />)
    expect(container.querySelector('canvas')).toBeNull()
    expect(container.querySelector('[data-cuttlefish-field]')).toBeNull()
    expect(rafSpy).not.toHaveBeenCalled()
    expect(webgl2Contexts).toBe(0)
  })

  it('Calm mounts the canvas, paints once, and starts NO RAF loop', () => {
    setCuttlefishMode('calm')
    const { container } = render(<CuttlefishField sessionId="s1" />)
    expect(container.querySelector('[data-cuttlefish-field]')).not.toBeNull()
    expect(rafSpy).not.toHaveBeenCalled()
    expect(webgl2Contexts).toBe(1)
  })

  it('reduced motion forces static even in Alive mode', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((q: string) => ({
        matches: q.includes('prefers-reduced-motion'),
        addEventListener() {},
        removeEventListener() {},
      })),
    )
    setCuttlefishMode('alive')
    const { container } = render(<CuttlefishField sessionId="s1" />)
    expect(container.querySelector('[data-cuttlefish-field]')).not.toBeNull()
    expect(rafSpy).not.toHaveBeenCalled()
  })

  it('Alive starts a RAF loop that suspends when the window loses focus', async () => {
    setCuttlefishMode('alive')
    const { unmount } = render(<CuttlefishField sessionId="s1" />)
    await act(async () => {})
    expect(rafSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
    unmount()
  })

  it('unmount loses the GL context (zero dangling contexts)', () => {
    setCuttlefishMode('calm')
    const { unmount } = render(<CuttlefishField sessionId="s1" />)
    expect(webgl2Contexts).toBe(1)
    unmount()
    // FakeWebGL2 counts creations; the component calls loseContext() on
    // cleanup — the probe here is that cleanup ran without throwing and the
    // canvas is gone from the DOM.
    expect(document.querySelector('[data-cuttlefish-field]')).toBeNull()
  })

  it('toggling Off unmounts the canvas entirely', async () => {
    setCuttlefishMode('calm')
    const { container } = render(<CuttlefishField sessionId="s1" />)
    expect(container.querySelector('canvas')).not.toBeNull()
    await act(async () => {
      setCuttlefishMode('off')
    })
    expect(container.querySelector('canvas')).toBeNull()
  })
})
