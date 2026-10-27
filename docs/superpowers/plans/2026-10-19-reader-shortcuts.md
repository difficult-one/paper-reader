# 阅读快捷键实现计划

**Goal:** 为现有阅读器增加常用操作的快捷键和可通过 F1 查看、可用键盘关闭的速查表。

**Architecture:** 集中定义快捷键及精确匹配规则，由 App 分派已有操作；PDF 阅读栏仅增加跳页输入聚焦、翻页和缩放的命令接口。沿用现有颜色、弹窗和联动行为。

**Tech Stack:** React、TypeScript、Electron、Vitest、Playwright。

## 约束

- 保留 Ctrl+O、Alt+Q 和原有选区、滚轮缩放行为。
- 输入框、可编辑区域及输入法组字期间不触发阅读或批注命令。
- 设置、导入和帮助弹窗阻止底层快捷键；重复按键只允许连续缩放。
- 不为在线翻译或直接删除分配快捷键。
- 按用户后续要求添加 Ctrl+Z：撤销批注新增、编辑及删除，输入框保留原生文字撤销；历史限当前论文及译文版本的当前会话。

## 实现与验证

- [x] 首先用 Electron smoke 复现缺失的 F1 速查表。
- [x] 在 `reader-shortcuts.ts` 集中定义操作及匹配；用 `tests/reader-shortcuts.test.ts` 验证组合键、修饰键冲突、重复与输入法保护。
- [x] 为 `PdfPane.tsx` 添加命令接口，在 `App.tsx` 分派 Ctrl+G、Ctrl+PageUp/PageDown、Ctrl+加减号/0、Alt+1/2/3、Alt+L、Alt+A、Alt+Q、Alt+H、Alt+N、Ctrl+逗号、Ctrl+Shift+O、F1 和 Escape。
- [x] 新建 `ShortcutsHelp.tsx`，添加可见入口和按钮提示；更新 README 的快捷键说明。
- [x] 用真实 Electron 窗口验证翻页、活动栏、缩放边界、高亮/备注、模式切换、输入保护及帮助弹窗焦点；运行单元测试和构建，检查实际截图。

验证结果：44 个测试文件、404 项单元测试及构建通过；快捷键与连续高亮专项 Electron smoke 通过。独立审查发现的滚轮活动栏追踪及撤销后的文字分组边界均已修复并通过回归。
