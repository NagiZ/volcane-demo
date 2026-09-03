# Ark Agent Custom Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Managed Agents 代理上实现 Custom Tool 全链路：捕获 `agent.custom_tool_use`、注册式分发执行、`requires_action` 时批量回传 `user.custom_tool_result`，并向前端推送 SSE `tool` 与状态条。

**Architecture:** 扩展轮询路径：`pollSessionEvents` 维护 pending 表，遇 `requires_action` idle 时通过注入回调执行 registry 并 `sendCustomToolResults`；真正 idle 才 SSE `done`。工具与框架解耦；前端新增 `tool` 事件与 `ToolStatusBar`。

**Tech Stack:** TypeScript, Express, axios, vitest, React + Vite

**Spec:** `docs/superpowers/specs/2026-09-03-ark-agent-custom-tool-design.md`

## Global Constraints

- Base URL：`https://ark.cn-beijing.volces.com/api/v3`
- 禁止引入火山方舟官方 SDK；使用 axios 纯 HTTP
- 事件字段严格官方：`id`/`name`/`input`；回传 `custom_tool_use_id`/`content`/`is_error`
- 仅在 `stop_reason.type === requires_action` 时执行并回传；批量放同一 `events` 数组
- `requires_action` idle **不得**结束本轮 chat
- SSE 新增 `{ type:'tool', tool_name, call_id, status:'running'|'done'|'error', message? }`
- `userId`（ToolContext）= `resolveUserKey(webUserToken).tokenHash`（与创建 Session 的 `USER_ID` 一致）
- 日志禁止打印完整 `webUserToken` / `ARK_API_KEY` / 大段敏感 payload
- Commit message 用中文 conventional commits；含 TAPD 占位（仅在用户要求提交时执行 commit 步骤）

---

## File Map

| 文件 | 职责 |
|------|------|
| `src/tools/types.ts` | ToolHandler / ToolContext / CustomToolUse |
| `src/tools/registry.ts` | 注册表 + get/register |
| `src/tools/builtinTools.ts` | 两个 mock 工具 + `registerBuiltinTools()` |
| `src/tools/executeCustomTools.ts` | 按 event_ids 执行并组装回传项 |
| `src/tools/*.test.ts` | 注册与执行单测 |
| `src/types/ark.ts` | outbound / session event 字段扩展 |
| `src/types/sse.ts` | SSE `tool` 联合成员 |
| `src/utils/arkEventParser.ts` | custom_tool_use / requires_action 解析 |
| `src/utils/arkEventParser.test.ts` | parser 单测 |
| `src/clients/arkClient.ts` | build + sendCustomToolResults（含短重试） |
| `src/clients/arkClient.test.ts` | body 单测 |
| `src/utils/pollSessionEvents.ts` | pending + requires_action 回调 |
| `src/utils/pollSessionEvents.test.ts` | 轮询行为单测 |
| `src/services/chatService.ts` | 注入 userId / onTool / 执行回调 |
| `src/server.ts` | 启动时 `registerBuiltinTools()` |
| `web/src/types.ts` / `api.ts` | 解析 `tool` |
| `web/src/components/ToolStatusBar.tsx` | 状态条 UI |
| `web/src/App.tsx` / `styles.css` | 串联 |

---

### Task 1: 类型 + 事件解析

**Files:**
- Create: `src/tools/types.ts`
- Modify: `src/types/ark.ts`
- Modify: `src/types/sse.ts`
- Modify: `src/utils/arkEventParser.ts`
- Modify: `src/utils/arkEventParser.test.ts`

**Interfaces:**
- Produces:
  - `ToolContext { userId: string }`
  - `ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>`
  - `CustomToolUse { id: string; name: string; input: Record<string, unknown> }`
  - `CustomToolResultItem { custom_tool_use_id: string; is_error: boolean; content: Array<{ type: 'text'; text: string }> }`
  - `ArkOutboundEvent` 增加 `user.custom_tool_result` 分支
  - `ArkSessionEvent` 增加可选 `name?` `input?` `stop_reason?` `status?`
  - `NormalizedSseEvent` 增加 `tool` 分支
  - `isCustomToolUseEvent(raw): boolean`
  - `parseCustomToolUse(raw): CustomToolUse | null`
  - `parseRequiresActionIdle(raw): { eventIds: string[] } | null`

