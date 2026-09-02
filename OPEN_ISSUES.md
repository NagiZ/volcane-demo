# 待处理问题：方舟接口对接偏差

> 记录时间：2026-09-02
> 状态：**问题 1–4 均已修复并通过真实 Ark E2E 验证**（2026-09-02）
>
> 背景：首次运行本项目时 `POST /api/agent/chat` 返回 `{"error":"Request failed with status code 400"}`。
> 经直连方舟接口逐项探测，定位出以下 4 个问题。
> 探测环境：`https://ark.cn-beijing.volces.com/api/v3`，凭据取自 `.env`。

---

## 环境状态（均已就绪，非阻塞）

| 项 | 状态 |
|----|------|
| Node.js | v22.17.0 |
| 依赖 | 已安装 |
| Redis | OrbStack 容器运行中，`redis-cli ping` → `PONG` |
| `.env` 三个 ARK 变量 | 已填入真实凭据 |
| 单元测试 | 15/15 通过 |
| 服务启动 | `npm run dev` → `http://127.0.0.1:3000` 正常 |
| 真实 Ark E2E | ✅ 通过（见文末「E2E 验证结果」） |

> **附注：Docker 镜像拉取。** 直连 Docker Hub 拉取 `redis:7` 失败（`registry-1.docker.io` 返回 502 Bad Gateway）。
> 已改用镜像源拉取后打本地标签绕过，`docker-compose.yml` 无需修改：
> ```bash
> docker pull docker.m.daocloud.io/library/redis:7
> docker tag docker.m.daocloud.io/library/redis:7 redis:7
> docker compose up -d
> ```
> 换机器或清理镜像后需重跑上述命令。（`docker.1ms.run` 同样可用；`dockerpull.org` 不可用。）

---

## 问题 1：创建 Session 的 agent 字段名错误 — ✅ 已修复

**位置：** `src/clients/arkClient.ts:53`

代码发送 `agent_id`，接口要求 `agent`。

```jsonc
// 修复前 ❌
{ "agent_id": "agent-xxx" }
// 修复后 ✅
{ "agent": "agent-xxx" }
```

**方舟返回（修复前）：**
```json
{"error":{"code":"MissingParameter","message":"The request failed because it is missing `agent` parameter. Request id: 0217883206833085f5f9cdf929782a5554623bbcd9b85d7fd4d9d","type":"Bad Request"}}
```

**取值说明：** `agent` 传字符串（`"agent-xxx"`）与传对象（`{"id":"agent-xxx"}`）**两种写法实测均可成功创建 Session**。
已采用**字符串**形式——与 `CreateSessionParams.agentId` 的既有字符串形状一致，改动最小。
若官网文档明确要求对象形式，此处需再调整（功能等价，非阻塞）。

---

## 问题 2：创建 Session 的 environment 字段名错误 — ✅ 已修复

**位置：** `src/clients/arkClient.ts:61`

代码在 `environment` 内层用 `environment_id`，接口要求 `id`。

```jsonc
// 修复前 ❌
"environment": { "type": "environment_with_overrides", "environment_id": "env-xxx", "config": {...} }
// 修复后 ✅
"environment": { "type": "environment_with_overrides", "id": "env-xxx", "config": {...} }
```

**方舟返回（修复前）：**
```json
{"error":{"code":"MissingParameter","message":"The request failed because it is missing `environment.id` parameter. Request id: 021788320668751a71fb5caa63bcd7df8c9e328d4d305c2f62382","type":"Bad Request"}}
```

**可用的完整请求体（实测通过）：**
```bash
curl -X POST "https://ark.cn-beijing.volces.com/api/v3/sessions" \
  -H "Authorization: Bearer $ARK_API_KEY" -H 'Content-Type: application/json' \
  -d '{
    "agent": "'"$ARK_AGENT_ID"'",
    "environment": {
      "type": "environment_with_overrides",
      "id": "'"$ARK_BASE_ENVIRONMENT_ID"'",
      "config": { "env": { "USER_ID": "probe", "USER_BEARER_TOKEN": "probe" } }
    }
  }'
```

---

## 问题 1–2 的修复验证

改动仅一处：`src/clients/arkClient.ts` 的 `createArkSession` body 构造（两个字段名）。
`src/types/ark.ts` 无需改动——`CreateSessionParams` 是内部入参形状，与线上字段名解耦。

| 验证项 | 结果 |
|--------|------|
| `npx tsc --noEmit` | 通过 |
| `npm test` | 15/15 通过（`arkClient` 请求体字段名已纳入覆盖） |
| `POST /api/agent/rebuild-session` | **200** `{"ok":true,"tokenHash":"4fd6d90c...","sessionId":"sesn-20260902040239-6dctk"}` |

