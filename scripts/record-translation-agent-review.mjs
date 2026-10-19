// Serialize the assessments actually made in this chat. This is not a model grader.
// Freeze the masked decisions before consulting the private arm mapping.
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'

const directory = resolve(process.argv[2] ?? 'output/translation-skill-evals/live-deepseek-20261018-final')
const target = join(directory, 'agent-review')
const sha = value => createHash('sha256').update(value).digest('hex')
const loadBytes = name => readFile(join(directory, name))
const load = async name => JSON.parse((await loadBytes(name)).toString('utf8'))
const rowsBytes = await loadBytes('blind-review.json')
const rows = JSON.parse(rowsBytes.toString('utf8'))
const groups = await load('agent-review/deidentified-groups.json')
const notes = {}; const noteHashes = {}
for (const name of (await readdir(target)).filter(name => /^notes-\d+-\d+\.json$/.test(name)).sort()) {
  const bytes = await readFile(join(target, name))
  noteHashes[name] = sha(bytes)
  for (const [id, value] of Object.entries(JSON.parse(bytes.toString('utf8')))) {
    if (Object.hasOwn(notes, id)) throw new Error(`Duplicate group assessment: ${id}`)
    notes[id] = value
  }
}
if (new Set(rows.map(row => row.blindId)).size !== rows.length) throw new Error('Duplicate blind input')
if (groups.length !== Object.keys(notes).length) throw new Error('Assessment group coverage mismatch')
const byId = new Map(rows.map(row => [row.blindId, row]))
const reviewedAt = new Date().toISOString()
const reviewer = 'Codex assistant; in-session masked-identity agent review'
const details = []
for (const group of groups) {
  const assessments = notes[group.groupId]
  if (!Array.isArray(assessments) || assessments.length !== group.variants.length) throw new Error(`Missing variant assessment: ${group.groupId}`)
  group.variants.forEach((variant, index) => {
    const note = assessments[index]
    const assessment = typeof note === 'string' ? note : note?.assessment
    const issues = typeof note === 'string' ? [] : note?.issues
    if (!assessment?.trim() || !Array.isArray(issues)) throw new Error('Empty assessment')
    for (const issue of issues) {
      if (!['critical', 'major', 'minor'].includes(issue.severity) || !['negation', 'condition', 'strength', 'statistics', 'binding', 'limitation', 'terminology', 'other'].includes(issue.category) || !issue.issue?.trim() || !issue.sourceQuote?.trim() || !group.source.includes(issue.sourceQuote) || !issue.translationQuote?.trim() || !variant.translation.includes(issue.translationQuote)) throw new Error(`Invalid literal issue evidence: ${group.groupId}`)
    }
    for (const blindId of variant.blindIds) {
      const row = byId.get(blindId)
      if (!row || row.source !== group.source || row.translation !== variant.translation || row.documentId !== group.documentId || row.page !== group.page || JSON.stringify(row.rect) !== JSON.stringify(group.rect)) throw new Error(`Changed masked input: ${blindId}`)
      details.push({ blindId, groupId: group.groupId, documentId: row.documentId, page: row.page, rect: row.rect, source: row.source, translation: row.translation, sourceHash: sha(row.source), outputHash: sha(row.translation), status: 'reviewed', reviewer, reviewedAt, method: 'agent', assessment, issues })
    }
  })
}
if (details.length !== rows.length || new Set(details.map(row => row.blindId)).size !== rows.length) throw new Error('Missing or duplicated translation assessment')
details.sort((a, b) => a.blindId.localeCompare(b.blindId))
const decisions = details.map(({ blindId, status, reviewer, reviewedAt, method, issues }) => ({ blindId, status, reviewer, reviewedAt, method, issues }))
const decisionsText = JSON.stringify(decisions, null, 2) + '\n'
const detailText = JSON.stringify(details, null, 2) + '\n'
await writeFile(join(target, 'agent-decisions.json'), decisionsText)
await writeFile(join(target, 'agent-review-detail.json'), detailText)
const limitations = [
  '代理已逐项阅读冻结原文和现存译文；这是代理审阅，不是人工审阅，未修改原始 pending 人工模板。',
  '本轮评分材料隐藏策略身份，但同一会话此前已接触两项候选模型问题和采集统计，不满足严格独立盲评。',
  '同一源段的不同译文并排核对，完全相同的源段/译文共用一次实质判断后逐条展开；策略身份在冻结决定后才用于汇总。',
  '只核对冻结文本片段；未逐页重新检查全部原始 PDF，源文跨页截断、压平代码和异常 DOI 空格单列为来源边界。',
  '无问题仅表示本次未发现有证据的问题，不构成语义正确性保证。失败输出无可审译文，仍在 400 条预期分母中。',
  'reviewedAt 为本批审阅完成记录时间，不声称是每条开始或结束的精确时刻。'
]
const manifest = { schemaVersion: 1, recordedAt: reviewedAt, method: 'agent', strictIndependentBlind: false, humanReviewed: 0, paidApiCalls: 0, inputFile: 'blind-review.json', inputSha256: sha(rowsBytes), notesSha256: noteHashes, decisionsSha256: sha(decisionsText), detailSha256: sha(detailText), groupsReviewed: groups.length, distinctTranslationsRead: groups.reduce((sum, group) => sum + group.variants.length, 0), translationRowsReviewed: decisions.length, limitations }
// This manifest is written while all decisions still contain only opaque blind IDs.
await writeFile(join(target, 'decisions-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

const keys = await load('blind-key.json')
const cases = await load('source-cases.json')
const runs = await load('outputs.json')
const policies = await load('policies.json')
const keyRunIds = keys.map(key => JSON.stringify([key.caseId, key.arm]))
const completedRunIds = new Set(runs.filter(run => run.status === 'completed' && run.output.trim()).map(run => JSON.stringify([run.caseId, run.arm])))
if (new Set(keys.map(key => key.blindId)).size !== keys.length || keys.length !== rows.length || new Set(keyRunIds).size !== keys.length || completedRunIds.size !== keys.length || keyRunIds.some(id => !completedRunIds.has(id))) throw new Error('Invalid private mapping: completed runs and reviewed identities must correspond one to one')
const privateById = new Map(keys.map(key => [key.blindId, key]))
const sourceById = new Map(cases.map(sample => [sample.id, sample]))
const runById = new Map(runs.map(run => [JSON.stringify([run.caseId, run.arm]), run]))
if (sourceById.size !== cases.length || runById.size !== runs.length || runs.length !== cases.length * 2) throw new Error('Invalid source/run denominator')
for (const sample of cases) if (sha(sample.source) !== sample.sourceHash) throw new Error('Changed frozen source')
for (const run of runs) if (!sourceById.has(run.caseId) || !['baseline', 'candidate'].includes(run.arm) || run.sourceHash !== sourceById.get(run.caseId).sourceHash || run.policy !== policies[run.arm]) throw new Error('Changed run source/policy')
const unblinded = details.map(row => {
  const mapping = privateById.get(row.blindId)
  const run = mapping && runById.get(JSON.stringify([mapping.caseId, mapping.arm]))
  if (!mapping || !run || run.status !== 'completed' || row.sourceHash !== mapping.sourceHash || row.outputHash !== mapping.outputHash || run.output !== row.translation || sourceById.get(mapping.caseId).source !== row.source) throw new Error('Private mapping does not match reviewed text')
  return { ...row, caseId: mapping.caseId, arm: mapping.arm, discipline: sourceById.get(mapping.caseId).discipline }
})
const reviewedByRun = new Map(unblinded.map(row => [JSON.stringify([row.caseId, row.arm]), row]))
const count = (selectedCases, arm) => {
  const selectedIds = new Set(selectedCases.map(sample => sample.id))
  const selectedRuns = runs.filter(run => selectedIds.has(run.caseId) && run.arm === arm)
  const reviewed = unblinded.filter(row => selectedIds.has(row.caseId) && row.arm === arm)
  const issues = reviewed.flatMap(row => row.issues)
  const ordinaryErrorParagraphs = reviewed.filter(row => row.issues.some(issue => issue.severity !== 'critical')).length
  return { expected: selectedCases.length, translated: selectedRuns.filter(run => run.status === 'completed').length, failed: selectedRuns.filter(run => run.status === 'failed').length, missing: selectedRuns.filter(run => run.status === 'missing').length, agentReviewed: reviewed.length, humanReviewed: 0, criticalIssues: issues.filter(issue => issue.severity === 'critical').length, majorIssues: issues.filter(issue => issue.severity === 'major').length, minorIssues: issues.filter(issue => issue.severity === 'minor').length, criticalParagraphs: reviewed.filter(row => row.issues.some(issue => issue.severity === 'critical')).length, ordinaryErrorParagraphs, agentOrdinaryErrorRate: reviewed.length ? ordinaryErrorParagraphs / reviewed.length : null }
}
const arms = ['baseline', 'candidate']
const summary = Object.fromEntries(arms.map(arm => [arm, count(cases, arm)]))
const sliceSummary = field => Object.fromEntries([...new Set(cases.map(sample => sample[field]))].map(value => [value, Object.fromEntries(arms.map(arm => [arm, count(cases.filter(sample => sample[field] === value), arm)]))]))
const paired = cases.flatMap(sample => {
  const baseline = reviewedByRun.get(JSON.stringify([sample.id, 'baseline']))
  const candidate = reviewedByRun.get(JSON.stringify([sample.id, 'candidate']))
  return baseline && candidate ? [{ sample, baseline, candidate }] : []
})
const hasError = row => row.issues.length > 0
const pairedComparison = {
  commonReviewedCases: paired.length,
  bothWithoutObservedIssues: paired.filter(pair => !hasError(pair.baseline) && !hasError(pair.candidate)).length,
  baselineOnlyHasObservedIssues: paired.filter(pair => hasError(pair.baseline) && !hasError(pair.candidate)).length,
  candidateOnlyHasObservedIssues: paired.filter(pair => !hasError(pair.baseline) && hasError(pair.candidate)).length,
  bothHaveObservedIssues: paired.filter(pair => hasError(pair.baseline) && hasError(pair.candidate)).length,
  baselineErrorParagraphs: paired.filter(pair => hasError(pair.baseline)).length,
  candidateErrorParagraphs: paired.filter(pair => hasError(pair.candidate)).length,
  baselineOnlyAvailableCases: cases.filter(sample => reviewedByRun.has(JSON.stringify([sample.id, 'baseline'])) && !reviewedByRun.has(JSON.stringify([sample.id, 'candidate']))).length,
  candidateOnlyAvailableCases: cases.filter(sample => !reviewedByRun.has(JSON.stringify([sample.id, 'baseline'])) && reviewedByRun.has(JSON.stringify([sample.id, 'candidate']))).length,
  neitherAvailableCases: cases.filter(sample => !reviewedByRun.has(JSON.stringify([sample.id, 'baseline'])) && !reviewedByRun.has(JSON.stringify([sample.id, 'candidate']))).length
}
const observations = [
  { groupId: 'G175', kind: 'source-ambiguity', countedAsConfirmedError: false, issue: 'times more 的总倍数/增加倍数歧义不能仅据此认定译文数值错误；需要核对来源作者意图。' },
  { groupId: 'G033', kind: 'severity-adjudication', countedAsConfirmedError: true, issue: '先前模型标 major 的分拉格朗日数据缺字，本轮标 minor：相邻句已完整表达分析用途，此处可直接补析，未发现科学关系反转。' }
]
const report = { ...manifest, policies, scope: 'Completed frozen outputs only; diagnostic agent evidence, not human release acceptance.', summary, pairedComparison, byPaper: sliceSummary('documentId'), byDiscipline: sliceSummary('discipline'), issueRows: unblinded.filter(row => row.issues.length > 0), observations, sourceBoundaryExamples: ['G003', 'G044', 'G079', 'G098', 'G148', 'G156', 'G179'], releaseReady: false }
await writeFile(join(target, 'agent-review-summary.json'), JSON.stringify(report, null, 2) + '\n')
const percent = value => value === null ? '无分母' : `${(100 * value).toFixed(2)}%`
const tableRows = arms.map(arm => { const c = summary[arm]; return `| ${arm === 'baseline' ? '旧策略' : '新策略'} | ${c.expected} | ${c.agentReviewed} | ${c.failed} | ${c.criticalIssues} | ${c.majorIssues} | ${c.minorIssues} | ${c.ordinaryErrorParagraphs}/${c.agentReviewed}（${percent(c.agentOrdinaryErrorRate)}） |` }).join('\n')
const issueRows = report.issueRows.map(row => `- **${row.arm === 'baseline' ? '旧策略' : '新策略'} · ${row.documentId} 第 ${row.page} 页 · ${row.groupId}**（盲评 ID：${row.blindId}）\n${row.issues.map(issue => `  - ${issue.severity}/${issue.category}；原文「${issue.sourceQuote}」；译文「${issue.translationQuote}」；${issue.issue}`).join('\n')}`).join('\n')
const markdown = `# 当前译文代理评审报告\n\n日期：2026-10-18。已完成全部 **${rows.length} 条可用译文**的代理核对，覆盖 ${groups.length} 个有可用译文的源段、10 篇论文。${manifest.distinctTranslationsRead} 个不同译文实际阅读，20 对完全相同的译文共用判断再展开为独立记录。没有新增付费 API 调用。\n\n本次是身份遮蔽材料上的代理评审，**不是人工盲评，也不是严格独立盲评**：同一会话此前已接触两项候选问题和采集统计。逐项决定冻结后才读取私有策略映射生成此汇总；人工审阅数保持 0。\n\n| 策略 | 预期 | 代理已审 | 采集失败 | critical | major | minor | 有一般问题段落/已审 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${tableRows}\n\n这只是单次代理判断中的描述性结果，不据此宣称真实语义错误率改善。共同可审配对为 ${pairedComparison.commonReviewedCases} 段，其中仅旧策略发现问题 ${pairedComparison.baselineOnlyHasObservedIssues} 段、仅新策略发现问题 ${pairedComparison.candidateOnlyHasObservedIssues} 段、两组都有问题 ${pairedComparison.bothHaveObservedIssues} 段、两组均未发现问题 ${pairedComparison.bothWithoutObservedIssues} 段。另有旧组单独可审 ${pairedComparison.baselineOnlyAvailableCases} 段、新组单独可审 ${pairedComparison.candidateOnlyAvailableCases} 段、两组均失败 ${pairedComparison.neitherAvailableCases} 段。失败不当作零错误或成功译文。\n\n## 有证据的问题\n\n${issueRows}\n\n## 裁定及来源边界\n\n- G175 的 times more 存在原文歧义，不确认三倍译法为错误；保留待来源意图核对。\n- G033 的漏析字按 minor 记录；相邻句已表达分析用途，未判成科学结论改变。\n- G003/G044/G079/G148/G179 等源段原本跨页或截断；G098/G156 代码原文已缺值或压平，未归罪于翻译。\n- 参考文献原样保留、机构专名保留、准确异译与等价标点不强行计错。\n- 本次未修改译文。修改后的输出将是新版本，不能继承本次记录。\n\n## 核验与交付\n\nagent-decisions.json 可交给原有 --assess 命令；agent-review-detail.json 保留逐条源文/译文、页码、矩形、SHA-256、核对说明与证据。decisions-manifest.json 绑定输入及全部分批记录摘要。原始 blind-review.json 的人工 pending 模板保持原样。\n\n本次仅完成代理语义评审；13 条采集失败、人工评审、复杂 PDF 的人工视觉检查和未知中断费用凭据门槛仍按原验收要求保留。发布验收仍未通过。\n`
await writeFile(join(target, 'agent-review-report.md'), markdown)
console.log(JSON.stringify({ summary, pairedComparison, decisionsSha256: manifest.decisionsSha256, strictIndependentBlind: false, humanReviewed: 0, releaseReady: false }, null, 2))
