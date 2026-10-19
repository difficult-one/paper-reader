const fs = require('node:fs/promises')
const path = require('node:path')
const [mode, input, ...args] = process.argv.slice(2)
const output = args[args.indexOf('--output') + 1]
async function main() {
  console.log('Translate Paragraphs 42% ' + process.env.PDF2ZH_OPENAI_API_KEY)
  if (mode === 'recovered') console.log('WARNING Retrying: RateLimitError: Error code: 429, will retry')
  if (mode === 'fatal') { console.log('DetectScannedFile 100%'); console.log('ERROR: Translation validation failed: invalid numbers.'); process.exitCode = 1; return }
  if (mode === 'slow') { setInterval(() => {}, 1000); return }
  if (mode === 'delayed') await new Promise(resolve => setTimeout(resolve, 200))
  if (mode === 'empty') return
  if (mode === 'api') {
    const response = await fetch(args[args.indexOf('--openai-base-url') + 1] + '/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.PDF2ZH_OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'You are a professional zh native translator.\n\n## Structure Rules\nKeep IDs.\n\n## Output Format\nReturn JSON.\n\n## Here is the input:\n[{"id":0,"input":"A scientific sentence."}]' }] })
    })
    if (!response.ok) throw new Error('Translation failed')
    const result = await response.json()
    if (!JSON.parse(result.choices[0].message.content)[0].output) throw new Error('Missing output')
  }
  await fs.mkdir(output, { recursive: true })
  if (mode === 'invalid') { await fs.writeFile(path.join(output, 'paper.zh.mono.pdf'), 'broken'); return }
  await fs.copyFile(input, path.join(output, 'paper.zh.mono.pdf'))
  if (mode === 'audit') await fs.writeFile(path.join(output, 'audit.json'), JSON.stringify({ profile: process.env.USERPROFILE, args, key: process.env.PDF2ZH_OPENAI_API_KEY }))
}
main().catch(() => process.exit(1))
