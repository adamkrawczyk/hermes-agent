/**
 * Acute-signal contracts: dot-state → field signal table, rail label format
 * (INPUT Nm / ERROR Nm), resting passes through unchanged.
 */
import { describe, expect, it } from 'vitest'

import { acuteMinutes, railLabel, signalForDotState } from './signal'

describe('acute signal derivation', () => {
  it('maps only needs-input and stalled to acute; everything else rests', () => {
    expect(signalForDotState('needs-input')).toBe('needs_me')
    expect(signalForDotState('stalled')).toBe('fault')
    expect(signalForDotState('working')).toBe('resting')
    expect(signalForDotState('unread')).toBe('resting')
    expect(signalForDotState('draft')).toBe('resting')
    expect(signalForDotState('idle')).toBe('resting')
    expect(signalForDotState(undefined)).toBe('resting')
  })

  it('rail label is literal: INPUT Nm / ERROR Nm, null at rest', () => {
    expect(railLabel('resting', 5)).toBeNull()
    expect(railLabel('needs_me', 0)).toBe('INPUT 0m')
    expect(railLabel('needs_me', 4.6)).toBe('INPUT 5m')
    expect(railLabel('fault', 12.2)).toBe('ERROR 12m')
  })

  it('acute minutes measure from the acute clock only, never resting ones', () => {
    const now = 1_000_000
    expect(acuteMinutes('needs-input', now - 120_000, now)).toBe(2)
    expect(acuteMinutes('working', now - 120_000, now)).toBe(0)
    expect(acuteMinutes('needs-input', null, now)).toBe(0)
  })
})
