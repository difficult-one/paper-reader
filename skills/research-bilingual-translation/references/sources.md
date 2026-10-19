# 实现依据

于 2026-10-17 查阅，下列为上游资料；规则为本项目编写，未安装外部 skill。

- [BabelDOC](https://github.com/funstory-ai/BabelDOC)：科学论文翻译和中间布局结构。本项目固定使用随包的 0.6.3，适配前核对其 ParagraphFinder 的 composition、bbox 与编号处理。
- [段落识别说明](https://funstory-ai.github.io/BabelDOC/ImplementationDetails/ParagraphFinding/ParagraphFinding/)：布局、行宽与缩进影响拆段；全局短行拆分可能产生误拆。文档标明可能含 AI 生成内容，实际行为以固定版本代码和回归结果为准。
- [PDFMathTranslate-next 高级配置](https://github.com/PDFMathTranslate/PDFMathTranslate-next/blob/main/docs/en/advanced/advanced.md)：翻译提示词扩展接口。不能把单独写一个 SKILL.md 当作已接入引擎。
- [PDF.js 示例](https://mozilla.github.io/pdf.js/examples/)：canvas、viewport 和缩放接口；项目用真实 Electron 测试滚动、选字、联动及缩放。

2026-10-18 实施补充：核对随包 BabelDOC 0.6.3 的 `il_translator_llm_only.py`、`automatic_term_extractor.py`：正文批次仍为 id/input/layout_label，输出为 id/output，术语仍为 src/tgt；上游词表表头为 Source Term / Target Term，表名不能证明用户作者身份。QA 单独使用 PDF.js 提取与 viewport 定位，并保留无法唯一匹配状态。

冻结语料的正式 DOI、标题、许可和 PDF SHA-256 见 [paper-corpus.json](../evals/paper-corpus.json)。2026-10-18 从出版方 JOSS 的 `.pdf` 链接获取新增 7 篇 CC BY 论文，另外 3 篇复用已有有来源记录的本地 PDF。未使用付费翻译模型扩展语料；原文约束尚待译文人工盲评。

2026-10-18 配对采集配置核实：[DeepSeek 首次调用](https://api-docs.deepseek.com/) 指定 `deepseek-flash` 当前为 DeepSeek-V4.1-Flash-1017；[人民币价目](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 和 [美元价目](https://api-docs.deepseek.com/quick_start/pricing/) 提供命中、未命中、输出及高峰/空闲价格。本次实验按高峰价格作保守费用预留，并记录核实日期；不能把模型别名和这些价格视为永久不变。
