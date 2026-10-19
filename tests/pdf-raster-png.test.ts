import { expect, it } from 'vitest'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { encodeRasterPng } from '../src/main/pdf-raster-png'

it('encodes opaque raster pixels losslessly with correct row boundaries and PNG checksums', async () => {
  const canvas = createCanvas(17, 9); const context = canvas.getContext('2d', { alpha: false })
  context.fillStyle = 'white'; context.fillRect(0, 0, 17, 9)
  for (let y = 0; y < 9; y++) for (let x = 0; x < 17; x++) {
    context.fillStyle = `rgba(${x * 15},${y * 28},${(x + y) * 9},0.8)`; context.fillRect(x, y, 1, 1)
  }
  const expected = context.getImageData(0, 0, 17, 9).data
  const png = await encodeRasterPng(canvas)
  const image = await loadImage(png)
  expect([image.width, image.height]).toEqual([17, 9])
  const decoded = createCanvas(17, 9).getContext('2d'); decoded.drawImage(image, 0, 0)
  expect([...decoded.getImageData(0, 0, 17, 9).data]).toEqual([...expected])
})
