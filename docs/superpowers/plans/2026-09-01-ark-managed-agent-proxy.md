# Ark Managed Agent 代理服务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个 TypeScript Express 后端，通过 Redis 映射 webUserToken→Ark Session，用纯 HTTP 对接火山方舟 Managed Agents，提供归一化 SSE 对话与手动重建 Session 接口。

**Architecture:** 薄分层：`routes` → `chatService` / `sessionService` → `sessionStore` + `arkClient`；身份标识经 `resolveUserKey` 解耦；chat 将方舟事件流解析为 `{type:delta|error|done}` SSE。

**Tech Stack:** TypeScript, Express, ioredis, axios, dotenv, cors, vitest, tsx

## Global Constraints

- Base URL：`https://ark.cn-beijing.volces.com/api/v3`
- 禁止顶层 `environment_id`；必须使用 `environment.type = "environment_with_overrides"`
- `environment_with_overrides.config.env` 全量替换，不拉取基座合并
- 禁止引入火山方舟官方 SDK；使用 axios 纯 HTTP
- Redis Key：`ark:session:map:{tokenHash}`；TTL **25 天**（`25 * 24 * 60 * 60` 秒）
- Redis 不存原始 `webUserToken`；`tokenHash = SHA-256(webUserToken)`
- 沙箱注入：`USER_ID=tokenHash`，`USER_BEARER_TOKEN=webUserToken`
- SSE 归一化：`delta` / `error` / `done`；不透传方舟原始事件
- Session 失效：删映射 → 重建 → 同一 `userMessage` 静默重试 **1 次**
- 不实现同 Session 并发锁；代码注释提醒风险
- 日志禁止打印完整 `webUserToken` / `ARK_API_KEY`
- `.env` 字段：`ARK_API_KEY`, `ARK_AGENT_ID`, `ARK_BASE_ENVIRONMENT_ID`, `REDIS_URL`, `PORT`
- 官方文档（实现 arkClient 前必读）：
  - 创建会话：https://docs.volcengine.com/docs/82379/2555932
  - Session 事件流：https://docs.volcengine.com/docs/82379/2555933

---

## File Map

| 文件 | 职责 |
|------|------|
| `package.json` | 依赖与脚本 |
| `tsconfig.json` | TS 编译配置 |
| `vitest.config.ts` | 单测配置 |
| `.env.example` | 环境变量模板 |
| `.gitignore` | 忽略 node_modules、dist、.env |
| `docker-compose.yml` | 仅 Redis |
| `src/config.ts` | 读取并校验 env |
| `src/utils/hash.ts` | `resolveUserKey` |
| `src/utils/sse.ts` | SSE 写入与归一化事件 |
| `src/utils/arkEventParser.ts` | 方舟 SSE 行 → 文本增量 |
| `src/types/ark.ts` | 方舟请求/响应/错误类型 |
| `src/store/sessionStore.ts` | Redis 映射 CRUD |
| `src/clients/arkClient.ts` | `createArkSession`, `sendSessionEvent` |
| `src/services/sessionService.ts` | 获取/创建/重建 Session |
| `src/services/chatService.ts` | chat 编排 + 失效重试 |
| `src/routes/agent.ts` | 两个 HTTP 路由 |
| `src/app.ts` | Express 实例 |
| `src/server.ts` | 启动入口 |
| `README.md` | 启动与 curl 示例 |

---