- [ ] **Step 1: 写失败单测（parser）**

在 `src/utils/arkEventParser.test.ts` 追加（若文件不存在则创建）：

```ts
import { describe, expect, it } from 'vitest';
import {
  isCustomToolUseEvent,
  parseCustomToolUse,
  parseRequiresActionIdle,
} from './arkEventParser.js';

describe('custom tool parsers', () => {
  it('parses agent.custom_tool_use', () => {
    const raw = {
      id: 'evt-1',
      type: 'agent.custom_tool_use',
      name: 'get_user_order',
      input: { order_id: 'ORD-1' },
    };
    expect(isCustomToolUseEvent(raw)).toBe(true);
    expect(parseCustomToolUse(raw)).toEqual({
      id: 'evt-1',
      name: 'get_user_order',
      input: { order_id: 'ORD-1' },
    });
  });

  it('parses requires_action idle', () => {
    expect(
      parseRequiresActionIdle({
        type: 'session.status_idle',
        stop_reason: { type: 'requires_action', event_ids: ['evt-1', 'evt-2'] },
      }),
    ).toEqual({ eventIds: ['evt-1', 'evt-2'] });
  });

  it('returns null for normal idle', () => {
    expect(parseRequiresActionIdle({ type: 'session.status_idle' })).toBeNull();
    expect(
      parseRequiresActionIdle({
        type: 'session.status_idle',
        stop_reason: { type: 'end_turn', event_ids: [] },
      }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npm test -- src/utils/arkEventParser.test.ts`  
Expected: FAIL（函数未导出）

- [ ] **Step 3: 实现类型与 parser**

创建 `src/tools/types.ts`：

```ts
export interface ToolContext {
  /** 与创建 Session 时 USER_ID 一致：tokenHash */
  userId: string;
}

export type ToolHandler = (
  input: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<unknown>;

export interface CustomToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface CustomToolResultItem {
  custom_tool_use_id: string;
  is_error: boolean;
  content: Array<{ type: 'text'; text: string }>;
}
```

更新 `src/types/ark.ts`：

- `ArkSessionEvent` 增加：
```ts
  name?: string;
  input?: unknown;
  status?: string;
  stop_reason?: {
    type?: string;
    event_ids?: string[];
  };
```

- `ArkOutboundEvent` 改为：
```ts
export type ArkOutboundEvent =
  | { type: 'user.message'; content: ArkMessageContentBlock[] }
  | { type: 'user.interrupt' }
  | {
      type: 'user.custom_tool_result';
      custom_tool_use_id: string;
      is_error: boolean;
      content: Array<{ type: 'text'; text: string }>;
    };
```

更新 `src/types/sse.ts`：

```ts
export type NormalizedSseEvent =
  | { type: 'delta'; text: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' }
  | {
      type: 'tool';
      tool_name: string;
      call_id: string;
      status: 'running' | 'done' | 'error';
      message?: string;
    };
```

在 `arkEventParser.ts` 实现：

```ts
import type { CustomToolUse } from '../tools/types.js';

export function isCustomToolUseEvent(raw: unknown): boolean {
  return Boolean(
    raw && typeof raw === 'object' && (raw as Record<string, unknown>).type === 'agent.custom_tool_use',
  );
}

export function parseCustomToolUse(raw: unknown): CustomToolUse | null {
  if (!isCustomToolUseEvent(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : '';
  const name = typeof o.name === 'string' ? o.name : '';
  if (!id || !name) return null;
  const input =
    o.input && typeof o.input === 'object' && !Array.isArray(o.input)
      ? (o.input as Record<string, unknown>)
      : {};
  return { id, name, input };
}

export function parseRequiresActionIdle(raw: unknown): { eventIds: string[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.type !== 'session.status_idle') return null;
  const sr = o.stop_reason;
  if (!sr || typeof sr !== 'object') return null;
  const stop = sr as Record<string, unknown>;
  if (stop.type !== 'requires_action') return null;
  const ids = stop.event_ids;
  if (!Array.isArray(ids)) return null;
  const eventIds = ids.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return { eventIds };
}
```

