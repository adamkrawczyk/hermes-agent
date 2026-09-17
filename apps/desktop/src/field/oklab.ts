/**
 * OKLab / OKLCh colour math — TypeScript port of cuttlefish-theme color/oklab.py
 * (exact Ottosson matrices; pinned by identity fixtures + oklab.test.ts).
 *
 * Shared by the cuttlefish field renderer and identity allocator. Ported, not
 * imported from apps/shared, because the field needs the full OKLab pipeline
 * (gamut mapping, polar form, ΔE OK) while apps/shared stays a hex/WCAG
 * utility; two colour sciences in one file would blur the seam.
 */

export interface OKLCh {
  L: number
  C: number
  /** hue in degrees 0..360 */
  h: number
}

// --- sRGB transfer ---------------------------------------------------------

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

// --- OKLab core ------------------------------------------------------------

/** sRGB (0..1, gamma-encoded) → OKLab. Sign-safe cube root (tiny negatives from float error). */
export function srgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb

  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)

  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ]
}

export function oklabToSrgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b

  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_

  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s

  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)]
}

// --- Polar form ------------------------------------------------------------

export function oklabToOklch(L: number, a: number, b: number): OKLCh {
  return { L, C: Math.hypot(a, b), h: (Math.atan2(b, a) * 180) / Math.PI % 360 }
}

export function oklchToOklab(c: OKLCh): [number, number, number] {
  const rad = (c.h * Math.PI) / 180
  return [c.L, c.C * Math.cos(rad), c.C * Math.sin(rad)]
}

// --- Hex helpers -----------------------------------------------------------

export function hexToRgb(value: string): [number, number, number] {
  const s = value.trim().replace(/^#/, '')
  if (!/^[0-9a-f]{6}$/i.test(s)) throw new Error(`expected #rrggbb, got ${value}`)
  const n = parseInt(s, 16)
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255]
}

export function rgbToHex(r: number, g: number, b: number): string {
  // Python parity: int(clamp(v) * 255.0 + 0.5) — truncation after +0.5, not
  // Math.round (which ties differently on the 0.5/255 boundary).
  const ch = (v: number) => Math.max(0, Math.min(255, Math.trunc(Math.max(0, Math.min(1, v)) * 255 + 0.5)))
  return '#' + [r, g, b].map(v => ch(v).toString(16).padStart(2, '0').toUpperCase()).join('')
}

export function oklchToHex(c: OKLCh): string {
  const [r, g, b] = oklabToSrgb(...oklchToOklab(gamutMap(c)))
  return rgbToHex(r, g, b)
}

export function hexToOklch(value: string): OKLCh {
  return oklabToOklch(...srgbToOklab(...hexToRgb(value)))
}

// --- Gamut -----------------------------------------------------------------

const GAMUT_EPS = 1e-4

export function inSrgbGamut(c: OKLCh): boolean {
  const [r, g, b] = oklabToSrgb(...oklchToOklab(c))
  return [r, g, b].every(v => -GAMUT_EPS <= v && v <= 1 + GAMUT_EPS)
}

/** Bring c into sRGB by reducing chroma, holding L and h fixed (hue promise).
 *
 * Inputs are rounded to 3 decimals FIRST: the Python original caches on
 * round(L,C,h, 3) and that quantisation is part of the pinned contract —
 * fixtures and peer distances reproduce only through the same rounding.
 */
export function gamutMap(c: OKLCh, iterations = 24): OKLCh {
  const r = { L: round3(c.L), C: round3(c.C), h: round3(c.h) }
  if (inSrgbGamut(r)) return r
  const L = Math.max(0, Math.min(1, r.L))
  if (!inSrgbGamut({ L, C: 0, h: r.h })) {
    return { L: L < 0.5 ? 0 : 1, C: 0, h: r.h }
  }
  let lo = 0
  let hi = r.C
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2
    if (inSrgbGamut({ L, C: mid, h: r.h })) lo = mid
    else hi = mid
  }
  return { L, C: lo, h: r.h }
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000

// --- Distance --------------------------------------------------------------

export function deltaEOk(a: OKLCh, b: OKLCh): number {
  const [l1, a1, b1] = oklchToOklab(a)
  const [l2, a2, b2] = oklchToOklab(b)
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2)
}