### Task 1: 项目脚手架与测试框架

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`

**Interfaces:**
- Produces: npm scripts `dev`, `build`, `start`, `test`

- [ ] **Step 1: 创建 `package.json`**

```json
{
  "name": "volcane-demo",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "axios": "^1.7.9",
    "cors": "^2.8.5",
    "dotenv": "^16.4.7",
    "express": "^4.21.2",
    "ioredis": "^5.4.2"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/node": "^22.10.5",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: 创建 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: 创建 `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: 创建 `.gitignore`**

```
node_modules/
dist/
.env
.DS_Store
```

- [ ] **Step 5: 创建 `.env.example`**

```
ARK_API_KEY=
ARK_AGENT_ID=
ARK_BASE_ENVIRONMENT_ID=
REDIS_URL=redis://127.0.0.1:6379
PORT=3000
```

- [ ] **Step 6: 安装依赖并验证**

Run: `npm install`
Expected: `node_modules/` 创建成功，无报错

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example
git commit -m "chore: 初始化 TypeScript 项目脚手架 --story=pending@tapd-pending"
```

---

### Task 2: 配置模块

**Files:**
- Create: `src/config.ts`

**Interfaces:**
- Produces: `export function loadConfig(): AppConfig`
- Produces: `export interface AppConfig { arkApiKey: string; arkAgentId: string; arkBaseEnvironmentId: string; redisUrl: string; port: number; arkBaseUrl: string }`

- [ ] **Step 1: 实现 `src/config.ts`**

```typescript
import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
  arkApiKey: string;
  arkAgentId: string;
  arkBaseEnvironmentId: string;
  redisUrl: string;
  port: number;
  arkBaseUrl: string;
}

const REQUIRED_KEYS = [
  'ARK_API_KEY',
  'ARK_AGENT_ID',
  'ARK_BASE_ENVIRONMENT_ID',
  'REDIS_URL',
] as const;

export function loadConfig(): AppConfig {
  const missing = REQUIRED_KEYS.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }

  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('PORT must be a positive number');
  }

  return {
    arkApiKey: process.env.ARK_API_KEY!.trim(),
    arkAgentId: process.env.ARK_AGENT_ID!.trim(),
    arkBaseEnvironmentId: process.env.ARK_BASE_ENVIRONMENT_ID!.trim(),
    redisUrl: process.env.REDIS_URL!.trim(),
    port,
    arkBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  };
}
```

- [ ] **Step 2: 手动验证**

Run: `npx tsx -e "import { loadConfig } from './src/config.ts'; console.log(loadConfig());"`（需先复制 `.env.example` → `.env` 并填占位值）
Expected: 打印配置对象或明确 missing env 错误

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: 添加环境配置加载模块 --story=pending@tapd-pending"
```

---

### Task 3: 用户标识哈希工具（TDD）

**Files:**
- Create: `src/utils/hash.ts`, `src/utils/hash.test.ts`

**Interfaces:**
- Produces: `export function sha256Hex(input: string): string`
- Produces: `export function resolveUserKey(webUserToken: string): { tokenHash: string }`

- [ ] **Step 1: 写失败测试 `src/utils/hash.test.ts`**

```typescript
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveUserKey, sha256Hex } from './hash.js';

describe('sha256Hex', () => {
  it('returns lowercase hex digest', () => {
    expect(sha256Hex('hello')).toBe(
      createHash('sha256').update('hello').digest('hex'),
    );
  });
});

describe('resolveUserKey', () => {
  it('maps webUserToken to tokenHash', () => {
    const token = 'user-token-abc';
    expect(resolveUserKey(token)).toEqual({
      tokenHash: sha256Hex(token),
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/utils/hash.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/utils/hash.ts`**

```typescript
import { createHash } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** MVP：webUserToken → tokenHash。后续可替换为 auth-service → userId。 */
export function resolveUserKey(webUserToken: string): { tokenHash: string } {
  return { tokenHash: sha256Hex(webUserToken) };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- src/utils/hash.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add src/utils/hash.ts src/utils/hash.test.ts
git commit -m "feat: 添加 webUserToken 哈希与用户标识解析 --story=pending@tapd-pending"
```

---

### Task 4: SSE 工具与方舟事件解析（TDD）

**Files:**
- Create: `src/utils/sse.ts`, `src/utils/sse.test.ts`, `src/utils/arkEventParser.ts`, `src/utils/arkEventParser.test.ts`, `src/types/sse.ts`

