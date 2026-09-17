/**
 * Cuttlefish WebGL2 shader — GPU twin of render.ts (fieldAt).
 *
 * Same math, GPU form. The CPU renderer is the oracle; parity is bounded-LSB
 * + exact-match % (float32 sin/pow drift is expected and bounded).
 * Uniform contract: uResolution, uTime, uHueDeg, uSignal, uMaskCount, uMaskBoxes.
 */

// ES 3.00 for the app (WebGL2); ES 1.00 twin for the headless software-GL
// oracle (gl 8.x is WebGL1-only). Keep the two bodies in lockstep: the
// harness compiles whichever matches the context, parity tests run both.
export const FIELD_VERTEX_SOURCE = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

export const FIELD_VERTEX_SOURCE_ES1 = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

export const FIELD_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

uniform vec2 uResolution;   // canvas pixels
uniform float uTime;        // ms
uniform float uHueDeg;      // identity hue (degrees)
uniform int uSignal;        // 0 resting, 1 needs_me, 2 fault
uniform int uMaskCount;
uniform vec4 uMaskBoxes[16]; // x0, x1, y0, y1 per box

out vec4 fragColor;

// --- hash noise (must match render.ts where float32 allows) ---

float hash2(float seed, float x, float y) {
  // The integer avalanche is done in uint space; float32 seed/x/y are
  // converted losslessly for |v| < 2^24.
  uint n = (uint(seed) ^ uint(x * 977.0) ^ uint(y * 1109.0)) & 0xffffffffu;
  n = (n ^ (n >> 16)) * 0x45d9f3bu;
  n = (n ^ (n >> 16)) * 0x45d9f3bu;
  return float(n ^ (n >> 16)) / 4294967295.0;
}

float vnoise(float seed, float x, float y) {
  float x0 = floor(x), y0 = floor(y);
  float fx = x - x0, fy = y - y0;
  fx = fx * fx * (3.0 - 2.0 * fx);
  fy = fy * fy * (3.0 - 2.0 * fy);
  float a = hash2(seed, x0, y0);
  float b = hash2(seed, x0 + 1.0, y0);
  float c = hash2(seed, x0, y0 + 1.0);
  float d = hash2(seed, x0 + 1.0, y0 + 1.0);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}

