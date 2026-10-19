// Reconcile this authorized experiment's attempts without changing original ledgers.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = resolve('output/translation-skill-evals')
const names = ['live-deepseek-20261018', 'live-deepseek-20261018-corrected', 'live-deepseek-20261018-final']
const chinaDate = value => { const date = new Date(Date.parse(value) + 8 * 3600000); return Number.isFinite(+date) ? { date: date.toISOString().slice(0, 10), day: date.getUTCDay() } : null }
const isThisSunday = value => { const date = chinaDate(value); return date?.date === '2026-10-18' && date.day === 0 }
const attempts = []
for (const name of names) {
  const directory = join(root, name)
  const ledger = JSON.parse(await readFile(join(directory, 'budget-ledger.json'), 'utf8'))
  const state = JSON.parse(await readFile(join(directory, 'collection-state.json'), 'utf8'))
  const records = []
  for (const file of await readdir(join(directory, 'diagnostics'), { recursive: true })) {
    if (!file.endsWith('.jsonl')) continue
    for (const line of (await readFile(join(directory, 'diagnostics', file), 'utf8')).trim().split(/\r?\n/)) {
      if (line.trim()) { const record = JSON.parse(line); if (record.source === 'remote') records.push(record) }
    }
  }
  const identifiers = records.map(row => JSON.stringify([row.taskId, row.logicalFingerprint, row.attempt]))
  if (new Set(identifiers).size !== records.length) throw new Error(`Duplicate paid diagnostic records: ${name}`)
  const sunday = records.every(row => isThisSunday(row.sentAt) && isThisSunday(row.timestamp)) && isThisSunday(state.startedAt) && isThisSunday(state.finishedAt)
  let knownOffpeakCny = 0; let unknownUsageRecords = 0
  const phases = {}
  for (const row of records) {
    phases[row.phase] = (phases[row.phase] ?? 0) + 1
    const usage = row.usage
    const miss = usage?.missTokens ?? usage?.estimatedMissTokens
    if (!usage?.comparable || ![usage.hitTokens, miss, usage.completionTokens].every(value => Number.isSafeInteger(value) && value >= 0)) { unknownUsageRecords++; continue }
    // Thinking tokens are already part of completionTokens; never add them twice.
    knownOffpeakCny += (usage.hitTokens * .02 + miss + usage.completionTokens * 4) / 1000000
  }
  const plan = JSON.parse(await readFile(join(directory, 'request-plan.json'), 'utf8'))
  const outputs = JSON.parse(await readFile(join(directory, 'outputs.json'), 'utf8'))
  if (ledger.mode !== 'live' || ledger.prices?.hit !== .006 || ledger.prices?.miss !== .3 || ledger.prices?.output !== 1.2 || !Number.isFinite(ledger.knownUsd) || ledger.knownUsd < 0) throw new Error('Ledger does not match the verified tariff')
  // Ledgers settle every paid call. Retained diagnostics may be a subset after rotation.
  const ledgerOffpeak = ledger.knownUsd * 10 / 3
  attempts.push({ directory, state: state.status, allPlannedOutputsAttempted: outputs.every(row => row.status !== 'missing'), expectedTaskLogs: plan.length * 2, retainedTaskLogs: (await readdir(join(directory, 'diagnostics'), { recursive: true })).filter(file => file.endsWith('.jsonl')).length, retainedPaidDiagnosticRequests: records.length, retainedPhases: phases, sundayOffpeakVerified: sunday, knownOffpeakEstimateCny: sunday ? ledgerOffpeak : null, retainedDiagnosticsOffpeakSubtotalCny: sunday ? knownOffpeakCny : null, diagnosticsCoverKnownLedger: Math.abs(ledgerOffpeak - knownOffpeakCny) < 1e-9, unknownUsageRecords, conservativeLedgerKnownCny: ledger.knownUsd * 20 / 3, retainedUnknownRequests: ledger.unknownRequests, retainedUnknownPeakUpperCny: ledger.reservedUsd * 20 / 3, retainedUnknownOffpeakUpperCny: sunday ? ledger.reservedUsd * 10 / 3 : null, ledgerLimitUsd: ledger.limitUsd })
}
const allSunday = attempts.every(row => row.sundayOffpeakVerified)
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), currency: 'CNY', authorizedTotal: 10,
  officialTariff: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', tariffVerifiedOn: '2026-10-18',
  lowPeakUnitPricesPerMillion: { hit: .02, miss: 1, output: 4 },
  pricingBasis: 'Sunday off-peak estimate from provider token usage. Original budget ledgers retain conservative peak rates. This report is not a provider invoice.',
  attempts, knownOffpeakEstimateCny: allSunday ? attempts.reduce((sum, row) => sum + row.knownOffpeakEstimateCny, 0) : null,
  unresolvedOffpeakUpperCny: allSunday ? attempts.reduce((sum, row) => sum + row.retainedUnknownOffpeakUpperCny, 0) : null,
  conservativeKnownAndReservedCny: attempts.reduce((sum, row) => sum + row.conservativeLedgerKnownCny + row.retainedUnknownPeakUpperCny, 0),
  allPlannedOutputsAttempted: attempts.at(-1).allPlannedOutputsAttempted,
  complete: attempts.at(-1).state === 'collected',
  limitations: ['Includes failed and invalid-harness attempts, not only successful translations.', 'An interrupted request remains bounded but unconfirmed unless reconciled with provider billing.', 'Cached outputs retain their original attempt costs; a local cache hit is not billed again.', 'The completed trial used the default 30-task diagnostic retention, so earlier individual logs were rotated out. Totals use the cumulative UsageBudget ledger, not the retained-log subtotal. Future collection now isolates diagnostics per batch/arm to preserve every phase.']
}
await writeFile(join(root, 'acceptance', 'cost-report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ complete: report.complete, knownOffpeakEstimateCny: report.knownOffpeakEstimateCny, unresolvedOffpeakUpperCny: report.unresolvedOffpeakUpperCny, conservativeKnownAndReservedCny: report.conservativeKnownAndReservedCny }))
