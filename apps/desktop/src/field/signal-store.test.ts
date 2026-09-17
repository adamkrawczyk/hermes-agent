/**
 * Runtime-keyed signal derivation contracts: attention outranks stalled;
 * sessions absent from both sets are omitted (resting is the default).
 *
 * $attentionSessionIds is computed from ($sessionStates, $sessions) via
 * storedId resolution, so the test drives $sessions + needsInput state the
 * way production does — not by poking the computed directly.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { $sessionStates, $stalledSessionIds } from '@/store/session-states'
import { setSessions } from '@/store/session'

import { $fieldSignalByRuntimeId } from './signal-store'

afterEach(() => {
  $sessionStates.set({})
  $stalledSessionIds.set([])
  setSessions([])
})

describe('$fieldSignalByRuntimeId', () => {
  it('maps stalled → fault, attention → needs_me, attention wins, rest omitted', () => {
    setSessions([
      { id: 's-stalled', title: 'a', profile: 'default' } as never,
      { id: 's-attention', title: 'b', profile: 'default' } as never,
      { id: 'both', title: 'c', profile: 'default' } as never,
      { id: 'r-other', title: 'd', profile: 'default' } as never,
    ])
    $stalledSessionIds.set(['s-stalled', 'both'])
    $sessionStates.set({
      'rt-stall': { storedSessionId: 's-stalled' } as never,
      // needsInput on the same stored id as a stall: attention must win.
      'rt-both': { storedSessionId: 'both', needsInput: true } as never,
      'rt-attention': { storedSessionId: 's-attention', needsInput: true } as never,
      'rt-rest': { storedSessionId: 'r-other' } as never,
    })

    const byId = $fieldSignalByRuntimeId.get()
    expect(byId['rt-stall']).toBe('fault')
    expect(byId['rt-attention']).toBe('needs_me')
    expect(byId['rt-both']).toBe('needs_me') // attention outranks stalled
    expect(byId['rt-rest']).toBeUndefined()
  })

  it('sessions without a stored id never escalate', () => {
    $stalledSessionIds.set(['s-stalled'])
    $sessionStates.set({ 'rt-nostored': {} as never })
    expect($fieldSignalByRuntimeId.get()['rt-nostored']).toBeUndefined()
  })
})