- [ ] **Step 4: 跑通 parser 单测**

Run: `npm test -- src/utils/arkEventParser.test.ts`  
Expected: PASS

---

### Task 2: 工具注册中心 + 内置示例 + execute 编排

**Files:**
- Create: `src/tools/registry.ts`
- Create: `src/tools/builtinTools.ts`
- Create: `src/tools/executeCustomTools.ts`
- Create: `src/tools/registry.test.ts`
- Create: `src/tools/executeCustomTools.test.ts`
- Modify: `src/server.ts`（注册 builtin）

**Interfaces:**
- Consumes: Task 1 types
- Produces:
  - `registerToolHandler(name, handler)` / `getToolHandler(name)` / `clearToolHandlers()`（仅测试）
  - `registerBuiltinTools()`
  - `resultToTextContent(value: unknown): string`
  - `executeCustomTools(params): Promise<CustomToolResultItem[]>`

- [ ] **Step 1: 写失败单测**

`src/tools/registry.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { clearToolHandlers, getToolHandler, registerToolHandler } from './registry.js';

describe('tool registry', () => {
  beforeEach(() => clearToolHandlers());

  it('registers and retrieves handler', async () => {
    registerToolHandler('echo', async (input) => input);
    const h = getToolHandler('echo');
    expect(h).toBeTypeOf('function');
    await expect(h!({ a: 1 }, { userId: 'u1' })).resolves.toEqual({ a: 1 });
  });
});
```

`src/tools/executeCustomTools.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { clearToolHandlers, registerToolHandler } from './registry.js';
import { executeCustomTools } from './executeCustomTools.js';
import type { CustomToolUse } from './types.js';

describe('executeCustomTools', () => {
  beforeEach(() => clearToolHandlers());

  it('runs registered tool and serializes JSON text', async () => {
    registerToolHandler('get_user_order', async (input, ctx) => ({
      order_id: input.order_id,
      user_id: ctx.userId,
      status: 'paid',
    }));
    const pending = new Map<string, CustomToolUse>([
      [
        'evt-1',
        { id: 'evt-1', name: 'get_user_order', input: { order_id: 'ORD-1' } },
      ],
    ]);
    const results = await executeCustomTools({
      eventIds: ['evt-1'],
      pending,
      userId: 'hash-u',
    });
    expect(results).toHaveLength(1);
    expect(results[0].custom_tool_use_id).toBe('evt-1');
    expect(results[0].is_error).toBe(false);
    expect(JSON.parse(results[0].content[0].text)).toMatchObject({
      order_id: 'ORD-1',
      user_id: 'hash-u',
      status: 'paid',
    });
  });

  it('returns is_error for unknown tool and missing pending', async () => {
    const pending = new Map<string, CustomToolUse>();
    const results = await executeCustomTools({
      eventIds: ['missing', 'evt-2'],
      pending: new Map([
        ['evt-2', { id: 'evt-2', name: 'nope', input: {} }],
      ]),
      userId: 'u',
    });
    expect(results[0].is_error).toBe(true);
    expect(results[1].is_error).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npm test -- src/tools/`  
Expected: FAIL

- [ ] **Step 3: 实现 registry / builtin / execute**

`src/tools/registry.ts`：

```ts
import type { ToolHandler } from './types.js';

const handlers = new Map<string, ToolHandler>();

export function registerToolHandler(name: string, handler: ToolHandler): void {
  const key = name.trim();
  if (!key) throw new Error('tool name is required');
  handlers.set(key, handler);
}

export function getToolHandler(name: string): ToolHandler | undefined {
  return handlers.get(name);
}

/** 仅供单测重置 */
export function clearToolHandlers(): void {
  handlers.clear();
}
```

