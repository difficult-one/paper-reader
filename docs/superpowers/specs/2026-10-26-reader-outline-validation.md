# 章节目录验证结果

- `npm run build`：通过 TypeScript 检查及 Electron/Vite 构建。
- `npm test`：46 个测试文件、427 项测试全部通过。
- `npm run test:ui`：配对、设置、问答、快捷键、多论文列表、左右拖入和章节目录全部通过。
- `npm run test:outline` 对应脚本已加入 `test:ui`，验证真实 PDF 的嵌套章节、命名目标及页内位置、无效目标提示、子章节展开收起、整栏收起与宽度恢复、Esc、左右目录来源、联动及独立跳转、单栏模式、最小窗口、与论文列表互斥、无书签页码导航、论文切换及重启恢复。
- 新增 10 项真实 PDF 单元测试；先观察旋转页面定位用例失败，再修复 XYZ、FitR、FitH、FitV 的坐标变换，最终全部通过。
- Impeccable 检查无发现；独立代码审查发现的旋转定位问题已修复并通过复核。
- 最小窗口工具栏溢出已通过紧凑显示目录按钮修复；既有论文列表最小窗口回归通过。

最终界面验证截图位于：`output/playwright/outline-1792980960209/`（expanded.png、collapsed.png、narrow.png、fallback.png）。已检查展开、回退与窄屏画面。功能只更改工作区源码与本地构建，不改变已安装应用的版本信息。
