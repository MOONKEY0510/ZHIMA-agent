# ChatFloat 优化实施计划

> 目标：在保持轻量定位的前提下，优先改善稳定性、数据一致性和流式交互性能，再优化启动速度、包体积与工程质量。
>
> 预计工期：1 名开发者约 8～12 个工作日。

## 一、当前基线

- `npm run typecheck`：通过。
- `npm test -- --run`：22 个测试全部通过。
- `cargo check`：通过。
- IDE 诊断：0 个错误。
- Release 已启用 `strip`、Thin LTO、单 codegen unit 和体积优化。

---

## 二、第一阶段：稳定性与安全边界

预计工期：2～3 天。

### 1. 统一限制 HTTP 响应大小

涉及文件：

- `src-tauri/src/commands/chat.rs`
- `src-tauri/src/commands/providers.rs`
- `src-tauri/src/api/web_search.rs`
- `src-tauri/src/commands/imagegen.rs`

实施内容：

- 封装统一的受限响应读取函数。
- 错误响应限制为 128 KiB。
- 模型列表和搜索 HTML 设置合理上限。
- 图片生成使用独立的大文件上限。
- 优先检查 `Content-Length`，同时限制实际流式累计大小。
- 截断日志和前端错误信息，避免展示超长服务端正文。

验收标准：

- 超限响应会主动终止并返回清晰错误。
- 普通聊天、搜索、模型列表和图片生成不受影响。
- 覆盖正常、超限、缺少 `Content-Length` 三类测试。

### 2. 修复 Provider 配置写入事务

涉及文件：

- `src-tauri/src/commands/providers.rs`
- `src-tauri/src/storage/config.rs`
- `src-tauri/src/storage/secrets.rs`

实施内容：

- 在配置副本上执行修改。
- 校验完成后处理 API Key。
- 配置持久化成功后再提交内存状态。
- 任一步骤失败时执行回滚。
- API Key 留空时明确区分“保留原值”和“删除原值”。

验收标准：

- 凭据写入失败不会改变内存或磁盘配置。
- 配置写入失败不会留下无效 Provider。
- 新增、编辑、删除 Provider 均覆盖失败路径测试。

### 3. 增强配置文件恢复能力

涉及文件：

- `src-tauri/src/storage/config.rs`

实施内容：

- 区分文件不存在、读取失败和 JSON 损坏。
- 写入采用临时文件、`flush`、`sync_all` 和安全替换。
- 成功写入前保留最近一份备份。
- 启动时检测遗留临时文件。
- 将损坏文件重命名为带时间戳的 `.corrupt` 文件。
- 将恢复结果返回前端并显示非阻塞提示。

验收标准：

- 配置损坏后应用不会静默丢失设置。
- 可以从最近备份恢复。
- 原始损坏文件会被保留。
- 正常首次启动不会显示错误。

### 4. 加固聊天请求生命周期

涉及文件：

- `src-tauri/src/commands/chat.rs`
- `src-tauri/src/state.rs`

实施内容：

- 后端生成内部唯一请求 ID，前端 ID 仅用于关联；或在注册时拒绝重复 ID。
- 限制外部 request ID 的长度和字符集。
- 清理 CancellationToken 时验证请求实例。
- 完成、失败、取消和超时走统一清理逻辑。
- 将关键路径的 `Mutex::lock().unwrap()` 改为可恢复处理。

验收标准：

- 重复 request ID 不会覆盖正在执行的请求。
- 旧请求完成时不会移除新请求的取消令牌。
- 连续取消和重复取消不会导致 panic。
- 锁中毒或状态异常返回错误，不直接退出应用。

---

## 三、第二阶段：消息持久化一致性

预计工期：1～2 天。

### 5. 将聊天轮次改成 SQLite 原子事务

涉及文件：

- `src/stores/chat-store.ts`
- `src-tauri/src/commands/history.rs`
- `src-tauri/src/storage/database.rs`

实施内容：

- 新增 `begin_chat_turn` 命令。
- 在单个事务内写入用户消息、助手占位消息，并更新会话时间。
- 返回最终消息 ID。
- 新增 `finish_chat_turn`，统一写入回答、状态和完成时间。
- 新增失败或取消状态的持久化路径。
- 移除前端三个独立 IPC 写入。

验收标准：

- 任一步骤失败时不会留下半条聊天轮次。
- 应用异常关闭后可以识别未完成回复。
- 取消和错误消息重启后状态一致。
- 旧数据库可以正常迁移。

