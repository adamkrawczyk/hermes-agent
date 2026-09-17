import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'

const bundle = await build({
  stdin: { contents: `export {renderShaderFrame} from './src/field/shaderHarness'; export {renderFieldToRGBA} from './src/field/render'; export {allocate} from './src/field/identity'`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'iife', globalName: 'field', platform: 'browser',
})
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  await page.setContent('<!doctype html><html><body></body></html>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const results = await page.evaluate(async () => {
    const results = []
    for (const signal of ['resting', 'needs_me', 'fault']) {
      for (const mask of [[], [{ x0: 90, x1: 90, y0: 60, y1: 60 }], [{ x0: 90, x1: 90, y0: 60, y1: 60 }, { x0: 20, x1: 50, y0: 6, y1: 26 }]]) {
        const args = { identity: field.allocate('shader-parity'), width: 96, height: 64, timeMs: 1000000, signal, mask }
        const cpu = field.renderFieldToRGBA(args)
        const gpu = await field.renderShaderFrame(args)
        if (!gpu) throw new Error('WebGL2 unavailable: parity NOT executed')
        let maxLsb = 0, exact = 0
        const hot = []
        for (let i = 0; i < cpu.length; i++) {
          const d = Math.abs(cpu[i] - gpu[i])
          maxLsb = Math.max(maxLsb, d)
          if (d === 0) exact++
          if (d > 8 && hot.length < 12) {
            const px = i >> 2
            hot.push({ x: px % 96, y: (px / 96) | 0, ch: i & 3, cpu: cpu[i], gpu: gpu[i], d })
          }
        }
        results.push({ signal, masked: mask.length > 0, maxLsb, exactFraction: exact / cpu.length, hot })
      }
    }
    return results
  })
  console.log(JSON.stringify({ backend: 'Chromium WebGL2 / SwiftShader (not hardware performance)', results }, null, 2))
  for (const result of results) {
    assert.ok(result.maxLsb <= 4, `max LSB: ${JSON.stringify(result)}`)
    assert.ok(result.exactFraction > 0.9, `exact fraction: ${JSON.stringify(result)}`)
  }
} finally {
  await browser.close()
}
