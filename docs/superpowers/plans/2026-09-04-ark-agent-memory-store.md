# Ark Agent Memory Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每个用户绑定永久 Memory Store，创建/重建会话时自动挂载，并提供后端直接读写记忆文件的 API。

**Architecture:** 独立 `arkMemoryClient` + Redis `UserMemoryRedisStore` + `MemoryService`；扩展 `createArkSession` 的 `resources[]` 在创建时挂载 `memory_store`；`GET/POST /api/agent/memory` 做按 path 的 upsert 读写。记忆映射与会话映射分离，重建会话不删记忆 ID。

**Tech Stack:** TypeScript, Express, axios, ioredis, vitest

**Spec:** `docs/superpowers/specs/2026-09-04-ark-agent-memory-store-design.md`

## Global Constraints

- Base URL：复用 `config.arkBaseUrl`（官方华北：`https://ark.cn-beijing.volces.com/api/v3`）
- 禁止引入火山方舟官方 SDK；使用 axios 纯 HTTP
- Redis 键：`ark:user_memory:{tokenHash}`（无 TTL）；锁：`ark:user_memory:lock:{tokenHash}`（EX 30）
- 身份键：`tokenHash = sha256(webUserToken)`，与现有 Session 一致
- memory_store **仅**在创建会话 `resources[]` 挂载；不可运行中补挂
- 挂载路径以会话资源 `mount_path` 为准；instructions **不**硬编码 `/mnt/memory/{id}/`
- 写入语义：Upsert（create 不覆盖；已存在则 update，优先带 `content_sha256`）
- 记忆库失败 → 整次创建会话失败（硬依赖）
- 日志禁止打印完整 `webUserToken` / `ARK_API_KEY`
- Commit message 用中文 conventional commits；含 TAPD 占位（仅在用户要求或计划 Step 明确要求时执行 commit）

---

## File Map

| 文件 | 职责 |
|------|------|
| `src/types/ark.ts` | Memory 类型；`CreateSessionParams.resources` |
| `src/utils/memoryPath.ts` | `normalizeMemoryPath` |
| `src/utils/memoryPath.test.ts` | path 规范化单测 |
| `src/clients/arkMemoryClient.ts` | Memory Store REST + `buildMemoryStoreResource` |
| `src/clients/arkMemoryClient.test.ts` | body / 归一化单测 |
| `src/clients/arkClient.ts` | `buildCreateSessionBody` 透传 `resources` |
| `src/clients/arkClient.test.ts` | resources 断言 |
| `src/store/memoryStore.ts` | Redis 映射 + 锁（类名 `UserMemoryRedisStore`） |
| `src/store/memoryStore.test.ts` | 假 Redis 单测 |
| `src/services/memoryService.ts` | getOrCreate / read / write upsert |
| `src/services/memoryService.test.ts` | upsert 分支单测 |
| `src/services/sessionService.ts` | 创建前挂载记忆库 |
| `src/routes/agent.ts` | `GET/POST /memory` |
| `src/app.ts` / `src/server.ts` | 注入 MemoryService |
| `README.md` | curl 附录 |

---

### Task 1: 类型、路径规范化、创建会话 body 扩展

**Files:**
- Modify: `src/types/ark.ts`
- Create: `src/utils/memoryPath.ts`
- Create: `src/utils/memoryPath.test.ts`
- Modify: `src/clients/arkClient.ts`（`buildCreateSessionBody`）
- Modify: `src/clients/arkClient.test.ts`

**Interfaces:**
- Produces:
  - `ArkMemoryStoreResource { type: 'memory_store'; memory_store_id: string; instructions?: string }`
  - `CreateSessionParams.resources?: ArkMemoryStoreResource[]`
  - `ArkMemoryFileInfo { id; path; content; updated_at?; content_sha256? }`
  - `normalizeMemoryPath(input?: string | null): string`
  - `DEFAULT_USER_PROFILE_PATH = '/user_profile.json'`
  - `buildCreateSessionBody`：有 `resources` 时写入 `body.resources`

- [ ] **Step 1: 写失败单测（path + session body）**

创建 `src/utils/memoryPath.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_PROFILE_PATH, normalizeMemoryPath } from './memoryPath.js';

describe('normalizeMemoryPath', () => {
  it('defaults empty to user_profile.json', () => {
    expect(normalizeMemoryPath(undefined)).toBe(DEFAULT_USER_PROFILE_PATH);
    expect(normalizeMemoryPath('')).toBe(DEFAULT_USER_PROFILE_PATH);
    expect(normalizeMemoryPath('   ')).toBe(DEFAULT_USER_PROFILE_PATH);
  });

  it('adds leading slash', () => {
    expect(normalizeMemoryPath('user_profile.json')).toBe('/user_profile.json');
    expect(normalizeMemoryPath('/prefs/a.json')).toBe('/prefs/a.json');
  });
});
```

