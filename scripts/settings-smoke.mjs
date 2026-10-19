import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

await mkdir('output/playwright', { recursive: true })
let discoveryCalls = 0; const submittedModels = []
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json')
  if (request.headers.authorization !== 'Bearer settings-test-secret') { response.writeHead(401); response.end(JSON.stringify({ error: { message: 'Invalid API key' } })); return }
  if (request.method === 'GET' && request.url === '/v1/models') {
    discoveryCalls++; response.end(JSON.stringify({ data: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }] })); return
  }
  if (request.method === 'POST' && request.url.endsWith('/chat/completions')) {
    let raw = ''; for await (const part of request) raw += part
    const body = JSON.parse(raw); submittedModels.push(body.model)
    if (!['deepseek-flash', 'custom/private-model'].includes(body.model)) { response.writeHead(400); response.end(JSON.stringify({ error: { message: 'Model Not Exist: ' + body.model + '; settings-test-secret' } })); return }
    response.end(JSON.stringify({ choices: [{ message: { content: '连接成功' } }] })); return
  }
  response.writeHead(404); response.end(JSON.stringify({ error: { message: 'Route not found' } }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const packaged = process.env.PAPER_READER_EXECUTABLE
const app = await electron.launch({ ...(packaged ? { executablePath: resolve(packaged) } : {}), args: [...(packaged ? [] : ['.']), `--data-dir=${resolve(`output/playwright/settings-${Date.now()}`)}`], env })
try {
  const page = await app.firstWindow(); const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('button', { name: '翻译设置', exact: true }).click()
  assert.equal(await page.getByLabel('翻译策略', { exact: true }).inputValue(), 'economy')
  await page.getByLabel('翻译策略', { exact: true }).selectOption('manual')
  assert.equal(await page.getByLabel('思考档位', { exact: true }).inputValue(), 'high')
  await page.getByLabel('思考档位', { exact: true }).selectOption('low')
  await page.getByLabel('服务地址', { exact: true }).fill(base)
  await page.getByLabel('API 密钥', { exact: true }).fill('settings-test-secret')
  await page.getByRole('button', { name: '获取模型', exact: true }).click({ timeout: 5000 })
  await page.getByLabel('可用模型', { exact: true }).selectOption('deepseek-flash')
  assert.equal(await page.getByLabel('模型名称', { exact: true }).inputValue(), 'deepseek-flash')
  assert.equal(await page.getByLabel('思考档位', { exact: true }).inputValue(), 'low')
  assert(await page.getByLabel('可用模型', { exact: true }).innerText().then(text => text.includes('DeepSeek-V4.1-Flash')))
  await page.getByLabel('模型名称', { exact: true }).fill('DeepSeek-V4.1-Flash')
  await page.getByRole('button', { name: '测试连接', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Model Not Exist' }).waitFor()
  assert(!(await page.locator('body').innerText()).includes('settings-test-secret'))
  await page.getByLabel('可用模型', { exact: true }).selectOption('deepseek-flash')
  await page.getByRole('button', { name: '测试连接', exact: true }).click()
  await page.getByText('连接成功，模型已返回有效回复。', { exact: true }).waitFor()
  assert.equal(submittedModels.at(-1), 'deepseek-flash')
  await page.screenshot({ path: 'output/playwright/model-selection.png' })
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '翻译设置', exact: true }).click()
  assert.equal(await page.getByLabel('API 密钥', { exact: true }).inputValue(), '')
  assert.equal(await page.getByLabel('翻译策略', { exact: true }).inputValue(), 'manual')
  await page.getByLabel('翻译策略', { exact: true }).selectOption('economy')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '翻译设置', exact: true }).click()
  assert.equal(await page.getByLabel('翻译策略', { exact: true }).inputValue(), 'economy')
  assert.equal(await page.getByLabel('思考档位', { exact: true }).count(), 0)
  await page.screenshot({ path: 'output/playwright/economy-settings.png' })
  assert.equal(await page.getByLabel('模型名称', { exact: true }).inputValue(), 'deepseek-flash')
  await page.getByRole('button', { name: '获取模型', exact: true }).click()
  await page.getByLabel('可用模型', { exact: true }).selectOption('deepseek-v4-pro')
  assert.equal(discoveryCalls, 2)
  await page.getByLabel('服务地址', { exact: true }).fill(base + '/no-list')
  assert(await page.getByLabel('可用模型', { exact: true }).isDisabled())
  await page.getByRole('button', { name: '获取模型', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '服务地址已更改' }).waitFor()
  await page.getByLabel('API 密钥', { exact: true }).fill('settings-test-secret')
  await page.getByRole('button', { name: '获取模型', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '手动填写' }).waitFor()
  await page.getByLabel('模型名称', { exact: true }).fill('custom/private-model')
  await page.getByRole('button', { name: '测试连接', exact: true }).click()
  await page.getByText('连接成功，模型已返回有效回复。', { exact: true }).waitFor()
  assert.equal(submittedModels.at(-1), 'custom/private-model')
  assert.deepEqual(errors, [])
  console.log('Settings UI passed: provider model list; API ID selection and submission; detailed HTTP 400 with redacted key; encrypted-key reuse; endpoint change; unsupported-list manual model.')
} finally { await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
