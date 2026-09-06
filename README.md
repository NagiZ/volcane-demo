# Ark Managed Agent Proxy

基于 Express 的 HTTP 代理服务，将前端请求转发至火山方舟（Ark）托管 Agent，并通过 Redis 维护用户与 Session 的映射关系。

> 📐 **架构与功能说明**：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— 分层结构、关键链路时序图
> （对话 / Custom Tool 回环 / 收口状态机 / 文件交互 / 记忆库 / 中止 / Session 重建）、API 契约与坑位清单。

## 前置条件

- **Node.js 18+**
- **Docker**（用于运行 Redis）

## 启动 Redis

```bash
docker compose up -d
```

## 配置环境变量

从示例文件复制并填写真实凭据：

```bash
cp .env.example .env
```

`.env` 中需配置以下变量：

| 变量 | 说明 |
|------|------|
| `ARK_API_KEY` | 火山方舟 API Key |
| `ARK_AGENT_ID` | 托管 Agent ID |
| `ARK_BASE_ENVIRONMENT_ID` | 基础环境 ID |
| `REDIS_URL` | Redis 连接地址，默认 `redis://127.0.0.1:6379` |
| `PORT` | 服务端口，默认 `3000` |

## 安装与启动

```bash
npm install
npm run dev
```

生产环境：

```bash
npm run build
npm start
```

## API 示例

> **实现说明：** `POST /events` 仅投递消息；Agent 回复通过 `GET /events` 轮询（或 SSE GET）获取后，再以归一化 SSE 推给前端。

### Chat（SSE 流式对话）

```bash
curl -N -X POST http://127.0.0.1:3000/api/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"webUserToken":"demo-token","userMessage":"你好"}'
```

### Rebuild Session（重建会话）

```bash
curl -X POST http://127.0.0.1:3000/api/agent/rebuild-session \
  -H 'Content-Type: application/json' \
  -d '{"webUserToken":"demo-token"}'
```

## 持久化记忆（Memory Store）

每个 `webUserToken`（经 sha256）绑定一个永久记忆库；创建/重建会话时自动挂载。业务层可直接读写记忆文件。

### 写入记忆

```bash
curl -X POST http://127.0.0.1:3000/api/agent/memory \
  -H 'Content-Type: application/json' \
  -d '{
    "webUserToken":"demo-user",
    "filePath":"/user_profile.json",
    "content":"{\"theme\":\"dark\",\"locale\":\"zh-CN\"}"
  }'
```

### 读取记忆

```bash
curl 'http://127.0.0.1:3000/api/agent/memory?webUserToken=demo-user&filePath=/user_profile.json'
```

### 验证挂载（对话）

```bash
curl -N -X POST http://127.0.0.1:3000/api/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"webUserToken":"demo-user","userMessage":"请先读取记忆库中的 user_profile.json 并复述偏好"}'
```

### 重建会话后记忆应保留

```bash
curl -X POST http://127.0.0.1:3000/api/agent/rebuild-session \
  -H 'Content-Type: application/json' \
  -d '{"webUserToken":"demo-user"}'
```

## 文件交互

上传文件、挂载到会话沙箱、消息内直读引用，以及查询 Agent 产物文件。

### 上传文件

```bash
curl -X POST http://localhost:3000/api/agent/upload-file \
  -F 'webUserToken=demo-user' \
  -F 'file=@./sample.pdf'
```

成功返回 `file_id`、`name`、`size`。

### 对话（挂载 + 直读）

```bash
curl -N -X POST http://localhost:3000/api/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "webUserToken":"demo-user",
    "userMessage":"请总结这个 PDF",
    "file_ids":["file-xxx"],
    "inline_file_ids":["file-xxx"]
  }'
```

`file_ids` 将全部挂载到 `/mnt/session/uploads/`；`inline_file_ids` 须为 `file_ids` 子集，用于消息内 file block 直读。

### 产物列表

```bash
curl 'http://localhost:3000/api/agent/output-files?webUserToken=demo-user'
```

返回当前会话 scope 内产物及方舟签名的 `download_url`。

### 手测清单

> 需配置 `.env` 中 `ARK_API_KEY` 等凭据后执行；未配置时仅作文档参考。

- [ ] 上传 PDF → 返回 `file_id`
- [ ] chat 仅 mount（不传 `inline_file_ids`）→ Agent 能读 `/mnt/session/uploads/...`
- [ ] chat + inline → 模型能总结 PDF/图片
- [ ] Agent 写 `/mnt/session/outputs/` → `output-files` 出现 `download_url`
- [ ] 无文件 chat / interrupt / rebuild 仍正常

## SSE 事件说明

服务将方舟原始 SSE 归一化为以下事件：

| 事件类型 | 说明 |
|----------|------|
| `delta` | 增量文本片段，字段 `text` |
| `tool` | Custom Tool 状态，字段 `tool_name` / `call_id` / `status`（`running` \| `done` \| `error`）及可选 `message` |
| `error` | 错误信息，字段 `code` 与 `message` |
| `done` | 流结束标志 |

示例输出：

```
data: {"type":"delta","text":"你好"}

data: {"type":"tool","tool_name":"get_user_order","call_id":"evt-1","status":"running"}

data: {"type":"done"}
```

## Custom Tool

方舟 Managed Agent 在需要调用本地工具时，会发出 `agent.custom_tool_use`；会话进入 `requires_action` 后由本服务执行并批量回传 `user.custom_tool_result`。官方字段与行为见 [Custom Tool 使用教程](https://docs.volcengine.com/docs/82379/2608630)。

**要点简述：**

- **控制台配置**：Agent 须预先配置同名 Custom Tool，本仓库内置 mock：
  - `get_user_order`（参数 `order_id`）
  - `create_work_order`（参数 `title` / `content`）
- **后端注册**：服务启动时自动调用 `registerBuiltinTools()`（见 `src/server.ts`）。新增工具只需 `registerToolHandler(name, handler)`。
- **`requires_action`**：轮询读到 `stop_reason.type === 'requires_action'` 时，按 `event_ids` 批量执行并回传结果；该次 idle **不收口**，须等到真正结束才推送 `done`。
- **前端**：对话过程中会出现「自定义工具」状态条（`ToolStatusBar`），随 SSE `tool` 事件在 running → done / error 间切换。
- **路径说明**：Custom Tool 编排挂在 `listSessionEvents` **轮询**路径；`tryStreamSessionEvents`（可选 SSE GET）本轮不挂接。若日后启用，需复用同一 `onRequiresAction` 回调。

### 手测清单（Custom Tool）

> 需在方舟控制台为 Agent 配置上述同名 Custom Tool，并配置好 `.env` 凭据。

- [ ] 触发 `get_user_order` → 状态条 running→done → 最终回复含订单信息
- [ ] 临时注册制造失败（handler 抛错或未注册名）→ 状态条 error，会话仍继续、Agent 能说明失败
- [ ] interrupt / 无工具 chat / 文件 chat 回归正常

## 注意事项

- **同一 Session 勿并发发消息** — 并发写入可能导致消息乱序或丢失。
- **环境变量仅在创建 Session 时注入，运行期不可改** — 修改 `.env` 后需调用 `rebuild-session` 或等待 Session 过期后才会生效。
- **Token 刷新应调用 `rebuild-session`** — 用户身份变更（如 token 刷新）后应主动重建 Session，以确保映射与凭据一致。
- **勿将 `ARK_API_KEY` 暴露给前端** — API Key 仅保存在服务端 `.env` 中，前端通过 `webUserToken` 标识用户即可。
