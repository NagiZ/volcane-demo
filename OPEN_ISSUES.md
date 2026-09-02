# 待处理问题：方舟接口对接偏差

> 记录时间：2026-09-02
> 状态：**问题 1–2 已修复并验证**；**问题 3 已定位待修**；**问题 4 阻塞，等待官网文档确认**
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
| 单元测试 | 6/6 通过 |
| 服务启动 | `npm run dev` → `http://127.0.0.1:3000` 正常 |

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
| `npm test` | 6/6 通过（注：**均未覆盖 `createArkSession`**，见下） |
| `POST /api/agent/rebuild-session` | **200** `{"ok":true,"tokenHash":"4fd6d90c...","sessionId":"sesn-20260902040239-6dctk"}` |

**为何用 `rebuild-session` 验证：** 该路由（`src/routes/agent.ts:38`）调用 `createArkSession` 后直接返回 JSON，
不经过问题 4 的坏流路径，因此能干净地单独验证问题 1–2 —— 且验证的是**服务端真实代码路径**，非 curl 手工请求体。

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

> ⚠️ **测试覆盖缺口（未解决）：** 6/6 通过与本次修复无关——现有单测只覆盖 `sse`/`arkEventParser`/`hash` 三个纯函数，
> **`arkClient` 与 `createArkSession` 无任何测试**。这正是这两个字段名 bug 能潜到运行时才暴露的原因。
> 建议在修问题 4 时一并补 `arkClient` 的请求体构造测试（断言字段名为 `agent` / `environment.id`），防止回归。

---

## 未修复项：createArkSession 的自定义 session id

**位置：** `src/clients/arkClient.ts:65` — `if (params.sessionId) body.id = params.sessionId`

**本次有意未改动。** 原因：

1. 自定义 session id 的正确字段名是否为 `id` **未经探测验证**；
2. 全项目无调用方传入该参数（`sessionService.ts:13` 未传），属**死代码路径**。

既无法验证、又无人使用，不宜顺手猜测。待文档确认后再处理。

---

## 问题 3：发送事件缺少 events 数组包裹 — 待修

**位置：** `src/clients/arkClient.ts:85`（`sendSessionEvent` 的 body 构造）

代码把单个事件对象直接作为 body，接口要求包在 `events` 数组内。

```jsonc
// 现状 ❌
{ "type": "user.message", "content": [{ "type": "text", "text": "..." }] }
// 接口要求 ✅
{ "events": [{ "type": "user.message", "content": [{ "type": "text", "text": "..." }] }] }
```

**方舟返回：**
```json
{"error":{"code":"InvalidParameter","message":"'events' field is a 'required' parameter, but the request does not have this parameter Request id: 021788320719466c023b1fb2f77c622a3f5432d0f622268496abb","type":"Bad Request"}}
```

**已验证：** 加上 `events` 包裹后消息投递成功，Agent 正常处理并回复（见问题 4 的事件列表）。

---

## 问题 4：⚠️ 阻塞 — `POST /events` 不流式返回回答

这是唯一无法靠改代码解决、需要文档确认的问题。

### 需求假设与实测不符

`prompt.md:34` 与设计文档 `docs/superpowers/specs/2026-09-01-ark-managed-agent-proxy-design.md:187` 均假定：

> 发送消息/事件接口：`POST /api/v3/sessions/{session_id}/events`，**流式返回 Agent 回答**。

现有实现据此把该接口的响应当作 SSE 字节流消费（`responseType: 'stream'` → `streamArkEvents` → 归一化 `delta`）。

**实测：该接口返回的是投递确认 JSON，而非 SSE 流。**

```
Content-Type: application/json; charset=utf-8

{"data":[{"id":"sevt-20260902034529-qr4d5","type":"user.message","content":[{"type":"text","text":"你好，请用一句话自我介绍"}]}]}
```

响应仅回显刚投递的 `user.message`，**不含任何 Agent 回复内容**，且连接立即关闭。
在 body 中加 `"stream": true` 无效（响应体不变）。

### Agent 本身工作正常

回复需通过 `GET /sessions/{id}/events` 读取。该接口返回完整事件列表，Agent 确实已正常处理：

