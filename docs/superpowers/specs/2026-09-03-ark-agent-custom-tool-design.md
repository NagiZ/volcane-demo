# Ark Managed Agent Custom Tool 设计

日期：2026-09-03  
状态：已确认  
来源：需求文档 + brainstorming 决策  
依赖：`2026-09-01-ark-managed-agent-proxy-design.md`（会话/鉴权/归一化 SSE）；与文件交互设计并行、互不阻塞  
官方参考：[Custom Tool 使用教程](https://docs.volcengine.com/docs/82379/2608630)、[会话事件类型](https://docs.volcengine.com/docs/82379/2555933)

## 1. 目标与边界

在现有 Node.js + Express + ioredis 代理上，补齐 Custom Tool 全链路：

1. 轮询会话事件时捕获 `agent.custom_tool_use`
2. 工具名注册式分发，执行业务（首版内置 2 个 mock 处理器）
3. 在 `session.status_idle` 且 `stop_reason.type === requires_action` 时，批量回传 `user.custom_tool_result`
4. 对前端扩展 SSE `tool` 事件，并展示工具状态条
5. 工具执行失败以 `is_error: true` 回传，不无故中断整轮会话

**验证链路**

```
前端 chat → user.message
  → Agent 发出 agent.custom_tool_use
  → session.status_idle (requires_action)
  → 后端 registry 执行 → user.custom_tool_result
  → Agent 继续推理 → agent.message → SSE delta
  → 真正 idle → SSE done
  同时：SSE tool(running|done|error) → ToolStatusBar
```

**明确不做（本轮）**

- 真实业务 API（示例保持 mock，可替换注册）
- Agent 控制台 Custom Tool 配置自动化
- 工具调用写入永久消息气泡 / 历史持久化
- 方舟官方 SDK（继续 axios）
- 改动鉴权、`webUserToken`→session 复用逻辑

## 2. 已确认决策

| 议题 | 选择 |
|------|------|
| 事件字段契约 | 严格官方：`id`/`name`/`input`；回传 `custom_tool_use_id`/`content`/`is_error` |
| 执行触发 | 以 `requires_action` + `stop_reason.event_ids` 为准，非见到 `custom_tool_use` 立即回传 |
| 架构 | 轮询内联执行（方案 1）：扩展 `pollSessionEvents` + 独立 registry / arkClient 回传 |
| 前端感知 | 扩展 SSE `tool` + Composer 上方 `ToolStatusBar` |
| 示例工具 | `get_user_order`、`create_work_order`（mock） |
| Base URL | `https://ark.cn-beijing.volces.com/api/v3` |

## 3. 架构与模块

| 模块 | 变更 |
|------|------|
| `src/tools/registry.ts` | 注册中心 + 内置示例处理器注册入口 |
| `src/tools/types.ts` | `ToolHandler`、`ToolContext`、解析后的 `CustomToolUse` |
| `src/clients/arkClient.ts` | `buildCustomToolResultEvents` / `sendCustomToolResults` |
| `src/types/ark.ts` | outbound 增加 `user.custom_tool_result`；session event 扩展相关字段 |
| `src/utils/arkEventParser.ts` | `isCustomToolUseEvent`、`parseCustomToolUse`、`parseRequiresActionIdle` |
| `src/utils/pollSessionEvents.ts` | pending 表；`requires_action` 时回调执行并继续轮询；真正 idle 才收口 |
| `src/services/chatService.ts` | 注入 `userId`、回传函数、`onTool` → SSE |
| `src/types/sse.ts` | 增加 `tool` 事件 |
| `src/server.ts` / 启动处 | 调用 `registerBuiltinTools()` |
| `web/src/types.ts` / `api.ts` | 解析 `tool` |
| `web/src/components/ToolStatusBar.tsx` | 工具状态列表 |
| `web/src/App.tsx` / `styles.css` | 串联与样式 |

现有事件获取方式不变：`POST /events` 投递后 **轮询** `listSessionEvents`（`tryStreamSessionEvents` 仍为可选路径；Custom Tool 编排挂在轮询路径）。若日后真正启用方舟 SSE GET，需复用同一 pending / requires_action 处理函数，本设计以抽离可复用回调为准。

## 4. 方舟事件契约

### 4.1 下行：`agent.custom_tool_use`

```json
{
  "id": "evt-...",
  "type": "agent.custom_tool_use",
  "name": "get_user_order",
  "input": { "order_id": "ORD-001" }
}
```

后端缓存：`pending.set(id, event)`，并向前端发 `tool`/`running`。

### 4.2 暂停：`session.status_idle` + `requires_action`

```json
{
  "id": "evt-...",
  "type": "session.status_idle",
  "status": "idle",
  "stop_reason": {
    "type": "requires_action",
    "event_ids": ["evt-..."]
  }
}
```

对每个 `event_id`：从 pending 取出工具事件 → 执行 handler → 组装结果。  
**同一 `POST .../events` 的 `events` 数组批量发送**全部 `user.custom_tool_result`。  
此 idle **不得**结束本轮 chat。

### 4.3 上行：`user.custom_tool_result`

```json
{
  "events": [
    {
      "type": "user.custom_tool_result",
      "custom_tool_use_id": "evt-...",
      "is_error": false,
      "content": [{ "type": "text", "text": "{\"order_id\":\"ORD-001\",\"status\":\"paid\"}" }]
    }
  ]
}
```

- `custom_tool_use_id` 必须等于原 `agent.custom_tool_use.id`，不可改写
- 结果优先 JSON 字符串放进 text 块，便于 Agent 解析
- 失败：`is_error: true`，`content` 仍提供可读错误文本/JSON

## 5. 轮询行为变更（关键）

现有逻辑：本轮见到 `session.status_idle` 且已有 `agent.message` / `user.interrupt` → 收口。

**新逻辑：**

1. 新事件若为 `agent.custom_tool_use` → 入 pending；可选 `onTool({ status: 'running', ... })`
2. 新事件若为 `session.status_idle`：
   - 若 `parseRequiresActionIdle(event)` 有 `event_ids`：
     - 调用 `executeAndReply(event_ids)`（同步 await 本批工具，避免未回传就继续空转）
     - 对每个工具发 `onTool(done|error)`
     - **不 return**；继续 poll（会话将回到 running）
   - 否则（真正空闲）：保持原收口条件（已回复或已中断）
3. 内置/MCP 的 `pendingToolCalls` 计数逻辑保留，**不**把 `custom_tool_use` 计入同一计数器
4. 回传 API 连续失败：记日志；向客户端发会话级 SSE `error` 并结束本轮，避免会话永久挂在 `requires_action`

`executeAndReply` 签名示意（由 ChatService 注入）：

```ts
async (toolUseIds: string[], pending: Map<string, CustomToolUse>) => Promise<void>
```

内部：lookup registry → `handler(input, { userId })` → `sendCustomToolResults`。

## 6. 工具注册中心

```ts
export type ToolContext = { userId: string };
export type ToolHandler = (
  input: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<unknown>;

registerToolHandler(name: string, handler: ToolHandler): void;
getToolHandler(name: string): ToolHandler | undefined;
```

**内置示例（启动时注册）：**

| 名称 | 入参 | 行为 |
|------|------|------|
| `get_user_order` | `order_id` | 返回 mock 订单 `{ order_id, user_id, status, amount }` |
| `create_work_order` | `title`, `content` | 返回 mock 工单 `{ work_order_id, title, status: 'created' }` |

未注册：`is_error: true`，message 含工具名。  
`userId` 来自现有 token → `resolveUserKey`，供后续真实业务权限校验。

新增真实工具：仅 `registerToolHandler`，不改 poll / chat 核心。

## 7. 对前端 SSE 契约

在 `delta` / `error` / `done` 之外增加：

```ts
{
  type: 'tool';
  tool_name: string;
  call_id: string;       // = 方舟 agent.custom_tool_use.id
  status: 'running' | 'done' | 'error';
  message?: string;      // error 时建议有
}
```

- 工具业务失败 → `type: 'tool', status: 'error'`，**不**自动发会话级 `error`/`done`
- 会话级 `error` 仅用于框架失败（回传失败、超时、中止等）

## 8. 前端 UI

**布局：** `MessageList` → `ToolStatusBar` → `OutputFilesBar` → `Composer`

**ToolStatusBar：**

- 流式中且 `toolCalls.length > 0` 时显示
- 按 `call_id` 更新 `running → done|error`
- 展示工具名 + 状态文案；失败显示 `message`
- 本轮 `done` / 中止 / 会话 `error` 后清空
- 样式延续现有暗色主题，无卡片堆、无 emoji

## 9. 错误处理摘要

| 场景 | 行为 |
|------|------|
| 未注册工具名 | 回传 `is_error: true`；SSE `tool`/`error`；继续会话 |
| handler 抛错 | 捕获；回传 `is_error: true`；SSE `tool`/`error`；继续会话 |
| `event_ids` 在 pending 中缺失 | 该 id 回传 error「unknown tool use」；其余照常；记日志 |
| `sendCustomToolResults` 失败 | 有限次重试（如 2 次）；仍失败 → SSE 会话 `error` 收口 |
| 客户端断开 / interrupt | 现有 abort + `user.interrupt`；pending 工具可不继续回传（会话将由方舟侧中断策略处理） |

## 10. 测试与手测

**单测**

- `buildCustomToolResultEvents` 字段名与 content 形态
- parser：custom_tool_use / requires_action idle
- poll：`requires_action` 触发执行回调且不提前结束；真正 idle 才结束
- 未注册工具 → `is_error: true`

**手测（Agent 控制台需已配置同名 Custom Tool）**

1. 触发 `get_user_order` → 状态条 running→done → 最终回复含订单信息  
2. handler 抛错 → 状态条 error，Agent 仍能说明失败  
3. 无工具 chat、interrupt、文件上传 chat 回归  

## 11. 官方约束备忘

- 先订阅/轮询再发 `user.message`，避免漏掉 `requires_action`（现有 baseline + 后投递已符合）
- 多工具以 `stop_reason.event_ids` 为准，批量回传
- 失败也必须回传 `user.custom_tool_result` 并设 `is_error: true`
- Custom Tool 名建议 1–64 位字母数字下划线连字符；单 Agent 最多 8 个
- 日志禁止打印完整 API Key / token / 大段敏感 payload
