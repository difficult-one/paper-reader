import { access, readFile, mkdtemp } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { verifyTranslationSkill } from './translation-skill-manifest.mjs'
const skillManifest = await verifyTranslationSkill(resolve('skills/research-bilingual-translation'))
const compiledManifest = JSON.parse(await readFile('out/main/translation-policy.json', 'utf8'))
if (JSON.stringify(skillManifest) !== JSON.stringify(compiledManifest)) throw new Error('已构建翻译规则与随包 skill 不一致，请重新构建。')
await access('resources/runtime/pdf2zh/pdf2zh.exe')
for (const file of ['resources/runtime/pdf2zh/runtime/python.exe', 'resources/reader_engine.py', 'resources/reader_layout.py', 'resources/reader_replay.py', 'skills/research-bilingual-translation/references/translation-rules.txt']) await access(file)
const actual = JSON.parse(await readFile('resources/runtime/pdf2zh/.paper-reader-runtime.json', 'utf8'))
const expected = JSON.parse(await readFile('resources/runtime-manifest.json', 'utf8'))
if (actual.sha256 !== expected.sha256) throw new Error('运行时版本不匹配，请先运行 npm run runtime:prepare')
console.log('固定版本翻译运行时检查通过。')
if (process.argv.includes('--probe')) {
  const profile = await mkdtemp(resolve('output/runtime-probe-'))
  const child = spawn(resolve('resources/runtime/pdf2zh/runtime/python.exe'), [resolve('resources/reader_engine.py'), resolve('resources/runtime/pdf2zh'), '--version'], { windowsHide: true, stdio: 'inherit', env: { ...process.env, HOME: profile, USERPROFILE: profile, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } })
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`运行时启动失败：${code}`))) })
}
