/**
 * Acute-state derivation: session dot state → field signal + literal rail
 * label (plan §3: INPUT Nm / ERROR Nm). One table, no ladders.
 */
import type { SessionDotState } from '@/store/session-dot-state'

export type FieldSignal = 'resting' | 'needs_me' | 'fault'

/** Weakest-to-strongest acute semantics; only these dot states escalate. */
const SIGNAL_BY_DOT: Partial<Record<SessionDotState, FieldSignal>> = {
  'needs-input': 'needs_me',
  stalled: 'fault',
}

export function signalForDotState(state: SessionDotState | undefined): FieldSignal {
  return (state && SIGNAL_BY_DOT[state]) || 'resting'
}

/** Minutes elapsed since the acute state began; 0 when the clock is absent. */
export function acuteMinutes(state: SessionDotState | undefined, sinceMs: number | null | undefined, now = Date.now()): number {
  if (!state || SIGNAL_BY_DOT[state] === undefined || !sinceMs) return 0
  return (now - sinceMs) / 60_000
}

export function railLabel(signal: FieldSignal, minutes: number): string | null {
  if (signal === 'resting') return null
  const word = signal === 'needs_me' ? 'INPUT' : 'ERROR'
  const m = Math.max(0, Math.round(minutes))
  return `${word} ${m}m`
}
