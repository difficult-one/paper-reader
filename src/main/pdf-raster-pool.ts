interface Lane { postMessage(message: unknown): void; on(event: string, listener: (...args: any[]) => void): unknown }
export function coordinateRasterWorkers(lanes: Lane[], host: { send(message: any): void; exit(code: number): void }) {
  const pending = new Map<string, number>(); const loads = lanes.map(() => 0)
  const ready = new Set<number>(); const exited = new Set<number>()
  let next = 0; let closing = false; let finished = false
  const finish = (code: number) => { if (!finished) { finished = true; host.exit(code) } }
  lanes.forEach((lane, index) => {
    lane.on('message', message => {
      if (finished) return
      if (message.type === 'ready') { ready.add(index); if (ready.size === lanes.length) host.send({ type: 'ready' }); return }
      if (pending.get(message.id) !== index) return
      pending.delete(message.id); loads[index]--; host.send(message)
    })
    lane.on('error', error => { if (!finished) { host.send({ type: 'fatal', error: error instanceof Error ? error.message : String(error) }); finish(1) } })
    lane.on('exit', code => {
      if (!closing || code !== 0) { finish(code || 1); return }
      exited.add(index); if (exited.size === lanes.length) finish(0)
    })
  })
  return { postMessage(message: any) {
    if (finished) return
    if (message.type === 'close') { closing = true; for (const lane of lanes) lane.postMessage(message); return }
    if (closing) return
    if (message.type === 'render') {
      let index = next
      for (let offset = 1; offset < lanes.length; offset++) { const candidate = (next + offset) % lanes.length; if (loads[candidate] < loads[index]) index = candidate }
      next = (index + 1) % lanes.length; pending.set(message.id, index); loads[index]++; lanes[index].postMessage(message); return
    }
    const index = pending.get(message.id)
    if (index === undefined) return
    if (message.type === 'cancel') { pending.delete(message.id); loads[index]-- }
    lanes[index].postMessage(message)
  } }
}
