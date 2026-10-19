import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Representative combinations, sequential so native input and CPU work in one
// reader cannot contaminate another. Keep heavy fixtures reported separately.
const cases = [
  { name: 'text-300-dpr1-half-single', args: ['--fixture=text', '--pages=300', '--dpr=1', '--zoom=0.5', '--mode=original'] },
  { name: 'text-300-dpr2-triple-dual', duration: 180000, args: ['--fixture=text', '--pages=300', '--dpr=2', '--zoom=3'] },
  { name: 'scan-96-dpr1-dual', args: ['--fixture=scan', '--pages=96', '--dpr=1'] },
  { name: 'vector-96-dpr2-dual', args: ['--fixture=vector', '--pages=96', '--dpr=2'] },
  { name: 'mixed-96-dpr15-dual', args: ['--fixture=mixed', '--pages=96', '--dpr=1.5'] },
  { name: 'annotations-stream-dpr15-dual', args: ['--dpr=1.5', '--annotations-per-page=32', '--background-ui'] },
]
const duration = process.argv.find(argument => argument.startsWith('--duration-ms='))
const prefix = process.argv.find(argument => argument.startsWith('--label-prefix='))?.slice('--label-prefix='.length) ?? (process.env.PAPER_READER_EXECUTABLE ? 'packaged-matrix' : 'source-matrix')
const directory = resolve('output/playwright', prefix); await mkdir(directory, { recursive: true })
const results = []
const only = process.argv.find(argument => argument.startsWith('--case='))?.slice('--case='.length)
for (const item of cases.filter(item => !only || item.name === only)) {
  const label = `${prefix}/${item.name}`
  const args = ['scripts/scroll-smoke.mjs', '--profile', '--foreground', '--rounds=1', duration ?? `--duration-ms=${item.duration ?? 60000}`, '--cache-mib=64', `--label=${label}`, ...item.args]
  console.log(JSON.stringify({ case: item.name, args }))
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: 'inherit', env: process.env })
    child.on('error', reject); child.on('exit', resolve)
  })
  let summary
  try { summary = JSON.parse(await readFile(resolve('output/playwright', label, 'summary.json'), 'utf8')) } catch {}
  results.push({ name: item.name, exitCode, args, summary })
  await writeFile(resolve(directory, 'summary.json'), JSON.stringify(results, null, 2))
}
if (results.some(result => result.exitCode || !result.summary || result.summary.failures.length)) process.exitCode = 1