`src/tools/builtinTools.ts`：

```ts
import { registerToolHandler } from './registry.js';

export function registerBuiltinTools(): void {
  registerToolHandler('get_user_order', async (input, ctx) => {
    const orderId = typeof input.order_id === 'string' ? input.order_id : 'unknown';
    return {
      order_id: orderId,
      user_id: ctx.userId,
      status: 'paid',
      amount: 99.0,
      currency: 'CNY',
    };
  });

  registerToolHandler('create_work_order', async (input, ctx) => {
    const title = typeof input.title === 'string' ? input.title : '';
    const content = typeof input.content === 'string' ? input.content : '';
    return {
      work_order_id: `WO-${Date.now()}`,
      title,
      content,
      status: 'created',
      created_by: ctx.userId,
    };
  });
}
```

`src/tools/executeCustomTools.ts`：

```ts
import { getToolHandler } from './registry.js';
import type { CustomToolResultItem, CustomToolUse } from './types.js';

export function resultToTextContent(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorResult(customToolUseId: string, message: string): CustomToolResultItem {
  return {
    custom_tool_use_id: customToolUseId,
    is_error: true,
    content: [{ type: 'text', text: resultToTextContent({ error: message }) }],
  };
}

export async function executeCustomTools(params: {
  eventIds: string[];
  pending: Map<string, CustomToolUse>;
  userId: string;
}): Promise<CustomToolResultItem[]> {
  const out: CustomToolResultItem[] = [];
  for (const eventId of params.eventIds) {
    const toolEvent = params.pending.get(eventId);
    params.pending.delete(eventId);
    if (!toolEvent) {
      out.push(errorResult(eventId, `Unknown custom_tool_use id: ${eventId}`));
      continue;
    }
    const handler = getToolHandler(toolEvent.name);
    if (!handler) {
      out.push(errorResult(eventId, `Unknown custom tool: ${toolEvent.name}`));
      continue;
    }
    try {
      const result = await handler(toolEvent.input, { userId: params.userId });
      out.push({
        custom_tool_use_id: eventId,
        is_error: false,
        content: [{ type: 'text', text: resultToTextContent(result) }],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tool execution failed';
      console.error(`[custom-tool] ${toolEvent.name} failed:`, message);
      out.push(errorResult(eventId, message));
    }
  }
  return out;
}
```

`src/server.ts` 在 `main` 开头（loadConfig 之后）调用：

```ts
import { registerBuiltinTools } from './tools/builtinTools.js';
// ...
registerBuiltinTools();
```

- [ ] **Step 4: 跑通 tools 单测**

Run: `npm test -- src/tools/`  
Expected: PASS

---

### Task 3: arkClient 回传 user.custom_tool_result

**Files:**
- Modify: `src/clients/arkClient.ts`
- Modify: `src/clients/arkClient.test.ts`

**Interfaces:**
- Consumes: `CustomToolResultItem`、`SendSessionEventsRequestBody`
- Produces:
  - `buildCustomToolResultEvents(results: CustomToolResultItem[]): SendSessionEventsRequestBody`
  - `sendCustomToolResults(params): Promise<void>`（失败最多重试 2 次，共 3 次尝试）

- [ ] **Step 1: 写失败单测**

```ts
import { buildCustomToolResultEvents } from './arkClient.js';

describe('buildCustomToolResultEvents', () => {
  it('matches official user.custom_tool_result shape', () => {
    expect(
      buildCustomToolResultEvents([
        {
          custom_tool_use_id: 'evt-1',
          is_error: false,
          content: [{ type: 'text', text: '{"ok":true}' }],
        },
      ]),
    ).toEqual({
      events: [
        {
          type: 'user.custom_tool_result',
          custom_tool_use_id: 'evt-1',
          is_error: false,
          content: [{ type: 'text', text: '{"ok":true}' }],
        },
      ],
    });
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npm test -- src/clients/arkClient.test.ts`  
Expected: FAIL

- [ ] **Step 3: 实现 build + send**

在 `arkClient.ts`：

