import { extractFile } from '@electron/asar'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const resources = resolve(process.argv[2] || 'release/win-unpacked/resources')
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(async entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]))).flat()
}
let count = 0
for (const file of await walk('out')) {
  assert((await readFile(file)).equals(extractFile(join(resources, 'app.asar'), file)), `Packaged build mismatch: ${file}`)
  count++
}
for (const file of ['reader_engine.py', 'reader_layout.py', 'reader_replay.py', 'source-code.zip']) assert((await readFile(join('resources', file))).equals(await readFile(join(resources, file))), `Packaged resource mismatch: ${file}`)
for (const file of await walk('skills/research-bilingual-translation')) assert((await readFile(file)).equals(await readFile(join(resources, file))), `Packaged skill mismatch: ${file}`)
console.log(`Packaged build (${count} files), layout adapters, skill and source archive match.`)