**Interfaces:**
- Produces: `export type NormalizedSseEvent = { type: 'delta'; text: string } | { type: 'error'; code: string; message: string } | { type: 'done' }`
- Produces: `export function initSse(res: Response): void`
- Produces: `export function writeSseEvent(res: Response, event: NormalizedSseEvent): void`
- Produces: `export function endSse(res: Response): void`
- Produces: `export function extractTextDeltaFromArkEvent(raw: unknown): string | null`

- [ ] **Step 1: 创建 `src/types/sse.ts`**

```typescript
export type NormalizedSseEvent =
  | { type: 'delta'; text: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' };
```

- [ ] **Step 2: 写失败测试 `src/utils/arkEventParser.test.ts`**

```typescript
import { describe, expect, it } from 'vitest';
import { extractTextDeltaFromArkEvent } from './arkEventParser.js';

describe('extractTextDeltaFromArkEvent', () => {
  it('extracts delta text from assistant message chunk', () => {
    const raw = {
      type: 'response.output_text.delta',
      delta: '你好',
    };
    expect(extractTextDeltaFromArkEvent(raw)).toBe('你好');
  });

  it('returns null for non-text events', () => {
    expect(extractTextDeltaFromArkEvent({ type: 'tool.start' })).toBeNull();
  });

  it('returns null for invalid payload', () => {
    expect(extractTextDeltaFromArkEvent(null)).toBeNull();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test -- src/utils/arkEventParser.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现 `src/utils/arkEventParser.ts`**

> 实现前打开 https://docs.volcengine.com/docs/82379/2555933 ，对照「Session 事件流」中**对用户可见的文本增量**事件字段，更新下方匹配分支。MVP 先支持常见 `delta`/`content`/`text` 字段名。

```typescript
/**
 * 从方舟 Session 事件 JSON 中提取可展示文本增量。
 * 只映射用户可见文本；工具/中间状态事件返回 null。
 */
export function extractTextDeltaFromArkEvent(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const event = raw as Record<string, unknown>;

  // 常见增量字段（按官方文档校准）
  if (typeof event.delta === 'string' && event.delta.length > 0) {
    return event.delta;
  }
  if (typeof event.text === 'string' && event.text.length > 0) {
    return event.text;
  }

  const content = event.content;
  if (typeof content === 'string' && content.length > 0) {
    return content;
  }
  if (Array.isArray(content)) {
    const textPart = content.find(
      (part) =>
        part &&
        typeof part === 'object' &&
        (part as Record<string, unknown>).type === 'output_text' &&
        typeof (part as Record<string, unknown>).text === 'string',
    ) as Record<string, unknown> | undefined;
    if (textPart?.text) return String(textPart.text);
  }

  return null;
}
```

- [ ] **Step 5: 写失败测试 `src/utils/sse.test.ts`**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { writeSseEvent } from './sse.js';

describe('writeSseEvent', () => {
  it('writes normalized delta as SSE data line', () => {
    const chunks: string[] = [];
    const res = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as unknown as import('express').Response;

    writeSseEvent(res, { type: 'delta', text: 'hi' });

    expect(chunks.join('')).toContain('data: {"type":"delta","text":"hi"}');
    expect(chunks.join('')).toContain('\n\n');
  });
});
```

- [ ] **Step 6: 实现 `src/utils/sse.ts`**

```typescript
import type { Response } from 'express';
import type { NormalizedSseEvent } from '../types/sse.js';

export function initSse(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

export function writeSseEvent(res: Response, event: NormalizedSseEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function endSse(res: Response): void {
  res.end();
}
```

- [ ] **Step 7: 运行全部 utils 测试**

