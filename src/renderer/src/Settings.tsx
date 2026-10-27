import { useEffect, useState } from 'react'
import { Check, KeyRound, LoaderCircle, Settings2, X } from 'lucide-react'
import type { AppInfo, AvailableModel, PublicSettings, ServiceSettings } from '../../shared/types'
interface Props { current: PublicSettings | null; info: AppInfo | null; close(): void; saved(settings: PublicSettings): void }
export function Settings({ current, info, close, saved }: Props) {
  const [form, setForm] = useState<ServiceSettings>({ baseUrl: current?.baseUrl ?? '', model: current?.model ?? '', apiKey: '', qps: current?.qps ?? 2, reasoningEffort: current?.reasoningEffort ?? 'high', translationMode: current?.translationMode ?? 'economy' })
  const [busy, setBusy] = useState(''); const [message, setMessage] = useState(''); const [success, setSuccess] = useState(false)
  const [models, setModels] = useState<AvailableModel[]>([])
  const update = (field: keyof ServiceSettings, value: string | number) => {
    setForm(previous => ({ ...previous, [field]: value })); setMessage(''); setSuccess(false)
    if (field === 'baseUrl' || field === 'apiKey') setModels([])
  }
  useEffect(() => { const listener = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) close() }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener) }, [close, busy])
  const action = async (test: boolean) => {
    setBusy(test ? 'test' : 'save'); setMessage(''); setSuccess(false)
    try {
      if (test) { const result = await window.reader.testConnection(form); if (!result.ok) throw new Error(result.error); setMessage(result.value); setSuccess(true) }
      else { const result = await window.reader.saveSettings(form); if (!result.ok) throw new Error(result.error); saved(result.value) }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy('') }
  }
  const fetchModels = async () => {
    setBusy('models'); setMessage(''); setSuccess(false); setModels([])
    try {
      const result = await window.reader.listModels({ baseUrl: form.baseUrl, apiKey: form.apiKey })
      if (!result.ok) throw new Error(result.error)
      setModels(result.value); setMessage(`已获取 ${result.value.length} 个模型，请从列表选择。`); setSuccess(true)
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy('') }
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close() }}>
    <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-heading">
      <header className="modal-header"><div className="modal-icon"><Settings2 size={21} /></div><div><h2 id="settings-heading">API 设置</h2><p>连接用于论文询问的服务与模型</p></div><button className="icon-button" aria-label="关闭设置" onClick={close} disabled={Boolean(busy)}><X size={20} /></button></header>
      <form onSubmit={event => { event.preventDefault(); void action(false) }}>
        <div className="settings-body">
          <div className="info-card"><KeyRound size={18} /><p>支持 OpenAI 兼容的 Chat Completions 接口。密钥加密保存在这台电脑上，提问时会将问题、选中文字及相关论文片段发送至你配置的服务商。</p></div>
          <label className="field">服务地址<input aria-label="服务地址" autoFocus type="url" placeholder="https://你的服务地址/v1" value={form.baseUrl} onChange={e => update('baseUrl', e.target.value)} required disabled={Boolean(busy)} /><small>填写 API 基础地址，无需填写 /chat/completions。</small></label>
          <label className="field">API 密钥<input aria-label="API 密钥" type="password" autoComplete="off" placeholder={current?.hasApiKey ? '已加密保存，留空可继续使用' : '填写你的 API Key'} value={form.apiKey} onChange={e => update('apiKey', e.target.value)} required={!current?.hasApiKey} disabled={Boolean(busy)} /><small>{current?.hasApiKey ? '同一服务地址可留空复用已存密钥；更换地址需填写对应密钥。' : '请勿与他人分享你的密钥。服务商可能按用量收费。'}</small></label>
          <div className="field model-field">
            <div className="model-field-heading"><label htmlFor="model-id">问答模型</label><button type="button" className="button secondary small" onClick={() => void fetchModels()} disabled={Boolean(busy)}>{busy === 'models' && <LoaderCircle size={14} className="spin" />}获取模型</button></div>
            <select aria-label="可用模型" value={models.some(model => model.id === form.model) ? form.model : ''} onChange={e => update('model', e.target.value)} disabled={Boolean(busy) || !models.length}>
              <option value="" disabled>{models.length ? '从列表选择，或在下方手动填写' : '填写地址与密钥后，点击“获取模型”'}</option>
              {models.map(model => <option key={model.id} value={model.id}>{model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id}</option>)}
            </select>
            <input id="model-id" aria-label="模型名称" placeholder="也可手动填写服务商提供的 API 模型 ID" value={form.model} onChange={e => update('model', e.target.value)} required disabled={Boolean(busy)} />
            <small>选择后会填入实际 API 模型 ID；展示名称与 API ID 可能不同。服务商不提供列表时，可直接手动填写。</small>
          </div>
          <label className="field compact-field">每秒请求数<select value={form.qps} onChange={e => update('qps', Number(e.target.value))} disabled={Boolean(busy)}>{[1, 2, 3, 4, 6, 8].map(n => <option key={n}>{n}</option>)}</select><small>遇到限流时，可降为 1 后重试。</small></label>
          <label className="field">DeepSeek 思考档位<select aria-label="思考档位" value={form.reasoningEffort} onChange={e => update('reasoningEffort', e.target.value)} disabled={Boolean(busy)}><option value="low">轻度思考 · Low</option><option value="high">标准思考 · High</option><option value="max">深度思考 · Max</option></select><small>仅对 DeepSeek 官方接口生效。更深思考可能增加问答耗时和费用，不保证回答更准确。</small></label>
          {message && <div className={`form-message ${success ? 'success' : 'failure'}`} role="status">{success && <Check size={16} />}{message}</div>}
          <details className="about"><summary>关于软件</summary><p>论文对照阅读器 {info?.version ?? ''}<br />许可证：AGPL-3.0。PDF.js：Apache-2.0。</p><button type="button" className="text-button" onClick={() => void window.reader.showDataFolder()}>打开本地数据目录</button></details>
        </div>
        <footer className="modal-footer"><button type="button" className="button secondary" onClick={() => void action(true)} disabled={Boolean(busy)}>{busy === 'test' && <LoaderCircle size={16} className="spin" />}测试连接</button><button type="submit" className="button primary" disabled={Boolean(busy)}>{busy === 'save' && <LoaderCircle size={16} className="spin" />}保存设置</button></footer>
      </form>
    </section>
  </div>
}
