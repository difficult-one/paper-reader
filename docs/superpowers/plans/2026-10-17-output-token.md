# DeepSeek 输出消耗实施计划

状态：已被两个对话协作的“保真省钱”目标取代。完成了 5 项 Python 原型测试，但整篇离线联调未通过；生产接线已撤回，未启用或打包。剩余项目不再单独执行，详见 `docs/2026-10-17-cost-quality-collaboration.md`。

**Goal:** 在保持翻译模型、思考档位和科研翻译规则的前提下，减少同页术语的重复推理。

**Architecture:** 给现有 Python 入口增加独立术语适配器，收集上游同页生成的批次并按源文 token 和段落数合并；不改上游依赖。Electron 仅为官方 DeepSeek 进程启用，最终是否默认启用以真实对照为准。

**Tech Stack:** Python 3.13、BabelDOC 0.6.3、TypeScript、Vitest。

- [ ] 新增 `tests/term_batching_test.py`，使用真实上游提取器的分批与解析，证明相邻 600-token 批次当前没有合并，同时覆盖所有源文、过滤和进度。
- [ ] 在 `resources/reader_terms.py` 实现相邻批次收集器，保留原有 extractor 回调；在 `resources/reader_engine.py` 为主进程及 Windows spawn 安装。
- [ ] 用 High 真实调用比较独立提取与同页合并提取，记录总输出、思考 token、术语覆盖和冲突。无节省或缺少关键术语则不启用。
- [ ] 若对照成立，在 `src/main/engine.ts` 设置仅官方 DeepSeek 生效的环境开关；新增必要进程参数测试。`package.json`、`scripts/package-source.mjs`、`scripts/check-runtime.mjs` 纳入适配器。
- [ ] 运行 Python 回归、Vitest、TypeScript 构建和真实引擎离线联调；记录验证结果。检查打包资源包含适配器。

已有基线：3 个相关 Vitest 文件共 58 项通过。没有 Git 元数据，修改前快照位于 `output/output-token-fix-20261017/before`。