在 `src/clients/arkClient.test.ts` 的 `buildCreateSessionBody` describe 内追加：

```ts
  it('includes memory_store resources when provided', () => {
    const body = buildCreateSessionBody({
      arkApiKey: 'k',
      arkBaseUrl: 'https://example.com/api/v3',
      agentId: 'agent-1',
      baseEnvironmentId: 'env-1',
      userId: 'user-hash',
      userBearerToken: 'token',
      resources: [
        {
          type: 'memory_store',
          memory_store_id: 'memstore-1',
          instructions: 'read user_profile.json',
        },
      ],
    });
    expect(body.resources).toEqual([
      {
        type: 'memory_store',
        memory_store_id: 'memstore-1',
        instructions: 'read user_profile.json',
      },
    ]);
  });

  it('omits resources when not provided', () => {
    const body = buildCreateSessionBody({
      arkApiKey: 'k',
      arkBaseUrl: 'https://example.com/api/v3',
      agentId: 'agent-1',
      baseEnvironmentId: 'env-1',
      userId: 'user-hash',
      userBearerToken: 'token',
    });
    expect(body).not.toHaveProperty('resources');
  });
```

- [ ] **Step 2: 跑测确认失败**

Run: `npm test -- src/utils/memoryPath.test.ts src/clients/arkClient.test.ts`  
Expected: FAIL（`normalizeMemoryPath` 未定义；resources 断言失败）

- [ ] **Step 3: 实现类型与规范化**

在 `src/types/ark.ts` 追加并扩展 `CreateSessionParams`：

```ts
export interface ArkMemoryStoreResource {
  type: 'memory_store';
  memory_store_id: string;
  instructions?: string;
}

export interface CreateSessionParams {
  arkApiKey: string;
  arkBaseUrl: string;
  agentId: string;
  baseEnvironmentId: string;
  userId: string;
  userBearerToken: string;
  sessionId?: string;
  /** 仅创建时可挂载；memory_store 不能事后追加 */
  resources?: ArkMemoryStoreResource[];
}

export interface ArkMemoryFileInfo {
  id: string;
  path: string;
  content: string;
  updated_at?: string;
  content_sha256?: string;
}
```

创建 `src/utils/memoryPath.ts`：

```ts
export const DEFAULT_USER_PROFILE_PATH = '/user_profile.json';

/** 空 → 默认画像路径；无前导 / 则补上 */
export function normalizeMemoryPath(input?: string | null): string {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return DEFAULT_USER_PROFILE_PATH;
  return raw.startsWith('/') ? raw : `/${raw}`;
}
```

修改 `buildCreateSessionBody`：在现有 body 构造末尾增加：

```ts
  if (params.resources && params.resources.length > 0) {
    body.resources = params.resources;
  }
```

- [ ] **Step 4: 跑测确认通过**

Run: `npm test -- src/utils/memoryPath.test.ts src/clients/arkClient.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types/ark.ts src/utils/memoryPath.ts src/utils/memoryPath.test.ts src/clients/arkClient.ts src/clients/arkClient.test.ts
git commit -m "$(cat <<'EOF'
feat: 扩展会话创建类型与记忆路径规范化 --story=请替换@tapd-请替换

EOF
)"
```

---

### Task 2: Redis UserMemoryRedisStore

**Files:**
- Create: `src/store/memoryStore.ts`
- Create: `src/store/memoryStore.test.ts`

**Interfaces:**
- Consumes: ioredis `Redis`（与 `SessionStore` 同模式）
- Produces:
  - `MEMORY_LOCK_TTL_SECONDS = 30`
  - `class UserMemoryRedisStore`
  - `getMemoryStoreId(tokenHash): Promise<string | null>`
  - `setMemoryStoreId(tokenHash, id): Promise<void>`（无 TTL）
  - `tryAcquireCreateLock(tokenHash): Promise<boolean>`
  - `releaseCreateLock(tokenHash): Promise<void>`

- [ ] **Step 1: 写失败单测（假 Redis）**

创建 `src/store/memoryStore.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { UserMemoryRedisStore } from './memoryStore.js';

function createFakeRedis() {
  const map = new Map<string, string>();
  return {
    map,
    async get(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    async set(key: string, value: string, ...args: unknown[]) {
      if (args.includes('NX') && map.has(key)) return null;
      map.set(key, value);
      return 'OK';
    },
    async del(key: string) {
      map.delete(key);
      return 1;
    },
  };
}

describe('UserMemoryRedisStore', () => {
  it('stores mapping without requiring TTL args', async () => {
    const redis = createFakeRedis();
    const store = new UserMemoryRedisStore(redis as never);
    await store.setMemoryStoreId('hash1', 'memstore-1');
    expect(await store.getMemoryStoreId('hash1')).toBe('memstore-1');
    expect(redis.map.get('ark:user_memory:hash1')).toBe('memstore-1');
  });

  it('acquires lock only once via SET NX', async () => {
    const redis = createFakeRedis();
    const store = new UserMemoryRedisStore(redis as never);
    expect(await store.tryAcquireCreateLock('hash1')).toBe(true);
    expect(await store.tryAcquireCreateLock('hash1')).toBe(false);
    await store.releaseCreateLock('hash1');
    expect(await store.tryAcquireCreateLock('hash1')).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npm test -- src/store/memoryStore.test.ts`  
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 UserMemoryRedisStore**

