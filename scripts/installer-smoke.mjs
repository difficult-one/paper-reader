import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { resolve, join, basename } from 'node:path'
import assert from 'node:assert/strict'

// Exercise the actual NSIS extraction DLL without registering/uninstalling any application.
const execute = promisify(execFile)
const config = JSON.parse(await readFile('package.json', 'utf8'))
const installer = resolve(process.argv[2] ?? `release/PaperReader-Setup-${config.version}.exe`)
const cache = resolve(process.env.ELECTRON_BUILDER_CACHE ?? '.downloads/electron-builder')
async function findTool(directory, matches) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile() && matches(path)) return path
    if (entry.isDirectory()) { const result = await findTool(path, matches); if (result) return result }
  }
}
const sevenZip = await findTool(cache, path => /[\\/]7za\.exe$/i.test(path))
const compiler = await findTool(cache, path => /[\\/]Bin[\\/]makensis\.exe$/i.test(path))
const plugin = await findTool(cache, path => /[\\/]x86-unicode[\\/]nsisunz\.dll$/i.test(path))
assert(sevenZip && compiler && plugin, 'Build the installer first to prepare its NSIS tools.')
const { stdout } = await execute(sevenZip, ['l', '-slt', '-sccUTF-8', installer], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
assert.match(stdout, /^Type = zip\r?$/m, 'This check exercises the ZIP extractor selected by this installer.')
const offset = Number(stdout.match(/^Offset = (\d+)/m)?.[1] ?? 0)
const size = Number(stdout.match(/^Physical Size = (\d+)/m)?.[1])
assert(Number.isSafeInteger(offset) && Number.isSafeInteger(size) && size > 0)
const directory = resolve('output/installer-smoke', `${Date.now()}-${config.version}`)
await mkdir(directory, { recursive: true })
const archive = join(directory, 'app.zip')
await pipeline(createReadStream(installer, { start: offset, end: offset + size - 1 }), createWriteStream(archive))
const target = join(directory, '安装验证')
const resultFile = join(directory, 'result.txt')
const probe = join(directory, 'extract-probe.exe')
const quote = text => text.replaceAll('$', '$$').replaceAll('"', '$\\"')
const source = `Unicode true
Name "PaperReader installer extraction check"
OutFile "${quote(probe)}"
RequestExecutionLevel user
SilentInstall silent
!addplugindir /x86-unicode "${quote(resolve(plugin, '..'))}"
Section
  CreateDirectory "${quote(target)}"
  nsisunz::Unzip "${quote(archive)}" "${quote(target)}"
  Pop $0
  FileOpen $1 "${quote(resultFile)}" w
  FileWrite $1 "$0$\\r$\\n"
  FileClose $1
  StrCmp $0 "success" +3
    SetErrorLevel 1
    Quit
SectionEnd
`
const script = join(directory, 'extract-probe.nsi')
await writeFile(script, '\ufeff' + source)
await execute(compiler, ['/V2', script], { windowsHide: true })
const started = performance.now()
let executionError
try { await execute(probe, [], { windowsHide: true }) } catch (error) { executionError = error }
const result = (await readFile(resultFile, 'utf8')).trim()
assert.equal(result, 'success', `NSIS failed to extract ${basename(installer)}: ${result}. Probe files: ${directory}`)
if (executionError) throw executionError
const executableName = (config.build.win.executableName ?? config.build.executableName ?? config.build.productName) + '.exe'
for (const file of [executableName, 'resources/app.asar', 'resources/source-code.zip', 'resources/LICENSE', 'resources/THIRD_PARTY_NOTICES.md']) await access(join(target, file))
await assert.rejects(access(join(target, 'resources/runtime/pdf2zh')), 'The new installer must not include the removed translation runtime.')
const report = { installer, target, executable: join(target, executableName), extractor: plugin, result, elapsedSeconds: +(Math.max(0, performance.now() - started) / 1000).toFixed(2) }
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
