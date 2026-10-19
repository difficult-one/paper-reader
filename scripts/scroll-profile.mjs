import { mkdir, writeFile } from 'node:fs/promises'
import { cpus, totalmem, platform, release } from 'node:os'
import { resolve } from 'node:path'
import { performanceFailures, percentile, summarizeFrames } from '../src/shared/reader-performance.ts'

// Runs inside the renderer. Keep this self-contained so evaluate does not capture Node state.
function beginSampling() {
  const data = { started: performance.now(), timeOrigin: performance.timeOrigin, frames: [], frameGaps: [], longTasks: [], inputLatency: [], memory: [], pages: [], wheelEvents: 0, boundaryInputs: 0, drawnFrames: 0, maxDrawnPerFrame: 0 }
  performance.mark('reader-profile-start')
  const drawn = new Set(); const originals = []; const visible = new Map()
  let active = true; let last; const pendingInput = new Map(); let lastMemory = 0
  const resources = () => ({ time: performance.now(), visibility: document.visibilityState, focused: document.hasFocus(), fonts: document.fonts.size, heap: performance.memory?.usedJSHeapSize ?? null, ...window.__pdfPerformance })
  const tick = now => {
    if (!active) return
    if (last !== undefined) {
      data.frames.push(now - last)
      if (now - last > 50) {
        data.frameGaps.push({ start: last, end: now, duration: now - last })
        performance.mark('reader-profile-gap', { detail: data.frameGaps.at(-1) })
      }
    }
    last = now
    if (drawn.size) data.drawnFrames++
    data.maxDrawnPerFrame = Math.max(data.maxDrawnPerFrame, drawn.size); drawn.clear()
    if (now - lastMemory >= 1000) { data.memory.push(resources()); lastMemory = now }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  for (const realm of [window, ...[...document.querySelectorAll('iframe')].map(frame => frame.contentWindow)]) {
    const prototype = realm.CanvasRenderingContext2D.prototype
    for (const name of ['fillText', 'strokeText', 'drawImage', 'fill', 'stroke']) {
      const original = prototype[name]; originals.push({ prototype, name, original })
      prototype[name] = function (...args) {
        if (this.canvas.dataset.pdfRaster || this.canvas.closest('.canvas-holder')) drawn.add(this.canvas)
        return original.apply(this, args)
      }
    }
  }
  const wheel = event => {
    data.wheelEvents++
    const root = event.target.closest?.('.pdf-scroll')
    if (root && ((event.deltaY < 0 && root.scrollTop <= 0) || (event.deltaY > 0 && root.scrollTop >= root.scrollHeight - root.clientHeight - 1))) {
      data.boundaryInputs++; return
    }
    if (root && !pendingInput.has(root)) pendingInput.set(root, event.timeStamp)
  }
  const scroll = event => {
    const root = event.target
    if (!pendingInput.has(root)) return
    const input = pendingInput.get(root); pendingInput.delete(root)
    requestAnimationFrame(() => { if (active) data.inputLatency.push(performance.now() - input) })
  }
  window.addEventListener('wheel', wheel, { passive: true }); window.addEventListener('scroll', scroll, { passive: true, capture: true })
  const tasks = new PerformanceObserver(list => data.longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration }))))
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) tasks.observe({ type: 'longtask' })
  const observers = []
  for (const root of document.querySelectorAll('.pdf-scroll')) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const sample = { side: root.closest('[data-side]').dataset.side, page: Number(entry.target.dataset.page), entered: performance.now(), preview: null, clear: null, left: null, cached: Boolean(entry.target.querySelector('.canvas-holder canvas')) }
          data.pages.push(sample); visible.set(entry.target, sample)
        } else {
          const sample = visible.get(entry.target)
          if (sample) sample.left = performance.now()
          visible.delete(entry.target)
        }
      }
      updatePages()
    }, { root })
    root.querySelectorAll('.page-slot').forEach(slot => observer.observe(slot)); observers.push(observer)
  }
  const updatePages = () => {
    for (const [slot, sample] of visible) {
      const canvas = slot.querySelector('.canvas-holder canvas')
      if (!canvas) continue
      const latency = performance.now() - sample.entered
      if (sample.preview === null) sample.preview = latency
      if (canvas.dataset.quality !== 'preview' && sample.clear === null) sample.clear = latency
    }
  }
  const mutations = new MutationObserver(updatePages); mutations.observe(document.querySelector('.reading-workspace'), { childList: true, subtree: true })
  // Include already-painted pages, whose initial IO callback comes after setup.
  const paintTimer = setInterval(updatePages, 50)
  window.stopScrollProfile = () => new Promise(resolve => requestAnimationFrame(() => {
    data.longTasks.push(...tasks.takeRecords().map(entry => ({ start: entry.startTime, duration: entry.duration })))
    updatePages()
    active = false; data.ended = performance.now(); data.memory.push(resources())
    tasks.disconnect(); mutations.disconnect(); observers.forEach(observer => observer.disconnect()); clearInterval(paintTimer)
    window.removeEventListener('wheel', wheel); window.removeEventListener('scroll', scroll, true)
    for (const { prototype, name, original } of originals) prototype[name] = original
    resolve(data)
  }))
}

