# 独立 QA 报告 v1

输出目录包含 `translation-source-index.json`、`translation-glossary.json`、`translation-quality-report.json`；异常 PDF 页缩略图在 `quality-thumbnails/page-N.png`。正文与术语模型 schema 保持原样。报告内容是本地原文/译文资料，缓存诊断日志仅保存允许的元数据。

报告顶层：schemaVersion、documentId、sourceVersion、translationPolicy、ruleVersion、generatedAt、summary、paragraphs、issues、extraction、terminologyConflicts。成功生成 PDF 后另有 outputVersion（PDF SHA-256）、outputFile、独立 layoutVersion 和 layout；旧布局版本的人工记录不能用于当前布局验收。

每段独立记录 paragraphId、page、section、rects、source、output、translationHash、contextFingerprint、risks、structuralStatus、semanticStatus、reviewMethod、humanReview、reviewCacheHit。

| 维度 | 状态含义 |
| --- | --- |
| structuralStatus=passed | 实际执行结构、数字、引用校验并通过 |
| structuralStatus=failed | 某项未通过；不标记语义已通过 |
| semanticStatus=pending | 未抽中、复核失败/无效/截断或尚无复核证据 |
| semanticStatus=model-passed | 独立模型返回完整合法条目且 issues=[]；不是人工检查或正确性保证 |
| semanticStatus=unresolved | 确定性校验失败或有带证据的语义问题 |
| reviewMethod | deterministic / model / model-incomplete |
| humanReview=pending | 软件不会自行标记人工通过；人工核对须针对具体 outputVersion 记录 |

问题包含 documentId、sourceVersion、paragraphId、page、section、rects、category、severity、sourceQuote、translationQuote、issue、status、reviewMethod、ruleVersion、translationHash。语义引句必须是该段原文/译文的非空逐字子串；缺失译文的确定性问题允许 translationQuote 为空，不能冒充模型审阅。

category：negation、condition、strength、statistics、binding、limitation、terminology、other；severity：critical、major、minor。模型附加说明/置信度不构成核对证据。page=null 表示当前文本无法唯一锚定源 PDF，不能猜测位置。报告状态只覆盖实际观察到的段落；coverageStatus=unobserved 时可能由中间布局回放跳过了网关，不能据“零问题”宣称通过。

summary 明确 total、structuralPassed、modelReviewed、semanticPending、unresolved。layout.status 的 structure-passed 仅涵盖页数、文字存在与页面边界；visualReview 保持 pending。异常页缩略图 unavailable 时保留状态，不伪造图像。统计基于观察段落，不冒充全文语义错误率。

批次聚合失败不能把已校验并保存的成功兄弟写成空译文。报告按各段实际结果保留结构状态；成功兄弟可继续风险复核，未解决段落仍报告失败。离线对齐历史报告只可纠正有现存输出依据的结构状态；未实际发生的模型或人工复核仍为 pending。

同一段不同译文/上下文会重新复核，旧结果不会覆盖成新版本。跨任务复核缓存验证 schema、原文、译文、文档、提取、服务/模型/思考与规则指纹；复核规则改变只使复核缓存失效，不强制重译。所有模型复核和局部修复计入现有请求、token 和 phase 账本。
