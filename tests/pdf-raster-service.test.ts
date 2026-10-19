import { afterAll, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'node:events'
import { PDFDocument, rgb } from 'pdf-lib'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { PdfRasterService } from '../src/main/pdf-raster-service'

const directory = await mkdtemp(join(tmpdir(), 'reader-raster-'))
const path = join(directory, 'page.pdf')
const pdf = await PDFDocument.create()
pdf.addPage([100, 100]).drawRectangle({ x: 0, y: 0, width: 100, height: 100, color: rgb(1, 0, 0) })
await writeFile(path, await pdf.save())
const service = new PdfRasterService({ resolvePdf: url => url === 'registered-pdf' ? path : undefined,
  assets: resolve('src/renderer/public/pdf-assets'), spawn: (path, assets) => new Worker(new URL('../src/main/pdf-raster-worker.ts', import.meta.url), { workerData: { path, assets } }) })
afterAll(async () => { await service.shutdown(); await rm(directory, { recursive: true }) })

it('只渲染已注册文档，未知地址和超预算像素不能启动绘制', async () => {
  await expect(service.open('unknown', 'file:///private.pdf')).rejects.toThrow()
  await service.open('owner', 'registered-pdf')
  await expect(service.render('owner', { id: 'large', page: 1, scale: 1, width: 9000, height: 9000, priority: 0 })).rejects.toThrow()
})

it('真实 worker 返回指定分辨率与颜色的 PNG，关闭一个共享所有者不影响另一个', async () => {
  await service.open('a', 'registered-pdf'); await service.open('b', 'registered-pdf')
  await service.close('a')
  const result = await service.render('b', { id: 'red', page: 1, scale: 1, width: 50, height: 50, priority: 0 })
  const image = await loadImage(result.png)
  expect([image.width, image.height]).toEqual([50, 50])
  const canvas = createCanvas(50, 50); const context = canvas.getContext('2d'); context.drawImage(image, 0, 0)
  expect([...context.getImageData(25, 25, 1, 1).data]).toEqual([255, 0, 0, 255])
  await service.close('b')
})

it('取消排队与关闭文档会结束等待者，旧所有者不能重新提交绘制', async () => {
  await service.open('cancel-owner', 'registered-pdf')
  const pending = service.render('cancel-owner', { id: 'cancel', page: 1, scale: 1, width: 50, height: 50, priority: 4 })
  const cancelled = expect(pending).rejects.toThrow()
  service.cancel('cancel-owner', 'cancel'); await cancelled
  await service.close('cancel-owner')
  await expect(service.render('cancel-owner', { id: 'stale', page: 1, scale: 1, width: 50, height: 50, priority: 0 })).rejects.toThrow()
})

it('预取进入视口后可提升已排队任务，其他所有者不能修改它的优先级', async () => {
  await service.open('reprioritize', 'registered-pdf')
  const order: string[] = []
  const render = (id: string, priority: number, width = 50) => service.render('reprioritize', { id, page: 1, scale: 1, width, height: width, priority }).then(() => { order.push(id) })
  const completed = Promise.all([render('busy', 0, 2000), render('waiting-a', 2), render('waiting-b', 3)])
  try {
    service.prioritize('owner', 'waiting-a', -10)
    service.prioritize('reprioritize', 'waiting-a', NaN)
    service.prioritize('reprioritize', 'waiting-b', 0)
    await completed
    expect(order).toEqual(['busy', 'waiting-b', 'waiting-a'])
  } finally { await completed; await service.close('reprioritize') }
})

it('名额被关闭进程占用时取消等待中的 open，释放名额后不能复活旧所有者', async () => {
  const children: EventEmitter[] = []
  let closing!: () => void
  const limited = new PdfRasterService({ resolvePdf: () => path, assets: directory, spawn() {
    const child = new EventEmitter()
    children.push(child)
    queueMicrotask(() => child.emit('message', { type: 'ready' }))
    return Object.assign(child, { postMessage(message: any) { if (message.type === 'close') closing = () => child.emit('exit', 0) }, terminate() { child.emit('exit', 0) } })
  } })
  for (let i = 0; i < 4; i++) await limited.open(`owner-${i}`, `url-${i}`)
  const closed = limited.close('owner-0')
  const opening = limited.open('abandoned', 'url-new')
  const rejected = expect(opening).rejects.toThrow()
  await limited.close('abandoned')
  closing(); await closed; await rejected
  expect(children.length).toBe(4)
  await expect(limited.render('abandoned', { id: 'old', page: 1, scale: 1, width: 1, height: 1, priority: 0 })).rejects.toThrow()
  for (let i = 1; i < 4; i++) { const done = limited.close(`owner-${i}`); closing(); await done }
  await limited.shutdown()
})
