# Zhima · 芝麻 — 极致轻量的桌面悬浮窗 AI 小助手

面向 Windows 的**极致轻量**桌面 AI 助手：按 `Alt+Space` 唤出悬浮窗，随时提问、流式回答，**不打断当前工作流**。
内置 Agent 工具、本地知识库、跨会话搜索、MCP 工具接入与文生图工作台，数据全部留在本机。

> 当前版本 **v2.2.0** · 安装包约 **4.9 MB** · 仅 Windows · 中文界面

## 🪶 极致轻量，体现在每一处

| 维度 | 芝麻 | 说明 |
|---|---|---|
| 安装包 | **约 4.9 MB** | Tauri 2 + 系统 WebView2，**不打包 Chromium**；Electron 方案通常 100 MB+ |
| 界面占位 | **560 × 260** | 悬浮窗小巧贴边，需要时一键展开完整会话模式 |
| 使用方式 | **随唤随到** | `Alt+Space` 唤起即输入，答完即走；划词按 `Alt+Q` 直接问答 |
| 后台驻留 | **单实例托盘** | 常驻系统托盘，重复启动自动聚焦，不重复占资源 |
| 依赖 | **无账号、无云端** | 本地 SQLite 存储；API Key 存 Windows 凭据管理器，不落盘 |
| 运行时 | **Rust 后端** | 网络请求、SSE 解析、工具执行全在 Rust 侧，占用低、响应快 |

## ✨ 功能一览

### 💬 对话与模型
- **随叫随到**：`Alt+Space` 全局唤起 / 隐藏，失焦自动隐藏（可关闭），位置记忆
- **多服务商多模型**：任意 OpenAI 兼容接口，**常用厂商一键预设**（DeepSeek / 智谱 GLM / MiniMax / Kimi / 通义千问 / 硅基流动 / 火山方舟 / OpenAI / OpenRouter / 本地 Ollama）
- **消息编辑与重新生成**：提问可随时编辑并重跑该轮回答；回答可原地重新生成，用 `‹ n/m ›` 在历史版本间切换，旧答案永不丢失
- **一问多答**：勾选多个模型并行提问，分栏对照，可逐列停止
- **助手（Assistant）**：角色提示词 + 绑定模型 + 工具策略保存为助手，会话可绑定；内置多套角色模板
- **流式对话**：Rust `reqwest` 直连 + 健壮 SSE 解析（粘包 / 拆包 / UTF-8 跨块），支持思考过程展示与等级选择（低 / 中 / 高 / 最大）
- **会话管理**：置顶 / 重命名 / 批量删除 / 轮次索引跳转 / 批量选择
- **跨会话全文搜索**：搜索框同时检索标题与**全部历史消息内容**，中文可搜，点击命中直达该条消息

### 🔍 检索与知识
- **联网搜索多引擎**：DuckDuckGo（默认，免 Key）/ Tavily / 博查 / SearXNG，设置内切换，密钥写入凭据管理器
- **网页抓取**：带 SSRF 防护的正文读取，搜索结果以来源卡片展示
- **本地知识库**：导入 Word / Excel / PPT / PDF / 网页 / 文本，自动分块入库；提问时按相关度（BM25）检索并注入上下文，命中提示「已参考知识库 n 条」，并提供检索测试面板
- **长期记忆**：用户确认式保存，按使用频率注入，密码等敏感内容自动拒绝

### 📎 输入与输出
- **文档附件**：输入框直接附加 docx / xlsx / pptx / pdf / 文本，正文并入本次提问，历史保留附件徽标
- **图片输入**：粘贴 / 选择图片走视觉模型，支持视觉兜底模型配置
- **文生图工作台**：文生图 + 参考图生图，参数面板 + 画布 + 生成历史
- **公式渲染**：支持 `$...$` 与 `$$...$$` LaTeX（KaTeX，仅在命中公式时按需加载，不拖慢首屏）
- **导出**：对话导出为 Markdown / PNG 图片 / 打印另存为 PDF（导出前自动展开长对话）
- **数据备份**：一键导出 / 导入会话、记忆与生成图片，支持合并或替换（**不含 API Key**）

### 🛠 工具与自动化
- **Agent 工具系统**：12 个内置工具（时间 / 计算 / 剪贴板读写 / 联网搜索 / 网页抓取 / 文本文件 / PDF / 文档 / 知识库检索 / 截屏 / 打开资源），工具调用时间线可视化
- **三级授权策略**：每次确认 / 本次会话允许 / 永久允许；本地敏感结果之后再调用联网工具需二次确认（数据流防泄漏）
- **MCP 工具服务器**：接入任意 stdio MCP 服务器（如官方 `filesystem` / `fetch`），自动发现其工具并默认需要确认后执行
- **划词助手**：任意程序中选中文本按 `Alt+Q`，自动取词并唤起窗口，提供翻译 / 解释 / 总结 / 润色 / 起草回复，回答可写回剪贴板（快捷键可改可关）

