# Ark Managed Agent Memory Store 持久化记忆设计

日期：2026-09-04  
状态：已确认  
来源：需求文档 + brainstorming 决策  
依赖：`2026-09-01-ark-managed-agent-proxy-design.md`、`2026-09-03-ark-agent-file-interaction-design.md`

## 1. 目标与边界

在现有 Node.js + Express + TypeScript + ioredis 代理上，为每个用户绑定专属 Memory Store，并在创建/重建会话时自动挂载，支持业务层直接读写记忆文件。

1. 每个 `tokenHash`（由 `webUserToken` 派生）永久绑定一个 `memory_store_id`
2. 创建会话时通过 `resources[]` 挂载记忆库（官方：仅支持创建时挂载）
3. 后端提供 `GET/POST /api/agent/memory`，无需经过 Agent 对话即可读写
4. 会话重建 / 30 天不活跃后沙箱重建：复用同一记忆库，数据不丢失
5. 与现有鉴权、SSE、Custom Tool、文件挂载、中断逻辑增量共存

**验证链路**

```
webUserToken → tokenHash
  → Redis ark:user_memory:{tokenHash} ↔ memory_store_id（无则创建）
  → POST /sessions { resources: [{ type: memory_store, ... }] }
  → Skill 经系统提示中的 mount_path 读写
  → 业务层 GET/POST /api/agent/memory 直接 upsert 文件
  → rebuild-session → 同 memory_store_id 重新挂载
```

**明确不做（本轮）**

- 前端记忆编辑 UI
- 删除记忆库 / 删除记忆文件对外 API
- 跨用户共享记忆
- 方舟官方 SDK（继续 axios REST）
- 改鉴权模型为真实 `userId`（继续 `sha256(webUserToken)`）

## 2. 已确认决策

| 议题 | 选择 |
|------|------|
| 代码形态 | TypeScript，按现有分层（方案 1） |
| 挂载路径 | 以会话资源返回的 `mount_path` 为准；instructions 不硬编码 `memstore-id` |
| 写入语义 | Upsert：无则 create，有则 update（优先带 `content_sha256`） |
| Redis 身份键 | `ark:user_memory:{tokenHash}`，无 TTL |
| 创建失败策略 | 硬依赖：记忆库失败则整次创建会话失败 |
| 架构 | 独立 `arkMemoryClient` + `MemoryStore` + `MemoryService` |
| 挂载时机 | 仅创建会话 body 的 `resources[]`（不可运行中补挂 memory_store） |

## 3. 架构与模块

```
webUserToken
  → resolveUserKey → tokenHash
  → MemoryStore(Redis) getOrCreate memory_store_id
  → SessionService 创建会话时 resources[] 挂载
  → MemoryService 业务层读写（upsert）
```

| 模块 | 变更 |
|------|------|
| `src/types/ark.ts` | Memory 类型；`CreateSessionParams.resources` 可选 |
| `src/clients/arkMemoryClient.ts`（新） | 创建/查询记忆库；列/读/建/更新记忆；构造挂载 resource |
| `src/clients/arkClient.ts` | `buildCreateSessionBody` / `createArkSession` 透传可选 `resources` |
| `src/store/memoryStore.ts`（新） | Redis 映射 + SET NX 并发锁 |
| `src/services/memoryService.ts`（新） | `getOrCreateUserMemoryStore` / `readUserMemory` / `writeUserMemory` |
| `src/services/sessionService.ts` | 创建前取记忆库 ID，传入 create session |
| `src/routes/agent.ts` | `GET/POST /memory` |
| `src/app.ts` / `src/server.ts` | 注入 `MemoryService`、`MemoryStore` |

官方 Base URL 不变：`https://ark.cn-beijing.volces.com/api/v3`（复用 `config.arkBaseUrl`）。

参考文档：82379/2555941、2555942、2555943、2555937。

## 4. Redis 映射

- **Key**：`ark:user_memory:{tokenHash}`
- **Value**：方舟返回的 `memory_store_id`（如 `memstore-...`）
- **TTL**：无（永久绑定；与会话 key 的 25 天 TTL 独立）
- **锁 Key**：`ark:user_memory:lock:{tokenHash}`，短 TTL（建议 30s），用于创建幂等

