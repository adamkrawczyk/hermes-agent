import { map } from 'nanostores'

import { readKey, writeKey } from '@/lib/storage'

/**
 * Cuttlefish living field — one store, tri-state + density (plan §6: same
 * shape family as $backdrop). Alive = animated field; Calm = one static
 * frame per state; Off = zero canvases/contexts/RAF/timers (probed, not
 * assumed). Density is the D-ladder rung (0 static / 1 full / 2 DPR-aware).
 */
export type CuttlefishMode = 'alive' | 'calm' | 'off'

const MODE_KEY = 'hermes.desktop.cuttlefish.mode.v1'
const DENSITY_KEY = 'hermes.desktop.cuttlefish.density.v1'

export interface CuttlefishState {
  mode: CuttlefishMode
  density: 0 | 1 | 2
}

function readMode(): CuttlefishMode {
  // Pilot-key migration: the first shipped build persisted a boolean.
  if (readKey('hermes.desktop.cuttlefish.on.v1') === 'true') return 'alive'
  const v = readKey(MODE_KEY)
  return v === 'alive' || v === 'calm' || v === 'off' ? v : 'calm'
}

function readDensity(): 0 | 1 | 2 {
  const v = readKey(DENSITY_KEY)
  return v === '0' || v === '1' || v === '2' ? (Number(v) as 0 | 1 | 2) : 1
}

export const $cuttlefish = map<CuttlefishState>({ mode: readMode(), density: readDensity() })

$cuttlefish.subscribe(state => {
  writeKey(MODE_KEY, state.mode)
  writeKey(DENSITY_KEY, String(state.density))
})

export function setCuttlefishMode(mode: CuttlefishMode) {
  $cuttlefish.setKey('mode', mode)
}

export function setCuttlefishDensity(density: 0 | 1 | 2) {
  $cuttlefish.setKey('density', density)
}

/** Derived: does the field render at all? */
export const cuttlefishActive = (state: CuttlefishState): boolean => state.mode !== 'off'
