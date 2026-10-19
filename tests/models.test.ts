import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import * as engine from '../src/main/engine'

let server: Server | undefined
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }; server = undefined })
async function serve(status: number, payload: unknown) {
  server = createServer((request, response) => {
    if (request.url !== '/custom/models' || request.method !== 'GET' || request.headers.authorization !== 'Bearer private-model-secret') { response.writeHead(400); response.end(); return }
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server!.address(); if (!address || typeof address === 'string') throw new Error('server')
  return { baseUrl: `http://127.0.0.1:${address.port}/custom`, apiKey: 'private-model-secret' }
}
it('无需先填模型，实际请求服务商模型列表，并区分 API ID 与展示名', async () => {
  const config = await serve(200, { data: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }, { id: 'another-model' }, { id: 'deepseek-flash' }, { name: 'invalid' }] })
  expect(typeof engine.listModels).toBe('function')
  expect(await engine.listModels(config)).toEqual([{ id: 'another-model' }, { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }])
})
it('服务商不支持模型列表时明确提示可手动输入', async () => {
  const config = await serve(404, { error: { message: 'route not found' } })
  expect(typeof engine.listModels).toBe('function')
  await expect(engine.listModels(config)).rejects.toThrow(/手动/)
})
it('空或无效模型列表不会被当成可用模型', async () => {
  const config = await serve(200, { data: [{ id: '' }, { id: 42 }] })
  expect(typeof engine.listModels).toBe('function')
  await expect(engine.listModels(config)).rejects.toThrow(/模型/)
})
it('模型列表鉴权失败隐藏密钥并给出可理解的提示', async () => {
  const config = await serve(401, { error: { message: 'Invalid key private-model-secret' } })
  expect(typeof engine.listModels).toBe('function')
  await expect(engine.listModels(config)).rejects.toThrow(/密钥/)
  try { await engine.listModels(config) } catch (error) { expect(String(error)).not.toContain(config.apiKey) }
})
it('HTTP 400 显示实际服务商错误并隐藏新填密钥', async () => {
  server = createServer((_request, response) => {
    response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Model Not Exist: requested-name; private-model-secret', code: 'model_not_found' } }))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('server')
  let message = ''
  try { await engine.testConnection({ baseUrl: `http://127.0.0.1:${address.port}`, model: 'requested-name', apiKey: 'private-model-secret', qps: 1 }) } catch (error) { message = String(error) }
  expect(message).toContain('400'); expect(message).toContain('Model Not Exist'); expect(message).not.toContain('private-model-secret')
})
