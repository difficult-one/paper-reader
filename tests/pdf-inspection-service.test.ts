import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PdfInspectionService } from '../src/main/pdf-inspection-service'

const directories: string[] = []; const services: PdfInspectionService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.shutdown()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
async function service() {
  const directory = await mkdtemp(join(tmpdir(), 'reader-inspect-')); directories.push(directory)
  const entry = join(directory, 'worker.mjs')
  await writeFile(entry, `import { parentPort } from 'node:worker_threads';
let active = false;
parentPort.on('message', async path => {
  if (active) { parentPort.postMessage({ error: 'overlapping PDF parsing' }); return; }
  if (path === 'crash') process.exit(1);
  active = true;
  await new Promise(resolve => setTimeout(resolve, 20));
  active = false;
  parentPort.postMessage(path === 'bad' ? { error: 'invalid PDF' } : { value: { pages: 3, hasText: true, language: 'en' } });
});`)
  const inspector = new PdfInspectionService(pathToFileURL(entry)); services.push(inspector)
  return inspector
}

it('serializes concurrent inspections in a reusable worker and continues after an invalid PDF', async () => {
  const inspector = await service()
  const first = inspector.inspect('first'); const bad = expect(inspector.inspect('bad')).rejects.toThrow('invalid PDF')
  const last = inspector.inspect('last')
  expect(await first).toEqual({ pages: 3, hasText: true, language: 'en' })
  await bad
  expect(await last).toEqual({ pages: 3, hasText: true, language: 'en' })
})

it('rejects an interrupted inspection and starts a new worker for the next request', async () => {
  const inspector = await service()
  await expect(inspector.inspect('crash')).rejects.toThrow(/线程已关闭/)
  expect(await inspector.inspect('next')).toEqual({ pages: 3, hasText: true, language: 'en' })
})

it('shutdown settles both in-flight and queued requests and refuses later work', async () => {
  const inspector = await service()
  const first = expect(inspector.inspect('first')).rejects.toThrow(/已关闭/)
  const next = expect(inspector.inspect('next')).rejects.toThrow(/已关闭/)
  await Promise.resolve()
  await inspector.shutdown(); await first; await next
  await expect(inspector.inspect('later')).rejects.toThrow(/已关闭/)
})
