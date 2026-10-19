import { spawn } from 'node:child_process'
const files = ['src', 'tests', 'scripts', 'docs', 'skills', 'resources/reader_engine.py', 'resources/reader_layout.py', 'resources/reader_replay.py', 'resources/runtime-manifest.json', 'resources/installer.nsh', 'resources/icon.png', 'resources/icon.ico', 'package.json', 'package-lock.json', 'tsconfig.json', 'electron.vite.config.ts', 'vitest.config.ts', 'README.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE']
await new Promise((resolve, reject) => {
  const child = spawn('tar.exe', ['-a', '-cf', 'resources/source-code.zip', ...files], { windowsHide: true, stdio: 'inherit' })
  child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`源码打包失败：${code}`)))
})
console.log('应用源码已打包，安装后位于 resources/source-code.zip。')
