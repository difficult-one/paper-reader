import { afterEach, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { offlineFixture, runTokenExperiment } from '../src/main/token-cache-runner'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
it('已有实验目录拒绝重复运行，保留旧结果且不把旧热缓存标为冷态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-runner-')); dirs.push(directory)
  await writeFile(join(directory, 'schedule.json'), 'old-schedule')
  await expect(runTokenExperiment(offlineFixture(), { directory, live: false })).rejects.toThrow(/已有|独立|重复/)
})
