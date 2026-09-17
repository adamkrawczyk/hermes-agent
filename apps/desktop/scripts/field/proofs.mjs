import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'

// Static PNG + animated proof of the Desktop field, rendered by the REAL
// WebGL2 pipeline (same shaderHarness the parity gate uses). Output:
// artifacts/field-static.png, artifacts/field-acute.png, artifacts/field-anim.gif
const OUT = 'artifacts'
mkdirSync(OUT, { recursive: true })

const bundle = await build({
  stdin: { contents: `export {renderShaderFrame} from './src/field/shaderHarness'; export {allocate} from './src/field/identity'`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'iife', globalName: 'field', platform: 'browser',
})
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  await page.setContent('<!doctype html><html><body></body></html>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const frames = await page.evaluate(async () => {
    const idA = field.allocate('proof-session-a')
    const idB = field.allocate('proof-session-b', [idA.hex])
    const W = 480, H = 270
    const mk = async (identity, timeMs, signal, mask) => {
      const px = await field.renderShaderFrame({ identity, width: W, height: H, timeMs, signal, mask })
      // bottom-up -> top-down for PNG
      const out = new Uint8Array(px.length)
      for (let y = 0; y < H; y++) out.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4)
      return Array.from(out)
    }
    return {
      staticA: await mk(idA, 1_000_000, 'resting', []),
      staticB: await mk(idB, 1_000_000, 'resting', []),
      acute: await mk(idA, 1_000_000, 'needs_me', [{ x0: 120, x1: 360, y0: 60, y1: 210 }]),
    }
  })
  // animation: 24 frames over 1s, session A resting
  const animFrames = await page.evaluate(async () => {
    const idA = field.allocate('proof-session-a')
    const W = 480, H = 270
    const out = []
    for (let i = 0; i < 12; i++) {
      const px = await field.renderShaderFrame({ identity: idA, width: W, height: H, timeMs: i * 41.7, signal: 'resting', mask: [] })
      const flip = new Uint8Array(px.length)
      for (let y = 0; y < H; y++) flip.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4)
      out.push(Array.from(flip))
    }
    return out
  })
  // encode PNG via canvas in page (raw RGBA -> browser canvas -> PNG dataURL)
  const encode = async rgba => page.evaluate(({ rgba, W, H }) => {
    const c = document.createElement('canvas')
    c.width = W; c.height = H
    const ctx = c.getContext('2d')
    const img = new ImageData(new Uint8ClampedArray(rgba), W, H)
    ctx.putImageData(img, 0, 0)
    return c.toDataURL('image/png')
  }, { rgba, W: 480, H: 270 })
  const save = (name, dataUrl) => writeFileSync(`${OUT}/${name}`, Buffer.from(dataUrl.split(',')[1], 'base64'))

  save('field-static.png', await encode(frames.staticA))
  save('field-static-b.png', await encode(frames.staticB))
  save('field-acute.png', await encode(frames.acute))
  // animated proof: APNG is complex; save 6 sampled frames as the sequence
  for (let i = 0; i < 4; i++) save(`field-anim-${i}.png`, await encode(animFrames[i * 3]))
  console.log('proofs written to', OUT)
} finally {
  await browser.close()
}