export async function runScrollProfile(app, page, options = {}) {
  const { durationMs = 60_000, rounds = 3, soakMs = 0, refreshHz = 60, label = 'performance-after', baseline = false, trace = false, coldOnly = false, requestedDpr } = options
  const directory = resolve('output/playwright', label); await mkdir(directory, { recursive: true })
  const environment = await app.evaluate(async ({ app, screen }) => ({ version: app.getVersion(), packaged: app.isPackaged,
    electron: process.versions.electron, chrome: process.versions.chrome, argv: process.argv,
    displays: screen.getAllDisplays().map(display => ({ bounds: display.bounds, scaleFactor: display.scaleFactor, frequency: display.displayFrequency })), gpuFeatures: app.getGPUFeatureStatus(), gpu: await app.getGPUInfo('basic') }))
  const renderer = await page.evaluate(() => ({ dpr: devicePixelRatio, width: innerWidth, height: innerHeight, userAgent: navigator.userAgent }))
  await writeFile(resolve(directory, 'environment.json'), JSON.stringify({ ...environment, renderer, backgroundThrottlingDisabled: true, cpu: cpus()[0]?.model, threads: cpus().length, memory: totalmem(), os: platform(), release: release(), options }, null, 2))
  const failures = []; const reports = []
  const leftInput = page.locator('[data-side="left"] .pane-controls input')
  for (let round = 0; round < rounds + (soakMs > 0 ? 1 : 0); round++) {
    const soaking = round === rounds; const duration = soaking ? soakMs : durationMs
    // Cold jump is recorded separately so setup and settlement cannot dilute scrolling frames.
    const count = await page.locator('[data-side="left"] .page-slot').count()
    const startPage = Math.min(count - 2, Math.max(5, Math.floor(count / 4)) + round * Math.max(1, Math.floor(count / 4)))
    await page.evaluate(beginSampling)
    await leftInput.fill(String(Math.max(1, startPage))); await leftInput.press('Enter')
    await page.locator(`[data-side="left"] [data-page="${Math.max(1, startPage)}"] canvas[data-quality="clear"]`).waitFor({ timeout: 30000 })
    // The target page may finish before the linked pane. Keep observing every
    // visible page so unfinished clear renders are not silently censored.
    await page.waitForFunction(() => [...document.querySelectorAll('.pdf-scroll')].every(root => {
      const bounds = root.getBoundingClientRect()
      return [...root.querySelectorAll('.page-slot')].filter(slot => { const box = slot.getBoundingClientRect(); return box.bottom > bounds.top && box.top < bounds.bottom })
        .every(slot => slot.querySelector('.canvas-holder canvas')?.dataset.quality === 'clear')
    }), undefined, { timeout: 30000 })
    const coldRaw = await page.evaluate(() => window.stopScrollProfile())
    await writeFile(resolve(directory, `${soaking ? 'soak' : `round-${round + 1}`}.cold.raw.json`), JSON.stringify(coldRaw))
    const coldRasterTrace = await page.evaluate(() => window.__pdfRasterTimings ?? null)
    if (coldRasterTrace) await writeFile(resolve(directory, `${soaking ? 'soak' : `round-${round + 1}`}.cold.raster.json`), JSON.stringify(coldRasterTrace))
    if (coldOnly) {
      const samples = coldRaw.pages.filter(sample => !sample.cached && sample.left === null)
      const previewP95Ms = percentile(samples.flatMap(sample => sample.preview === null ? [] : [sample.preview]), .95)
      const clearP95Ms = percentile(samples.flatMap(sample => sample.clear === null ? [] : [sample.clear]), .95)
      const errors = []
      const actualDpr = await page.evaluate(() => devicePixelRatio)
      if (requestedDpr !== undefined && Math.abs(actualDpr - requestedDpr) >= 1e-6) errors.push('实际 DPR 与请求值不符')
      if (!samples.length || samples.some(sample => sample.preview === null || sample.clear === null)) errors.push('缺少完整真实冷页样本')
      if (previewP95Ms > 150) errors.push('冷页预览 P95 >150 ms')
      if (clearP95Ms > 500) errors.push('冷页清晰层 P95 >500 ms')
      const report = { phase: 'cold-only', startPage, actualDpr, coldPages: samples.length, previewP95Ms, clearP95Ms, failures: errors }
      reports.push(report); failures.push(...errors); console.log(JSON.stringify(report))
      continue
    }
    await leftInput.fill('1'); await leftInput.press('Enter')
    await page.locator('[data-side="left"] [data-page="1"] canvas[data-quality="clear"]').waitFor({ timeout: 30000 })
    const cdp = await page.context().newCDPSession(page)
    if (trace && !soaking) {
      await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline', transferMode: 'ReturnAsStream' })
      await cdp.send('Profiler.enable'); await cdp.send('Profiler.start')
    }
    await page.evaluate(beginSampling)
    const started = Date.now(); const processMemory = []; const endpoints = []
    let i = 0; let direction = 1; let nextMemory = 0
    while (Date.now() - started < duration) {
      const side = Math.floor((Date.now() - started) / 10_000) % 2 && await page.locator('[data-side="right"] .pdf-scroll').count() ? 'right' : 'left'
      const pane = page.locator(`[data-side="${side}"] .pdf-scroll`)
      if (!(i % 40)) {
        const limits = await pane.evaluate(element => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight }))
        if (direction > 0 && limits.top >= limits.max - 1) { endpoints.push({ edge: 'bottom', side, elapsed: Date.now() - started, ...limits }); direction = -1 }
        if (direction < 0 && limits.top <= 1) { endpoints.push({ edge: 'top', side, elapsed: Date.now() - started, ...limits }); direction = 1 }
        const bounds = await pane.boundingBox(); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      }
      await page.mouse.wheel(0, direction * 110); i++
      if (Date.now() - started >= nextMemory) {
        const snapshot = await app.evaluate(({ app, BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]
          return { processes: app.getAppMetrics().map(process => ({ type: process.type, name: process.name, memory: process.memory, cpu: process.cpu.percentCPUUsage })),
            window: { visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused(), bounds: window.getBounds(), backgroundThrottling: window.webContents.getBackgroundThrottling() } }
        })
        processMemory.push({ elapsed: Date.now() - started, sentInputs: i, ...snapshot })
        nextMemory += 10_000
        console.log(JSON.stringify({ phase: soaking ? 'soak' : `round-${round + 1}`, elapsedSeconds: Math.round((Date.now() - started) / 1000), sentInputs: i, endpoints: endpoints.length }))
      }
    }
    // Keep settlement separate from the continuous-input frame statistics.
    const raw = await page.evaluate(() => window.stopScrollProfile())
    raw.processMemory = processMemory; raw.endpoints = endpoints; raw.sentInputs = i; raw.durationMs = Date.now() - started
    const prefix = soaking ? 'soak' : `round-${round + 1}`
    await page.evaluate(beginSampling)
    let settled = true
    try {
      await page.waitForFunction(() => [...document.querySelectorAll('.pdf-scroll')].every(root => {
        const bounds = root.getBoundingClientRect()
        return [...root.querySelectorAll('.page-slot')].filter(slot => {
          const box = slot.getBoundingClientRect(); return box.bottom > bounds.top && box.top < bounds.bottom
        }).every(slot => slot.querySelector('.canvas-holder canvas')?.dataset.quality === 'clear')
      }), undefined, { timeout: 5000 })
    } catch { settled = false }
    const settlement = await page.evaluate(() => window.stopScrollProfile())
    const linkedDrift = await page.evaluate(() => {
      const roots = [...document.querySelectorAll('.pdf-scroll')]
      return roots.length === 2 && Math.abs(roots[0].scrollHeight - roots[1].scrollHeight) <= 1 ? Math.abs(roots[0].scrollTop - roots[1].scrollTop) : null
    })
    await writeFile(resolve(directory, `${prefix}.settlement.raw.json`), JSON.stringify(settlement))
    if (trace && !soaking) {
      const { profile } = await cdp.send('Profiler.stop'); await writeFile(resolve(directory, `${prefix}.cpuprofile`), JSON.stringify(profile))
      const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve)); await cdp.send('Tracing.end')
      const { stream } = await complete; const chunks = []
      while (true) { const result = await cdp.send('IO.read', { handle: stream }); chunks.push(result.base64Encoded ? Buffer.from(result.data, 'base64') : Buffer.from(result.data)); if (result.eof) break }
      await cdp.send('IO.close', { handle: stream }); await writeFile(resolve(directory, `${prefix}.trace.json`), Buffer.concat(chunks))
    }
    await cdp.detach()
    const actualDpr = await page.evaluate(() => devicePixelRatio)
    const cold = [...coldRaw.pages, ...raw.pages].filter(sample => !sample.cached)
    const incomplete = [...coldRaw.pages.filter(sample => !sample.cached).filter(sample => sample.preview === null && (sample.left ?? coldRaw.ended) - sample.entered >= 500), ...raw.pages.filter(sample => !sample.cached).filter(sample => sample.preview === null && (sample.left ?? raw.ended) - sample.entered >= 500)]
    const preview = cold.flatMap(sample => sample.preview === null ? [] : [sample.preview])
    const coldVisits = [...coldRaw.pages.map(sample => ({ ...sample, ended: coldRaw.ended })), ...raw.pages.map(sample => ({ ...sample, ended: raw.ended }))].filter(sample => !sample.cached)
    // Unfinished visits are censored, not successful zero-latency samples. A
    // page that remained visible for >=150 ms already supplies a lower bound.
    const missedPreview = coldVisits.filter(sample => sample.preview === null && (sample.left ?? sample.ended) - sample.entered >= 150)
    const previewBounds = [...preview, ...missedPreview.map(sample => (sample.left ?? sample.ended) - sample.entered)]
    const stablePages = settlement.pages.filter(sample => sample.left === null)
    const clear = [...coldRaw.pages.filter(sample => !sample.cached).flatMap(sample => sample.clear === null ? [] : [sample.clear]), ...stablePages.flatMap(sample => sample.clear === null ? [] : [sample.clear])]
    const report = { phase: prefix, actualDpr, ...summarizeFrames(raw.frames), wheelEvents: raw.wheelEvents, drawnFrames: raw.drawnFrames, maxDrawnPerFrame: raw.maxDrawnPerFrame,
      inputP95Ms: percentile(raw.inputLatency, .95), longTasks: raw.longTasks.length, coldPages: cold.length, incomplete: incomplete.length,
      previewP95Ms: percentile(preview, .95), previewP95LowerBoundMs: percentile(previewBounds, .95), missedPreview: missedPreview.length,
      censoredColdPages: coldVisits.filter(sample => sample.preview === null && (sample.left ?? sample.ended) - sample.entered < 150).length,
      clearP95Ms: percentile(clear, .95), settled, linkedDriftPx: linkedDrift, stablePages: stablePages.length, incompleteClear: stablePages.filter(sample => sample.clear === null).length,
      endpoints, peakRasterBytes: Math.max(0, ...raw.memory.map(sample => sample.rasterBytes ?? 0), ...settlement.memory.map(sample => sample.rasterBytes ?? 0)),
      resources: raw.memory.at(-1), durationMs: raw.durationMs }
    const errors = performanceFailures({ ...raw, longTasks: raw.longTasks.map(task => task.duration) }, refreshHz)
    if (requestedDpr !== undefined && Math.abs(actualDpr - requestedDpr) >= 1e-6) errors.push('实际 DPR 与请求值不符')
    if (round === 0 && !cold.length) errors.push('首轮缺少真实冷页样本，预取已覆盖探测页')
    if (!raw.wheelEvents || !raw.inputLatency.length) errors.push('缺少原生输入/反馈样本')
    if (processMemory.some(sample => !sample.window.visible || sample.window.minimized)) errors.push('采样窗口被隐藏或最小化，前台连续输入验证无效')
    if (raw.maxDrawnPerFrame > 1) errors.push('同一帧绘制多个 PDF 画布')
    if (duration >= 60000 && raw.wheelEvents < duration / 1000 * 20) errors.push('有效滚轮输入不足 20 次/秒，连续输入压力测试无效')
    if (duration >= 60000 && processMemory.some((sample, index) => index && sample.elapsed - processMemory[index - 1].elapsed >= 8000
      && (sample.sentInputs - processMemory[index - 1].sentInputs) / ((sample.elapsed - processMemory[index - 1].elapsed) / 1000) < 20)) errors.push('至少一个完整输入窗口不足 20 次/秒，连续输入压力测试无效')
    if (duration >= 60000 && (!endpoints.some(point => point.edge === 'top') || !endpoints.some(point => point.edge === 'bottom'))) errors.push('未完成整篇到底再回顶的往返')
    if (incomplete.length) errors.push('视口冷页超过 500 ms 仍无预览')
    if (report.previewP95Ms > 150 || report.previewP95LowerBoundMs > 150) errors.push('冷页预览 P95 >150 ms（含未完成样本的延迟下界）')
    if (report.clearP95Ms > 500) errors.push('冷页清晰层 P95 >500 ms')
    if (!settled || !stablePages.length || report.incompleteClear || !clear.length) errors.push('停止输入后可见页清晰层未全部完成')
    if (linkedDrift !== null && linkedDrift > 2) errors.push('双栏联动稳定后误差 >2 px')
    if (raw.memory.some(sample => sample.rasterBytes > sample.rasterBudget || sample.textBytes > sample.textBudget)) errors.push('缓存超出配置预算')
    if (soaking && processMemory.length >= 4) {
      const rendererRss = sample => sample.processes.filter(process => process.type === 'Tab').reduce((sum, process) => sum + process.memory.workingSetSize, 0)
      const allRss = sample => sample.processes.reduce((sum, process) => sum + process.memory.workingSetSize, 0)
      const warm = processMemory.filter(sample => sample.elapsed >= Math.min(60_000, duration / 3))
      const first = warm.slice(0, 3).map(allRss); const last = warm.slice(-3).map(allRss)
      const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
      report.memoryGrowth = median(last) / median(first) - 1
      report.rendererMemoryGrowth = median(warm.slice(-3).map(rendererRss)) / median(warm.slice(0, 3).map(rendererRss)) - 1
      if (report.memoryGrowth > .1) errors.push('预热后末轮稳定内存增幅 >10%')
    }
    report.failures = errors
    reports.push(report); failures.push(...errors.map(error => `${prefix}: ${error}`))
    await writeFile(resolve(directory, `${prefix}.raw.json`), JSON.stringify(raw))
    const rasterTrace = await page.evaluate(() => window.__pdfRasterTimings ?? null)
    if (rasterTrace) await writeFile(resolve(directory, `${prefix}.raster.json`), JSON.stringify(rasterTrace))
    await writeFile(resolve(directory, `${prefix}.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
  }
  await writeFile(resolve(directory, 'summary.json'), JSON.stringify({ reports, failures }, null, 2))
  if (!baseline && failures.length) throw new Error(`性能门禁失败：\n${failures.join('\n')}`)
  return reports
}
