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
for (const file of ['source-code.zip', 'icon.png']) assert((await readFile(join('resources', file))).equals(await readFile(join(resources, file))), `Packaged resource mismatch: ${file}`)
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) assert((await readFile(file)).equals(await readFile(join(resources, file))), `Packaged notice mismatch: ${file}`)
console.log(`Packaged build (${count} files), notices and source archive match.`)
