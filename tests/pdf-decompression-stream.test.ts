import { expect, it } from 'vitest'
import { deflateSync, gzipSync } from 'node:zlib'
import { PdfDecompressionStream } from '../src/main/pdf-decompression-stream'

async function read(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return { bytes: Buffer.concat(chunks), count: chunks.length }
}
async function write(stream: WritableStream<BufferSource>, bytes: Uint8Array, step = bytes.length) {
  const writer = stream.getWriter()
  for (let offset = 0; offset < bytes.length; offset += step) await writer.write(Uint8Array.from(bytes.subarray(offset, offset + step)))
  await writer.close()
}

it('complete PDF image streams retain every byte while avoiding hundreds of output handoffs', async () => {
  const source = Buffer.alloc(5_000_037)
  for (let i = 0; i < source.length; i++) source[i] = (i * 17 + (i >> 9)) & 255
  const stream = new PdfDecompressionStream('deflate')
  const [result] = await Promise.all([read(stream.readable), write(stream.writable, deflateSync(source))])
  expect(result.bytes.equals(source)).toBe(true)
  expect(result.count).toBeLessThan(20)
})

it('compressed input split across stream boundaries still decodes completely', async () => {
  const source = Buffer.alloc(10_037)
  for (let i = 0; i < source.length; i++) source[i] = (i * 13 + (i >> 4)) & 255
  const stream = new PdfDecompressionStream('deflate')
  const [result] = await Promise.all([read(stream.readable), write(stream.writable, deflateSync(source), 13)])
  expect(result.bytes.equals(source)).toBe(true)
})

it('other formats retain the native decoder', async () => {
  const source = Buffer.from('scientific content and conditions')
  const stream = new PdfDecompressionStream('gzip')
  const [result] = await Promise.all([read(stream.readable), write(stream.writable, gzipSync(source))])
  expect(result.bytes.equals(source)).toBe(true)
})

it('malformed deflate propagates an error instead of yielding successful partial pixels', async () => {
  const stream = new PdfDecompressionStream('deflate')
  const results = await Promise.allSettled([read(stream.readable), write(stream.writable, new Uint8Array([0, 1, 2, 3]))])
  expect(results.every(result => result.status === 'rejected')).toBe(true)
})

it('cancelling the reader settles an in-flight producer instead of leaving decompression blocked', async () => {
  const stream = new PdfDecompressionStream('deflate')
  const producer = write(stream.writable, deflateSync(Buffer.alloc(5_000_000, 73)), 1).catch(() => {})
  const reader = stream.readable.getReader()
  expect((await reader.read()).done).toBe(false)
  await reader.cancel('reader-closed'); await producer
  expect((await reader.read()).done).toBe(true)
})

it('trailing garbage rejects both sides just like Node DecompressionStream', async () => {
  const stream = new PdfDecompressionStream('deflate')
  const bytes = Buffer.concat([deflateSync(Buffer.from('complete image')), Buffer.from([17, 31])])
  const results = await Promise.allSettled([read(stream.readable), write(stream.writable, bytes)])
  expect(results.every(result => result.status === 'rejected')).toBe(true)
})
