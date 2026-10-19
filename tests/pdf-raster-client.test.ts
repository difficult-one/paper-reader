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