### 6. 调整数据库执行模型

涉及文件：

- `src-tauri/src/storage/database.rs`
- `src-tauri/src/commands/history.rs`

实施内容：

- 将同步 SQLite 操作放入专用线程或 `spawn_blocking`。
- 批量写入全部使用事务。
- 检查并启用 WAL 和 `busy_timeout`。
- 检查会话 ID、消息时间及状态字段索引。
- 缩短数据库锁持有时间。

验收标准：

- 加载历史记录时不阻塞聊天流事件。
- 连续快速发送消息不会出现数据库锁错误。
- 数据库命令具备事务失败测试。

---

## 四、第三阶段：流式渲染性能

预计工期：2～3 天。

### 7. 将流式草稿从历史消息数组中分离

涉及文件：

- `src/stores/chat-store.ts`
- `src/components/conversation/MessageList.tsx`

建议状态结构：

- `messages`：已持久化的稳定消息。
- `streamingByRequestId`：正在输出的草稿。
- `streamStatusByRequestId`：请求状态。
- 完成后一次性将草稿合并到 `messages`。

实施内容：

- 流事件只更新对应草稿。
- 不再为每个刷新帧复制完整消息数组。
- 组件按消息 ID 局部订阅。
- 已完成消息使用 `React.memo`。
- 保留动画帧合并，避免逐 token 更新 UI。

验收标准：

- 长会话流式输出时，历史消息组件不重复渲染。
- 取消和失败时草稿能正确合并或移除。
- 切换会话不会串流。
- 补充并发请求和会话切换测试。

### 8. 降低流式 Markdown 开销

涉及文件：

- `src/components/markdown/Markdown.tsx`
- `src/components/conversation/MessageList.tsx`

实施内容：

- 流式阶段优先使用轻量渲染。
- Markdown 解析限制为每 100～200 ms 一次。
- 代码高亮仅在消息完成后执行。
- 对 Markdown 组件使用 memo。
- 按内容与语言缓存代码高亮结果。
- 流式代码块尚未闭合时不执行自动语言检测。

验收标准：

- 长代码回答期间输入框保持流畅。
- 回答完成后自动切换为完整 Markdown。
- 表格、列表、链接和代码块显示不回退。
- 复制代码功能保持正常。

### 9. 固定流事件去重内存

涉及文件：

- `src/services/stream-events.ts`

实施内容：

- 单调序列场景只保存 `lastSequence`。
- 如果需要接受少量乱序，使用固定大小滑动窗口。
- 完成、错误、取消、超时和卸载时统一清理。
- 增加长时间无事件的兜底超时。

验收标准：

- 流事件数量增加时，去重缓存保持固定空间。
- 重复事件不会重复追加内容。
- 异常结束不会留下请求状态。
- 覆盖重复、乱序、丢失和超时测试。

---

## 五、第四阶段：启动速度与包体积

预计工期：1～2 天。

### 10. 懒加载非核心界面

涉及文件：

- `src/app/App.tsx`
- `src/features/settings/SettingsPanel.tsx`
- 图片生成与更新相关组件

实施内容：

- 使用 `React.lazy` 和动态 `import()`。
- 优先拆分设置、图片生成和更新组件。
- 将 `SettingsPanel` 按设置标签拆成独立模块。
- 为懒加载模块增加轻量加载状态。
- 加载失败时提供重试入口。

验收标准：

- 启动聊天窗口时不加载完整设置模块。
- 打开设置和图片生成页面没有明显闪烁。
- 构建产物中出现独立功能 chunk。
- 首屏主 chunk 体积明显下降。

### 11. 优化 Markdown 依赖

涉及文件：

- `src/components/markdown/Markdown.tsx`
- `vite.config.ts`

实施内容：

- 关闭未知语言自动检测。
- 只注册实际常用语言。
- 高亮器按需加载。
- 调整 `manualChunks`，避免将高亮器固定放入基础 Markdown chunk。
- 记录构建前后的 chunk 大小。

验收标准：

- Markdown 基础 chunk 明显小于当前约 329 KB。
- 常见语言仍可正确高亮。
- 未识别语言降级为普通代码块。
- 普通文本回答无需加载高亮器。

### 12. 清理重复 Rust 依赖

涉及文件：

- `src-tauri/Cargo.toml`
- 文件选择、资源打开和媒体工具实现

实施内容：

- 检查 `rfd` 与 Tauri dialog 的重复使用。
- 检查 `open` 与 Tauri opener 的重复使用。
- 统计 `image` 实际使用格式。
- 评估 PDF、截图功能是否适合使用 Cargo feature。
- 确认依赖未使用后再删除。

