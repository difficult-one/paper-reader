# Save Beside Original Implementation Plan

> **For agentic workers:** Execute inline with focused regression tests and a final read-only review.

**Goal:** 现有和后续生成的中文 PDF 自动出现在原文目录。

**Architecture:** 新增一个保存副本的文件帮助函数，以原子不覆盖方式创建输出；LibraryService 在生成、缓存复用和打开缓存时调用。DocumentSession 提供保存结果，界面在完成和失败提示中展示真实位置。

**Tech Stack:** Electron、TypeScript、Node fs、Vitest、Playwright。

## Global Constraints

不覆盖原文与其他不同内容文件；缓存保留；目录写入失败不能使已完成翻译变失败；不使用用户付费 API 测试。不擅自关闭或替换正在运行的旧版应用。

### Task 1: 保存副本

Files: `src/main/translation-files.ts`, `tests/translation-files.test.ts`。

Interface: `saveBesideOriginal(source: string, originalPath: string): Promise<string>`。

- [x] 先测试常规文件名、相同内容复用、重名递增及不可写路径，确认失败。
- [x] 使用 `copyFile` 的 `COPYFILE_EXCL` 避免覆盖；相同内容比较完整字节；保持目标目录存在才写入，不创建用户移动/删除的目录。
- [x] 定向测试通过。

### Task 2: 接入生成与恢复

Files: `src/main/library.ts`, `src/shared/types.ts`, `src/renderer/src/App.tsx`, `tests/library.test.ts`。

- [x] 测试完成后自动保存、删除外部副本后缓存加载恢复，以及保存失败保留成功缓存和警告。
- [x] 在主进程集中调用保存辅助函数，向会话写入 `savedTranslationPath` 或 `saveWarning`，源路径元数据在打开原文时持久化。
- [x] 翻译完成显示真实保存路径，写入失败显示“另存译文”的恢复操作指引。
- [x] 完整测试及现有翻译 UI 回归。

### Task 3: 迁移与交付

- [x] 核实已有原文与缓存映射，安全复制当前译文到其原目录并校验内容。
- [x] 更新使用说明、版本 0.1.6，构建安装包。
- [x] 只读审查、打包版验证、安装载荷验证及 SHA-256。

当前目录没有 Git 元数据，不初始化仓库。

验证进度：79 项单元测试和构建通过。真实引擎对本地模拟 API 的 UI 流程通过，并验证自动副本与手动导出字节相同。双 PDF 导入和重启流程通过；Impeccable detect 无问题。审查发现的自动保存期间重开同篇论文导致会话不一致的问题已增加 fresh/cached 两种失败回归并修复。

最终验证：独立只读复审通过。0.1.6 打包版的完整翻译、自动保存、导出字节一致及重启阅读通过；应用文件和源码归档与生产构建逐字节一致。实际安装 ZIP 插件向独立中文目录解压成功（16.95 秒），解压主程序、app.asar、源码归档和运行时清单与已测版本一致。安装包 672,747,535 字节，SHA-256 为 c4723832234d6e4f736699aab7b257e6cb3b123c84279150f34cf62150e497eb。
