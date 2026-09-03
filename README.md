# Ark Managed Agent Proxy

基于 Express 的 HTTP 代理服务，将前端请求转发至火山方舟（Ark）托管 Agent，并通过 Redis 维护用户与 Session 的映射关系。

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

服务将方舟原始 SSE 归一化为以下三种事件：

| 事件类型 | 说明 |
|----------|------|
| `delta` | 增量文本片段，字段 `text` |
| `error` | 错误信息，字段 `code` 与 `message` |
| `done` | 流结束标志 |

示例输出：

```
data: {"type":"delta","text":"你好"}

data: {"type":"done"}
```

## 注意事项

- **同一 Session 勿并发发消息** — 并发写入可能导致消息乱序或丢失。
- **环境变量仅在创建 Session 时注入，运行期不可改** — 修改 `.env` 后需调用 `rebuild-session` 或等待 Session 过期后才会生效。
- **Token 刷新应调用 `rebuild-session`** — 用户身份变更（如 token 刷新）后应主动重建 Session，以确保映射与凭据一致。
- **勿将 `ARK_API_KEY` 暴露给前端** — API Key 仅保存在服务端 `.env` 中，前端通过 `webUserToken` 标识用户即可。