创建 `src/store/memoryStore.ts`：

```ts
import { Redis } from 'ioredis';

export const MEMORY_LOCK_TTL_SECONDS = 30;

function memoryKey(tokenHash: string): string {
  return `ark:user_memory:${tokenHash}`;
}

function lockKey(tokenHash: string): string {
  return `ark:user_memory:lock:${tokenHash}`;
}

/** tokenHash → memory_store_id 永久映射 */
export class UserMemoryRedisStore {
  constructor(private readonly redis: Redis) {}

  async getMemoryStoreId(tokenHash: string): Promise<string | null> {
    return this.redis.get(memoryKey(tokenHash));
  }

  /** 永久绑定：不设置 EX */
  async setMemoryStoreId(tokenHash: string, memoryStoreId: string): Promise<void> {
    await this.redis.set(memoryKey(tokenHash), memoryStoreId);
  }

  /** @returns true 表示抢到锁 */
  async tryAcquireCreateLock(tokenHash: string): Promise<boolean> {
    const result = await this.redis.set(
      lockKey(tokenHash),
      '1',
      'EX',
      MEMORY_LOCK_TTL_SECONDS,
      'NX',
    );
    return result === 'OK';
  }

  async releaseCreateLock(tokenHash: string): Promise<void> {
    await this.redis.del(lockKey(tokenHash));
  }
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `npm test -- src/store/memoryStore.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/memoryStore.ts src/store/memoryStore.test.ts
git commit -m "$(cat <<'EOF'
feat: 新增用户记忆库 Redis 永久映射 --story=请替换@tapd-请替换

EOF
)"
```

---

### Task 3: arkMemoryClient（方舟 Memory REST）

**Files:**
- Create: `src/clients/arkMemoryClient.ts`
- Create: `src/clients/arkMemoryClient.test.ts`

**Interfaces:**
- Consumes: `ArkApiError` from `arkClient.ts`；`ArkMemoryFileInfo` / `ArkMemoryStoreResource` from types
- Produces:
  - `DEFAULT_MEMORY_INSTRUCTIONS`
  - `buildMemoryStoreResource(memoryStoreId, instructions?): ArkMemoryStoreResource`
  - `normalizeMemoryFile(raw): ArkMemoryFileInfo | null`
  - `createMemoryStore` / `getMemoryStoreInfo` / `listMemoryFiles`
  - `getMemoryFile` / `createMemoryFile` / `updateMemoryFile` / `findMemoryByPath`

上游路径（相对 `arkBaseUrl`）：

| 操作 | HTTP |
|------|------|
| 创建库 | `POST /memory_stores` `{ name, description }` |
| 查库 | `GET /memory_stores/{id}` |
| 列记忆 | `GET /memory_stores/{id}/memories?path_prefix=` |
| 读记忆 | `GET /memory_stores/{id}/memories/{memoryId}` |
| 创建记忆 | `POST /memory_stores/{id}/memories` `{ path, content }` |
| 更新记忆 | `POST /memory_stores/{id}/memories/{memoryId}` `{ content, content_sha256? }` |

实现时先不加 beta header（与现有 arkClient 一致）。若线上 400 提示缺 header，再在本文件 `authHeaders` 集中补齐，**不要**与 session managed-agents header 混用。

- [ ] **Step 1: 写失败单测**

创建 `src/clients/arkMemoryClient.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMORY_INSTRUCTIONS,
  buildMemoryStoreResource,
  normalizeMemoryFile,
} from './arkMemoryClient.js';

describe('buildMemoryStoreResource', () => {
  it('builds memory_store resource', () => {
    expect(buildMemoryStoreResource('memstore-1')).toEqual({
      type: 'memory_store',
      memory_store_id: 'memstore-1',
      instructions: DEFAULT_MEMORY_INSTRUCTIONS,
    });
    expect(buildMemoryStoreResource('memstore-1', 'custom')).toMatchObject({
      instructions: 'custom',
    });
  });
});