```ts
import type { CustomToolResultItem } from '../tools/types.js';

export function buildCustomToolResultEvents(
  results: CustomToolResultItem[],
): SendSessionEventsRequestBody {
  return {
    events: results.map((r) => ({
      type: 'user.custom_tool_result' as const,
      custom_tool_use_id: r.custom_tool_use_id,
      is_error: r.is_error,
      content: r.content,
    })),
  };
}

export interface SendCustomToolResultsParams {
  arkApiKey: string;
  arkBaseUrl: string;
  sessionId: string;
  results: CustomToolResultItem[];
  signal?: AbortSignal;
  /** 额外尝试次数，默认 2（总尝试 = 1 + retries） */
  retries?: number;
}

export async function sendCustomToolResults(params: SendCustomToolResultsParams): Promise<void> {
  if (params.results.length === 0) return;
  const body = buildCustomToolResultEvents(params.results);
  const retries = params.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await axios.post(
        `${params.arkBaseUrl}/sessions/${encodeURIComponent(params.sessionId)}/events`,
        body,
        {
          headers: authHeaders(params.arkApiKey),
          timeout: NO_TIMEOUT,
          signal: params.signal,
        },
      );
      return;
    } catch (err) {
      lastErr = err;
      if (params.signal?.aborted) break;
    }
  }
  throw toArkError(lastErr);
}
```

- [ ] **Step 4: 跑通 arkClient 单测**

Run: `npm test -- src/clients/arkClient.test.ts`  
Expected: PASS

---

### Task 4: 扩展 pollSessionEvents（requires_action）

**Files:**
- Modify: `src/utils/pollSessionEvents.ts`
- Modify: `src/utils/pollSessionEvents.test.ts`

**Interfaces:**
- Consumes: `parseCustomToolUse`、`parseRequiresActionIdle`、`isCustomToolUseEvent`
- Produces: `PollSessionEventsParams` 增加：
  - `onTool?: (ev: { tool_name: string; call_id: string; status: 'running'|'done'|'error'; message?: string }) => void`
  - `onRequiresAction?: (eventIds: string[], pending: Map<string, CustomToolUse>) => Promise<void>`

行为要点：
1. 新 `custom_tool_use` → `pending.set` + `onTool(running)`
2. 新 idle 且 `parseRequiresActionIdle` 非空 → `await onRequiresAction(eventIds, pending)`；**不 return**
3. 新 idle 且非 requires_action → 保持原「已回复或中断则 return」
4. `custom_tool_use` **不**增减 `pendingToolCalls`

- [ ] **Step 1: 写失败/行为单测**

追加到 `pollSessionEvents.test.ts`：

```ts
import type { CustomToolUse } from '../tools/types.js';

it('requires_action 触发回调且不提前结束，真正 idle 才收口', async () => {
  const pendingSeen: string[][] = [];
  const tools: Array<{ status: string; call_id: string }> = [];
  const rounds: ArkSessionEvent[][] = [
    [
      { id: 'run1', type: 'session.status_running' },
      {
        id: 'ctu1',
        type: 'agent.custom_tool_use',
        name: 'get_user_order',
        input: { order_id: '1' },
      },
    ],
    [
      { id: 'run1', type: 'session.status_running' },
      {
        id: 'ctu1',
        type: 'agent.custom_tool_use',
        name: 'get_user_order',
        input: { order_id: '1' },
      },
      {
        id: 'idle-ra',
        type: 'session.status_idle',
        stop_reason: { type: 'requires_action', event_ids: ['ctu1'] },
      },
    ],
    [
      { id: 'run2', type: 'session.status_running' },
      { id: 'm1', type: 'agent.message', content: [{ type: 'text', text: '订单已付' }] },
      { id: 'idle-done', type: 'session.status_idle' },
    ],
  ];
  let i = 0;
  await pollSessionEventsForAgentReply({
    listEvents: async () => rounds[Math.min(i++, rounds.length - 1)]!,
    pollIntervalMs: 1,
    onDelta: () => {},
    onTool: (ev) => tools.push({ status: ev.status, call_id: ev.call_id }),
    onRequiresAction: async (eventIds, pending) => {
      pendingSeen.push([...eventIds]);
      for (const id of eventIds) pending.delete(id);
    },
  });
  expect(pendingSeen).toEqual([['ctu1']]);
  expect(tools.some((t) => t.call_id === 'ctu1' && t.status === 'running')).toBe(true);
});
```