验收标准：

- 功能行为保持不变。
- Release 二进制或安装包体积下降。
- `cargo check`、`cargo test` 和 Windows 安装包构建全部通过。

---

## 六、第五阶段：测试和发布门禁

预计工期：1～2 天，可与前面阶段同步进行。

### 13. 补齐核心自动化测试

优先新增：

- HTTP 响应大小限制。
- Provider 配置提交和回滚。
- 配置损坏与备份恢复。
- request ID 冲突。
- 流事件重复、乱序、取消和超时。
- SQLite 聊天轮次事务。
- 流式 Store 并发。
- 设置页和 App 基础集成。
- 数据库 migration。

验收标准：

- 核心 Rust 模块具备单元或集成测试。
- 前端关键 Store 和流事件覆盖失败路径。
- 每个已修复问题都有对应回归测试。

### 14. 建立统一质量检查命令

涉及文件：

- `package.json`
- CI 或发布脚本

建议检查项：

- `npm run typecheck`
- `npm test`
- `cargo fmt --check`
- `cargo clippy -- -D warnings`
- `cargo test`
- `npm run build`

建议脚本：

- `check:frontend`
- `check:rust`
- `check`
- `release:check`

验收标准：

- 一条命令可以完成全部发布前检查。
- 任一环节失败都会阻止发布。
- 本地检查与 CI 使用同一套命令。

---

## 七、推荐提交拆分

1. `fix: cap remote response body sizes`
2. `fix: make provider updates transactional`
3. `fix: recover corrupted provider configuration`
4. `fix: harden chat request lifecycle`
5. `refactor: persist chat turns atomically`
6. `perf: isolate streaming message state`
7. `perf: defer markdown highlighting while streaming`
8. `fix: bound stream event deduplication state`
9. `perf: lazy load optional application panels`
10. `build: reduce markdown and native dependency size`
11. `test: cover persistence and streaming failure paths`
12. `chore: add unified release checks`

---

## 八、短迭代优先范围

如果当前只安排一个短迭代，优先完成以下六项：

1. HTTP 响应大小限制。
2. Provider 配置事务。
3. 配置损坏恢复。
4. SQLite 聊天轮次事务。
5. 流式消息状态分离。
6. 流式阶段延迟 Markdown 高亮。

这些工作能够同时改善安全性、数据可靠性和长回答时的流畅度，最符合轻量 Agent 助手的产品定位。

---

## 九、实施结果（2026-08-15）

已完成：

- 聊天、模型列表、搜索、图片相关 HTTP 响应大小限制。
- Provider 配置副本提交、损坏文件保留、临时文件同步、备份与 Windows 安全替换。
- Provider API Key 更新和删除的失败补偿回滚。
- request ID 格式校验和重复登记拒绝。
- SQLite `begin_chat_turn` 原子事务，一次提交新会话、用户消息、助手占位及会话元数据。
- 流式助手草稿与稳定历史消息分离，高频增量不再复制完整历史数组。
- 流式阶段使用轻量纯文本，完成后再执行 Markdown 解析与代码高亮。
- 流事件去重缓存固定为有限空间。
- 设置、图片生成和更新组件懒加载。
- 严格 Clippy 问题清理和统一质量检查命令。
- 聊天轮次事务提交、回滚测试，以及前端新状态结构回归测试。

验证结果：

- 前端类型检查通过。
- 前端 22 个测试全部通过。
- 前端生产构建通过。
- `cargo fmt --check` 通过。
- `cargo clippy -- -D warnings` 通过。
- Rust 80 个测试全部通过。
- Windows Release 应用和 NSIS 安装包构建成功。
- 更新签名阶段需要发布环境提供 `TAURI_SIGNING_PRIVATE_KEY`；本地未配置私钥，因此签名步骤未完成。

经过评估后保留：

- `rfd` 用于 Rust Agent 工具中的本地文件选择，`open` 用于 Agent 的资源打开工具，不能直接删除。
- 当前数据库为单 SQLite 连接和短临界区访问。简单包裹 `spawn_blocking` 仍会被同一连接锁串行化，收益有限；连接池或专用数据库线程应作为独立架构迭代，而不是在本轮中扩大改造范围。
- Markdown 高亮包仍是主要前端 chunk。进一步按语言动态注册会增加实现复杂度，后续应结合真实语言使用统计再决定裁剪范围。
