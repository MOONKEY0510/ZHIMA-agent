# ChatFloat 发布与升级策略

## 产物结构

每次发布在 `release/` 目录产出：

```text
release/
  ChatFloat_x.y.z_x64-setup.exe    NSIS 安装版（当前用户 / 全机器 二选一）
  checksums.txt                    SHA-256 校验值
  release-notes.txt                版本说明
```

安装包由 Tauri Bundler + NSIS 生成，源文件位于 `src-tauri/target/release/bundle/nsis/`。

## WebView2 运行时

应用依赖 WebView2。安装器配置为 `downloadBootstrapper` 模式：目标机器缺少 WebView2 时，安装过程会自动下载并静默安装微软官方引导程序。Windows 11 自带 WebView2，绝大多数 Windows 10 机器也已通过系统更新获得，因此通常无额外动作。

## 升级行为

安装器支持覆盖升级（NSIS 默认行为），升级时：

程序文件被新版本替换；用户数据不受影响——配置、凭据与会话历史分别位于 `%APPDATA%\com.chatfloat.desktop`（providers.json、settings.json）、Windows 凭据管理器与 `%APPDATA%\com.chatfloat.desktop\chatfloat.db`，均不在程序安装目录内。

数据库采用 `PRAGMA user_version` 迁移机制，新版本启动时按序应用未执行的迁移，不会破坏已有表结构。v2.0.0 在既有 v1–v4 表结构上新增了 `conversation_summaries`（v5）、`memories`（v6）、`agent_runs`（v7）三张表，均为独立新表，不影响既有会话与消息数据。任何版本的回滚（安装旧版覆盖新版）不会删除数据，但旧版本无法识别新版本引入的表结构变更，因此建议只向前升级。

> 升级提示：v1.6.0 的历史中可能保存过完整的工具结果（含剪贴板、文件正文、截图等）。v2.0.0 起敏感工具结果默认不再落盘；已有历史不会被自动扫描或上传，如不需要可手动清理。

## 自动更新与签名（v2.0.0 起）

应用内置 Tauri 官方 updater 插件，从你自己的静态服务器拉取更新：

- 更新清单 `latest.json` 托管在服务器静态目录，客户端按 `tauri.conf.json` 中
  `plugins.updater.endpoints` 配置的地址检查版本。
- 安装包使用 minisign 签名（Ed25519），客户端校验签名通过后才允许安装，
  防止更新包被篡改或被中间人替换。
- 下载完成后以 passive 模式静默运行 NSIS 安装并自动重启应用，用户数据不受影响。

### 密钥管理

密钥对由 `npx @tauri-apps/cli signer generate -w ~/.tauri` 生成（本项目已生成）：

- 私钥：`~/.tauri`（本机文件，务必备份，勿提交到仓库、勿外泄）
- 公钥：`~/.tauri.pub`，内容已写入 `tauri.conf.json` 的 `plugins.updater.pubkey`

> 私钥或密码丢失后将无法为后续版本签名，届时更新将不可用。

### 服务器端部署

服务器只需提供静态文件（任意 Web 服务器 / 对象存储均可），目录结构：

```text
chatfloat/                          # 静态目录
  latest.json                       # 更新清单（客户端检查更新时拉取）
  ChatFloat_<version>_x64-setup.exe
  ChatFloat_<version>_x64-setup.exe.sig
```

`latest.json` 由发布脚本自动生成，格式如下：

```json
{
  "version": "2.0.1",
  "notes": "本次更新说明",
  "pub_date": "2026-08-11T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<minisign base64 签名>",
      "url": "https://example.com/chatfloat/ChatFloat_2.0.1_x64-setup.exe"
    }
  }
}
```

发布前确认：

1. `tauri.conf.json` 的 `plugins.updater.endpoints` 替换为真实地址
   （如 `https://example.com/chatfloat/latest.json`）。
2. 服务器需支持 HTTPS（应用 CSP 仅允许 https/wss 出网请求）。

### 发布新版本流程

1. 更新 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 三处版本号。
2. 在 `release/release-notes.txt` 顶部写入本版说明（脚本会截取对应版本段作为更新说明）。
3. 运行 `node scripts/release-update.mjs`（构建 + 签名 + 生成清单）；
   已构建过可加 `--skip-build`。构建需要读取 `~/.tauri` 私钥，若密钥在别处，
   通过环境变量 `TAURI_SIGNING_PRIVATE_KEY_PATH` 指定。
4. 上传 `release/updates/` 整个目录到服务器静态目录。
5. 客户端下次启动（或 设置→通用→软件更新→检查更新）即可收到新版本提示。

### 本地验证

调试时可临时把 `endpoints` 指向本地 HTTP 服务器
（如 `http://localhost:8000/chatfloat/latest.json`），
用 `npm run tauri:dev` 验证"检查→下载→安装→重启"完整流程；
正式发布务必使用 HTTPS。

## 代码签名（Windows Authenticode）

安装包仍未做 Windows 代码签名（Authenticode），原因：尚未购置代码签名证书。
影响：首次运行安装包可能触发 SmartScreen"未知发布者"提示，用户需点击"仍要运行"。
这与 updater 的 minisign 签名相互独立，二者都需要才能获得完整体验；
后续购置证书后可配置 `bundle.windows.signCommand`（或 CI 中使用 signtool）补上。

## 发布检查清单

发布新版本前依次确认：版本号在 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 三处一致；`npm run typecheck`、`npm test`、`cargo test` 全部通过；`node scripts/release-update.mjs` 成功产出安装包与 `latest.json`；干净环境安装、启动、Alt+Space 唤起、一次流式对话、覆盖升级五项手工验证；`sha256sum` 写入 checksums.txt；release-notes.txt 更新；`release/updates/` 已上传服务器并确认 endpoints 可达。
