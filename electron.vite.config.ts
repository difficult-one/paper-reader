import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { cpSync, mkdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

execFileSync(process.execPath, [resolve('scripts/translation-skill-manifest.mjs'), 'verify'], { stdio: 'inherit', windowsHide: true })
const translationManifest = readFileSync(resolve('skills/research-bilingual-translation/provenance.json'), 'utf8')
const translationProvenance = { name: 'translation-skill-provenance', generateBundle(this: { emitFile: (file: { type: 'asset'; fileName: string; source: string }) => unknown }) { this.emitFile({ type: 'asset', fileName: 'translation-policy.json', source: translationManifest }) } }

for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  const target = resolve('src/renderer/public/pdf-assets', directory)
  mkdirSync(target, { recursive: true })
  cpSync(resolve('node_modules/pdfjs-dist', directory), target, { recursive: true })
}

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin(), translationProvenance], build: { rollupOptions: { input: { index: 'src/main/index.ts', 'document-context-worker': 'src/main/document-context-worker.ts', 'pdf-raster-worker': 'src/main/pdf-raster-worker.ts', 'pdf-raster-process': 'src/main/pdf-raster-process.ts' } } } },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: 'src/preload/index.ts', output: { format: 'cjs', entryFileNames: 'index.cjs' } } } },
  renderer: { root: 'src/renderer', plugins: [react()] }
})
