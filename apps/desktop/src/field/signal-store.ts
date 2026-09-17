/**
 * Runtime-id-keyed acute signal for the field surface. The dot-state store
 * keys by stored id; a chat surface holds the runtime id, so this subscribes
 * to the same predicates ($attention/$stalled sets + $sessionStates) and
 * resolves through the state's own storedSessionId — one derivation, no
 * duplicate policy.
 */
import { computed } from 'nanostores'

import { $attentionSessionIds, $sessionStates, $stalledSessionIds } from '@/store/session-states'

import type { FieldSignal } from './signal'

export const $fieldSignalByRuntimeId = computed(
  [$attentionSessionIds, $stalledSessionIds, $sessionStates],
  (attention, stalled, states) => {
    const out: Record<string, FieldSignal> = {}
    for (const [runtimeId, state] of Object.entries(states)) {
      const stored = state.storedSessionId
      let signal: FieldSignal = 'resting'
      if (stored && stalled.includes(stored)) signal = 'fault'
      if (stored && attention.includes(stored)) signal = 'needs_me'
      if (signal !== 'resting') out[runtimeId] = signal
    }
    return out
  },
)