describe('normalizeMemoryFile', () => {
  it('normalizes id/path/content', () => {
    expect(
      normalizeMemoryFile({
        id: 'mem-1',
        path: '/user_profile.json',
        content: '{}',
        updated_at: '2026-01-01T00:00:00Z',
        content_sha256: 'abc',
      }),
    ).toEqual({
      id: 'mem-1',
      path: '/user_profile.json',
      content: '{}',
      updated_at: '2026-01-01T00:00:00Z',
      content_sha256: 'abc',
    });
    expect(normalizeMemoryFile(null)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npm test -- src/clients/arkMemoryClient.test.ts`  
Expected: FAIL

- [ ] **Step 3: 实现 `src/clients/arkMemoryClient.ts`**

创建完整文件（与 Interfaces 签名一致）：

```ts
import axios, { AxiosError } from 'axios';
import { ArkApiError } from './arkClient.js';
import type { ArkMemoryFileInfo, ArkMemoryStoreResource } from '../types/ark.js';

const NO_TIMEOUT = 0;

export const DEFAULT_MEMORY_INSTRUCTIONS =
  '这是该用户的专属持久化记忆库，保存了用户偏好、使用习惯、历史配置。请使用系统提示中给出的实际 mount_path 访问该目录；启动任务前优先读取其中的 user_profile.json；任务过程中更新的用户信息请及时写回该目录。';

function authHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function readArkErrorPayload(data: unknown): { message: string; code?: string } {
  if (!data || typeof data !== 'object') return { message: 'Unknown ark error' };
  const obj = data as Record<string, unknown>;
  const nested = obj.error;
  if (nested && typeof nested === 'object') {
    const err = nested as Record<string, unknown>;
    return {
      message: typeof err.message === 'string' ? err.message : 'Ark API error',
      code: typeof err.code === 'string' ? err.code : undefined,
    };
  }
  return {
    message:
      (typeof obj.message === 'string' && obj.message) ||
      (typeof obj.error === 'string' && obj.error) ||
      'Ark API error',
    code: typeof obj.code === 'string' ? obj.code : undefined,
  };
}

function toArkError(err: unknown): ArkApiError {
  if (err instanceof ArkApiError) return err;
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    const { message, code } = readArkErrorPayload(err.response?.data);
    return new ArkApiError(message, { status, code });
  }
  return new ArkApiError(err instanceof Error ? err.message : 'Unknown ark error');
}

export function buildMemoryStoreResource(
  memoryStoreId: string,
  instructions: string = DEFAULT_MEMORY_INSTRUCTIONS,
): ArkMemoryStoreResource {
  return {
    type: 'memory_store',
    memory_store_id: memoryStoreId,
    instructions,
  };
}

export function normalizeMemoryFile(raw: unknown): ArkMemoryFileInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id =
    (typeof o.id === 'string' && o.id) ||
    (typeof o.memory_id === 'string' && o.memory_id) ||
    '';
  const path = typeof o.path === 'string' ? o.path : '';
  const content = typeof o.content === 'string' ? o.content : '';
  if (!id || !path) return null;
  return {
    id,
    path,
    content,
    ...(typeof o.updated_at === 'string' ? { updated_at: o.updated_at } : {}),
    ...(typeof o.content_sha256 === 'string' ? { content_sha256: o.content_sha256 } : {}),
  };
}

export interface MemoryClientBaseParams {
  arkApiKey: string;
  arkBaseUrl: string;
  signal?: AbortSignal;
}

export async function createMemoryStore(
  params: MemoryClientBaseParams & { name: string; description: string },
): Promise<{ id: string }> {
  try {
    const res = await axios.post(
      `${params.arkBaseUrl}/memory_stores`,
      { name: params.name, description: params.description },
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT, signal: params.signal },
    );
    const id =
      res.data && typeof res.data === 'object' && typeof (res.data as { id?: unknown }).id === 'string'
        ? (res.data as { id: string }).id
        : '';
    if (!id) throw new ArkApiError('Create memory store response missing id');
    return { id };
  } catch (err) {
    throw toArkError(err);
  }
}

export async function getMemoryStoreInfo(
  params: MemoryClientBaseParams & { memoryStoreId: string },
): Promise<{ id: string; name?: string }> {
  try {
    const res = await axios.get(
      `${params.arkBaseUrl}/memory_stores/${encodeURIComponent(params.memoryStoreId)}`,
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT, signal: params.signal },
    );
    const data = res.data as { id?: string; name?: string };
    if (!data?.id) throw new ArkApiError('Get memory store response missing id');
    return { id: data.id, ...(data.name ? { name: data.name } : {}) };
  } catch (err) {
    throw toArkError(err);
  }
}

export async function listMemoryFiles(
  params: MemoryClientBaseParams & { memoryStoreId: string; pathPrefix?: string },
): Promise<Array<{ id: string; path: string }>> {
  try {
    const res = await axios.get(
      `${params.arkBaseUrl}/memory_stores/${encodeURIComponent(params.memoryStoreId)}/memories`,
      {
        headers: authHeaders(params.arkApiKey),
        timeout: NO_TIMEOUT,
        signal: params.signal,
        params: params.pathPrefix ? { path_prefix: params.pathPrefix } : undefined,
      },
    );
    const data = res.data;
    const list = Array.isArray(data)
      ? data
      : data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data)
        ? (data as { data: unknown[] }).data
        : [];
    return list
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const o = item as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id : '';
        const path = typeof o.path === 'string' ? o.path : '';
        return id && path ? { id, path } : null;
      })
      .filter((x): x is { id: string; path: string } => x != null);
  } catch (err) {
    throw toArkError(err);
  }
}

