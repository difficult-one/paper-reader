import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { ReaderStore } from '../src/main/store'
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
const key = randomBytes(32)
const codec = {
  encrypt(value: string) { const iv = randomBytes(16); const cipher = createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final()]) },
  decrypt(value: Buffer) { const decipher = createDecipheriv('aes-256-cbc', key, value.subarray(0, 16)); return Buffer.concat([decipher.update(value.subarray(16)), decipher.final()]).toString() }
}
it('配置重启后可用，磁盘中不保存明文密钥，空白密钥保留原值', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reader-store-')); dirs.push(dir)
  const store = new ReaderStore(dir, codec)
  await store.saveSettings({ baseUrl: 'https://example.com', model: 'paper-model', apiKey: 'private-test-key', qps: 2 })
  expect(await readFile(join(dir, 'settings.json'), 'utf8')).not.toContain('private-test-key')
  const reloaded = new ReaderStore(dir, codec)
  expect((await reloaded.settings()).apiKey).toBe('private-test-key')
  await reloaded.saveSettings({ baseUrl: 'https://example.com/v1', model: 'paper-model-2', apiKey: '', qps: 1 })
  expect((await reloaded.settings()).apiKey).toBe('private-test-key')
})
it('阅读状态保存后恢复；损坏配置明确报错且不静默覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reader-store-')); dirs.push(dir)
  const store = new ReaderStore(dir, codec)
  const state = { left: { page: 3, fraction: 0.4 }, right: { page: 3, fraction: 0.4 }, zoom: 1, split: 50, linked: true }
  await store.saveReading('abc', state)
  expect(await new ReaderStore(dir, codec).reading('abc')).toEqual(state)
  await writeFile(join(dir, 'settings.json'), 'broken-json')
  await expect(store.settings()).rejects.toThrow(/记录无法读取/)
  expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe('broken-json')
})
it('上次打开的论文可在重启后恢复，也可以清除', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reader-last-')); dirs.push(dir)
  const store = new ReaderStore(dir, codec)
  expect(await store.lastDocument()).toBeNull()
  await store.saveLastDocument('C:/papers/example.pdf')
  expect(await new ReaderStore(dir, codec).lastDocument()).toBe('C:/papers/example.pdf')
  await store.saveLastDocument(null)
  expect(await new ReaderStore(dir, codec).lastDocument()).toBeNull()
})
it('切换服务地址时，不能把上一服务的已存密钥留空复用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reader-store-')); dirs.push(dir)
  const store = new ReaderStore(dir, codec)
  await store.saveSettings({ baseUrl: 'https://example.com', model: 'model-a', apiKey: 'private-test-key', qps: 2 })
  await expect(store.saveSettings({ baseUrl: 'https://different.example.com', model: 'model-b', apiKey: '', qps: 2 })).rejects.toThrow(/密钥/)
  expect((await store.settings()).baseUrl).toBe('https://example.com/v1')
})
it('旧配置保留标准思考，其他思考档位保存后重启可恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reader-mode-')); dirs.push(dir)
  const store = new ReaderStore(dir, codec)
  const settings = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'private-test-key', qps: 2 }
  await store.saveSettings(settings)
  expect((await store.settings()).reasoningEffort).toBe('high')
  await store.saveSettings({ ...settings, reasoningEffort: 'low' })
  expect((await new ReaderStore(dir, codec).settings()).reasoningEffort).toBe('low')
})

it('新配置推荐保真省钱，旧配置保持手动档位，显式模式可保存', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reader-economy-')); dirs.push(dir)
  const store = new ReaderStore(dir, codec)
  expect((await store.settings()).translationMode).toBe('economy')
  await store.saveSettings({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'private-test-key', qps: 2, reasoningEffort: 'high' })
  expect((await store.settings()).translationMode).toBe('manual')
  await store.saveSettings({ ...await store.settings(), translationMode: 'economy' })
  expect((await new ReaderStore(dir, codec).settings()).translationMode).toBe('economy')
})
