# Ctrl + 滚轮缩放

**目标：** 鼠标位于 PDF 页面时，按住 Ctrl 向上滚动放大，向下滚动缩小。

**方案：** 在 `PdfPane.tsx` 的 PDF 滚动容器注册可取消的原生 wheel 监听器，复用现有缩放档位和 `onZoom`，从而保留双栏联动、阅读位置与缩放保存。普通滚轮继续滚动，Ctrl + 滚轮阻止浏览器默认缩放；到达 50% 和 300% 时停止改变比例。卸载时移除监听器。

直接复用现有档位，避免引入与下拉框不一致的连续比例；不采用浏览器整体缩放，因为阅读器已有独立的 PDF 缩放状态。

**技术：** React、TypeScript、Electron、Playwright；不新增依赖。

- [x] 扩展 `scripts/pair-smoke.mjs`，用实际 Ctrl + 滚轮验证联动、独立缩放、普通滚动、缩放范围和重新打开后的保存恢复。先运行并确认未实现时失败。
- [x] 在 `src/renderer/src/PdfPane.tsx` 复用缩放档位，添加非 passive 的滚轮监听，使用最新缩放值处理连续事件，并为现有缩放框补充快捷键提示。
- [x] 在 `README.md` 说明操作方式。
- [x] 运行构建、单元测试和配对 UI 测试，检查截图和修改范围。

**验证结果：** `npm run build`、`npm run test:pair` 通过；`npm test` 最终 41 个文件、393 项测试全部通过。首次与 UI 测试并行运行时，既有问答取消测试在收到首段文本前取消而失败；该测试单独复核通过，随后全量独立运行通过。UI 检测未报告问题，已查看正常和小窗口截图；独立代码审查未发现缺陷。

**安装版同步：** 用户反馈无效后，确认实际运行的 `D:/APP/paper-reader/PaperReader/PaperReader.exe` 所用旧 `resources/app.asar` 缺少滚轮监听。已备份旧归档，在保留后端和依赖文件内容及 unpacked 标记不变的前提下替换渲染产物，通过安装版候选程序的完整配对测试，再正常关闭实际程序、原子替换归档、同步源码包。实际安装路径启动并打开原论文后，单栏 Ctrl + 滚轮从 100% 放大到 125%，确认 PDF 宽度改变、应用整体缩放保持 100%，随后滚轮缩小恢复原比例并重新打开程序。备份位于 `output/ctrl-wheel-zoom/installed-update-1792410548791/`，实测截图位于 `output/ctrl-wheel-zoom/installed-verified.png`。