Run: `npm test -- src/utils`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/types/sse.ts src/utils/sse.ts src/utils/sse.test.ts src/utils/arkEventParser.ts src/utils/arkEventParser.test.ts
git commit -m "feat: 添加 SSE 写入与方舟事件文本解析 --story=pending@tapd-pending"
```

---

### Task 5: Redis Session 存储

**Files:**
- Create: `src/store/sessionStore.ts`

**Interfaces:**
- Produces: `export class SessionStore { getSessionId(tokenHash: string): Promise<string | null>; setSessionId(tokenHash: string, sessionId: string): Promise<void>; deleteSession(tokenHash: string): Promise<void>; }`
- Constant: `SESSION_TTL_SECONDS = 25 * 24 * 60 * 60`

- [ ] **Step 1: 实现 `src/store/sessionStore.ts`**

```typescript
import Redis from 'ioredis';

export const SESSION_TTL_SECONDS = 25 * 24 * 60 * 60;

function redisKey(tokenHash: string): string {
  return `ark:session:map:${tokenHash}`;
}

export class SessionStore {
  constructor(private readonly redis: Redis) {}

  async getSessionId(tokenHash: string): Promise<string | null> {
    return this.redis.get(redisKey(tokenHash));
  }

  async setSessionId(tokenHash: string, sessionId: string): Promise<void> {
    await this.redis.set(redisKey(tokenHash), sessionId, 'EX', SESSION_TTL_SECONDS);
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.redis.del(redisKey(tokenHash));
  }
}
```

- [ ] **Step 2: 手动验证（需 Redis 运行）**

Run:
```bash
docker compose up -d
npx tsx -e "
import Redis from 'ioredis';
import { SessionStore } from './src/store/sessionStore.ts';
const store = new SessionStore(new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'));
const h = 'testhash';
await store.setSessionId(h, 'sess-1');
console.log(await store.getSessionId(h));
await store.deleteSession(h);
console.log(await store.getSessionId(h));
process.exit(0);
"
```
Expected: 先打印 `sess-1`，再打印 `null`

- [ ] **Step 3: Commit**

```bash
git add src/store/sessionStore.ts
git commit -m "feat: 添加 Redis Session 映射存储 --story=pending@tapd-pending"
```

---

### Task 6: 方舟 HTTP 客户端

**Files:**
- Create: `src/types/ark.ts`, `src/clients/arkClient.ts`

**Interfaces:**
- Produces: `export class ArkApiError extends Error { status?: number; code?: string; isSessionNotFound: boolean }`
- Produces: `export async function createArkSession(params: CreateSessionParams): Promise<{ sessionId: string }>`
- Produces: `export async function sendSessionEvent(params: SendEventParams): Promise<NodeJS.ReadableStream>`

- [ ] **Step 1: 阅读官方文档并创建 `src/types/ark.ts`**

> 打开 https://docs.volcengine.com/docs/82379/2555932 与 https://docs.volcengine.com/docs/82379/2555933，确认字段名后微调类型。以下为与 spec 对齐的初始形状：

```typescript
export interface CreateSessionParams {
  arkApiKey: string;
  arkBaseUrl: string;
  agentId: string;
  baseEnvironmentId: string;
  userId: string;
  userBearerToken: string;
  /** 可选自定义 session id */
  sessionId?: string;
}

export interface SendEventParams {
  arkApiKey: string;
  arkBaseUrl: string;
  sessionId: string;
  userMessage: string;
  signal?: AbortSignal;
}

export interface CreateSessionResponse {
  id: string;
}
```

- [ ] **Step 2: 实现 `src/clients/arkClient.ts`**

```typescript
import axios, { AxiosError, type AxiosResponse } from 'axios';
import type { CreateSessionParams, CreateSessionResponse, SendEventParams } from '../types/ark.js';

export class ArkApiError extends Error {
  status?: number;
  code?: string;
  isSessionNotFound: boolean;

  constructor(message: string, options?: { status?: number; code?: string; isSessionNotFound?: boolean }) {
    super(message);
    this.name = 'ArkApiError';
    this.status = options?.status;
    this.code = options?.code;
    this.isSessionNotFound = options?.isSessionNotFound ?? false;
  }
}

function authHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function toArkError(err: unknown): ArkApiError {
  if (err instanceof ArkApiError) return err;
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    const data = err.response?.data as Record<string, unknown> | undefined;
    const message =
      (typeof data?.message === 'string' && data.message) ||
      (typeof data?.error === 'string' && data.error) ||
      err.message;
    const code = typeof data?.code === 'string' ? data.code : undefined;
    const lower = `${message} ${code ?? ''}`.toLowerCase();
    const isSessionNotFound =
      status === 404 || lower.includes('session') && (lower.includes('not found') || lower.includes('不存在') || lower.includes('invalid'));
    return new ArkApiError(message, { status, code, isSessionNotFound });
  }
  return new ArkApiError(err instanceof Error ? err.message : 'Unknown ark error');
}

