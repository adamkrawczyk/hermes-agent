/**
 * Glyph-mask measurement: the transcript's bounding boxes, in canvas pixels,
 * re-measured per frame. Element boxes → integer pixel boxes (device-raster
 * aligned); never guesses, always measures.
 */
export interface MaskBox {
  x0: number
  x1: number
  y0: number
  y1: number
}

/**
 * Measure the transcript element's content box against the canvas, mapping
 * CSS px → canvas px via the canvas's own scale (canvas.width/clientWidth).
 * Returns null when the transcript is absent or zero-sized.
 */
export function measureTranscriptMask(canvas: HTMLCanvasElement, transcript: HTMLElement | null): MaskBox | null {
  if (!transcript) return null
  const cRect = canvas.getBoundingClientRect()
  const tRect = transcript.getBoundingClientRect()
  const scale = cRect.width > 0 ? canvas.width / cRect.width : 1
  const x0 = Math.floor((tRect.left - cRect.left) * scale)
  const y0 = Math.floor((tRect.top - cRect.top) * scale)
  const x1 = Math.ceil((tRect.right - cRect.left) * scale)
  const y1 = Math.ceil((tRect.bottom - cRect.top) * scale)
  if (x1 <= x0 || y1 <= y0) return null
  return { x0, x1, y0, y1 }
}
