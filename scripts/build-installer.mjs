import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

// Keep extracted build tools beside the workspace. EFS-encrypted user caches
// can reject the directory rename used by electron-builder on Windows.
const env = { ...process.env, ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE || resolve('.downloads/electron-builder') }
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['node_modules/electron-builder/out/cli/cli.js', '--win', 'nsis', '--x64', '--publish', 'never'], { windowsHide: true, stdio: 'inherit', env })
  child.on('error', reject)
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`安装包构建失败：${code}`)))
})
