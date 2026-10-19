// Record the assistant's explicitly non-blind review of archived real outputs.
// This script writes the assessment already made in this chat; it does not call a model.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
const directory = resolve('output/translation-skill-evals/acceptance')
await mkdir(directory, { recursive: true })
const sourceFile = resolve('output/fidelity-economy-validation/semantic-review-pairs.json')
const sourceBytes = await readFile(sourceFile)
const cases = JSON.parse(sourceBytes.toString('utf8'))
const observations = {
  'modality-condition': '两种译文均保留可能性与测试条件；省略定冠词不影响科学含义。',
  'negation-significance': '否定、统计学显著性、p=0.08 与 n=42 均保留；未添加等效性结论。',
  'not-equivalence': '保留未能拒绝与不能证明等效性的逻辑关系。',
  'bounded-convergence': '保留电阻恒定前提、有界与不一定收敛的区分。',
  'percent-points': '保留 5% 与 5 个百分点的否定对照。',
  'strict-comparator': '保留 only when 限定与 p<0.05 方向。',
  'unicode-comparator': 'x<=0.05 未变成严格小于；ASCII 形式可接受。',
  'scientific-notation': 't=2s、电流负号和指数 -4 均保留。',
  'confidence-interval': '估计值 1.5、95% CI 和端点顺序 1.2→1.8 保留。',
  'unit-change': '电流 5mA 与电压 3.3V 的量级和变量绑定均保留。',
  'identifier-protection': '图 2、式 (8)、URL/DOI 完整保留；空格差异不改变含义。',
  'formula-style': '样本的全称范围、K 样式标签和 {v1} 均保留。',
  'causation': '保留观察到的关联不能确立因果效应。',
  'implication-direction': '阻尼系数为正仍为保证稳定性的充分条件，未变成必要条件。',
  'semantic-no-number': '对噪声敏感度低于基线的比较方向保留。',
  'local-repair-context': '它保持不变的指代仍为比例增益 K；未更换指代对象。',
  'real-fair-date': '收稿、接受和发表三组年月日及对应关系均保留。'
}
const sha = value => createHash('sha256').update(value).digest('hex')
const report = {
  schemaVersion: 1, reviewedOn: '2026-10-18', reviewMethod: 'agent-nonblind', reviewer: 'Codex assistant in this chat', humanReviewed: false,
  sourceFile, sourceSha256: sha(sourceBytes), policyScope: 'Archived 2026-10-17 high/economy outputs; not the current 2026-10-18 split-rule policy.',
  summary: { sourceCases: cases.length, translationsExamined: cases.length * 2, observedCritical: 0, observedMajor: 0, observedMinor: 0, currentPolicyPairedEvidence: false, releaseReady: false },
  cases: cases.map(sample => {
    if (!observations[sample.id]) throw new Error(`No recorded assessment for ${sample.id}`)
    return { id: sample.id, source: sample.source, sourceHash: sha(sample.source), outputs: ['high', 'economy'].map(arm => ({ arm, output: sample[arm], outputHash: sha(sample[arm]) })), method: 'agent-nonblind', humanStatus: 'pending', issues: [], assessment: observations[sample.id] }
  }),
  exclusions: [
    { file: resolve('output/fidelity-economy-validation/engine-1792241026794/report.json'), reason: 'The archived report explicitly says mock=true and paidCalls=0. Its UMAP PDF is a local layout fixture, not a real translation quality sample.' },
    { file: resolve('output/fidelity-economy-validation/engine-1792240942090/translated/umap.no_watermark.zh.mono.pdf'), reason: 'Visible output is source English prefixed with 译文. Excluded from semantic accuracy evaluation.' }
  ],
  limitations: ['非随机、非盲评；代理已看到策略标签。', '仅 17 条短句及两个历史策略，不能外推到 200 段、10 篇论文或当前候选策略。', '代理审阅不能代替人类评审，未写入任何 human-passed 状态。']
}
await writeFile(join(directory, 'historical-agent-review.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report.summary))