（实现时按现有测试风格微调：确保 `onDelta` 收到最终文本或至少函数正常返回。）

- [ ] **Step 2: 跑测确认失败或旧行为误收口**

Run: `npm test -- src/utils/pollSessionEvents.test.ts`  
Expected: 新用例 FAIL（无 onRequiresAction / 过早结束）

- [ ] **Step 3: 实现 poll 扩展**

在 `PollSessionEventsParams` 增加可选回调。循环内：

```ts
import {
  // 现有 imports...
  parseCustomToolUse,
  parseRequiresActionIdle,
} from './arkEventParser.js';
import type { CustomToolUse } from '../tools/types.js';

// 在函数内：
const pendingCustomTools = new Map<string, CustomToolUse>();

// 在处理 newEvents 的循环中：
for (const event of newEvents) {
  seen.add(sessionEventKey(event));
  if (isToolUseEvent(event)) pendingToolCalls++;
  else if (isToolResultEvent(event)) pendingToolCalls = Math.max(0, pendingToolCalls - 1);
  if (isUserInterruptEvent(event)) interrupted = true;

  const custom = parseCustomToolUse(event);
  if (custom) {
    pendingCustomTools.set(custom.id, custom);
    params.onTool?.({
      tool_name: custom.name,
      call_id: custom.id,
      status: 'running',
    });
  }

  const requires = parseRequiresActionIdle(event);
  if (requires && params.onRequiresAction) {
    await params.onRequiresAction(requires.eventIds, pendingCustomTools);
    lastProgressAt = Date.now();
  }
}

// 收口处：仅当「非 requires_action idle」时才 hasNewIdle 收口
const hasNewTerminalIdle = newEvents.some((e) => {
  if (!isSessionIdleEvent(e)) return false;
  return parseRequiresActionIdle(e) == null;
});

if (hasNewTerminalIdle && (repliedAt !== null || interrupted)) {
  return;
}
```

删除或替换原先 `hasNewIdle = newEvents.some(isSessionIdleEvent)` 的收口用法。

- [ ] **Step 4: 全量 poll 单测通过**

Run: `npm test -- src/utils/pollSessionEvents.test.ts`  
Expected: PASS（含旧用例；若旧用例依赖「任意 idle」需确认 fixtures 无 requires_action）

---

### Task 5: ChatService 接线 + SSE tool

**Files:**
- Modify: `src/services/chatService.ts`

**Interfaces:**
- Consumes: `executeCustomTools`、`sendCustomToolResults`、`resolveUserKey`
- Produces: `streamOnce` 内轮询带 `onTool` / `onRequiresAction`

- [ ] **Step 1: 在 `streamOnce` 的 `pollSessionEventsForAgentReply` 调用处接线**

`streamOnce` 增加参数或从外层传入 `userId: string`（tokenHash）。  
`streamChat` 里 `getOrCreateSession` 已返回 `tokenHash`，传入 `streamOnce`。

```ts
import { sendCustomToolResults } from '../clients/arkClient.js';
import { executeCustomTools } from '../tools/executeCustomTools.js';

// poll 调用：
await pollSessionEventsForAgentReply({
  listEvents: () => listSessionEvents(this.arkListParams(sessionId, signal)),
  baselineEventIds,
  onDelta: (text) => writeSseEvent(res, { type: 'delta', text }),
  onTool: (ev) => writeSseEvent(res, { type: 'tool', ...ev }),
  onRequiresAction: async (eventIds, pending) => {
    const results = await executeCustomTools({
      eventIds,
      pending,
      userId,
    });
    for (const r of results) {
      const toolName = /* 尽量从结果前 pending 已删，可用 results 对应：*/
        // 在 execute 前先快照 name：
        '';
      // 见下方「快照」写法
    }
    try {
      await sendCustomToolResults({
        arkApiKey: this.config.arkApiKey,
        arkBaseUrl: this.config.arkBaseUrl,
        sessionId,
        results,
        signal,
      });
    } catch (err) {
      throw err; // 由外层 catch 写成 SSE error
    }
  },
  signal,
});
```