```
session.status_running
session.thread_status_running
user.message              | "你好，请用一句话自我介绍"
span.model_request_start
agent.thinking            | "The user is asking me to introduce myself..."
agent.message             | "你好，我是一个运行在命令行环境中的通用智能体，可以帮你完成代码编写与修复、终端操作..."
span.model_request_end
session.thread_status_idle
session.status_idle
```

**结论：`agent.message` 即回复正文；`agent.thinking` 为思维链，归一化时应过滤。**
Agent 配置回显：`pms-agent` / 模型 `deepseek-v4-flash-ga-260731` / `thinking: enabled`。

### 已排除的流式方案

| 尝试 | 结果 |
|------|------|
| `POST /events` body 加 `stream:true` | 无效，仍返回投递确认 JSON |
| `GET /events?stream=true` | 200 但 `application/json`，非 SSE |
| `GET /events?watch=true` | 同上 |
| `GET /events?follow=true` | 同上 |
| `GET /sessions/{id}/responses` | 404 Not Found |
| `GET /sessions/{id}/stream` | 404 Not Found |
| `GET /sessions/{id}/messages` | 404 Not Found |

> 注：内置网络搜索无法查证方舟文档——请求被方舟侧拦截：
> `403 Access denied ... verify the activation status`。故以上仅为黑盒探测，**不能排除存在未被试到的正确参数或专用接口**。

### ❓ 待你从官网文档确认

1. **是否存在原生流式订阅接口？** 若有，正确的路径与参数是什么？
   （上表的路径/参数均已排除，可能是我未试到的形式。）
2. **若无原生流式接口，采用哪种方案？**

   - **方案 A：轮询模拟流式（倾向）** — `POST` 投递后轮询 `GET /events`，将新增 `agent.message` 增量转为 SSE `delta` 下发。
     *优点：* 保留 README 已定义的前端 SSE 契约，前端无需改动。
     *缺点：* 非真实流式，有轮询延迟；需处理去重（按事件 `id`）与终止判定（`session.status_idle`）。
   - **方案 B：改为非流式** — 等处理完成后一次性返回完整回复，README 与 `/api/agent/chat` 契约相应调整。
     *优点：* 实现简单，无轮询开销。*缺点：* 失去流式体验，长回答等待时间长。

3. **若走方案 A，`GET /events` 是否支持增量拉取？**（如 `after`/`since`/`cursor` 类游标参数，避免每次全量拉取）——此项未探测。

### 受影响范围

修问题 4 需改动的文件（问题 1–2 已修完，仅动了 `arkClient.ts` 的两个字段名；问题 3 亦仅改 `arkClient.ts`）：

| 文件 | 说明 |
|------|------|
| `src/clients/arkClient.ts` | `sendSessionEvent` 返回类型由字节流改为其他形态 |
| `src/utils/streamArkEvents.ts` | 上游不再是 SSE 字节流，解析逻辑需重写 |
| `src/utils/arkEventParser.ts` | 改为解析事件对象；需过滤 `agent.thinking`，取 `agent.message` |
| `src/utils/arkEventParser.test.ts` | 现有 3 个测试基于 SSE 行解析，需同步更新 |
| `src/services/chatService.ts` | 编排逻辑（轮询循环 / 一次性等待） |
| `README.md` | 若走方案 B 需更新 SSE 事件说明 |

> 提醒：现有单测虽 6/6 通过，但 `arkEventParser` 的测试是针对**假定的** SSE 行格式written 的，未覆盖真实响应形态——故测试通过并不代表对接正确。

---

## 探测与验证产生的副作用

在方舟侧创建了 3 个真实 Session（含少量 token 消耗），如需清理可留意：

| Session ID | 来源 | 说明 |
|------------|------|------|
| `sesn-20260902034457-hqr9m` | curl 直连探测 | 收到 2 条消息（"你好，请用一句话自我介绍"、"1+1等于几"） |
| `sesn-20260902034457-c6qwg` | curl 直连探测 | 未发送消息 |
| `sesn-20260902040239-6dctk` | **服务端** `rebuild-session` | 问题 1–2 修复验证，未发送消息 |

**Redis 状态：** 前 2 个由 curl 直连创建，未写入映射。
第 3 个经服务创建，**已在 Redis 写入映射** `tokenHash(fix-verify-token) → sesn-20260902040239-6dctk`
（tokenHash `4fd6d90c...`）。此为验证用的测试数据，可按需清理：

```bash
docker compose exec redis redis-cli --scan --pattern '*4fd6d90c*'
```

