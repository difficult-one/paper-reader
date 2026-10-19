import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveBesideOriginal } from '../src/main/translation-files'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'reader-save-')); directories.push(directory)
  const source = join(directory, 'cached.pdf'); await writeFile(source, 'translated PDF bytes')
  const original = join(directory, '论文.PDF'); await writeFile(original, 'original PDF bytes')
  return { directory, source, original }
}
it('保存中文 PDF 到原文旁边，保留原文和内部缓存', async () => {
  const { directory, source, original } = await fixture()
  const output = await saveBesideOriginal(source, original)
  expect(output).toBe(join(directory, '论文.中文译文.pdf'))
  expect(await readFile(output, 'utf8')).toBe('translated PDF bytes')
  expect(await readFile(original, 'utf8')).toBe('original PDF bytes')
  expect(await readFile(source, 'utf8')).toBe('translated PDF bytes')
})
it('同名不同内容保留，依次选择编号；同内容不再生成重复文件', async () => {
  const { directory, source, original } = await fixture()
  await writeFile(join(directory, '论文.中文译文.pdf'), 'existing version')
  await writeFile(join(directory, '论文.中文译文 (2).pdf'), 'another version')
  expect(await saveBesideOriginal(source, original)).toBe(join(directory, '论文.中文译文 (3).pdf'))
  expect(await saveBesideOriginal(source, original)).toBe(join(directory, '论文.中文译文 (3).pdf'))
  expect(await readFile(join(directory, '论文.中文译文.pdf'), 'utf8')).toBe('existing version')
})
it('同名路径为文件夹时跳过，不破坏目录', async () => {
  const { directory, source, original } = await fixture()
  await mkdir(join(directory, '论文.中文译文.pdf'))
  expect(await saveBesideOriginal(source, original)).toBe(join(directory, '论文.中文译文 (2).pdf'))
})
it('原目录已经不存在时报告写入失败，不创建新的目录', async () => {
  const { directory, source } = await fixture()
  await expect(saveBesideOriginal(source, join(directory, 'missing', 'paper.pdf'))).rejects.toThrow()
})
