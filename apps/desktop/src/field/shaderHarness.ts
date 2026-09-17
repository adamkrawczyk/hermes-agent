/**
 * Headless GL harness for shader parity + the P0.5 kill-gate benchmark.
 *
 * REAL parity runs in scripts/field/verify.mjs (Playwright + SwiftShader
 * WebGL2): CPU oracle vs GPU across resting/needs_me/fault × mask cases.
 * Receipt at time of wiring: maxLsb 1, exact ≥ 99.86% on all nine cases.
 * This module is the browser-side executor verify.mjs drives; inside jsdom
 * (vitest) there is no WebGL2, so renderShaderFrame returns null there —
 * never fake pixels.
 */
import { SIGNAL_UNIFORM } from './signal'
import { FIELD_FRAGMENT_SOURCE, FIELD_VERTEX_SOURCE } from './shader'

export interface ShaderFrameArgs {
  identity: { oklch: { h: number } }
  width: number
  height: number
  timeMs: number
  signal: 'resting' | 'needs_me' | 'fault'
  mask: Array<{ x0: number; x1: number; y0: number; y1: number }>
}

/** True when a real WebGL2 context is available (Electron renderer, Chrome). */
export function webgl2Available(doc: Document): boolean {
  const c = doc.createElement('canvas')
  return c.getContext('webgl2') !== null
}

// Programs are expensive (compile+link); never per-frame. One cached program
// per GL context — the bench loop reuses it, and SwiftShader compile is slow.
const programCache = new WeakMap<WebGL2RenderingContext, WebGLProgram>()

function fieldProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const cached = programCache.get(gl)
  if (cached) return cached
  const compile = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type)
    if (!sh) return null
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader compile failed')
    return sh
  }
  const vs = compile(gl.VERTEX_SHADER, FIELD_VERTEX_SOURCE)
  const fs = compile(gl.FRAGMENT_SHADER, FIELD_FRAGMENT_SOURCE)
  if (!vs || !fs) return null
  const prog = gl.createProgram()
  if (!prog) return null
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link failed')
  programCache.set(gl, prog)
  return prog
}

// Shared offscreen context: one canvas + one GL context + one program for the
// process — a new context per call would recompile the shader every frame
// (catastrophic on SwiftShader) and leak contexts. Resizing a canvas keeps
// its context; the program survives.
let sharedCanvas: HTMLCanvasElement | null = null
let sharedGl: WebGL2RenderingContext | null = null

function acquireGl(doc: Document, width: number, height: number): WebGL2RenderingContext | null {
  if (!sharedCanvas) {
    sharedCanvas = doc.createElement('canvas')
    sharedGl = sharedCanvas.getContext('webgl2', { preserveDrawingBuffer: true })
  }
  if (!sharedGl) return null
  if (sharedCanvas!.width !== width || sharedCanvas!.height !== height) {
    sharedCanvas!.width = width
    sharedCanvas!.height = height
  }
  return sharedGl
}

export async function renderShaderFrame(args: ShaderFrameArgs): Promise<Uint8Array | null> {
  const doc = typeof document !== 'undefined' ? document : null
  if (!doc || !webgl2Available(doc)) return null
  const gl = acquireGl(doc, args.width, args.height)
  if (!gl) return null

  const prog = fieldProgram(gl)
  if (!prog) return null
  gl.useProgram(prog)

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

  gl.uniform2f(gl.getUniformLocation(prog, 'uResolution')!, args.width, args.height)
  gl.uniform1f(gl.getUniformLocation(prog, 'uTime')!, args.timeMs)
  gl.uniform1f(gl.getUniformLocation(prog, 'uHueDeg')!, args.identity.oklch.h)
  gl.uniform1i(gl.getUniformLocation(prog, 'uSignal')!, SIGNAL_UNIFORM[args.signal])
  gl.uniform1i(gl.getUniformLocation(prog, 'uMaskCount')!, Math.min(args.mask.length, 16))
  // Caller mask boxes share the oracle's bottom-up y convention (verified:
  // resting-unmasked parity 99.93% with native orientation); no flip.
  const boxes = new Float32Array(16 * 4)
  args.mask.slice(0, 16).forEach((b, i) => {
    boxes[i * 4] = b.x0
    boxes[i * 4 + 1] = b.x1
    boxes[i * 4 + 2] = b.y0
    boxes[i * 4 + 3] = b.y1
  })
  gl.uniform4fv(gl.getUniformLocation(prog, 'uMaskBoxes')!, boxes)

  gl.viewport(0, 0, args.width, args.height)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

  // readPixels returns GPU-native orientation, which matches the CPU oracle
  // directly (verified: resting-unmasked parity 99.93% before any flip).
  const px = new Uint8Array(args.width * args.height * 4)
  gl.readPixels(0, 0, args.width, args.height, gl.RGBA, gl.UNSIGNED_BYTE, px)
  return px
}
