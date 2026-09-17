/**
 * Glyph-mask measurement contracts: CSS→canvas px mapping honors the canvas's
 * own scale (DPR), clamps to integers, and returns null for absent/zero boxes.
 */
import { describe, expect, it } from 'vitest'

import { measureTranscriptMask } from './mask'

function fakeCanvas(canvasW: number, cssW: number, rect: { left: number; top: number; width?: number; height?: number }) {
  return {
    width: canvasW,
    clientWidth: cssW,
    getBoundingClientRect: () => ({
      left: rect.left,
      top: rect.top,
      right: rect.left + (rect.width ?? cssW),
      bottom: rect.top + (rect.height ?? 100),
      width: rect.width ?? cssW,
      height: rect.height ?? 100,
      x: rect.left, y: rect.top, toJSON: () => ({}),
    }),
  } as HTMLCanvasElement
}

function fakeTranscript(rect: { left: number; top: number; right: number; bottom: number }) {
  return {
    getBoundingClientRect: () => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top, x: rect.left, y: rect.top, toJSON: () => ({}), left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }),
  } as HTMLElement
}

describe('measureTranscriptMask', () => {
  it('maps CSS px to canvas px through the canvas scale (DPR 2)', () => {
    const canvas = fakeCanvas(1920, 960, { left: 0, top: 0, width: 960, height: 540 })
    const tr = fakeTranscript({ left: 100, top: 50, right: 860, bottom: 500 })
    const box = measureTranscriptMask(canvas, tr)
    expect(box).toEqual({ x0: 200, x1: 1720, y0: 100, y1: 1000 })
  })

  it('returns null when the transcript is absent', () => {
    const canvas = fakeCanvas(960, 960, { left: 0, top: 0 })
    expect(measureTranscriptMask(canvas, null)).toBeNull()
  })

  it('returns null for a zero-sized or inverted box', () => {
    const canvas = fakeCanvas(960, 960, { left: 0, top: 0 })
    expect(measureTranscriptMask(canvas, fakeTranscript({ left: 0, top: 0, right: 0, bottom: 0 }))).toBeNull()
  })

  it('offsets correctly when the canvas is not at the origin', () => {
    const canvas = fakeCanvas(480, 480, { left: 20, top: 10, width: 480, height: 270 })
    const tr = fakeTranscript({ left: 40, top: 30, right: 400, bottom: 240 })
    // scale = 480/480 = 1; coords relative to canvas
    expect(measureTranscriptMask(canvas, tr)).toEqual({ x0: 20, x1: 380, y0: 20, y1: 230 })
  })
})
