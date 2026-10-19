import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const child = spawn(resolve('resources/runtime/pdf2zh/runtime/python.exe'), [resolve('tests/layout_adapter_test.py')], { windowsHide: true, stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
