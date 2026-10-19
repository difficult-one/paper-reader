# Fidelity Economy Implementation Plan

**Goal:** 交付保留科研忠实性规则、减少不必要思考及重复修复的显式翻译策略。

**Architecture:** 网关负责策略路由与一次有界修复，独立质量模块负责可检测结构/数字问题。沿用现有段落缓存、诊断、设置和 PDF 版本兼容规则。

**Tech Stack:** TypeScript / Electron / React / Vitest；捆绑 BabelDOC；DeepSeek 官方 Chat Completions。

## Task 1: 策略与质量模块

- [x] 新增 `tests/translation-quality.test.ts`：科学计数、Unicode 负号、千分位、百分号、比较符号、链接与标签排除；数值改变、漏数字、损坏结构拒绝；读取 `src/main/translation-quality.ts`。
- [x] 在 `tests/translation-gateway.test.ts` 测试显式 economy 的 low 路由、保留输出上限，manual 三档与其他服务不变。
- [x] 确认失败后实现最小策略/校验；`src/shared/types.ts`、`core.ts` 和 `store.ts` 增加可保存模式，缺失模式保留旧 manual，新空配置 economy。

## Task 2: 有界修复与缓存

- [x] 用本地服务测试首次异常后的 high 修复仅含错误条目、完整上下文及正确合并；两个响应的 usage 都计入；二次失败重复请求不再发远端；取消不发后续修复。
- [x] 修改 `translation-gateway.ts` 的批量与单段/术语路径，使用独立质量函数，不修改上游 Python。策略模式纳入请求、段落和 PDF 缓存，manual 键保持兼容；旧完整 PDF 仅受限只读回退。
- [x] 运行全量单测、类型检查和构建；独立审查改动。

## Task 3: 设置与交付

- [x] `Settings.tsx` 新增现有样式的翻译策略选择，economy 隐藏手动档位；`index.ts` 正确公开模式。`App.tsx` 显示修复计数和明确失败提示。
- [x] 真实引擎连接本地模拟服务验证模式、取消、重启缓存；小规模真实语义样本控制总预算，报告完整费用与语义抽检限制。
- [x] 更新 0.1.9、构建打包、从实际安装包解压验证、记录 SHA-256 与验证结果；协作文档交付审查文件。

本项目无 Git 元数据，保留 `output/fidelity-economy-backup-20261017` 作为改前快照，不伪造提交记录。