**为何用 `rebuild-session` 验证：** 该路由（`src/routes/agent.ts:38`）调用 `createArkSession` 后直接返回 JSON，
不经过问题 4 当时尚未修复的坏流路径，因此能干净地单独验证问题 1–2 —— 且验证的是**服务端真实代码路径**，非 curl 手工请求体。

**env 覆盖注入确认**（问题 2 的实质目的）——回查服务创建出的 Session：

```
session:             sesn-20260902040239-6dctk
agent.id:            agent-20260831101610-mph52
env.id:              env-20260831103937-t9vs7
overridden_fields:   ["env"]
injected env:        {"USER_BEARER_TOKEN":"fix-verify-token",
                      "USER_ID":"4fd6d90c54b0753db590203ff338e738ea6c24d8c568cf99201169f053bde791"}
```

`USER_ID` = tokenHash、`USER_BEARER_TOKEN` = 原始 token，与 `sessionService.ts:18-19` 传参一致，
覆盖机制完全符合设计预期。**问题 1–2 至此闭环，无残留。**

> ⚠️ **测试覆盖（已改善）：** 现有 15 项单测覆盖 `hash` / `sse` / `arkEventParser` / `arkClient` 请求体构造 / `pollSessionEvents`。
> 仍缺真实 Ark E2E 自动化测试。

---

## 未修复项：createArkSession 的自定义 session id

**位置：** `src/clients/arkClient.ts:65` — `if (params.sessionId) body.id = params.sessionId`

**本次有意未改动。** 原因：

1. 自定义 session id 的正确字段名是否为 `id` **未经探测验证**；
2. 全项目无调用方传入该参数（`sessionService.ts:13` 未传），属**死代码路径**。

既无法验证、又无人使用，不宜顺手猜测。待文档确认后再处理。

---

## 问题 3：发送事件缺少 events 数组包裹 — ✅ 已修复

**位置：** `src/clients/arkClient.ts` — `buildSendSessionEventsBody` / `sendSessionEvent`

```jsonc
// 修复后 ✅
{ "events": [{ "type": "user.message", "content": [{ "type": "text", "text": "..." }] }] }
```

**修复说明：** `sendSessionEvent` 改为 JSON 投递确认响应（非 stream）；单测 `arkClient.test.ts` 断言 `events` 数组结构。

---

## 问题 4：POST /events 不流式返回回答 — ✅ 已修复（轮询 + 可选 SSE GET）

**官方文档结构（Managed Agents API）：**
- **发送会话事件** — `POST /sessions/{id}/events`（投递确认 JSON）
- **查询会话事件列表** — `GET /sessions/{id}/events`（JSON 列表）
- **流式获取会话事件** — 同路径 `GET`，请求头 `Accept: text/event-stream`

原实现误将 POST 响应当 SSE 消费，导致永远读不到 `agent.message`。

**修复方案（已实现）：**

1. `POST` 投递 `user.message`（`events` 数组包裹）
2. 优先尝试 `GET` + `Accept: text/event-stream`（`tryStreamSessionEvents`）
3. 若非 SSE，回退 **轮询** `listSessionEvents`（`pollSessionEventsForAgentReply`）：
   - 投递前记录 baseline 事件 id，避免历史事件干扰
   - 只提取新增 `agent.message` 文本 → SSE `delta`
   - 过滤 `agent.thinking`
   - 出现 `session.status_idle` 且本轮有新 user/agent 事件时结束

**改动文件：**

| 文件 | 说明 |
|------|------|
| `src/clients/arkClient.ts` | `sendSessionEvent` / `listSessionEvents` / `tryStreamSessionEvents` |
| `src/utils/pollSessionEvents.ts` | 轮询编排（新增） |
| `src/utils/arkEventParser.ts` | 解析 `agent.message`，过滤 `agent.thinking` |
| `src/services/chatService.ts` | POST → stream GET 或 poll → 归一化 SSE |
| `src/clients/arkClient.test.ts` | 请求体字段名单测（新增） |
| `src/utils/pollSessionEvents.test.ts` | 轮询逻辑单测（新增） |

**验证：** `npm test` 15/15 通过，`npm run build` 通过。真实 Ark E2E 已通过（见下节）。

> ⚠️ **实测修正：`Accept: text/event-stream` 在本环境不生效。**
> 步骤 2 的流式尝试**从未成功**，实际始终走步骤 3 的轮询回退。实测证据：
>
> | 时机 | 请求 | 响应 |
> |------|------|------|
> | Session idle | `GET /events` + `Accept: text/event-stream` | `200`，`application/json; charset=utf-8` |
> | Session **处理中**（投递长回答后立即请求） | 同上 | `200`，`application/json; charset=utf-8` |
>
> 两种时机下 `Content-Type` 均为 JSON，无 SSE 分块。特意在「处理中」复测，是为排除
> 「因 Session 空闲才降级为 JSON」的可能——结论是该接口在本环境不支持 SSE。
>
> 这不影响功能正确性（轮询回退工作正常），但意味着：
> - `tryStreamSessionEvents` 目前是**未被真正启用的代码路径**，每轮对话会多一次无效请求；
> - 若官网文档确认该 header 应当生效，则可能是 API 版本/地域/Agent 配置差异，值得再核对；
> - 若确认不支持，可考虑移除该尝试以省掉一次往返。

