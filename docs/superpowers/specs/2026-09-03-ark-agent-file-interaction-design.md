# Ark Managed Agent 文件交互设计

日期：2026-09-03  
状态：已确认  
来源：需求文档 + brainstorming 决策  
依赖：`2026-09-01-ark-managed-agent-proxy-design.md`（现有会话/SSE/鉴权）

## 1. 目标与边界

在现有 Node.js + Express + ioredis 代理上，补齐完整文件交互：

1. 前端上传文件 → 后端转发方舟 Files API → 得到 `file_id`
2. 将文件挂载到用户当前会话沙箱（运行中会话实时生效，无需重建）
3. 消息内可选引用文件，让模型直接理解图片/短文档
4. 查询 Agent 产物文件并返回带签名的临时 `download_url`
5. 保持 `webUserToken` 鉴权：只能操作自己会话的文件

**验证链路**

```
本地文件 → POST /api/agent/upload-file → file_id
  → POST /api/agent/chat { file_ids, inline_file_ids? }
  → mount /mnt/session/uploads/<name> + user.message
  → Agent 读写沙箱 → 产物写入 /mnt/session/outputs/
  → GET /api/agent/output-files → download_url
```

**明确不做（本轮）**

- 删除文件 / 卸载会话资源 API
- 自定义 `mount_path`（统一默认路径）
- 上传进度条（仅 chip 状态）
- Redis 持久化 `file_id` 映射（文件由方舟托管；`file_id` 可跨会话复用）
- 方舟官方 SDK（继续 axios）

## 2. 已确认决策

| 议题 | 选择 |
|------|------|
| 文件使用模式 | 默认挂载 + 文本路径说明；可选 `inline_file_ids` 做消息内 file 引用 |
| 字段名 | `file_ids`（全部挂载）+ `inline_file_ids`（须为 `file_ids` 子集） |
| 交付范围 | 前后端一起 |
| 前端形态 | Composer 内嵌附件；产物列表可折叠条在 Composer 上方 |
| 架构 | 扩展现有 `arkClient` + `ChatService` + `routes/agent`（方案 1） |
| 挂载失败策略 | 任一个挂载失败则整次 chat 以 SSE `error` 返回，不半挂载后发消息 |
| 会话重建 | chat 因 session_not_found 重试时，在新 session 上重新 mount |

## 3. 架构与模块

| 模块 | 变更 |
|------|------|
| `package.json` | 新增 `multer`、`@types/multer` |
| `types/ark.ts` | 扩展 content block：`ArkFileContentBlock`；Files/Resources 响应类型 |
| `clients/arkClient.ts` | `uploadArkFile` / `getArkFile` / `mountFileToSession` / `listSessionOutputFiles`；扩展 `buildSendSessionEventsBody` |
| `services/chatService.ts` | chat 入参接受 `file_ids` / `inline_file_ids`；发消息前挂载；重建会话后重挂载 |
| `routes/agent.ts` | `POST /upload-file`、`GET /output-files`；`POST /chat` 解析新字段 |
| `app.ts` | upload 路由需在 `express.json` 之外用 multer（路由内挂载即可） |
| `web/src/api.ts` | `uploadAgentFile` / `fetchOutputFiles`；`streamChat` 传文件 id |
| `web/src/components/Composer.tsx` | 附件选择、上传 chip、直读勾选 |
| `web/src/components/OutputFilesBar.tsx`（新） | 产物列表刷新与下载 |
| `web/src/App.tsx` | 串联上传结果、发送 payload、done 后刷新产物 |

官方 Base URL 不变：`https://ark.cn-beijing.volces.com/api/v3`。

## 4. 后端 API 契约

### 4.1 `POST /api/agent/upload-file`

- **Content-Type**：`multipart/form-data`
- **字段**：`file`（单文件）、`webUserToken`（文本字段）
- **限制**：multer `memoryStorage`；单文件最大 512MB；不写本地磁盘
- **上游**：`POST /api/v3/files`，`purpose=agent`，`file` 为 multipart
- **成功 200**：

```json
{ "file_id": "file-xxx", "name": "report.pdf", "size": 12345 }
```

- **错误**：缺 token/文件 → 400；超限 → 413；上游失败 → 502（友好文案）

说明：上传本身不绑定 session（文件是独立资源）。鉴权仍校验 `webUserToken` 非空，防止匿名滥用上传配额。

### 4.2 `POST /api/agent/chat`（增强）

原有字段：`webUserToken`、`userMessage`。

新增可选字段：

```json
{
  "webUserToken": "...",
  "userMessage": "请分析这些文件",
  "file_ids": ["file-a", "file-b"],
  "inline_file_ids": ["file-a"],
  "file_names": { "file-a": "report.pdf", "file-b": "data.csv" }
}
```

`file_names` 为可选辅助字段（前端上传后已知文件名，推荐传，避免二次查询）。

规则：

1. 鉴权、查/建会话、SSE 形态不变
2. 若 `file_ids` 非空：发送前对当前 `sessionId` 逐个调用添加会话资源
3. 挂载文件名解析优先级：`file_names[file_id]` → 方舟 `GET /files/{file_id}` 的 filename → 回退 `file_id`
4. 挂载路径：沙箱绝对路径为 `/mnt/session/uploads/<sanitizedBasename>`；basename 去掉路径分隔符；同名冲突时追加短 `file_id` 后缀
5. `user.message` content 构造：
   - 始终包含用户文本
   - 若有挂载：追加一段文本，列出各文件沙箱绝对路径（便于 Skill/bash 使用）
   - 对每个 `inline_file_ids` 追加 `{ "type": "file", "file_id": "..." }`
