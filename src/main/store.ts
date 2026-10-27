import type { ProviderSettings, ReadingState, ServiceSettings } from '../shared/types'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeBaseUrl, validateProvider, validateSettings } from '../shared/core'
export interface SecretCodec { encrypt(value: string): Buffer; decrypt(value: Buffer): string }
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw new Error(`本地记录无法读取，请在数据目录检查 ${path.split(/[\\/]/).pop()}，原记录未被覆盖。`)
  }
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(temporary, path)
}
export class ReaderStore {
  private pending = new Map<string, Promise<void>>()
  constructor(readonly directory: string, private readonly codec: SecretCodec) {}
  private async write(path: string, value: unknown): Promise<void> {
    const operation = (this.pending.get(path) ?? Promise.resolve()).catch(() => {}).then(() => writeJson(path, value))
    this.pending.set(path, operation)
    try { await operation } finally { if (this.pending.get(path) === operation) this.pending.delete(path) }
  }
  async flush(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending.values()]) }
  async lastDocument(): Promise<string | null> {
    const value = await readJson<{ path: string | null } | null>(join(this.directory, 'last-document.json'), null)
    return typeof value?.path === 'string' ? value.path : null
  }
  async saveLastDocument(path: string | null): Promise<void> {
    await this.write(join(this.directory, 'last-document.json'), { path })
  }
  async settings(): Promise<ServiceSettings> {
    const saved = await readJson<({ baseUrl: string; model: string; qps: number; reasoningEffort?: 'low' | 'high' | 'max'; translationMode?: 'economy' | 'manual'; encryptedKey: string }) | null>(join(this.directory, 'settings.json'), null)
    if (!saved) return { baseUrl: '', model: '', apiKey: '', qps: 2, translationMode: 'economy' }
    let apiKey: string
    try { apiKey = this.codec.decrypt(Buffer.from(saved.encryptedKey, 'base64')) }
    catch { throw new Error('API 密钥无法解密，请在API 设置中重新配置。') }
    return validateSettings({ baseUrl: saved.baseUrl, model: saved.model, qps: saved.qps, apiKey, reasoningEffort: saved.reasoningEffort, translationMode: saved.translationMode })
  }
  async credentials(input: ProviderSettings): Promise<ProviderSettings> {
    if (input?.apiKey?.trim()) return validateProvider(input)
    const saved = await this.settings()
    let baseUrl: string
    try { baseUrl = normalizeBaseUrl(input?.baseUrl) } catch { throw new Error('服务地址不是有效的网址。') }
    if (saved.apiKey && baseUrl !== saved.baseUrl) throw new Error('服务地址已更改，请填写对应服务商的 API 密钥。')
    return validateProvider({ baseUrl, apiKey: saved.apiKey })
  }
  async saveSettings(input: ServiceSettings): Promise<void> {
    const settings = validateSettings({ ...input, ...await this.credentials(input) })
    await this.write(join(this.directory, 'settings.json'), { baseUrl: settings.baseUrl, model: settings.model, qps: settings.qps, reasoningEffort: settings.reasoningEffort, translationMode: settings.translationMode, encryptedKey: this.codec.encrypt(settings.apiKey).toString('base64') })
  }
  async reading(id: string): Promise<ReadingState | undefined> {
    this.checkId(id)
    return readJson<ReadingState | undefined>(join(this.directory, 'reading', `${id}.json`), undefined)
  }
  async saveReading(id: string, state: ReadingState): Promise<void> {
    this.checkId(id)
    const validPosition = (p: ReadingState['left']) => p && Number.isInteger(p.page) && p.page >= 1 && Number.isFinite(p.fraction) && p.fraction >= 0 && p.fraction <= 1
    if (state?.mode !== undefined && !['parallel', 'original', 'translated'].includes(state.mode)) throw new Error('阅读模式无效。')
    if (state?.translationKey !== undefined && (typeof state.translationKey !== 'string' || !/^[a-f0-9]{64}$/.test(state.translationKey))) throw new Error('阅读版本标识无效。')
    if (!state || !validPosition(state.left) || !validPosition(state.right) || !Number.isFinite(state.zoom) || state.zoom < 0.4 || state.zoom > 3 || (state.rightZoom !== undefined && (!Number.isFinite(state.rightZoom) || state.rightZoom < 0.4 || state.rightZoom > 3)) || !Number.isFinite(state.split) || state.split < 25 || state.split > 75 || typeof state.linked !== 'boolean') throw new Error('阅读位置无效。')
    await this.write(join(this.directory, 'reading', `${id}.json`), state)
  }
  private checkId(id: string) { if (!/^[a-f0-9]{1,64}$/.test(id)) throw new Error('文档标识无效。') }
}