/** 创建 Ark Managed Agent Session（environment_with_overrides 全量 env） */
export async function createArkSession(params: CreateSessionParams): Promise<{ sessionId: string }> {
  const body: Record<string, unknown> = {
    agent_id: params.agentId,
    environment: {
      type: 'environment_with_overrides',
      environment_id: params.baseEnvironmentId,
      config: {
        env: {
          USER_ID: params.userId,
          USER_BEARER_TOKEN: params.userBearerToken,
        },
      },
    },
  };
  if (params.sessionId) body.id = params.sessionId;

  try {
    const res = await axios.post<CreateSessionResponse>(
      `${params.arkBaseUrl}/sessions`,
      body,
      { headers: authHeaders(params.arkApiKey), timeout: 30_000 },
    );
    if (!res.data?.id) throw new ArkApiError('Create session response missing id');
    return { sessionId: res.data.id };
  } catch (err) {
    throw toArkError(err);
  }
}

/**
 * 向 Session 发送用户消息，返回上游 SSE 字节流。
 * 请求体字段名以官方 Session 事件流文档为准（实现时校准）。
 */
export async function sendSessionEvent(params: SendEventParams): Promise<NodeJS.ReadableStream> {
  // TODO(ark-doc): 若官方文档要求不同 event type / content 结构，在此替换
  const body = {
    type: 'user.message',
    content: params.userMessage,
  };

  try {
    const res: AxiosResponse<NodeJS.ReadableStream> = await axios.post(
      `${params.arkBaseUrl}/sessions/${encodeURIComponent(params.sessionId)}/events`,
      body,
      {
        headers: {
          ...authHeaders(params.arkApiKey),
          Accept: 'text/event-stream',
        },
        responseType: 'stream',
        timeout: 0,
        signal: params.signal,
      },
    );
    return res.data;
  } catch (err) {
    throw toArkError(err);
  }
}
```

- [ ] **Step 3: 编译检查**

Run: `npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 4: Commit**

```bash
git add src/types/ark.ts src/clients/arkClient.ts
git commit -m "feat: 添加方舟 Session 创建与事件发送 HTTP 客户端 --story=pending@tapd-pending"
```

---

### Task 7: Session 服务

**Files:**
- Create: `src/services/sessionService.ts`

**Interfaces:**
- Consumes: `SessionStore`, `createArkSession`, `loadConfig`, `resolveUserKey`
- Produces: `export class SessionService { getOrCreateSession(webUserToken: string): Promise<{ tokenHash: string; sessionId: string }>; rebuildSession(webUserToken: string): Promise<{ tokenHash: string; sessionId: string }>; invalidateAndRecreate(webUserToken: string): Promise<{ tokenHash: string; sessionId: string }>; }`

- [ ] **Step 1: 实现 `src/services/sessionService.ts`**

