# Ark Managed Agent 代理服务设计

日期：2026-09-01  
状态：已评审（对话确认）  
来源：`prompt.md` + brainstorming 决策

## 1. 目标与边界

构建一个 Node.js（TypeScript）后端，对接火山方舟 Managed Agents（华北北京），完成：

- 前端携带 `webUserToken` 发起对话
- Redis 维护 `tokenHash ↔ ark sessionId` 映射并优先复用 Session
- 创建 Session 时用 `environment_with_overrides` 注入沙箱环境变量
- 对话以归一化 SSE 流式返回
- 提供手动重建 Session 接口

**MVP 验证链路**

```
webUserToken → tokenHash → Redis Session 映射 → Ark Session
  → environment_with_overrides → USER_BEARER_TOKEN → Sandbox Skill → 业务 API
```

**明确不做**

- 真实 auth-service / 解析 userId
- 方舟官方 SDK（纯 HTTP + axios）
- 同 Session 消息排队锁（仅注释提醒并发风险）
- 代理沙箱出站请求
- 生产级观测 / K8s

## 2. 已确认决策

| 议题 | 选择 |
|------|------|
| SSE 形态 | 归一化：`delta` / `error` / `done`，不透传方舟原始事件 |
| Session 失效 | chat 内自动删映射、重建 Session，同一 `userMessage` 静默重试 1 次 |
| 语言 | TypeScript |
| Redis 交付 | `docker-compose.yml` 仅起 Redis |
| 架构 | 薄分层（方案 1） |
| 上游调用 | 纯 HTTP，不引入方舟 SDK |

## 3. 架构与模块

单进程 Express 服务；Redis 存映射；出站调用  
`https://ark.cn-beijing.volces.com/api/v3`。

| 模块 | 职责 | 依赖 |
|------|------|------|
| `config` | 读取并校验 `.env` | dotenv |
| `resolveUserKey` | `webUserToken → tokenHash`（SHA-256）；后续可替换为 auth→userId | crypto |
| `sessionStore` | Redis CRUD，TTL 25 天 | ioredis |
| `arkClient` | `createArkSession`、`sendSessionEvent` | axios |
| `sessionService` | 获取或创建 Session；失效重建；`rebuildSession` | store + ark + resolve |
| `chatService` | 确保 Session → 发事件 → 归一化 SSE；失败恢复重试 | session + ark + sse |
| `routes/agent` | HTTP 路由 | services |
| `sse` | SSE 头与事件写入 | Express `res` |

**身份解耦**：业务只认 `userKey`（MVP = `tokenHash`）。Redis key 与沙箱 `USER_ID` 均使用 `userKey`，不把「如何从 token 得到身份」散落多处。

### 目录结构

```
volcane-demo/
  package.json
  tsconfig.json
  .env.example
  .gitignore
  docker-compose.yml
  README.md
  prompt.md
  src/
    server.ts
    app.ts
    config.ts
    routes/agent.ts
    services/sessionService.ts
    services/chatService.ts
    clients/arkClient.ts
    store/sessionStore.ts
    utils/hash.ts
    utils/sse.ts
    types/ark.ts
```

### 技术选型

- TypeScript + Express + ioredis + axios + dotenv + cors
- 开发用 `tsx`，生产用 `tsc` → `node dist/...`
- 禁止方舟官方 SDK

## 4. 接口契约

### 4.1 `POST /api/agent/chat`

**Request**

```json
{
  "webUserToken": "string, required",
  "userMessage": "string, required"
}
```

入参非法 → `400` JSON（尚未进入 SSE）。