**快照写法（必须按此实现，避免 pending.delete 后丢 name）：**

```ts
onRequiresAction: async (eventIds, pending) => {
  const snapshot = eventIds.map((id) => ({
    id,
    name: pending.get(id)?.name ?? 'unknown',
  }));
  const results = await executeCustomTools({ eventIds, pending, userId });
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const meta = snapshot[i]!;
    writeSseEvent(res, {
      type: 'tool',
      tool_name: meta.name,
      call_id: r.custom_tool_use_id,
      status: r.is_error ? 'error' : 'done',
      ...(r.is_error
        ? { message: r.content[0]?.text ?? 'tool error' }
        : {}),
    });
  }
  await sendCustomToolResults({
    arkApiKey: this.config.arkApiKey,
    arkBaseUrl: this.config.arkBaseUrl,
    sessionId,
    results,
    signal,
  });
},
```

注意：`streamChat` 外层已有 try/catch 写 SSE error；确保 `onRequiresAction` 抛出的 `ArkApiError` 能冒泡到该处。

- [ ] **Step 2: 更新 `streamOnce` 签名把 `userId` 从 `streamChat` 传入**

```ts
private async streamOnce(
  sessionId: string,
  userMessage: string,
  res: Response,
  options?: { mountedPaths?: string[]; inlineFileIds?: string[]; userId: string },
)
```

`streamChat`：`await this.streamOnce(session.sessionId, ..., { ..., userId: session.tokenHash })`。

- [ ] **Step 3: 编译与单测回归**

Run: `npm test && npx tsc --noEmit`  
Expected: PASS

---

### Task 6: 前端 SSE 解析 + ToolStatusBar + App

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Create: `web/src/components/ToolStatusBar.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Produces:
  - 前端 `NormalizedSseEvent` 含 `tool`
  - `ToolCallStatus { call_id, tool_name, status, message? }`
  - `ToolStatusBar({ items }: { items: ToolCallStatus[] })`

- [ ] **Step 1: 扩展 types + parseNormalizedEvent**

`web/src/types.ts`：与后端 `sse.ts` 对齐增加 `tool`；新增：

```ts
export interface ToolCallStatus {
  call_id: string;
  tool_name: string;
  status: 'running' | 'done' | 'error';
  message?: string;
}
```

`web/src/api.ts` 的 `parseNormalizedEvent`：

```ts
if (
  raw.type === 'tool' &&
  typeof raw.tool_name === 'string' &&
  typeof raw.call_id === 'string' &&
  (raw.status === 'running' || raw.status === 'done' || raw.status === 'error')
) {
  return {
    type: 'tool',
    tool_name: raw.tool_name,
    call_id: raw.call_id,
    status: raw.status,
    ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
  };
}
```

更新注释：「三种」→「四种（含 tool）」。

- [ ] **Step 2: 实现 ToolStatusBar**

```tsx
import type { ToolCallStatus } from '../types';

function statusLabel(item: ToolCallStatus): string {
  if (item.status === 'running') return '调用中';
  if (item.status === 'done') return '完成';
  return item.message ? `失败：${item.message}` : '失败';
}

