# Cache Prefix Implementation Plan

> **For agentic workers:** Execute inline, task by task, with regression tests and a final code review.

**Goal:** 增加可复用固定前缀并减少语义相同请求的重复调用。

**Architecture:** 在现有主进程翻译网关中规范已知 BabelDOC 模板。缓存使用确定性对象表示、兼容旧文件，并验证响应结构。

**Tech Stack:** TypeScript、Node HTTP、Vitest。

## Global Constraints

不关闭思考，不填造命中率，不追加多轮历史，不改上游运行时，不调用用户付费服务。正文和术语不得丢失。

### Task 1: 模板与缓存

Files: `src/main/translation-gateway.ts`, `src/main/translation-prompts.ts`, `tests/translation-gateway.test.ts`。

Interfaces: `prepareTranslationRequest(input, settings)` 保持签名；新 `stableMessages(messages)` 负责仅针对已知模板重排。

- [x] 加入条件 glossary、术语模板、单段模板、未知模板及对象键序缓存测试。
- [x] 运行 `npm test -- tests/translation-gateway.test.ts`，确认新测试因目标行为缺失失败。
- [x] 将固定规则和示例与可变正文分离，保持条件 glossary 指令，规范正文批请求内 JSON 的对象键及格式；用户数组和字符串原值保留。
- [x] 使用递归对象键排序创建键；以旧准备函数生成旧键作为只读兼容回退。术语 JSON 需数组且元素 src/tgt 非空；并发错误不计命中。
- [x] 运行网关测试和完整 `npm test`。

### Task 2: 验证

- [x] 运行 `npm run build` 和 `npm run test:ui`，验证真实引擎、模拟 HTTP、原文和中文渲染。
- [x] README 说明前缀策略和实际数据限制；只读审查修改。

验证：20 个网关测试通过，完整单测 70 项通过。真实翻译引擎对本地模拟 API 的流程通过（15 次请求），未使用用户付费服务。固定规则、正文及词表均保留。只读独立审查未发现剩余缓存正确性问题。

No Git commit: 当前工作目录不含 `.git`。
