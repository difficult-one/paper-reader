import { Worker } from 'node:worker_threads'
import { coordinateRasterWorkers } from './pdf-raster-pool'

// PDF.js detects Electron's utility main thread as a browser environment.
// A Node worker supplies its supported Node environment, while the enclosing
// process gives each PDF an independent native font registry and crash cleanup.
const input = JSON.parse(process.argv.find(argument => argument.startsWith('--raster-init='))!.slice('--raster-init='.length))
// Both lanes belong to this PDF and close together. Keep their shared native
// font registry alive until this process exits; per-thread aliases stay unique.
const lanes = Array.from({ length: 2 }, () => new Worker(new URL('./pdf-raster-worker.js', import.meta.url), { workerData: { ...input, sharedFonts: true } }))
const pool = coordinateRasterWorkers(lanes, { send: message => process.parentPort.postMessage(message), exit: code => process.exit(code) })
process.parentPort.on('message', event => pool.postMessage(event.data))
