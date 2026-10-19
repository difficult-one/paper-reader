# 翻译策略验收运行说明

冻结输入：`skills/research-bilingual-translation/evals/paper-cases.jsonl`，200 段 / 10 篇 / 6 个领域。对照提示词在 `evals/baseline-body-system.txt`，来自 2026-10-17 真实请求的固定 system 消息；候选使用实际当前规则编译器。比较保持相同源文、模型和思考；旧组只复现归档提示策略，两组都用当前确定性校验器，不冒称重现完整历史应用。

## 无费用准备

```powershell
node scripts/translation-acceptance.mjs
```

默认在 `output/translation-skill-evals/acceptance-current` 写入 90 次初译请求、45 个稳定源文批次（每批最多 5 段）、两组指纹、200 段来源、空输出状态及明确的不通过理由。候选风险/抽样复核额外 0–45 次，局部修复另计。准备命令不请求模型，不使用历史账本预算。

## 真实采集

本次已获用户明确授权：人民币 10 元、DeepSeek 最新模型。2026-10-18 官方文档核实为 DeepSeek-V4.1-Flash-1017，调用名 `deepseek-flash`。本机可运行 `scripts/start-translation-acceptance.ps1`，通过隐藏内容的窗口粘贴密钥，自动启动固定实验目录；密钥仅经子进程环境变量传递，不写入文件。重复启动已开始的目录会拒绝。该启动器需要 PowerShell 7。

本次按官方高峰单价保守预留：每百万输入命中/未命中/输出分别为 0.04 / 2 / 8 元，对应公开美元价格 0.006 / 0.3 / 1.2。各项人民币单价均为美元单价的 20/3 倍，因此内部上限 1.5 美元恰对应人民币 10 元；这是公布单价的等价比，不是汇率。实际空闲时段账单可能更低。公开设置、价目和授权依据保存在 `output/translation-skill-evals/deepseek-authorized-20261018`，不得把该授权用于其他目录的重复付费采集。[官方人民币价目](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)

本次实际为周日，全部属于低峰；每百万输入命中/未命中/输出为 0.02 / 1 / 4 元。`translation-acceptance-cost-report.mjs` 从每次真实远端诊断的 tokens 与时间核对低峰估算，并纳入失败尝试。原始保守账本不改写成低峰。首轮因归档 CRLF 未编译候选而作废，次轮因脚注误报停止；当前目录为 `live-deepseek-20261018-final`。启动器从总预算扣除前两次已知费用和首轮一个中断请求的完整保守预留，复用经当前校验的原始基线缓存及次轮候选/复核缓存；前两次不另获 10 元额度。所有旧记录留存。

环境变量 `PAPER_READER_EXPERIMENT_API_KEY` 提供独立实验密钥。`--settings` 是公开 JSON，含 baseUrl/model/qps/reasoningEffort；`--prices` 是公开 JSON，含 hit/miss/output 三个**每百万 token 美元价格**，应依据实验当天官方价格填写。密钥不写入这两个文件或命令文本。

```powershell
node scripts/translation-acceptance.mjs --live --settings public-settings.json --prices verified-prices.json --budget-usd 1 --output output/translation-skill-evals/live-acceptance
```

命令中的 1 美元只是预算语法示例，不是费用估算或已授权预算。实际按用户明确上限填写。默认输入保守预留 131072、最大输出 65536；若服务模型的输入/输出契约不同，明确给 `--max-input-tokens` / `--max-output-tokens`。输入以实际请求 UTF-8 字节数作保守上界；所有初译、结构修复、独立复核继承输出上限并在发送前验证同一 UsageBudget 契约。低于单次预留时可能在第一次请求前停止，token 缺失后停止继续付费。

准备和采集均以原子 `acceptance.lock` 防止目录并发写入。每批记录账本，成功段落立即保存，失败不自动重新开始。已有 `collection-state.json` 的目录拒绝重跑；崩溃留下的锁不能自动删除，先确认进程已退出并核对账本。使用新目录再次运行会有额外费用，须在当前授权内决定。

`outputs.json` 保留两组所有预期 ID 的 completed/failed/missing，批次失败保留其中已校验的成功段落，不能用仅成功样本作为分母。`experiment.json` 保存实际公开服务/模型/思考与预算契约，不保存密钥；`diagnostics` 保存 phase 元数据；`quality` 保存候选独立 QA。完成后 `collection-completion.json` 绑定源文、策略、请求、公开实验配置、输出、状态和最终账本摘要；崩溃、不完整采集、未结算预留或摘要不符均不能计为费用已知。

诊断目录现按 batch/arm 隔离，避免默认 30 任务轮转丢弃本实验的早期调用。只有明确的 `translation-structure-failure` 会留档后继续其余计划批次；包括独立复核在内的真实 HTTP/网络失败均停止继续请求。聚合失败时 QA 从内部已校验段落结果保留成功兄弟的状态，错误响应本身不改成成功。

