import { build } from 'esbuild'
import { chromium } from '@playwright/test'

// P0.5 kill-gate: renders the field shader on SwiftShader WebGL2 and measures
// wall-clock frame times across the density ladder. SOFTWARE GL numbers — the
// honest ceiling for "worst possible GPU"; real-hardware runs follow on the
// first Electron e2e pass. Fails on: p95 > 16.7ms (60fps budget) at D1, or
// any frame > 100ms.
const bundle = await build({
  stdin: { contents: `export {renderShaderFrame} from './src/field/shaderHarness'; export {allocate} from './src/field/identity'`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'iife', globalName: 'field', platform: 'browser',
})
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage()
  await page.setContent('<!doctype html><html><body></body></html>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const report = await page.evaluate(async () => {
    const identity = field.allocate('kill-gate')
    const rungs = [
      { name: 'D0-static', width: 960, height: 540, frames: 30, signal: 'resting' },
      { name: 'D1-60fps', width: 1920, height: 1080, frames: 60, signal: 'resting' },
      { name: 'D1-acute', width: 1920, height: 1080, frames: 60, signal: 'needs_me' },
      { name: 'D2-dpr2', width: 2560, height: 1440, frames: 60, signal: 'resting' },
    ]
    const out = []
    for (const rung of rungs) {
      // warm-up compile
      await field.renderShaderFrame({ identity, width: rung.width, height: rung.height, timeMs: 0, signal: rung.signal, mask: [] })
      const times = []
      for (let i = 0; i < rung.frames; i++) {
        const t0 = performance.now()
        await field.renderShaderFrame({ identity, width: rung.width, height: rung.height, timeMs: i * 16.7, signal: rung.signal, mask: [] })
        times.push(performance.now() - t0)
      }
      times.sort((a, b) => a - b)
      const pick = q => times[Math.min(times.length - 1, Math.floor(times.length * q))]
      out.push({
        rung: rung.name,
        res: `${rung.width}x${rung.height}`,
        frames: rung.frames,
        p50ms: +pick(0.5).toFixed(1),
        p95ms: +pick(0.95).toFixed(1),
        maxMs: +times[times.length - 1].toFixed(1),
      })
    }
    return out
  })
  console.log(JSON.stringify({ backend: 'SwiftShader (software GL — ceiling, not hardware)', report }, null, 2))
  const d1 = report.find(r => r.rung === 'D1-60fps')
  if (!d1) throw new Error('D1 rung missing')
  if (d1.p95ms > 16.7) throw new Error(`KILL: D1 p95 ${d1.p95ms}ms > 16.7ms budget`)
  for (const r of report) if (r.maxMs > 100) throw new Error(`KILL: ${r.rung} max ${r.maxMs}ms > 100ms`)
  console.log('KILL-GATE: PASS (software-GL ceiling)')
} finally {
  await browser.close()
}