export async function getMemoryFile(
  params: MemoryClientBaseParams & { memoryStoreId: string; memoryId: string },
): Promise<ArkMemoryFileInfo> {
  try {
    const res = await axios.get(
      `${params.arkBaseUrl}/memory_stores/${encodeURIComponent(params.memoryStoreId)}/memories/${encodeURIComponent(params.memoryId)}`,
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT, signal: params.signal },
    );
    const info = normalizeMemoryFile(res.data);
    if (!info) throw new ArkApiError('Get memory file response invalid');
    return info;
  } catch (err) {
    throw toArkError(err);
  }
}

export async function createMemoryFile(
  params: MemoryClientBaseParams & { memoryStoreId: string; path: string; content: string },
): Promise<ArkMemoryFileInfo> {
  try {
    const res = await axios.post(
      `${params.arkBaseUrl}/memory_stores/${encodeURIComponent(params.memoryStoreId)}/memories`,
      { path: params.path, content: params.content },
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT, signal: params.signal },
    );
    const info = normalizeMemoryFile(res.data);
    if (!info) throw new ArkApiError('Create memory file response invalid');
    return info;
  } catch (err) {
    throw toArkError(err);
  }
}

export async function updateMemoryFile(
  params: MemoryClientBaseParams & {
    memoryStoreId: string;
    memoryId: string;
    content: string;
    contentSha256?: string;
  },
): Promise<ArkMemoryFileInfo> {
  try {
    const body: Record<string, string> = { content: params.content };
    if (params.contentSha256) body.content_sha256 = params.contentSha256;
    const res = await axios.post(
      `${params.arkBaseUrl}/memory_stores/${encodeURIComponent(params.memoryStoreId)}/memories/${encodeURIComponent(params.memoryId)}`,
      body,
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT, signal: params.signal },
    );
    const info = normalizeMemoryFile(res.data);
    if (!info) throw new ArkApiError('Update memory file response invalid');
    return info;
  } catch (err) {
    throw toArkError(err);
  }
}