`getOrCreateUserMemoryStore(tokenHash)`：

1. `GET` 映射，有则返回
2. `SET NX EX` 锁；失败则短轮询等待映射出现（超时失败）
3. 双重检查映射
4. 调用方舟创建记忆库：name=`user_memory_{tokenHash前16位}`，description=`用户 {tokenHash前8位} 专属持久化记忆库`
5. `SET` 映射为真实 id，删除锁
6. 创建失败：删锁并抛错（不写脏映射）

## 5. 后端 API 契约

### 5.1 `GET /api/agent/memory`

- **Query**：`webUserToken`（必填）、`filePath`（可选，默认 `/user_profile.json`）
- **逻辑**：`tokenHash` → `getOrCreateUserMemoryStore` → 按 path 定位记忆并读取
- **成功 200**：

```json
{
  "path": "/user_profile.json",
  "content": "{\"theme\":\"dark\"}",
  "updated_at": "2026-09-04T05:00:00Z"
}
```

- **错误**：缺 token → 400；path 不存在 → 404；上游失败 → 502/503

### 5.2 `POST /api/agent/memory`

- **Body**：

```json
{
  "webUserToken": "...",
  "filePath": "/user_profile.json",
  "content": "{\"theme\":\"dark\"}"
}
```

- **逻辑**：Upsert  
  1. 规范化 path（必须以 `/` 开头）  
  2. 列/查是否已有该 path  
  3. 无 → create；有 → update（若有 `content_sha256` 则带上；冲突则重读再试一次）
- **成功 200**：`{ "success": true, "path": "/user_profile.json" }`
- **隔离**：只能操作当前 token 对应记忆库

路径缺省与校验：`filePath` 空则 `/user_profile.json`；不以 `/` 开头则自动补前导 `/`（例如 `user_profile.json` → `/user_profile.json`）。

## 6. 会话创建 / 重建与挂载

### 6.1 创建（`SessionService.createAndPersist`）

1. `getOrCreateUserMemoryStore(tokenHash)`（失败则整次失败，不写 session Redis）
2. `createArkSession` body：

```json
{
  "agent": "<arkAgentId>",
  "environment": {
    "type": "environment_with_overrides",
    "id": "<baseEnvironmentId>",
    "config": {
      "env": {
        "USER_ID": "<tokenHash>",
        "USER_BEARER_TOKEN": "<webUserToken>",
        "LEYO_AGENT_KEY": "<webUserToken>"
      }
    }
  },
  "resources": [
    {
      "type": "memory_store",
      "memory_store_id": "memstore-xxx",
      "instructions": "这是该用户的专属持久化记忆库，保存了用户偏好、使用习惯、历史配置。请使用系统提示中给出的实际 mount_path 访问该目录；启动任务前优先读取其中的 user_profile.json；任务过程中更新的用户信息请及时写回该目录。"
    }
  ]
}
```

3. 原有 env 覆盖逻辑不变；`resources` 仅增加 memory_store（文件仍走 chat 时动态挂载）
4. 成功后 `SessionStore.setSessionId`

### 6.2 重建（`rebuildSession`）

- 只删除 `ark:session:map:{tokenHash}`
- **不删除** `ark:user_memory:{tokenHash}`
- 再走创建流程 → 同一 `memory_store_id` 重新挂载

### 6.3 挂载路径约定

- 不以 `/mnt/memory/{memory_store_id}/` 硬编码
- Agent 侧以系统提示 / 会话资源 `mount_path` 为准
- 业务读写 API 使用记忆库 REST path（如 `/user_profile.json`），与沙箱 mount 路径分离

### 6.4 与文件资源关系

| 资源 | 挂载时机 |
|------|----------|
| `memory_store` | 仅创建会话 `resources[]` |
| `file` | chat 时 `POST /sessions/{id}/resources` |

验收可调用方舟「查询会话资源列表」确认存在 `type=memory_store` 及 `mount_path`。本轮可不新增对外「列会话资源」代理接口；手测用方舟 API 或临时脚本即可。

## 7. arkMemoryClient 工具函数