```typescript
import { createArkSession } from '../clients/arkClient.js';
import type { AppConfig } from '../config.js';
import { SessionStore } from '../store/sessionStore.js';
import { resolveUserKey } from '../utils/hash.js';

export class SessionService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: SessionStore,
  ) {}

  private async createAndPersist(tokenHash: string, webUserToken: string): Promise<string> {
    const { sessionId } = await createArkSession({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      agentId: this.config.arkAgentId,
      baseEnvironmentId: this.config.arkBaseEnvironmentId,
      userId: tokenHash,
      userBearerToken: webUserToken,
    });
    await this.store.setSessionId(tokenHash, sessionId);
    return sessionId;
  }

  async getOrCreateSession(webUserToken: string): Promise<{ tokenHash: string; sessionId: string }> {
    const { tokenHash } = resolveUserKey(webUserToken);
    const existing = await this.store.getSessionId(tokenHash);
    if (existing) return { tokenHash, sessionId: existing };
    const sessionId = await this.createAndPersist(tokenHash, webUserToken);
    return { tokenHash, sessionId };
  }

  async rebuildSession(webUserToken: string): Promise<{ tokenHash: string; sessionId: string }> {
    const { tokenHash } = resolveUserKey(webUserToken);
    await this.store.deleteSession(tokenHash);
    const sessionId = await this.createAndPersist(tokenHash, webUserToken);
    return { tokenHash, sessionId };
  }

  async invalidateAndRecreate(webUserToken: string): Promise<{ tokenHash: string; sessionId: string }> {
    return this.rebuildSession(webUserToken);
  }
}
```

- [ ] **Step 2: 编译检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/sessionService.ts
git commit -m "feat: 添加 Session 获取、创建与重建服务 --story=pending@tapd-pending"
```

---

### Task 8: Chat 服务（流式编排 + 失效重试）

**Files:**
- Create: `src/services/chatService.ts`, `src/utils/streamArkEvents.ts`

**Interfaces:**
- Consumes: `SessionService`, `sendSessionEvent`, `writeSseEvent`, `extractTextDeltaFromArkEvent`
- Produces: `export class ChatService { streamChat(res: Response, input: { webUserToken: string; userMessage: string }): Promise<void>; }`

- [ ] **Step 1: 实现 SSE 行解析 `src/utils/streamArkEvents.ts`**

```typescript
import type { IncomingMessage } from 'node:http';
import { extractTextDeltaFromArkEvent } from './arkEventParser.js';

export async function* iterateArkSse(stream: IncomingMessage): AsyncGenerator<unknown> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // 忽略无法解析的行
      }
    }
  }
}

export async function pipeArkStreamToSse(
  stream: IncomingMessage,
  write: (text: string) => void,
): Promise<void> {
  for await (const event of iterateArkSse(stream)) {
    const delta = extractTextDeltaFromArkEvent(event);
    if (delta) write(delta);
  }
}
```

- [ ] **Step 2: 实现 `src/services/chatService.ts`**

```typescript
import type { Response } from 'express';
import { ArkApiError, sendSessionEvent } from '../clients/arkClient.js';
import type { AppConfig } from '../config.js';
import { endSse, initSse, writeSseEvent } from '../utils/sse.js';
import { pipeArkStreamToSse } from '../utils/streamArkEvents.js';
import { SessionService } from './sessionService.js';

/**
 * 注意：同一 Ark Session 不支持并发发送两条消息。
 * MVP 不实现排队锁，调用方需避免并行 chat 请求。
 */
export class ChatService {
  constructor(
    private readonly config: AppConfig,
    private readonly sessionService: SessionService,
  ) {}

  private async streamOnce(sessionId: string, userMessage: string, res: Response): Promise<void> {
    const upstream = await sendSessionEvent({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      sessionId,
      userMessage,
    });

    res.on('close', () => {
      upstream.destroy?.();
    });

    await pipeArkStreamToSse(upstream, (text) => {
      writeSseEvent(res, { type: 'delta', text });
    });
  }

