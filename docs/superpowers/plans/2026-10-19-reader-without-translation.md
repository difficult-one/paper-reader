# Reader Without Translation Implementation Plan

**Goal:** 移除自动翻译，保留 API 问答、对照与联动。

**Architecture:** 沿用阅读、配对和问答结构。关闭应用翻译任务入口，兼容已有译文与本地数据。

**Tech Stack:** Electron、React、TypeScript、Vitest、Playwright。

## Global Constraints

- 保留询问、API、对照观看及联动阅读。
- 不删除已有用户数据或变更缓存键。
- 沿用现有界面样式。

## Tasks

- [x] 更新 settings-smoke 和 pair-smoke，先运行确认旧版不满足新需求。
- [x] 删除 App 翻译状态、按钮、进度与统计；右栏改为导入提示。
- [x] 删除 ReaderBridge、preload 与 main 的翻译任务方法/处理器。
- [x] API 设置去除翻译专属选项，保留问答配置与密钥复用。
- [x] 更新问答、快捷键测试和使用说明；构建并运行回归。
- [x] 审查代码并交付可运行版本。
