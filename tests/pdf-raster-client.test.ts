import { afterEach, expect, it, vi } from 'vitest'
import { PdfRasterClient } from '../src/renderer/src/pdf-raster-client'
import type { PdfRasterRequest } from '../src/shared/pdf-raster'

afterEach(() => vi.unstubAllGlobals())

it('waiting for worker startup does not freeze the old prefetch priority', async () => {
  let ready!: (value: { ok: true; value: undefined }) => void
  const opening = new Promise(resolve => { ready = resolve })
  const render = vi.fn(async (_owner: string, _request: PdfRasterRequest) => ({ ok: false, error: 'fixture-stop' }))
  vi.stubGlobal('window', { reader: { openPdfRaster: () => opening, renderPdfRaster: render } })
  const client = new PdfRasterClient('registered')
  let priority = 3
  const painted = expect(client.paint({} as HTMLCanvasElement, { page: 7, scale: 1, width: 100, height: 100, priority }, { priority: () => priority })).rejects.toThrow('fixture-stop')
  priority = 0; client.prioritize(7)
  ready({ ok: true, value: undefined }); await painted
  expect(render.mock.calls[0][1]).toMatchObject({ page: 7, priority: 0 })
})

it('visible work keeps the second lane available to visible pages until it finishes or leaves the viewport', async () => {
  let finish!: (value: { ok: false; error: string }) => void
  const render = vi.fn(() => new Promise(resolve => { finish = resolve }))
  vi.stubGlobal('window', { reader: { openPdfRaster: async () => ({ ok: true }), renderPdfRaster: render } })
  const client = new PdfRasterClient('registered')
  let priority = 0
  const painted = expect(client.paint({} as HTMLCanvasElement, { page: 48, scale: 1, width: 225, height: 291, priority }, { priority: () => priority })).rejects.toThrow('fixture-stop')
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce())
  try {
    expect(client.canStart(0)).toBe(true)
    expect(client.canStart(1)).toBe(true)
    expect(client.canStart(2)).toBe(false)
    expect(client.canStart(3)).toBe(false)
    priority = 2
    expect(client.canStart(2)).toBe(true)
  } finally {
    finish({ ok: false, error: 'fixture-stop' }); await painted
  }
  expect(client.canStart(2)).toBe(true)
})

it('counts decoding and queued canvas commits against the two in-flight lanes', async () => {
  const frames: FrameRequestCallback[] = []
  const decodes: ((bitmap: ImageBitmap) => void)[] = []
  const drawn: number[] = []; let closed = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('createImageBitmap', () => new Promise<ImageBitmap>(resolve => decodes.push(resolve)))
  vi.stubGlobal('window', { reader: { openPdfRaster: async () => ({ ok: true }), renderPdfRaster: async () => ({ ok: true, value: { png: new Uint8Array() } }) } })
  const client = new PdfRasterClient('registered')
  const paint = (page: number) => client.paint({ getContext: () => ({ drawImage: () => drawn.push(page) }) } as unknown as HTMLCanvasElement,
    { page, scale: 1, width: 100, height: 100, priority: 0 }, { priority: 0 })
  const first = paint(1); const second = paint(2)
  try {
    await vi.waitFor(() => expect(decodes).toHaveLength(2))
    expect(client.canStart(0)).toBe(false)
    decodes[0]({ width: 100, height: 100, close: () => { closed++ } })
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0))
    expect(client.canStart(0)).toBe(false)
    frames.shift()!(performance.now()); await first
    expect(drawn).toEqual([1]); expect(client.canStart(0)).toBe(true)
  } finally {
    for (const decode of decodes) decode({ width: 100, height: 100, close: () => { closed++ } })
    await Promise.resolve(); await Promise.resolve()
    while (frames.length) frames.shift()!(performance.now())
    await Promise.all([first, second])
  }
  expect(drawn).toEqual([1, 2]); expect(closed).toBe(2)
})

it('closing during decode prevents a later canvas commit and releases the bitmap', async () => {
  let decode!: (bitmap: ImageBitmap) => void
  const draw = vi.fn(); const close = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(performance.now())); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('createImageBitmap', () => new Promise<ImageBitmap>(resolve => { decode = resolve }))
  vi.stubGlobal('window', { reader: { openPdfRaster: async () => ({ ok: true }), renderPdfRaster: async () => ({ ok: true, value: { png: new Uint8Array() } }), cancelPdfRaster: async () => {}, closePdfRaster: async () => {} } })
  const client = new PdfRasterClient('registered')
  const painting = client.paint({ getContext: () => ({ drawImage: draw }) } as unknown as HTMLCanvasElement, { page: 1, scale: 1, width: 100, height: 100, priority: 0 }, {})
  const rejected = expect(painting).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(decode).toBeTypeOf('function'))
  client.close(); decode({ close } as unknown as ImageBitmap)
  await rejected
  expect(draw).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce()
})

it('closing cancels a queued canvas commit and rejects future paint requests', async () => {
  const frames: FrameRequestCallback[] = []; const draw = vi.fn(); const close = vi.fn()
  const render = vi.fn(async () => ({ ok: true, value: { png: new Uint8Array() } }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('createImageBitmap', async () => ({ width: 100, height: 100, close }))
  vi.stubGlobal('window', { reader: { openPdfRaster: async () => ({ ok: true }), renderPdfRaster: render, closePdfRaster: async () => {} } })
  const client = new PdfRasterClient('registered')
  const canvas = { getContext: () => ({ drawImage: draw }) } as unknown as HTMLCanvasElement
  const request = { page: 1, scale: 1, width: 100, height: 100, priority: 0 }
  const painting = expect(client.paint(canvas, request, {})).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(frames).toHaveLength(1))
  client.close(); await painting
  for (const frame of frames) frame(performance.now())
  await expect(client.paint(canvas, request, {})).rejects.toMatchObject({ name: 'AbortError' })
  expect(draw).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce(); expect(render).toHaveBeenCalledOnce()
})