  async streamChat(
    res: Response,
    input: { webUserToken: string; userMessage: string },
  ): Promise<void> {
    initSse(res);

    let session = await this.sessionService.getOrCreateSession(input.webUserToken);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.streamOnce(session.sessionId, input.userMessage, res);
        writeSseEvent(res, { type: 'done' });
        endSse(res);
        return;
      } catch (err) {
        const arkErr = err instanceof ArkApiError ? err : new ArkApiError(String(err));
        const canRetry = attempt === 0 && arkErr.isSessionNotFound;
        if (canRetry) {
          session = await this.sessionService.invalidateAndRecreate(input.webUserToken);
          continue;
        }
        writeSseEvent(res, {
          type: 'error',
          code: arkErr.code ?? 'ARK_ERROR',
          message: arkErr.message,
        });
        endSse(res);
        return;
      }
    }
  }
}
```

- [ ] **Step 3: 编译检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/utils/streamArkEvents.ts src/services/chatService.ts
git commit -m "feat: 添加 chat 流式编排与 Session 失效重试 --story=pending@tapd-pending"
```

---

### Task 9: HTTP 路由与应用入口

**Files:**
- Create: `src/routes/agent.ts`, `src/app.ts`, `src/server.ts`

**Interfaces:**
- Produces: Express app 挂载 `POST /api/agent/chat`, `POST /api/agent/rebuild-session`

- [ ] **Step 1: 实现 `src/routes/agent.ts`**

```typescript
import { Router, type Request, type Response } from 'express';
import type { ChatService } from '../services/chatService.js';
import type { SessionService } from '../services/sessionService.js';

function requireNonEmptyString(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return `${field} is required`;
  return null;
}

export function createAgentRouter(deps: {
  chatService: ChatService;
  sessionService: SessionService;
}): Router {
  const router = Router();

  router.post('/chat', async (req: Request, res: Response) => {
    const tokenErr = requireNonEmptyString(req.body?.webUserToken, 'webUserToken');
    const msgErr = requireNonEmptyString(req.body?.userMessage, 'userMessage');
    if (tokenErr || msgErr) {
      return res.status(400).json({ error: tokenErr ?? msgErr });
    }

    try {
      await deps.chatService.streamChat(res, {
        webUserToken: req.body.webUserToken.trim(),
        userMessage: req.body.userMessage.trim(),
      });
    } catch (err) {
      if (!res.headersSent) {
        return res.status(503).json({
          error: err instanceof Error ? err.message : 'Chat failed',
        });
      }
      if (!res.writableEnded) res.end();
    }
  });

  router.post('/rebuild-session', async (req: Request, res: Response) => {
    const tokenErr = requireNonEmptyString(req.body?.webUserToken, 'webUserToken');
    if (tokenErr) return res.status(400).json({ error: tokenErr });

    try {
      const result = await deps.sessionService.rebuildSession(req.body.webUserToken.trim());
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(503).json({
        error: err instanceof Error ? err.message : 'Rebuild failed',
      });
    }
  });

  return router;
}
```

- [ ] **Step 2: 实现 `src/app.ts`**

```typescript
import cors from 'cors';
import express from 'express';
import type { AppConfig } from './config.js';
import { createAgentRouter } from './routes/agent.js';
import type { ChatService } from './services/chatService.js';
import type { SessionService } from './services/sessionService.js';

export function createApp(deps: {
  config: AppConfig;
  chatService: ChatService;
  sessionService: SessionService;
}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/agent', createAgentRouter(deps));
  return app;
}
```

- [ ] **Step 3: 实现 `src/server.ts`**

```typescript
import Redis from 'ioredis';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { ChatService } from './services/chatService.js';
import { SessionService } from './services/sessionService.js';
import { SessionStore } from './store/sessionStore.js';

async function main() {
  const config = loadConfig();
  const redis = new Redis(config.redisUrl);
  const sessionStore = new SessionStore(redis);
  const sessionService = new SessionService(config, sessionStore);
  const chatService = new ChatService(config, sessionService);

  const app = createApp({ config, chatService, sessionService });
  app.listen(config.port, () => {
    // DEBUG: 仅打印端口；禁止打印密钥
    console.log(`Server listening on http://127.0.0.1:${config.port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: 本地启动验证**

