/**
 * Cuttlefish field mount — canvas behind the transcript (plan §6: beside
 * <Backdrop/>, keyed by the existing session identity, glass-scoped
 * transparency, never the global token).
 *
 * Discipline:
 * - Off means ZERO: no canvas element, no GL context, no RAF (test-probed).
 * - Calm and prefers-reduced-motion paint ONE static frame per state.
 * - Unfocused window suspends the animation timer (visible windows keep
 *   animating; DESIGN.md Motion).
 * - Context loss falls back to nothing (static field is a later rung).
 */
import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'

import type { IdentityColor } from '@/field/identity'
import { allocate } from '@/field/identity'
import { measureTranscriptMask } from '@/field/mask'
import { FIELD_FRAGMENT_SOURCE, FIELD_VERTEX_SOURCE } from '@/field/shader'
import { $cuttlefish } from '@/store/cuttlefish'

export interface CuttlefishFieldProps {
  sessionId: string
  /** Live peer hexes for farthest-point allocation. */
  livePeers?: readonly string[]
  /** Acute signal for THIS session's surface. */
  signal?: 'resting' | 'needs_me' | 'fault'
  /** Transcript element whose content box becomes the glyph mask. */
  transcriptEl?: HTMLElement | null
}

export function CuttlefishField({ sessionId, livePeers = [], signal = 'resting', transcriptEl = null }: CuttlefishFieldProps) {
  const state = useStore($cuttlefish)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Allocation is deterministic per (session, live) — memo outside render
  // churn; identity is stable while peers are stable.
  const identityRef = useRef<IdentityColor | null>(null)
  const peersKey = livePeers.join(',')
  if (identityRef.current === null || identityRef.current.sessionId !== sessionId) {
    identityRef.current = allocate(sessionId, livePeers)
  }

  useEffect(() => {
    if (state.mode === 'off') return

    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true })
    if (!gl) return // GL failure: render nothing rather than fake pixels

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const animated = state.mode === 'alive' && !reduceMotion

    let raf = 0
    let lastT = -1

    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'compile failed')
      return sh
    }

    let prog: WebGLProgram
    try {
      prog = gl.createProgram()!
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, FIELD_VERTEX_SOURCE))
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FIELD_FRAGMENT_SOURCE))
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return
    } catch {
      return
    }
    gl.useProgram(prog)

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'aPos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    const u = (name: string) => gl.getUniformLocation(prog, name)!

    const identity = identityRef.current!
    // The transcript scroller is the glyph mask target; it lives in this
    // surface's DOM (aui_thread-viewport). Queried per effect, measured per
    // frame — no ref plumbing through third-party Thread internals.
    const findTranscript = (): HTMLElement | null =>
      transcriptEl ?? (canvas.closest('[data-chat-surface]')?.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]') ?? null)
    const draw = (t: number) => {
      const dpr = state.density >= 2 ? window.devicePixelRatio : 1
      const w = Math.floor(canvas.clientWidth * dpr)
      const h = Math.floor(canvas.clientHeight * dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      gl.viewport(0, 0, w, h)
      gl.uniform2f(u('uResolution'), w, h)
      gl.uniform1f(u('uTime'), animated ? t : 1_000_000)
      gl.uniform1f(u('uHueDeg'), identity.oklch.h)
      gl.uniform1i(u('uSignal'), signal === 'resting' ? 0 : signal === 'needs_me' ? 1 : 2)
      // Glyph mask: measured per frame so streaming/resize keeps it true; the
      // contraction is frozen-instant, so re-measure never causes shimmer.
      const box = measureTranscriptMask(canvas, findTranscript())
      gl.uniform1i(u('uMaskCount'), box ? 1 : 0)
      const boxes = new Float32Array(16 * 4)
      if (box) {
        // gl_FragCoord is bottom-up; the measured box is top-down CSS space.
        boxes[0] = box.x0
        boxes[1] = box.x1
        boxes[2] = h - box.y1
        boxes[3] = h - box.y0
      }
      gl.uniform4fv(u('uMaskBoxes'), boxes)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    if (!animated) {
      draw(1_000_000) // one static frame per state
      return
    }

    const tick = (t: number) => {
      if (document.hasFocus() && t !== lastT) {
        lastT = t
        draw(t)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      const lose = gl.getExtension('WEBGL_lose_context')
      lose?.loseContext()
    }
  }, [state.mode, state.density, signal, peersKey, sessionId, transcriptEl])

  if (state.mode === 'off') return null

  return (
    <canvas
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-1"
      data-cuttlefish-field=""
      ref={canvasRef}
    />
  )
}