成功进入流：

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`

**归一化 SSE `data` JSON**

| `type` | 字段 | 含义 |
|--------|------|------|
| `delta` | `text` | 可展示文本增量 |
| `error` | `code`, `message` | 流内错误 |
| `done` | （无额外必填） | 本轮正常结束 |

自动重建 Session 对前端透明，不发送 `session_rebuilt`。

### 4.2 `POST /api/agent/rebuild-session`

**Request**

```json
{
  "webUserToken": "string, required"
}
```

**Response `200`**

```json
{
  "ok": true,
  "tokenHash": "<sha256 hex>",
  "sessionId": "<new ark session id>"
}
```

行为：删除 Redis 映射 → 创建新 Ark Session（用当前 `webUserToken` 注入 `USER_BEARER_TOKEN`）→ 写回 Redis → 返回。不发送对话消息。

### 4.3 通用约定

- 不向客户端暴露 `ARK_API_KEY`
- CORS：MVP 使用 `cors` 默认开放，便于本地 Web 调试
- 同一 Session 禁止并发两条消息：不实现锁，代码注释说明风险

## 5. 数据与方舟约束

### Redis

- Key：`ark:session:map:{tokenHash}`
- Value：方舟 `sessionId` 字符串
- TTL：25 天（小于沙箱快照约 30 天）
- 不存储原始 `webUserToken`

### 创建 Session

- `POST /api/v3/sessions`
- Header：`Authorization: Bearer ${ARK_API_KEY}`
- **禁止**顶层 `environment_id`
- **必须**使用 `environment.type = "environment_with_overrides"`
- 基座控制台 env 为空：`config.env` 为全量替换，创建时直接传入全部变量，不做基座拉取合并
- 注入：
  - `USER_ID` = `tokenHash`（MVP 临时用户标识）
  - `USER_BEARER_TOKEN` = 原始 `webUserToken`
- Agent / Environment 已在控制台创建：`ARK_AGENT_ID`、`ARK_BASE_ENVIRONMENT_ID` 为固定配置
- Session 创建成功后运行期不可改沙箱环境变量；token 刷新场景用重建 Session

### 发送消息

- `POST /api/v3/sessions/{session_id}/events`
- 上游流式响应由后端解析，抽出可展示文本后推归一化 `delta`
- 文本抽取规则：实现时以官方 Session 事件流文档中的事件类型与内容字段为准；只映射「对用户可见的增量文本」，工具/中间状态事件默认丢弃（除非后续产品要求透出）

官方字段疑问以火山文档为准（Managed Agents 总览 / 快速入门 / 创建会话 / Session 事件流）。

## 6. 核心流程

### Chat

1. 校验 `webUserToken`、`userMessage`；计算 `tokenHash`
2. 查 Redis；无则 `createArkSession` 并写入映射
3. `sendSessionEvent`，解析上游流 → SSE `delta` → `done`
4. 若判定 Session 不可用：HTTP 404，或响应体/错误信息明确表示 session 不存在/已失效（实现时对照官方错误码；不把一般 5xx/限流当成失效）
   - 删映射 → 重建 Session → 写 Redis → **同一 `userMessage` 再发一次**
   - 仅重试 1 次；再次失败则 SSE `error`

### Rebuild

删映射 → 创建 Session → 写 Redis → JSON 返回。

## 7. 错误处理

| 场景 | 行为 |
|------|------|
| 入参非法 | `400` JSON |
| Redis 不可用 | 未开 SSE：`503` JSON；已开流：SSE `error`。rebuild：`503` JSON |
| 方舟 create 失败 | 不写脏 Redis；按上列 JSON/SSE 返回 |
| 方舟 events 失败（非 session 失效） | SSE `error`（或未开流时 JSON） |
| session 失效 | 自动重建 + 重试 1 次 |
| 客户端断开 | 中止读取上游流，尽量 abort 请求 |

日志：可用 `DEBUG` 打印 `tokenHash` 前缀、`sessionId`；**禁止**打印完整 `webUserToken` 或 `ARK_API_KEY`。生产路径与调试代码用注释区分。

## 8. 配置与交付

### 环境变量（`.env` / `.env.example`）

```
ARK_API_KEY=
ARK_AGENT_ID=
ARK_BASE_ENVIRONMENT_ID=
REDIS_URL=
PORT=
```

### Docker Compose

仅 Redis（如 `redis:7`，映射 `6379`）。示例：`REDIS_URL=redis://127.0.0.1:6379`。

### README 必含

安装依赖、启动 Redis、填写 `.env`、启动服务、chat/rebuild 的 curl 示例、SSE 事件说明、并发与环境变量不可变的注意点。

### 测试（MVP）

- 手工：curl / Postman + Compose Redis
- 可选：`resolveUserKey`、SSE 解析纯函数单测
- 不强制对接真实方舟的自动化 e2e

## 9. 后续演进（非本版范围）

接入 auth-service 后：

```
webUserToken → auth-service → userId → Session 映射
```

替换点集中在 `resolveUserKey`（及 `USER_ID` 注入值）；Session 编排逻辑保持不变。