Run:
```bash
docker compose up -d
cp .env.example .env   # 填入真实 ARK_* 值
npm run dev
curl -s http://127.0.0.1:3000/health
```
Expected: `{"ok":true}`

- [ ] **Step 5: Commit**

```bash
git add src/routes/agent.ts src/app.ts src/server.ts
git commit -m "feat: 添加 agent 路由与 Express 服务入口 --story=pending@tapd-pending"
```

---

### Task 10: Docker Compose 与 README

**Files:**
- Create: `docker-compose.yml`, `README.md`

- [ ] **Step 1: 创建 `docker-compose.yml`**

```yaml
services:
  redis:
    image: redis:7
    ports:
      - '6379:6379'
    volumes:
      - redis-data:/data

volumes:
  redis-data:
```

- [ ] **Step 2: 创建 `README.md`**

README 必须包含以下章节与示例命令：

1. 前置条件：Node.js 18+、Docker
2. 启动 Redis：`docker compose up -d`
3. 配置 `.env`（从 `.env.example` 复制）
4. 安装与启动：`npm install` → `npm run dev`
5. Chat curl（SSE）：
```bash
curl -N -X POST http://127.0.0.1:3000/api/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"webUserToken":"demo-token","userMessage":"你好"}'
```
6. Rebuild curl：
```bash
curl -X POST http://127.0.0.1:3000/api/agent/rebuild-session \
  -H 'Content-Type: application/json' \
  -d '{"webUserToken":"demo-token"}'
```
7. SSE 事件说明：`delta` / `error` / `done`
8. 注意事项：
   - 同一 Session 勿并发发消息
   - 环境变量仅在创建 Session 时注入，运行期不可改
   - token 刷新应调用 rebuild-session
   - 勿将 `ARK_API_KEY` 暴露给前端

- [ ] **Step 3: 运行测试套件**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 4: 生产构建验证**

Run: `npm run build && npm start`
Expected: 服务正常启动，`/health` 可访问

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml README.md
git commit -m "docs: 添加 Redis Compose 与服务 README --story=pending@tapd-pending"
```

---

## Spec Coverage Checklist

| Spec 要求 | 对应 Task |
|-----------|-----------|
| TypeScript + Express + ioredis + axios | Task 1, 5, 6, 9 |
| 纯 HTTP，无 SDK | Task 6 |
| `resolveUserKey` 身份解耦 | Task 3, 7 |
| Redis 映射 TTL 25 天 | Task 5 |
| `environment_with_overrides` 全量 env | Task 6, 7 |
| 归一化 SSE delta/error/done | Task 4, 8, 9 |
| Session 失效自动重建重试 1 次 | Task 6, 8 |
| rebuild-session 接口 | Task 7, 9 |
| 入参校验 400 | Task 9 |
| Redis/方舟错误处理 | Task 5, 6, 8, 9 |
| 并发风险注释 | Task 8 |
| docker-compose Redis | Task 10 |
| README + curl | Task 10 |
| 可选单测 hash/SSE 解析 | Task 3, 4 |

## Manual E2E Checklist（需真实 ARK 凭据）

- [ ] 首次 chat：Redis 写入映射，SSE 收到 `delta` + `done`
- [ ] 第二次 chat（同 token）：复用 sessionId（DEBUG 日志可见）
- [ ] rebuild-session：返回新 sessionId，旧映射被替换
- [ ] 手动删 Redis key 后 chat：自动创建新 Session
- [ ] 无效 sessionId 场景（可手动改 Redis 值为假 id）：chat 自动重建并成功回复

---

**Plan complete and saved to `docs/superpowers/plans/2026-09-01-ark-managed-agent-proxy.md`.**

**Two execution options:**

1. **Subagent-Driven (recommended)** — 每个 Task 派一个全新 subagent，Task 之间做 review，迭代快
2. **Inline Execution** — 在本会话用 executing-plans 按 Task 批量执行，检查点处 review

**Which approach?**