export async function findMemoryByPath(
  params: MemoryClientBaseParams & { memoryStoreId: string; path: string },
): Promise<{ id: string; path: string } | null> {
  const files = await listMemoryFiles({
    arkApiKey: params.arkApiKey,
    arkBaseUrl: params.arkBaseUrl,
    memoryStoreId: params.memoryStoreId,
    pathPrefix: '/',
    signal: params.signal,
  });
  return files.find((f) => f.path === params.path) ?? null;
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `npm test -- src/clients/arkMemoryClient.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/clients/arkMemoryClient.ts src/clients/arkMemoryClient.test.ts
git commit -m "$(cat <<'EOF'
feat: 新增 Memory Store 方舟 REST 客户端 --story=请替换@tapd-请替换

EOF
)"
```

---

### Task 4: MemoryService（getOrCreate + 读写 upsert）

**Files:**
- Create: `src/services/memoryService.ts`
- Create: `src/services/memoryService.test.ts`

**Interfaces:**
- Consumes: `UserMemoryRedisStore`；arkMemoryClient 函数；`normalizeMemoryPath`；`AppConfig`；`resolveUserKey`；`ArkApiError`
- Produces:
  - `class MemoryService`
  - `getOrCreateUserMemoryStore(tokenHash: string): Promise<string>`
  - `readUserMemory(webUserToken, filePath?): Promise<{ path; content; updated_at }>`
  - `writeUserMemory(webUserToken, filePath, content): Promise<{ success: true; path }>`
  - 读不存在：`ArkApiError(..., { status: 404, code: 'MEMORY_NOT_FOUND' })`
  - 锁超时：`ArkApiError('memory store 创建中，请重试', { status: 503, code: 'MEMORY_LOCK_TIMEOUT' })`

- [ ] **Step 1: 写失败单测**

创建 `src/services/memoryService.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../clients/arkMemoryClient.js', () => ({
  createMemoryStore: vi.fn(),
  findMemoryByPath: vi.fn(),
  getMemoryFile: vi.fn(),
  createMemoryFile: vi.fn(),
  updateMemoryFile: vi.fn(),
}));

import {
  createMemoryFile,
  createMemoryStore,
  findMemoryByPath,
  getMemoryFile,
  updateMemoryFile,
} from '../clients/arkMemoryClient.js';
import { MemoryService } from './memoryService.js';
import type { AppConfig } from '../config.js';
import type { UserMemoryRedisStore } from '../store/memoryStore.js';

const config = {
  arkApiKey: 'k',
  arkBaseUrl: 'https://example.com/api/v3',
} as AppConfig;

describe('MemoryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing memory store id from redis', async () => {
    const store = {
      getMemoryStoreId: vi.fn().mockResolvedValue('memstore-existing'),
      tryAcquireCreateLock: vi.fn(),
      setMemoryStoreId: vi.fn(),
      releaseCreateLock: vi.fn(),
    } as unknown as UserMemoryRedisStore;
    const svc = new MemoryService(config, store);
    await expect(svc.getOrCreateUserMemoryStore('hash')).resolves.toBe('memstore-existing');
    expect(createMemoryStore).not.toHaveBeenCalled();
  });

  it('creates store when missing and lock acquired', async () => {
    const hash = 'abcd'.repeat(8);
    const store = {
      getMemoryStoreId: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
      tryAcquireCreateLock: vi.fn().mockResolvedValue(true),
      setMemoryStoreId: vi.fn().mockResolvedValue(undefined),
      releaseCreateLock: vi.fn().mockResolvedValue(undefined),
    } as unknown as UserMemoryRedisStore;
    vi.mocked(createMemoryStore).mockResolvedValue({ id: 'memstore-new' });
    const svc = new MemoryService(config, store);
    await expect(svc.getOrCreateUserMemoryStore(hash)).resolves.toBe('memstore-new');
    expect(createMemoryStore).toHaveBeenCalled();
    expect(store.setMemoryStoreId).toHaveBeenCalledWith(hash, 'memstore-new');
    expect(store.releaseCreateLock).toHaveBeenCalledWith(hash);
  });

  it('write creates when path missing', async () => {
    const store = {
      getMemoryStoreId: vi.fn().mockResolvedValue('memstore-1'),
      tryAcquireCreateLock: vi.fn(),
      setMemoryStoreId: vi.fn(),
      releaseCreateLock: vi.fn(),
    } as unknown as UserMemoryRedisStore;
    vi.mocked(findMemoryByPath).mockResolvedValue(null);
    vi.mocked(createMemoryFile).mockResolvedValue({
      id: 'm1',
      path: '/user_profile.json',
      content: '{}',
    });
    const svc = new MemoryService(config, store);
    await expect(svc.writeUserMemory('token', 'user_profile.json', '{}')).resolves.toEqual({
      success: true,
      path: '/user_profile.json',
    });
    expect(createMemoryFile).toHaveBeenCalled();
    expect(updateMemoryFile).not.toHaveBeenCalled();
  });

  it('write updates when path exists', async () => {
    const store = {
      getMemoryStoreId: vi.fn().mockResolvedValue('memstore-1'),
      tryAcquireCreateLock: vi.fn(),
      setMemoryStoreId: vi.fn(),
      releaseCreateLock: vi.fn(),
    } as unknown as UserMemoryRedisStore;
    vi.mocked(findMemoryByPath).mockResolvedValue({ id: 'm1', path: '/user_profile.json' });
    vi.mocked(getMemoryFile).mockResolvedValue({
      id: 'm1',
      path: '/user_profile.json',
      content: 'old',
      content_sha256: 'sha',
    });
    vi.mocked(updateMemoryFile).mockResolvedValue({
      id: 'm1',
      path: '/user_profile.json',
      content: 'new',
    });
    const svc = new MemoryService(config, store);
    await expect(svc.writeUserMemory('token', '/user_profile.json', 'new')).resolves.toEqual({
      success: true,
      path: '/user_profile.json',
    });
    expect(updateMemoryFile).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: 'm1', content: 'new', contentSha256: 'sha' }),
    );
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npm test -- src/services/memoryService.test.ts`  
Expected: FAIL

- [ ] **Step 3: 实现 `src/services/memoryService.ts`**

```ts
import { ArkApiError } from '../clients/arkClient.js';
import {
  createMemoryFile,
  createMemoryStore,
  findMemoryByPath,
  getMemoryFile,
  updateMemoryFile,
} from '../clients/arkMemoryClient.js';
import type { AppConfig } from '../config.js';
import { UserMemoryRedisStore } from '../store/memoryStore.js';
import { resolveUserKey } from '../utils/hash.js';
import { normalizeMemoryPath } from '../utils/memoryPath.js';

const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class MemoryService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: UserMemoryRedisStore,
  ) {}

  async getOrCreateUserMemoryStore(tokenHash: string): Promise<string> {
    const existing = await this.store.getMemoryStoreId(tokenHash);
    if (existing) return existing;

    const locked = await this.store.tryAcquireCreateLock(tokenHash);
    if (!locked) {
      const waited = await this.waitForMemoryStoreId(tokenHash, LOCK_WAIT_MS);
      if (waited) return waited;
      throw new ArkApiError('memory store 创建中，请重试', {
        status: 503,
        code: 'MEMORY_LOCK_TIMEOUT',
      });
    }

    try {
      const again = await this.store.getMemoryStoreId(tokenHash);
      if (again) return again;

      const name = `user_memory_${tokenHash.slice(0, 16)}`;
      const description = `用户 ${tokenHash.slice(0, 8)} 专属持久化记忆库`;
      console.log(`[memory] creating store for hash=${tokenHash.slice(0, 8)} name=${name}`);
      const { id } = await createMemoryStore({
        arkApiKey: this.config.arkApiKey,
        arkBaseUrl: this.config.arkBaseUrl,
        name,
        description,
      });
      await this.store.setMemoryStoreId(tokenHash, id);
      console.log(`[memory] created store id=${id} hash=${tokenHash.slice(0, 8)}`);
      return id;
    } catch (err) {
      console.error(
        `[memory] create failed hash=${tokenHash.slice(0, 8)}:`,
        err instanceof Error ? err.message : err,
      );
      throw err;
    } finally {
      await this.store.releaseCreateLock(tokenHash);
    }
  }

  private async waitForMemoryStoreId(
    tokenHash: string,
    timeoutMs: number,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const id = await this.store.getMemoryStoreId(tokenHash);
      if (id) return id;
      await sleep(LOCK_POLL_MS);
    }
    return null;
  }

  async readUserMemory(
    webUserToken: string,
    filePath?: string,
  ): Promise<{ path: string; content: string; updated_at: string }> {
    const { tokenHash } = resolveUserKey(webUserToken);
    const path = normalizeMemoryPath(filePath);
    const memoryStoreId = await this.getOrCreateUserMemoryStore(tokenHash);
    const found = await findMemoryByPath({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      memoryStoreId,
      path,
    });
    if (!found) {
      throw new ArkApiError('memory file not found', {
        status: 404,
        code: 'MEMORY_NOT_FOUND',
      });
    }
    const file = await getMemoryFile({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      memoryStoreId,
      memoryId: found.id,
    });
    return {
      path: file.path,
      content: file.content,
      updated_at: file.updated_at ?? '',
    };
  }

  async writeUserMemory(
    webUserToken: string,
    filePath: string | undefined,
    content: string,
  ): Promise<{ success: true; path: string }> {
    const { tokenHash } = resolveUserKey(webUserToken);
    const path = normalizeMemoryPath(filePath);
    const memoryStoreId = await this.getOrCreateUserMemoryStore(tokenHash);
    const found = await findMemoryByPath({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      memoryStoreId,
      path,
    });

    if (!found) {
      await createMemoryFile({
        arkApiKey: this.config.arkApiKey,
        arkBaseUrl: this.config.arkBaseUrl,
        memoryStoreId,
        path,
        content,
      });
      return { success: true, path };
    }

    await this.updateWithOptionalRetry(memoryStoreId, found.id, content);
    return { success: true, path };
  }

  private async updateWithOptionalRetry(
    memoryStoreId: string,
    memoryId: string,
    content: string,
  ): Promise<void> {
    const current = await getMemoryFile({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      memoryStoreId,
      memoryId,
    });
    try {
      await updateMemoryFile({
        arkApiKey: this.config.arkApiKey,
        arkBaseUrl: this.config.arkBaseUrl,
        memoryStoreId,
        memoryId,
        content,
        contentSha256: current.content_sha256,
      });
    } catch (err) {
      const status = err instanceof ArkApiError ? err.status : undefined;
      if (status !== 409 && status !== 412 && status !== 400) throw err;
      const fresh = await getMemoryFile({
        arkApiKey: this.config.arkApiKey,
        arkBaseUrl: this.config.arkBaseUrl,
        memoryStoreId,
        memoryId,
      });
      await updateMemoryFile({
        arkApiKey: this.config.arkApiKey,
        arkBaseUrl: this.config.arkBaseUrl,
        memoryStoreId,
        memoryId,
        content,
        contentSha256: fresh.content_sha256,
      });
    }
  }
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `npm test -- src/services/memoryService.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/memoryService.ts src/services/memoryService.test.ts
git commit -m "$(cat <<'EOF'
feat: 实现用户记忆库 getOrCreate 与 upsert 读写 --story=请替换@tapd-请替换

EOF
)"
```

---

### Task 5+6: Session 挂载 + 路由注入（同一 commit）

**Files:**
- Modify: `src/services/sessionService.ts`
- Modify: `src/routes/agent.ts`
- Modify: `src/app.ts`
- Modify: `src/server.ts`

**Interfaces:**
- `SessionService` 构造增加 `memoryService: MemoryService`
- `createAndPersist`：先 `getOrCreateUserMemoryStore`，再 `createArkSession({ ..., resources: [buildMemoryStoreResource(id)] })`
- `rebuildSession`：只 `deleteSession`，**不**删记忆映射
- `GET /api/agent/memory`：query `webUserToken` + 可选 `filePath`
- `POST /api/agent/memory`：body `webUserToken` + `content`（非空）+ 可选 `filePath`
- 404/503 映射 ArkApiError.status

- [ ] **Step 1: 改 SessionService**

```ts
private async createAndPersist(tokenHash: string, webUserToken: string): Promise<string> {
  const memoryStoreId = await this.memoryService.getOrCreateUserMemoryStore(tokenHash);
  const { sessionId } = await createArkSession({
    arkApiKey: this.config.arkApiKey,
    arkBaseUrl: this.config.arkBaseUrl,
    agentId: this.config.arkAgentId,
    baseEnvironmentId: this.config.arkBaseEnvironmentId,
    userId: tokenHash,
    userBearerToken: webUserToken,
    resources: [buildMemoryStoreResource(memoryStoreId)],
  });
  await this.store.setSessionId(tokenHash, sessionId);
  return sessionId;
}
```

- [ ] **Step 2: 改 routes / app / server**

`createAgentRouter` deps 类型增加 `memoryService: MemoryService`。

在 `src/routes/agent.ts` 增加：

```ts
  router.get('/memory', async (req: Request, res: Response) => {
    const tokenErr = requireNonEmptyString(req.query?.webUserToken, 'webUserToken');
    if (tokenErr) return res.status(400).json({ error: tokenErr });
    const filePath =
      typeof req.query?.filePath === 'string' ? req.query.filePath : undefined;
    try {
      const result = await deps.memoryService.readUserMemory(
        String(req.query.webUserToken).trim(),
        filePath,
      );
      return res.status(200).json(result);
    } catch (err) {
      if (err instanceof ArkApiError && err.status === 404) {
        return res.status(404).json({ error: err.message });
      }
      if (err instanceof ArkApiError && err.status === 503) {
        return res.status(503).json({ error: err.message });
      }
      return res.status(502).json({
        error: err instanceof Error ? err.message : 'Read memory failed',
      });
    }
  });

  router.post('/memory', async (req: Request, res: Response) => {
    const tokenErr = requireNonEmptyString(req.body?.webUserToken, 'webUserToken');
    const contentErr = requireNonEmptyString(req.body?.content, 'content');
    if (tokenErr || contentErr) {
      return res.status(400).json({ error: tokenErr ?? contentErr });
    }
    const filePath =
      typeof req.body?.filePath === 'string' ? req.body.filePath : undefined;
    try {
      const result = await deps.memoryService.writeUserMemory(
        req.body.webUserToken.trim(),
        filePath,
        req.body.content,
      );
      return res.status(200).json(result);
    } catch (err) {
      if (err instanceof ArkApiError && err.status === 503) {
        return res.status(503).json({ error: err.message });
      }
      return res.status(502).json({
        error: err instanceof Error ? err.message : 'Write memory failed',
      });
    }
  });
