import { Duplex } from 'node:stream'
import { createInflate } from 'node:zlib'

const NativeDecompressionStream = globalThis.DecompressionStream

// PDF.js reads complete image streams, but Node's default 16 KiB output causes
// hundreds of worker-pool round trips for a single RGB image and its soft mask.
// Keep native streaming, backpressure, errors and cancellation with larger output
// chunks. Other compression formats retain Node's implementation unchanged.
export class PdfDecompressionStream {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<BufferSource>
  constructor(format: string) {
    const stream = format === 'deflate'
      ? Duplex.toWeb(createInflate({ chunkSize: 1024 * 1024, rejectGarbageAfterEnd: true }))
      : new NativeDecompressionStream(format as ConstructorParameters<typeof NativeDecompressionStream>[0])
    // Node and lib.dom declare the same Web Streams interface separately.
    this.readable = stream.readable as unknown as ReadableStream<Uint8Array>
    this.writable = stream.writable
  }
}