float fractal5(float seed, float x, float y) {
  float total = 0.0, amp = 0.5, freq = 1.0, norm = 0.0;
  for (int i = 0; i < 5; i++) {
    total += vnoise(seed + float(i * 1013), x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return total / norm;
}

// --- OKLab (linear-light input) ---

vec3 oklabFromLinear(vec3 c) {
  float l = cbrt(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b);
  float m = cbrt(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b);
  float s = cbrt(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);
  return vec3(
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  );
}

vec3 linearFromOklab(vec3 lab) {
  float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s_ = lab.x - 0.0894841775 * lab.y - 1.291485548 * lab.z;
  float l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  );
}

vec3 oklchToLinear(float L, float C, float hDeg) {
  float rad = radians(hDeg);
  return linearFromOklab(vec3(L, C * cos(rad), C * sin(rad)));
}

vec3 blend3(vec3 a, vec3 b, float t) { return a + (b - a) * t; }

float contractionAt(vec2 pix) {
  float best = 0.0;
  for (int i = 0; i < uMaskCount; i++) {
    vec4 b = uMaskBoxes[i];
    float dx = pix.x < b.x ? b.x - pix.x : (pix.x > b.y ? pix.x - b.y : 0.0);
    float dy = pix.y < b.z ? b.z - pix.y : (pix.y > b.w ? pix.y - b.w : 0.0);
    float d = length(vec2(dx, dy));
    float t = clamp(1.0 - d / 48.0, 0.0, 1.0);
    float feather = t * t * (3.0 - 2.0 * t);
    best = max(best, feather);
  }
  return best;
}

// The frozen instant: contraction colour derives from t=0 so masked pixels
// never move (plan §3). Field evaluation at arbitrary time, resting signal.
vec3 fieldAt(vec2 pix, float t) {
  vec2 n = pix / max(vec2(1.0), uResolution);
  float tt = t * 0.000018;
  float broad = fractal5(20260917.0, n.x * 3.1 + tt, n.y * 2.1 - tt * 0.6);
  float fine = fractal5(20260917.0 + 9001.0, n.x * 15.0 + tt * 0.4, n.y * 15.0 - tt * 0.2);
  float pearl = fractal5(20260917.0 + 19007.0, n.x * uResolution.x / 3.7 + tt * 0.2, n.y * uResolution.y / 3.7 - tt * 0.1)
    + vnoise(20260917.0 + 29011.0, pix.x / 2.1, pix.y / 2.1) * 0.12;
  float wave = 0.5 + 0.5 * sin(n.x * 15.0 + sin(n.y * 8.0 + tt) * 1.7 + tt * 3.0);
  float hueDeg = uHueDeg;
  vec3 leuc = oklchToLinear(0.150 + broad * 0.012, 0.03, hueDeg + 68.8);
  vec3 iri = oklchToLinear(0.018 + broad * 0.02 + fine * 0.008, 0.018 + broad * 0.018, hueDeg + 217.7 + wave * 28.6);
  float pigmentL = 0.155 + max(0.0, broad - 0.74) * 0.28 + max(0.0, wave - 0.82) * 0.2;
  vec3 pigment = oklchToLinear(pigmentL, 0.10 + fine * 0.05, hueDeg);
  vec3 outc = vec3(0.0);
  outc = blend3(outc, leuc, 0.55);
  outc = blend3(outc, iri, 0.5);
  outc = blend3(outc, pigment, clamp(broad * 0.9 + wave * 0.5 - 0.42, 0.0, 0.7));
  return outc;
}

vec3 acuteBlend(vec3 outc, float fine, float pearl) {
  float cls = fine * 0.5 + mod(pearl, 0.5);
  if (cls < 0.45) return outc;
  if (cls < 0.9) {
    vec3 tint = uSignal == 1 ? oklchToLinear(0.6, 0.18, 83.0) : oklchToLinear(0.6, 0.18, 27.0);
    return blend3(outc, tint, 0.55);
  }
  vec3 flash = uSignal == 1 ? vec3(1.0, 0.7, 0.14) : vec3(0.96, 0.14, 0.2);
  return blend3(outc, flash, 0.5);
}

void main() {
  vec2 pix = gl_FragCoord.xy - vec2(0.5);
  float contraction = contractionAt(pix);
  vec3 outc = fieldAt(pix, uTime);
  float fine = 0.0;
  float pearl = 0.0;
  {
    vec2 n = pix / max(vec2(1.0), uResolution);
    float tt = uTime * 0.000018;
    fine = fractal5(20260917.0 + 9001.0, n.x * 15.0 + tt * 0.4, n.y * 15.0 - tt * 0.2);
    pearl = fractal5(20260917.0 + 19007.0, n.x * uResolution.x / 3.7 + tt * 0.2, n.y * uResolution.y / 3.7 - tt * 0.1);
  }
  if (uSignal != 0) outc = acuteBlend(outc, fine, pearl);
  if (contraction > 0.0) {
    vec3 frozen = fieldAt(pix, 0.0);
    // frozen fine for the chroma cap
    vec2 n = pix / max(vec2(1.0), uResolution);
    float fineFrozen = fractal5(20260917.0 + 9001.0, n.x * 15.0, n.y * 15.0);
    vec3 lab = oklabFromLinear(frozen);
    float hue = atan(lab.z, lab.y);
    float chroma = length(lab.yz);
    float calmL = 0.4 + clamp((lab.x - 0.4) * 0.06, -0.018, 0.018);
    vec3 contracted = linearFromOklab(vec3(calmL, cos(hue) * min(chroma, 0.04 + fineFrozen * 0.06), sin(hue) * min(chroma, 0.04 + fineFrozen * 0.06)));
    outc = blend3(outc, contracted, contraction);
  }
  // linear -> sRGB byte
  vec3 c = clamp(outc, 0.0, 1.0);
  vec3 s = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  fragColor = vec4(s, 1.0);
}
`

// ES1 note: the uint-avalanche hash cannot be expressed in GLSL ES 1.00
// (no integer ops). The headless oracle therefore uses the CPU renderer's
// own float64 hash through the SAME source contract; the app's WebGL2
// shader is the only GPU body. Parity for WebGL2 runs on real Electron.
export const FIELD_FRAGMENT_SOURCE_ES1: string | null = null