---

## E2E 验证结果（真实 Ark 调用）

服务运行于 `http://127.0.0.1:3000`，Redis 为 OrbStack 容器，凭据取自 `.env`。

**第一轮** — `POST /api/agent/chat`，`webUserToken: "e2e-verify"`：

```
data: {"type":"delta","text":"你好！我是 pms-agent，一个运行在命令行环境中的通用智能体，可以帮你完成软件开发、终端操作、数据分析、文档写作等各种任务——比如乐药内部系统的 PMS 业务操作也可以通过我来完成。有什么需要帮忙的吗？"}

data: {"type":"done"}
```

**第二轮**（同一 token）— 问「我刚才问你的第一句话是什么？请原样重复」：

```
data: {"type":"delta","text":"你刚才问我的第一句话是：“你好，请用一句话自我介绍”。"}

data: {"type":"done"}
```

### 验证结论

| 验证项 | 结果 | 依据 |
|--------|------|------|
| SSE 契约 | ✅ | `delta` → `done`，与 README 定义一致 |
| **会话复用** | ✅ | 第二轮准确复述第一轮内容，证明 Redis 映射生效、非每次新建 Session |
| **`agent.thinking` 过滤** | ✅ | 方舟侧确实产生 `agent.thinking x2`，但两轮 SSE 输出均无思维链混入 |
| 多轮落于同一 Session | ✅ | 方舟侧 `user.message x2`，Session ID 唯一 |

**方舟侧事件统计**（Session `sesn-20260902055828-26lb8`，对应 Redis key `ark:session:map:9041cc57...`）：

```
session.status_running x2      user.message x2         agent.thinking x2
session.thread_status_running x2   span.model_request_start x2   agent.message x2
session.thread_status_idle x2      span.model_request_end x2     session.status_idle x2
```

> `agent.thinking` 的过滤是**被真实数据触发并验证**的，而非碰巧未遇到——这是特意回查方舟侧事件列表确认的。

### 已知行为差异：非逐字流式

轮询实现下 `delta` 为**整段一次性下发**（上述两轮各只有 1 个 `delta` 事件），
对前端 SSE 契约成立，但**无打字机逐字效果**。

若需真正的逐字流式，取决于方舟是否提供原生流式接口——目前已排除 8 种尝试
（见问题 4 的排除表 + 上文 `Accept: text/event-stream` 的两次时机实测）。

---

## 探测与验证产生的副作用

在方舟侧创建了 4 个真实 Session（含 token 消耗），如需清理可留意：

| Session ID | 来源 | 说明 |
|------------|------|------|
| `sesn-20260902034457-hqr9m` | curl 直连探测 | 收到 2 条消息（"你好，请用一句话自我介绍"、"1+1等于几"） |
| `sesn-20260902034457-c6qwg` | curl 直连探测 | 未发送消息 |
| `sesn-20260902040239-6dctk` | **服务端** `rebuild-session` | 问题 1–2 修复验证，未发送消息 |
| `sesn-20260902055828-26lb8` | **服务端** `chat` | E2E 验证，收到 3 条消息（2 轮对话 + 1 条 SSE 时机探测） |

**Redis 中的测试映射**（均为验证数据，可按需清理）：

| tokenHash 前缀 | webUserToken | Session |
|----------------|--------------|---------|
| `4fd6d90c...` | `fix-verify-token` | `sesn-20260902040239-6dctk` |
| `9041cc57...` | `e2e-verify` | `sesn-20260902055828-26lb8` |

前 2 个 Session 由 curl 直连创建，未写入 Redis 映射。

```bash
# 查看
docker compose exec redis redis-cli --scan --pattern 'ark:session:map:*'
# 清理本次验证数据
docker compose exec redis redis-cli DEL \
  ark:session:map:4fd6d90c54b0753db590203ff338e738ea6c24d8c568cf99201169f053bde791 \
  ark:session:map:9041cc577fac319d2bb8a0dce1cdce7bbd3337c7db6852c95dc52152e497a976
```

> 另注：`sesn-20260902055828-26lb8` 的第 3 条消息（"请从1数到20…"）是为验证
> 「处理中」时机的 SSE 行为而直连投递的，其 `agent.message` 未经服务读取，属探测残留。

