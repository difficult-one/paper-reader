import { readFile, mkdir, writeFile, access } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
const manifest = JSON.parse(await readFile(new URL('../resources/runtime-manifest.json', import.meta.url)))
await mkdir('.downloads', { recursive: true })
await mkdir('resources/runtime', { recursive: true })
const archive = resolve('.downloads/pdf2zh.zip')
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit', windowsHide: true })
  child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command}: ${code}`)))
})
try { await access(archive) } catch {
  await run('curl.exe', ['-L', '--fail', '--retry', '3', '--silent', '--show-error', manifest.url, '-o', archive])
}
const hash = createHash('sha256')
for await (const chunk of createReadStream(archive)) hash.update(chunk)
if (hash.digest('hex') !== manifest.sha256) throw new Error('运行包校验失败，请删除 .downloads/pdf2zh.zip 后重试。')
console.log('运行包 SHA-256 校验通过，正在解压。')
await run('tar.exe', ['-xf', archive, '-C', resolve('resources/runtime')])
await writeFile('resources/runtime/pdf2zh/.paper-reader-runtime.json', JSON.stringify(manifest, null, 2))
console.log('PDFMathTranslate-next 2.9.0 运行时已准备。')
