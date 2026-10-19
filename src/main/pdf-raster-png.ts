import { crc32, deflate } from 'node:zlib'
import { promisify } from 'node:util'
import type { Canvas } from '@napi-rs/canvas'

const compress = promisify(deflate)
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function chunk(name: string, data = Buffer.alloc(0)) {
  const result = Buffer.allocUnsafe(data.length + 12)
  result.writeUInt32BE(data.length, 0); result.write(name, 4, 4, 'ascii'); data.copy(result, 8)
  result.writeUInt32BE(crc32(result.subarray(4, data.length + 8)), data.length + 8)
  return result
}
export async function encodeRasterPng(canvas: Canvas): Promise<Buffer> {
  // The displayed surface is opaque RGBA. Filter zero and fast deflate keep
  // every pixel while avoiding Skia's expensive PNG compression on dense plots.
  const stride = canvas.width * 4
  const rows = Buffer.allocUnsafe((stride + 1) * canvas.height)
  const pixels = canvas.data()
  for (let y = 0; y < canvas.height; y++) {
    const offset = y * (stride + 1); rows[offset] = 0
    pixels.copy(rows, offset + 1, y * stride, (y + 1) * stride)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(canvas.width, 0); header.writeUInt32BE(canvas.height, 4)
  header[8] = 8; header[9] = 6
  const compressed = await compress(rows, { level: 1 })
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND')])
}