### 🎨 界面与系统
- 6 套主题（系统 / 浅色 / 深色 / 暖色 / 玫瑰 / 春日）、自定义头像与背景
- 悬浮窗 ↔ 完整会话模式一键切换，页面切换与呼出均有水浮现过渡动效
- 系统托盘、单实例、自动更新（Ed25519 签名校验）

### 🔒 安全与隐私
- API Key 仅存 Windows 凭据管理器，配置文件不含密钥
- 敏感工具结果**不写入历史**；网页/搜索结果按不可信资料处理，Prompt 分层防注入
- 网页抓取防 SSRF（含 DNS 重绑定防护），请求限流与自动重试
- 全部对话、记忆、知识库、生成图片保存在本机 SQLite

## 🛠 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 · TypeScript · Vite · Tailwind CSS · Zustand · react-virtuoso · KaTeX |
| 后端 | Rust · Tauri 2 · reqwest · rusqlite (SQLite，含 FTS5) · keyring · zip / pdf-extract |
| 关键机制 | SSE 流式解析 · FTS5 trigram 中文全文检索 · BM25 知识库 · MCP JSON-RPC · SendInput 取词 |
| 动画 | react-spring（窗口"水浮现"入场 / 页面切换过渡） |

## 📁 目录结构

```text
src/                        React + TypeScript 前端
  app/                      入口组件
  components/               composer / conversation / history / markdown / model-picker / window-shell
  features/settings/        设置面板（模型 / 外观 / 角色 / 工具 / 知识库 / MCP / 诊断 / 通用）
  features/imagegen/        文生图工作台
  lib/                      导出（Markdown / PNG）、打印、附件块、窗口与动效工具
  services/                 流式事件桥接 + providers / history / assistants / backup / knowledge / mcp API
  stores/                   Zustand：chat / providers / settings / window / assistants / imagegen
  styles/                   设计令牌与全局样式（含打印样式）
src-tauri/src/              Rust / Tauri 后端
  agent/                    上下文预算 · 滚动摘要 · 长期记忆 · 知识库分块与提示词
  api/                      OpenAI 适配器 · SSE 解析 · 联网搜索与多引擎 · 安全 HTTP 抓取
  commands/                 chat / history / providers / assistants / backup / knowledge / mcp / settings …
  mcp/                      MCP stdio 客户端（JSON-RPC + 会话池）
  storage/                  providers.json 配置 · keyring 密钥 · SQLite 会话库（迁移 v1→v16）
  tools/                    工具注册表 · 12 个内置工具 · 文档解析（docx/xlsx/pptx/pdf/文本）
  window/                   窗口管理 · 全局快捷键 · 托盘 · 划词取词
  models/                   请求 / 响应 / 配置数据结构
scripts/                    图标生成与发布脚本（release-update.mjs）
```

## 🚀 开发

前置：Node.js ≥ 18、Rust（stable-msvc）、Windows MSVC 构建工具。

```bash
npm install
npm run tauri:dev
```

## 📦 构建与发布

```bash
npm run tauri:build                 # 仅构建安装包
node scripts/release-update.mjs     # 构建 + minisign 签名 + 生成 latest.json
```

安装包（NSIS）输出到 `src-tauri/target/release/bundle/nsis/`，发布产物汇总到 `release/updates/`。
脚本支持通过环境变量自动部署到静态服务器（暂存 → 大小校验 → 原子替换），详见脚本头部注释。

## 🧪 测试与检查

```bash
npm run check:frontend              # typecheck + vitest + vite build
npm run check:rust                  # fmt --check + clippy -D warnings + cargo test
npm run check                       # 两者一起跑
```

当前基线：Rust **156** 个单测、前端 **68** 个测试全部通过。

## 🔒 隐私

所有对话历史、记忆、知识库与生成图片保存在本地 SQLite；API Key 存于 Windows 凭据管理器；
敏感工具结果（剪贴板 / 文件 / PDF / 截图）默认不写入历史；除你配置的模型服务商与搜索接口外，不请求任何第三方服务。
详见 [PRIVACY.md](./PRIVACY.md)。

## ⚠️ 已知限制

- 安装包未做 Windows 代码签名（未购置证书），首次运行可能触发 SmartScreen「未知发布者」提示
- 知识库为本地 BM25 关键词检索（**有意不引入向量模型**，保持零外部依赖）
- 划词取词对管理员权限（UAC 提升）窗口无效，这是 Windows 系统限制
- 仅提供 Windows 版本与中文界面

## 📸 界面预览

![主界面](./assets/screenshots/Snipaste_2026-09-01_16-37-54.png)

![完整会话与历史](./assets/screenshots/Snipaste_2026-09-01_16-38-30.png)

![对话与轮次索引](./assets/screenshots/Snipaste_2026-09-01_16-39-02.png)

![生图工作台](./assets/screenshots/Snipaste_2026-09-01_16-39-17.png)

![设置 · 模型](./assets/screenshots/Snipaste_2026-09-01_16-39-28.png)

![设置 · 外观与工具](./assets/screenshots/Snipaste_2026-09-01_16-39-44.png)

![设置 · 通用](./assets/screenshots/Snipaste_2026-09-01_16-39-53.png)