## 人类盲评

只向评审者提供 `blind-review.json`；**不要同时提供** `blind-private.json`、`blind-key.json`、`outputs.json`、request-plan 或 policies。盲评行没有策略名/指纹，ID 与顺序由本次实验随机生成的私有盐决定，同一实验内稳定。公开种子只决定请求顺序，不能用它恢复盲评身份。评审材料仍保留原文、页码、矩形和译文。

评审者对每条记录填写 status、reviewer、reviewedAt、method=human 及 issues。status=reviewed 且 issues=[] 表示实际核对后无问题；pending/unjudgeable 仍保留分母。每个问题需要 severity、category、原文逐字 sourceQuote、译文逐字 translationQuote 和具体 issue。允许多个准确译法，不做句子相等比较。模型或代理结果 method=agent，不能计入人工审阅数。

```powershell
node scripts/translation-acceptance.mjs --assess --decisions completed-blind-review.json --output output/translation-skill-evals/live-acceptance
```

该命令默认版面未通过，因此完整发布门槛保持未满足。当前工具要求冻结论文各有一个候选 PDF 的人类版面记录。完成实际检查后，另传 `--layout-review human-layout-review.json --layout-artifacts layout-artifacts.json`。前者记录 method=human、status=passed、reviewer、reviewedAt 和 outputHashes（对应 PDF 的 SHA-256）；后者是 `[{"pdfPath":"绝对 PDF 路径","qualityReportPath":"对应 translation-quality-report.json 路径"}]`。程序读取实际 PDF 字节，并核对 QA 的源文摘要、候选 translationPolicy、当前独立 layoutVersion、输出摘要和结构检查状态。随意填入 64 位字符串不算有效凭据。人工字段必须来自实际检查，程序不能代填身份。

评估报告分学科、论文与策略保留 expected、translated、structurePassed、humanReviewed、agentReviewed、unjudgeable、criticalParagraphs、ordinaryErrorParagraphs。发布要求：完整 200 段双组输出与人工决定、候选结构全通过、不新增 critical、一般错误段落率不高于旧组、版面通过且费用已知。critical 保守比较问题类别、原文引句和问题说明；旧错误被另一个新错误替换也会阻止通过，措辞不同的同一问题需人工统一裁定。任一未满足返回非零退出码。CLI 核对冻结源文和当前实际策略，旧输出不能重新标记为当前验收；输出/源文摘要不符、重复决定和伪造引句直接拒绝。

## 本次代理评审结果

用户已明确选择改为代理评审。`live-deepseek-20261018-final/agent-review/agent-decisions.json` 包含全部 387 条 `method=agent` 的完成记录；`agent-review-detail.json` 保留逐条源文、译文、位置、摘要与核对说明，`decisions-manifest.json` 绑定盲评输入和分批判断。`scripts/record-translation-agent-review.mjs` 只序列化本会话实际作出的判断并验证证据，不自动评分，也不调用模型。

旧/新策略分别发现 3 major /（4 major + 2 minor），两组未发现 critical；代理有一般问题段落比例分别 1.56%（3/192）与 3.08%（6/195）。这不是人工错误率，也不证明新策略改善。完整结果见 `agent-review/agent-review-report.md`。本次代理此前参与了实现和采集并见过候选问题，虽在评分材料中遮蔽策略身份，仍不满足严格独立盲评。

```powershell
node scripts/translation-acceptance.mjs --assess --decisions output/translation-skill-evals/live-deepseek-20261018-final/agent-review/agent-decisions.json --output output/translation-skill-evals/live-deepseek-20261018-final
```

该离线命令已验证通过全部记录的格式与版本，发布结果按预期退出 1：agentReviewed=192/195，但 humanReviewed=0/0，13 条采集失败、人工版面和费用凭据门槛仍未满足。验收报告里的 ordinaryErrorParagraphs/ordinaryErrorRate 是人工口径（当前 0/null），代理计数单列在 `agent-review-summary.json`。原人工 pending 模板、原始译文和执行报告保留。

## 其他证据的使用边界

2026-10-18 真实采集已尝试全部 400 条，旧/新组通过结构检查为 192/195；387 条可供盲评，失败 13 条仍保留分母。当前结果未通过发布门槛。`scripts/summarize-translation-acceptance.mjs` 只离线对齐现存证据，记录实际 68 段候选模型复核与 2 项待确认问题，不补发模型请求、不标记人工通过。所有原执行报告保留。

`historical-agent-review.json` 是代理复查既有 17 组短句的补充资料，不是当前候选的盲评。`translation-layout-acceptance.mjs` 使用真实 BabelDOC 和本地模拟服务，验证公式/双栏/报告技术链路，不证明中文语义质量；无真实模型费用。
