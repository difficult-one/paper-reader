# Paired PDF Implementation Plan

> **For agentic workers:** Execute inline, task by task, with regression tests and a final code review.

**Goal:** 导入已有中英 PDF 后直接对照、批注并恢复配对。

**Architecture:** LibraryService 验证并存储本地配对，IPC 提供选择与提交，React 对话框负责左右文件确认。复用现有 PdfPane。

**Tech Stack:** Electron、React、TypeScript、PDF.js、Vitest、Playwright。

## Global Constraints

两份 PDF、英文左中文右、不需要 API。页数不同关闭联动。配对与密钥无关，导出当前版本且不覆盖导入源文件。

### Task 1: 配对存储

Files: `src/main/library.ts`, `src/shared/types.ts`, `tests/library.test.ts`。

Interfaces: `LibraryService.importPair(originalPath: string, translatedPath: string): Promise<DocumentSession>`；会话添加 `translationSource?: 'imported' | 'generated'` 及 `translatedName?: string`。ReaderBridge 增加 `selectPdf(path?: string): Promise<Result<PdfChoice | null>>`、`importPair(originalPath, translatedPath)`；PdfChoice 包含路径、名称、页数、语言与文字信息。

- [x] 使用真实测试 PDF 加入无设置导入、重启后移动原文件仍恢复、不同版本批注标识、相同文件拒绝、损坏文件不替换原配对的失败测试。
- [x] 运行 `npm test -- tests/library.test.ts`，确认失败。
- [x] 两侧验证后存储右侧快照与 pair.json，复用原文 openFile 流程但提交时不重复打开；恢复时校验导入 PDF；导出按当前 session 选择导入或生成来源。
- [x] 运行 library 测试及完整测试。

### Task 2: 界面与 IPC

Files: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/ImportPair.tsx`, `src/renderer/src/styles.css`, `scripts/pair-smoke.mjs`。

- [x] 编写真实 Electron 脚本，打开首页导入入口并选择两份 PDF，验证右侧渲染、API 未配置及页码联动。
- [x] 运行脚本确认入口缺失。
- [x] 增加只选文件 IPC 和导入 IPC；对话框两个明确槽位、选择、交换、取消、确认和就地错误；管理焦点及 Escape。
- [x] App 单文件流程复用，双文件拖入打开确认对话框；已有原文时预填左侧；保存当前阅读位置后提交；同文档切换中文版本重置右侧位置。
- [x] 脚本覆盖不同页数、替换译文、批注版本隔离、取消和重启；默认与最小窗口截图验收。

### Task 3: 交付

- [x] 更新 README 和版本 0.1.5；运行 build、所有单测、界面和设置回归。
- [x] 运行 `npm run package`、安装载荷验证和打包版双 PDF 冒烟测试。
- [x] 保存安装包 SHA-256、检视最终代码并记录验证。

No Git commit: 当前工作目录不含 `.git`。

已验证：70 项单元测试、源码版双 PDF、原翻译流程及设置流程通过。独立只读审查发现的导出保护、导入失败原子性、版本阅读位置和键盘焦点问题均修正并补充回归测试；异步缓存译文返回也检查当前文档，避免切换回旧论文。Impeccable detect 无问题。实际检查了 1000×680 窗口的导入框和双栏阅读截图。

最终打包版的双 PDF、设置、真实引擎对模拟服务的完整翻译与重启流程均通过。最终构建的 7 个应用文件与 app.asar 中内容逐字节一致；源码归档一致。实际 NSIS ZIP 插件将最终安装载荷解压到独立中文目录成功（18.08 秒），解压的主程序、app.asar、源码归档和运行时清单均与验证版本一致。安装包 672,741,414 字节，SHA-256：8258bc40c810c1b8bcbd18b370ba96fb406819aaab6555220566ea91fc028caa。
