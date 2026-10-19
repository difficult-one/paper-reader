# Token 缓存与成本优化验收记录

更新：2026-10-19。工程实现及离线验证已完成；真实模型经济性和人工语义验收尚未完成。未消耗真实模型额度。

## 已实施

- P0：按请求类型和 primary、repair、semantic-review 阶段保存内容输出、思考输出及费用。思考是总输出的子集；未知 usage、异常计数和缺少价格不视为免费。本地复用单独计数。
- P1：文档术语记录包括版本、原始源批次、语境、来源证据和模型/策略/提取范围。新章节只使用本章原始批次和相关候选，不额外请求全文。引擎的 `{src,tgt}` schema 没有来源 ID，因此不猜测同拼写词到某个段落的对应关系，也不移除影响消歧的兄弟段落；完整原始批次相同才直接复用。
- P2：`baseline` 保留现有思考策略；`terminology` 启用文档术语记录；`adaptive` 在官方已知模型上试验清晰定义术语非思考，正文使用现有 Low 与风险路由。已有独立质量审查时复用其路径。一次升级后仍失败即报告错误，截断不作为成功缓存。
- P3：翻译后 IL 保存来源映射；源文、提取边界、策略和模型范围一致才跳过术语/翻译并继续排版。随机 debug ID 不影响精确来源匹配。部分失败、fallback 或取消不形成完整回放结果；损坏记录保留并回退。回放保留原质量报告链接，新质量报告明确没有重新检查旧译文语义。
- 实验入口：随机顺序、每组重复三次、本地冷/热分开、热态预备费用另列但仍计入总预算；每万源文 token 费用与 P95 耗时分组报告。输出原始 usage 诊断、盲评 CSV 和独立解盲表。每次使用独立输出目录，避免把旧热缓存记成冷态。真实费用采用显式单价估算，不当作服务商账单。

新术语与 adaptive 策略通过 `PAPER_READER_TRANSLATION_STRATEGY=terminology|adaptive` 显式开启；默认 `baseline`。`PAPER_READER_TRANSLATION_REPLAY=0` 关闭 IL 回放。旧缓存和旧批注不清空。

## 验证证据与边界

- 全量 TypeScript/Vitest、应用构建、运行时版本探测均通过；最终机器结果保存于 `output/token-cache-final-tests.json`。
- Python 回放测试 5 项通过：真实 BabelDOC IL 序列化、来源/策略隔离、损坏回退、取消、实际安装钩子跳过两个付费阶段、部分失败不落缓存以及原质量报告来源链接。排版适配测试 9 项通过。
- `output/token-cache-offline-20261019-final/report.json`：18 次测量与 9 次热态预备运行，结构失败 0；三种策略各自 3 次热态重试的有效段落复用率均为 100%。
- 该离线样本只有 1 个合成文档、1 学科、2 个正文段落，不能证明真实翻译质量、20% 节省或论文总体 P95。合成费用不报告为真实模型节省。
- 尚未完成 10 篇、3 学科、200 段的真实论文对照、人工盲评、完整真实论文重排视觉验收和不确定性评估。实验策略保持关闭；不宣称达到发布经济性目标。

独立审查指出了三项问题并已修复：局部定义可能依赖后文、错拼价格字段可绕过预算、复用实验目录污染冷态。对应回归测试均已加入。共享工作区的其他问答、阅读器和翻译质量改动予以保留。

## 真实实验准备

用户已授权总上限 **¥10**、使用最新 DeepSeek。本轮内部额度进一步设为 **$1.00 总计**，保留汇率与计价余量；不得把重跑视为新一笔预算。当前环境和用户级环境变量均未配置 `PAPER_READER_EXPERIMENT_API_KEY`，所以尚未开始真实请求。

截至核验日，官方 `deepseek-flash` 指向 DeepSeek-V4.1-Flash-1017。[官方模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)支持 thinking 开关与 Low 档。预算使用峰价上界：每百万 token 命中输入 $0.006、未命中输入 $0.30、输出 $1.20；实际扣费受时段和服务商账单影响。

命令格式：

```powershell
npm run experiment:tokens -- --live --manifest D:\实验数据\manifest.json --budget-usd 1.00 --output output\token-cache-live-独立目录
```

manifest 使用 `settings`（baseUrl、model、qps）、`prices`（hit、miss、output，美元/百万 token）、`contextWindowTokens` 和 `documents`。每篇包括安全唯一 `id`、`discipline`、实际源文 `sourceTokens`、`extractionVersion` 与原始引擎 `requests`（Chat Completions 请求数组）。源 token 由提取流程提供，不用译文 token 代替。`src/main/token-cache-runner.ts` 的 `offlineFixture()` 提供完整可运行格式。

请求前按显式输入和输出上限预留，修复与热态预备均占额度；预留和已知费用写入 `budget.json`，缺失 usage 即保留未知费用预留并停止。目录锁防止覆盖旧实验；中断后的预算记录必须先核对，不能直接换目录再次花费 $1。
