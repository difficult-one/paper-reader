import { expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { coordinateRasterWorkers } from '../src/main/pdf-raster-pool'

class Lane extends EventEmitter {
  sent: any[] = []
  postMessage(message: any) { this.sent.push(message) }
}
it('balances renders across ready lanes, routes updates, and exits only after both lanes close', () => {
  const lanes = [new Lane(), new Lane()]; const messages: any[] = []; const exits: number[] = []
  const pool = coordinateRasterWorkers(lanes, { send: message => messages.push(message), exit: code => exits.push(code) })
  lanes[0].emit('message', { type: 'ready' }); expect(messages).toEqual([])
  lanes[1].emit('message', { type: 'ready' }); expect(messages).toEqual([{ type: 'ready' }])
  pool.postMessage({ type: 'render', id: 'a' }); pool.postMessage({ type: 'render', id: 'b' })
  expect(lanes.map(lane => lane.sent.map(message => message.id))).toEqual([['a'], ['b']])
  pool.postMessage({ type: 'priority', id: 'b', priority: 0 }); pool.postMessage({ type: 'cancel', id: 'a' })
  expect(lanes[1].sent.at(-1)).toMatchObject({ type: 'priority', id: 'b' })
  expect(lanes[0].sent.at(-1)).toMatchObject({ type: 'cancel', id: 'a' })
  pool.postMessage({ type: 'render', id: 'c' }); expect(lanes[0].sent.at(-1).id).toBe('c')
  lanes[0].emit('message', { id: 'c', png: new Uint8Array() }); expect(messages.at(-1).id).toBe('c')
  pool.postMessage({ type: 'close' })
  expect(lanes.every(lane => lane.sent.at(-1).type === 'close')).toBe(true)
  lanes[0].emit('exit', 0); expect(exits).toEqual([])
  lanes[1].emit('exit', 0); expect(exits).toEqual([0])
})
it('a lane failure terminates the coupled PDF lifecycle exactly once', () => {
  const lanes = [new Lane(), new Lane()]; const messages: any[] = []; const exits: number[] = []
  coordinateRasterWorkers(lanes, { send: message => messages.push(message), exit: code => exits.push(code) })
  lanes[0].emit('error', new Error('fixture failure')); lanes[0].emit('exit', 1); lanes[1].emit('exit', 0)
  expect(messages).toEqual([{ type: 'fatal', error: 'fixture failure' }]); expect(exits).toEqual([1])
})