```

`src/app.ts`：`createApp` deps 增加 `memoryService`，传入 `createAgentRouter`。

`src/server.ts`：

```ts
import { MemoryService } from './services/memoryService.js';
import { UserMemoryRedisStore } from './store/memoryStore.js';

const memoryRedisStore = new UserMemoryRedisStore(redis);
const memoryService = new MemoryService(config, memoryRedisStore);
const sessionService = new SessionService(config, sessionStore, memoryService);
const app = createApp({ config, chatService, sessionService, fileService, memoryService });
```

`POST /memory`：`content` 使用现有 `requireNonEmptyString`（不允许空串）。

- [ ] **Step 3: 全量验证**

Run: `npm test && npx tsc --noEmit`  
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/sessionService.ts src/routes/agent.ts src/app.ts src/server.ts
git commit -m "$(cat <<'EOF'
feat: 会话创建挂载记忆库并暴露读写 API --story=请替换@tapd-请替换

EOF
)"
```

---

### Task 7: README curl 附录

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 追加「持久化记忆（Memory Store）」一节**

在 README「API 示例」相关位置追加：

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: README 追加 Memory Store curl 示例 --story=请替换@tapd-请替换

EOF
)"
```

---

## Spec Coverage Checklist

| Spec 要求 | Task |
|-----------|------|
| Redis 永久映射 + SET NX | Task 2, 4 |
| getOrCreateUserMemoryStore | Task 4 |
| arkMemoryClient REST | Task 3 |
| 创建会话 resources 挂载 | Task 1, 5+6 |
| instructions 不硬编码 mount id | Task 3 |
| GET/POST /memory upsert | Task 4, 5+6 |
| rebuild 不删记忆 | Task 5+6 |
| 硬依赖失败 | Task 4, 5+6 |
| path 规范化 | Task 1, 4 |
| README curl | Task 7 |

## 手测验收

1. 新 token：`POST /memory` → Redis 有 `ark:user_memory:*`；再 chat → Agent 能读画像  
2. 同 token 再写 → Redis 中 `memory_store_id` 不变  
3. `rebuild-session` 后记忆映射不变，`GET /memory` 仍可读  
4. 方舟 `GET /sessions/{id}/resources` 可见 `type=memory_store` 与 `mount_path`
