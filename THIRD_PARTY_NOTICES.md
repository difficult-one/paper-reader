# 第三方组件与源码

论文对照阅读器采用 GNU Affero General Public License v3.0（AGPL-3.0-only）。完整许可证见安装目录 resources/LICENSE。
本应用的对应源码（不包含第三方二进制文件）随安装包附带于 resources/source-code.zip，包含源代码、依赖锁定、测试、构建与运行时准备脚本。

## 历史翻译引擎

0.1.12 起移除自动翻译，不再随安装包分发下列翻译引擎、模型、字体、Python 或 Visual C++ 安装程序。对应源码压缩包仍包含项目历史翻译适配代码及固定版本清单，供源码复现和旧版缓存兼容使用。以下资源路径仅适用于 0.1.11 及更早版本的运行包，当前安装包不包含这些路径。

- PDFMathTranslate-next v2.9.0，AGPL-3.0：https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/tree/v2.9.0
- BabelDOC v0.6.3，AGPL-3.0：https://github.com/funstory-ai/BabelDOC/tree/v0.6.3
- 使用官方 Windows with-assets 运行包；下载地址、精确版本与校验值见 resources/runtime-manifest.json。
- 上游 Python 源文件、dist-info 中的许可证和资源文件保留在 resources/runtime/pdf2zh。其原生组件、模型、字体各自保留原许可证。
- Python 运行时许可证见 resources/runtime/pdf2zh/runtime/LICENSE.txt。随运行包分发的 Microsoft Visual C++ 安装程序适用 Microsoft 自身条款。

## 桌面与阅读组件

- Electron，MIT：https://github.com/electron/electron
- React / React DOM，MIT：https://github.com/facebook/react
- PDF.js（pdfjs-dist），Apache-2.0：https://github.com/mozilla/pdf.js
- Lucide 图标，ISC：https://github.com/lucide-icons/lucide
- PDF.js 在 Node 环境使用的 @napi-rs/canvas，MIT：https://github.com/Brooooooklyn/canvas

第三方 Node 依赖的原许可证随 node_modules 一并打包。Electron 的许可证及 Chromium 第三方声明位于安装目录 LICENSE.electron.txt 和 LICENSES.chromium.html。

## 设计参考

- https://github.com/kd14125/pdf2zh-desktop ：参考运行时版本信息、Windows 打包和任务管理方式。
- https://github.com/Liozhang/z-transplit ：参考双栏阅读与滚动联动的交互方式。
- https://github.com/zotero/reader ：参考阅读与批注侧栏的交互方式。
- https://github.com/agentcooper/react-pdf-highlighter 与 https://github.com/DanielArnould/react-pdf-highlighter-extended ：参考选字高亮及与缩放比例无关的定位方式。

本项目未复制上述参考项目的应用源码。历史固定运行包来自 PDFMathTranslate-next 官方 Release。
