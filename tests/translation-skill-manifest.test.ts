import { afterEach, expect, it } from 'vitest'
import { mkdtemp, cp, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { TRANSLATION_POLICY_VERSION } from '../src/main/cache-versions'
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
it('verifies packaged files and rejects a changed task rule or incomplete copied skill', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'skill-package-')); directories.push(directory)
  await cp(resolve('skills/research-bilingual-translation'), directory, { recursive: true })
  const script = resolve('scripts/translation-skill-manifest.mjs')
  execFileSync(process.execPath, [script, 'write', directory])
  execFileSync(process.execPath, [script, 'verify', directory])
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(directory, 'provenance.json'), 'utf8'))
  expect(manifest.translationPolicy).toBe(TRANSLATION_POLICY_VERSION)
  await writeFile(join(directory, 'references/terminology-rules.txt'), 'different task rules')
  expect(() => execFileSync(process.execPath, [script, 'verify', directory], { stdio: 'pipe' })).toThrow()
})