| 函数 | 行为 |
|------|------|
| `createMemoryStore({ name, description })` | `POST /memory_stores` → `memory_store_id` |
| `getMemoryStoreInfo(memoryStoreId)` | `GET /memory_stores/{id}` |
| `listMemoryFiles(memoryStoreId, pathPrefix?)` | `GET /memory_stores/{id}/memories` |
| `readMemoryById` / 按 path 查找后读 | 返回 `content`、`updated_at`、`content_sha256?` |
| `createMemoryFile(memoryStoreId, path, content)` | `POST .../memories`（不覆盖） |
| `updateMemoryFile(memoryStoreId, memoryId, content, sha?)` | 官方 update |
| `buildMemoryStoreResource(memoryStoreId, instructions)` | 构造 create session 用 resource 对象 |

错误统一转为现有 `ArkApiError`（复用/扩展 `toArkError` 模式）。不打印完整 `webUserToken`；日志可用 tokenHash 前 8 位 + memory_store_id。

若方舟 Memory API 需要独立 beta header，在 memory client 内集中配置，与 session API header 隔离（避免错误组合）。

## 8. 错误处理摘要

| 场景 | 行为 |
|------|------|
| 缺 `webUserToken` / `content` | HTTP 400 |
| 记忆文件 path 不存在（读） | HTTP 404 |
| 创建记忆库失败 | 会话不创建；HTTP 503 + 明确 message |
| Redis 锁等待超时 | HTTP 503「memory store 创建中，请重试」 |
| Upsert sha 冲突 | 重读再 update 一次；仍失败 → 502/409 |
| 会话 create 因 resources 被拒 | 不写 session Redis；返回上游错误 |
| 重建会话 | 记忆映射保留 |

## 9. 测试与手测

**单测**

- `buildCreateSessionBody`：含 `resources` memory_store 项；无 resources 时行为与现网一致
- `MemoryStore`：SET NX 占锁、映射读写、无 TTL
- `writeUserMemory`：create 分支 / update 分支（mock axios）
- path 规范化：`user_profile.json` → `/user_profile.json`

**curl 示例**

```bash
# 1) 写入用户画像（会按需创建记忆库）
curl -X POST http://localhost:3000/api/agent/memory \
  -H 'Content-Type: application/json' \
  -d '{
    "webUserToken":"demo-user",
    "filePath":"/user_profile.json",
    "content":"{\"theme\":\"dark\",\"locale\":\"zh-CN\"}"
  }'

# 2) 读取
curl 'http://localhost:3000/api/agent/memory?webUserToken=demo-user&filePath=/user_profile.json'

# 3) 触发建会话（chat 或 rebuild）后记忆应已挂载
curl -N -X POST http://localhost:3000/api/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"webUserToken":"demo-user","userMessage":"请先读取记忆库中的 user_profile.json 并复述偏好"}'

# 4) 重建会话后记忆应仍在
curl -X POST http://localhost:3000/api/agent/rebuild-session \
  -H 'Content-Type: application/json' \
  -d '{"webUserToken":"demo-user"}'
```

**回归**：无记忆相关改动的 interrupt、文件上传 chat、Custom Tool、历史消息拉取行为不变。

## 10. 验收标准

1. 新用户首次创建会话：自动创建专属记忆库，Redis 写入映射，会话 resources 含 memory_store
2. 老用户创建/重建：复用同一 `memory_store_id`，不重复创建
3. `POST /memory` 写入后 `GET /memory` 可读回
4. 重建会话后记忆库 ID 不变，数据完整
5. 会话资源详情可见 `memory_store` 类型挂载及 `mount_path`

## 11. 官方约束备忘

- 记忆库生命周期独立于会话；删会话 / 沙箱销毁不影响记忆内容
- memory_store 只能在创建会话时挂载，不能像 file 一样运行中追加
- 沙箱内目录在 `/mnt/memory/` 下；具体子目录以 `mount_path` 为准
- `instructions` / store `description` 会进入 Agent 系统提示
- 写入推荐结构化 JSON，便于业务导出分析
- 30 天不活跃后重建会话即可自动重新挂载，无需数据迁移