6. `inline_file_ids` 必须是 `file_ids` 的子集，否则 HTTP 400（在进入 SSE 前）
7. 挂载失败：写 SSE `{ type: "error", code, message }` 后结束

### 4.3 `GET /api/agent/output-files`

- **Query**：`webUserToken`
- **逻辑**：解析 token → 查已有 session（无则返回空列表，不创建）→ `GET /api/v3/files?scope_id={sessionId}`
- **成功 200**：

```json
{
  "ok": true,
  "sessionId": "sesn-xxx",
  "files": [
    {
      "file_id": "file-yyy",
      "name": "result.csv",
      "size": 2048,
      "download_url": "https://..."
    }
  ]
}
```

`download_url` 直接透传方舟带签名的临时地址，后端不做二次代理。

## 5. arkClient 工具函数

### `uploadArkFile(params)`

- 入参：`arkApiKey`、`arkBaseUrl`、`fileBuffer`、`originalName`、可选 `contentType`
- 用 axios + `FormData`（Node 原生或 form-data 兼容）上传
- `purpose=agent`
- 返回完整文件信息对象（至少含 `id`/`file_id`、`filename`/`name`、`bytes`/`size`；实现时按方舟实际字段归一化）

### `getArkFile(params)`

- `GET /files/{fileId}`
- 用于在缺少 `file_names` 时解析挂载 basename
- 归一化返回至少：`file_id`、`name`、`size`

### `mountFileToSession(params)`

- `POST /sessions/{sessionId}/resources`
- body：`{ type: "file", file_id, mount_path }`
- 调用方舟时 `mount_path` 使用 `/<sanitizedBasename>`（官方：相对 uploads 根）
- 向 Agent 文本提示使用沙箱绝对路径 `/mnt/session/uploads/<sanitizedBasename>`

### `listSessionOutputFiles(params)`

- `GET /files?scope_id={sessionId}`
- 返回归一化列表：`file_id`、`name`、`size`、`download_url`

### `buildSendSessionEventsBody` 扩展

签名变为接受：

```ts
{
  userMessage: string;
  mountedPaths?: string[];       // 沙箱绝对路径，写入提示文本
  inlineFileIds?: string[];      // 消息内 file 引用
}
```

生成 `content: Array<ArkTextContentBlock | ArkFileContentBlock>`。

## 6. 前端行为

### Composer

- 「附件」按钮多选文件 → 立即 `uploadAgentFile`
- Chip：文件名、大小、状态（上传中 / 就绪 / 失败）、移除、可选「模型直读」
- 默认勾选直读：`image/*`、`application/pdf`、以及常见短文档 MIME（如 `text/plain`、`text/markdown`、`application/msword`、`application/vnd.openxmlformats-officedocument.*`）；其余默认不勾
- `onSend(text, { file_ids, inline_file_ids, file_names })`
- 发送成功清空附件；流式中禁用附件操作
- 用户消息展示附件名标签（只读）

### OutputFilesBar

- Composer 上方可折叠条
- 刷新按钮 + 列表（名、大小、下载）
- Agent SSE `done` 后自动静默刷新一次
- 无会话/空列表：简短空状态文案

## 7. 错误处理摘要

| 场景 | 行为 |
|------|------|
| 上传缺文件/token | HTTP 400 |
| 文件 > 512MB | HTTP 413 |
| 方舟上传失败 | HTTP 502 + 可读 message |
| `inline_file_ids` ⊄ `file_ids` | HTTP 400（chat 进 SSE 前） |
| 挂载失败 | SSE error，不发 user.message |
| session 失效重建 | 新 session 上重做 mount，再发消息 |
| 无会话查产物 | `{ sessionId: null, files: [] }` |

## 8. 测试与手测

**单测**

- `buildSendSessionEventsBody`：纯文本；带 `mountedPaths` 提示；带 `inlineFileIds` file block
- mount 请求 body 字段名断言（`type`/`file_id`/`mount_path`）
- basename 消毒与重名后缀（若抽纯函数）

**curl 示例（实现后写入注释或 README 附录）**

```bash
# 1) 上传
curl -X POST http://localhost:3000/api/agent/upload-file \
  -F 'webUserToken=demo-user' \
  -F 'file=@./sample.pdf'

# 2) 对话（挂载 + 直读）
curl -N -X POST http://localhost:3000/api/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "webUserToken":"demo-user",
    "userMessage":"请总结这个 PDF",
    "file_ids":["file-xxx"],
    "inline_file_ids":["file-xxx"]
  }'

# 3) 产物列表
curl 'http://localhost:3000/api/agent/output-files?webUserToken=demo-user'
```

**回归**：interrupt、rebuild、无文件 chat、历史消息拉取行为不变。

## 9. 官方约束备忘

- 文件是独立资源：删会话不删源文件；同一 `file_id` 可挂多会话
- Agent 产物统一写 `/mnt/session/outputs/`，系统同步为 scope 内文件
- 挂载实时生效，运行中会话无需重启
- 大文件优先挂载，勿塞进消息 content
- 单文件最大 512MB
- 参考文档：82379/2555935～2555938
