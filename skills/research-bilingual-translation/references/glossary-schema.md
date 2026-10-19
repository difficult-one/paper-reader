# 术语记录契约 v1

文件 `translation-glossary.json` 独立于模型术语 JSON，顶层包含 schemaVersion、documentId（源 PDF SHA-256）、sourceVersion（文档与 QA 提取版本）、version（内容 SHA-256）、entries、conflicts。

每条 entries 包含 src、tgt、paragraphId、page、section、sourceQuote、definitionQuote、abbreviation、origin、status、preferred。

`origin`：`user` 是显式用户词表；`extracted` 是模型抽取；`supplied` 是上游提供但无法证明用户身份的词表。不要把自动词表标成用户指定。

`status`：`user-specified` / `source-defined` / `candidate` / `conflict`。`definitionQuote` 只能摘自包含本术语作主语的明确本地定义；普通提及只保存 `sourceQuote`，定义为 null。定义原文存在不代表中文候选已获人工确认。模型 confidence 不进入 schema。

冲突按同一文档和章节内的 src/译法判定；不同章节保留各自定义。用户译法 preferred=true，冲突也不覆盖它。当前软件只保守识别明确英文定义，复杂定义仍需人工确认。上游术语抽取请求没有真实章节标题时作用域为 document，不冒充已按章节消歧。

重复/模糊来源的 page=null、rects 为空，并在 QA 中显示未定位。条目不能因拼写是另一个词的子串而建立虚假出处。文档间不无条件复用，增量术语缓存保留服务、模型、策略、提取、上下文和来源。