export function ToolStatusBar({ items }: { items: ToolCallStatus[] }) {
  if (items.length === 0) return null;
  return (
    <div className="tool-status" aria-live="polite">
      <div className="tool-status__title">自定义工具</div>
      <ul className="tool-status__list">
        {items.map((item) => (
          <li
            key={item.call_id}
            className={`tool-status__item tool-status__item--${item.status}`}
          >
            <span className="tool-status__name">{item.tool_name}</span>
            <span className="tool-status__state">{statusLabel(item)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: App 串联**

- `const [toolCalls, setToolCalls] = useState<ToolCallStatus[]>([])`
- `handleSend` 开始时 `setToolCalls([])`
- `onEvent`：
```ts
if (event.type === 'tool') {
  setToolCalls((prev) => {
    const rest = prev.filter((x) => x.call_id !== event.call_id);
    return [
      ...rest,
      {
        call_id: event.call_id,
        tool_name: event.tool_name,
        status: event.status,
        ...(event.message ? { message: event.message } : {}),
      },
    ];
  });
  return;
}
```
- `done` / 会话 `error` / finally 中止后：`setToolCalls([])`（可在 finally 统一清）
- footer：
```tsx
<ToolStatusBar items={toolCalls} />
<OutputFilesBar ... />
<Composer ... />
```

- [ ] **Step 4: styles**

在 `styles.css` 的 `.dock` 相关区域增加：

```css
.tool-status {
  margin: 0 0 0.5rem;
  padding: 0.5rem 0.75rem;
  border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  font-size: 0.85rem;
  color: var(--muted, #9aa3b2);
}
.tool-status__title {
  font-weight: 600;
  margin-bottom: 0.35rem;
  color: var(--fg, #e8ecf1);
}
.tool-status__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.tool-status__item {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
}
.tool-status__item--running .tool-status__state { opacity: 0.9; }
.tool-status__item--done .tool-status__state { opacity: 0.7; }
.tool-status__item--error .tool-status__state { color: #f07178; }
.tool-status__name { font-family: ui-monospace, monospace; }
```

（颜色变量名若与现有 CSS 不一致，改为项目已有变量。）

- [ ] **Step 5: 前后端类型检查与全量测试**

```bash
npm test
npx tsc --noEmit
cd web && npx tsc --noEmit
```

Expected: 全部 PASS

---

### Task 7: README 附录（手测说明）

**Files:**
- Modify: `README.md`（若存在 SSE 小节则追加 Custom Tool）

- [ ] **Step 1: 追加说明**

内容要点：
1. 控制台 Agent 需配置同名 Custom Tool：`get_user_order`（`order_id`）、`create_work_order`（`title`/`content`）
2. 后端启动自动 `registerBuiltinTools`
3. 新增工具：`registerToolHandler` 即可
4. 前端会出现「自定义工具」状态条
5. 官方字段与 `requires_action` 行为简述 + 文档链接 2608630

- [ ] **Step 2: 手测清单（执行者勾选）**
  - [ ] 触发 get_user_order → 状态条 running→done → 最终回复
  - [ ] 临时注册制造失败 → 状态条 error，会话仍继续
  - [ ] interrupt / 无工具 chat / 文件 chat 回归

---

## Spec Coverage Checklist

| Spec 要求 | Task |
|-----------|------|
| 官方字段 id/name/input + custom_tool_use_id/content/is_error | Task 1, 3 |
| requires_action 触发 + 批量回传 | Task 4, 5 |
| requires_action idle 不收口 | Task 4 |
| 注册中心 + 2 mock 工具 | Task 2 |
| 未注册/抛错 is_error 回传 | Task 2 |
| sendCustomToolResults + 重试 | Task 3 |
| SSE tool + ToolStatusBar | Task 5, 6 |
| userId=tokenHash | Task 5 |
| 不改鉴权/session 复用 | 全局（无破坏性 task） |
| README / 手测 | Task 7 |

---

## Self-Review Notes

- `executeCustomTools` 会从 pending `delete`，ChatService 必须先 snapshot `name` 再执行（Task 5 已写明）
- 旧 poll 测试若用「任意 idle」收口，改为「非 requires_action idle」后，fixtures 无 stop_reason 的 idle 仍可收口
- `tryStreamSessionEvents` 路径本轮不挂 Custom Tool（与现网一致：该路径通常不可用）；若启用需复用同一 `onRequiresAction`——YAGNI，仅在 README 注明
- Commit 步骤默认跳过，除非用户明确要求
