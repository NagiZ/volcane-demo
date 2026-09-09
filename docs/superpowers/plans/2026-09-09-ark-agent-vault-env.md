# Ark Agent 环境变量型 Vault 凭证改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Managed Agents 会话沙箱中的 `LEYO_AGENT_KEY` 从明文 `config.env` 迁移到方舟环境变量型 Vault，并支持按 token 清理以完成安全验收。

**Architecture:** 在现有 `SessionService.createAndPersist` 链路上先 `createEnvVault`，再 `createArkSession({ vault_ids })`；Redis 新增 `tokenHash → vaultId`；对外 `DELETE /api/agent/vault` 用 `webUserToken` 查映射后删 Vault。Skill 零改动。

**Tech Stack:** TypeScript, Express, axios, ioredis, vitest, 现有 web React

**Spec:** `docs/superpowers/specs/2026-09-09-ark-agent-vault-env-design.md`

## Global Constraints

- Base URL：复用 `config.arkBaseUrl`（`https://ark.cn-beijing.volces.com/api/v3`）
- 禁止引入方舟官方 SDK；axios REST
- Vault `secret_name` 固定：`LEYO_AGENT_KEY`
- Vault networking：`{ "type": "unrestricted" }`（不做 allowed_hosts）
- CreateSession `env`：**仅** `USER_ID`；禁止 `LEYO_AGENT_KEY` / `USER_BEARER_TOKEN`
- Redis vault key：`ark:vault:map:{tokenHash}`，TTL 与 session 相同（`SESSION_TTL_SECONDS`）
- 清理 Vault：**保留** session 映射（便于同会话验 401）
- 日志禁止打印完整 `webUserToken` / `secret_value` / `ARK_API_KEY`
- Commit message 用中文 conventional commits + TAPD 占位（仅在用户要求或本计划 Step 明确要求时执行 commit）

---

## File Map

| 文件 | 职责 |
|------|------|
| `src/types/ark.ts` | `CreateSessionParams`：`vaultIds`；移除 `userBearerToken` |
| `src/clients/arkClient.ts` | `buildCreateSessionBody` 写 `vault_ids`，env 仅 USER_ID |
| `src/clients/arkClient.test.ts` | 更新 body 断言 |
| `src/clients/arkVaultClient.ts` | `buildCreateEnvVaultBody` / `createEnvVault` / `deleteVault` |
| `src/clients/arkVaultClient.test.ts` | Vault client 单测 |
| `src/store/sessionStore.ts` | vault 映射 get/set/delete |
| `src/store/sessionStore.test.ts` | 假 Redis 单测 |
| `src/services/sessionService.ts` | 创建链路联 Vault；rebuild 清旧；暴露 deleteVaultForToken |
| `src/services/sessionService.test.ts` | 映射 / 回滚 / vaultIds 传参 |
| `src/routes/agent.ts` | `DELETE /vault`；rebuild 可回 vaultId |
| `web/src/api.ts` / `types.ts` / `TokenBar.tsx` / `App.tsx` | 清理 Vault UI |

---

### Task 1: CreateSession 类型与 body（vault_ids，去掉明文密钥）

**Files:**
- Modify: `src/types/ark.ts`
- Modify: `src/clients/arkClient.ts`（`buildCreateSessionBody`）
- Modify: `src/clients/arkClient.test.ts`

**Interfaces:**
- Produces:
  - `CreateSessionParams`：
    ```ts
    export interface CreateSessionParams {
      arkApiKey: string;
      arkBaseUrl: string;
      agentId: string;
      baseEnvironmentId: string;
      userId: string;
      vaultIds: string[];
      sessionId?: string;
      resources?: ArkMemoryStoreResource[];
    }
    ```
  - `buildCreateSessionBody`：`config.env = { USER_ID }`；`config.vault_ids = params.vaultIds`（始终写入数组，调用方保证非空）

- [ ] **Step 1: 改失败单测**

将 `src/clients/arkClient.test.ts` 中 `buildCreateSessionBody` 的三个用例改为使用 `vaultIds`，并断言无明文密钥：

```ts
describe('buildCreateSessionBody', () => {
  it('uses agent and environment.id per Ark API', () => {
    const body = buildCreateSessionBody({
      arkApiKey: 'k',
      arkBaseUrl: 'https://example.com/api/v3',
      agentId: 'agent-1',
      baseEnvironmentId: 'env-1',
      userId: 'user-hash',
      vaultIds: ['vault-1'],
    });

    expect(body.agent).toBe('agent-1');
    expect(body).not.toHaveProperty('agent_id');
    expect(body).not.toHaveProperty('environment_id');

    const environment = body.environment as Record<string, unknown>;
    expect(environment.type).toBe('environment_with_overrides');
    expect(environment.id).toBe('env-1');
    expect(environment).not.toHaveProperty('environment_id');

    const config = environment.config as {
      env: Record<string, string>;
      vault_ids: string[];
    };
    expect(config.env).toEqual({ USER_ID: 'user-hash' });
    expect(config.env).not.toHaveProperty('USER_BEARER_TOKEN');
    expect(config.env).not.toHaveProperty('LEYO_AGENT_KEY');
    expect(config.vault_ids).toEqual(['vault-1']);
  });

  it('includes memory_store resources when provided', () => {
    const body = buildCreateSessionBody({
      arkApiKey: 'k',
      arkBaseUrl: 'https://example.com/api/v3',
      agentId: 'agent-1',
      baseEnvironmentId: 'env-1',
      userId: 'user-hash',
      vaultIds: ['vault-1'],
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
      vaultIds: ['vault-1'],
    });
    expect(body).not.toHaveProperty('resources');
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npm test -- src/clients/arkClient.test.ts`

Expected: FAIL（类型 / 断言与现实现不一致）

- [ ] **Step 3: 改类型与实现**

`src/types/ark.ts` 中 `CreateSessionParams`：删除 `userBearerToken`，增加 `vaultIds: string[]`。

`buildCreateSessionBody`：

```ts
export function buildCreateSessionBody(params: CreateSessionParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    agent: params.agentId,
    environment: {
      type: 'environment_with_overrides',
      id: params.baseEnvironmentId,
      config: {
        env: {
          USER_ID: params.userId,
        },
        vault_ids: params.vaultIds,
      },
    },
  };
  if (params.sessionId) body.id = params.sessionId;
  if (params.resources && params.resources.length > 0) {
    body.resources = params.resources;
  }
  return body;
}
```

- [ ] **Step 4: 跑测通过**

Run: `npm test -- src/clients/arkClient.test.ts`

Expected: PASS（若其它文件因 `userBearerToken` 编译失败，本 Task 仅保证 arkClient 测试文件逻辑正确；全量类型错误在 Task 4 一并收口也可——优先在本步修掉 `createArkSession` 调用方的明显类型缺口，或暂时 `// @ts-expect-error` 禁止：应直接改 `sessionService` 编译能过的最小桩。若 `tsc`/vitest 因 sessionService 仍传 `userBearerToken` 失败，先在 `sessionService` 临时传 `vaultIds: []` 占位并删 `userBearerToken`，Task 4 再接真 Vault。）

**推荐：** Task 1 结束后 `sessionService.createAndPersist` 临时改为：

```ts
const { sessionId } = await createArkSession({
  arkApiKey: this.config.arkApiKey,
  arkBaseUrl: this.config.arkBaseUrl,
  agentId: this.config.arkAgentId,
  baseEnvironmentId: this.config.arkBaseEnvironmentId,
  userId: tokenHash,
  vaultIds: [], // Task 4 替换为真实 vaultId
  resources: [buildMemoryStoreResource(memoryStoreId)],
});
```

并更新 `sessionService.test.ts` 中对 `userBearerToken` 的期望（若有）为含 `vaultIds`。

- [ ] **Step 5: Commit**（仅当用户要求提交时）

```bash
git add src/types/ark.ts src/clients/arkClient.ts src/clients/arkClient.test.ts src/services/sessionService.ts src/services/sessionService.test.ts
git commit -m "$(cat <<'EOF'
refactor: CreateSession 改用 vault_ids 并移除明文密钥 env --story=请替换@tapd-请替换

[请在此处粘贴 TAPD 需求/缺陷/任务 ID。获取方式：在 TAPD 页面点击「链接 -> 复制源码关键字」]
[如代码已全部提交，可在 TAPD ID 后添加这些指令来更新 TAPD 状态：#fix / #fixed / #finish / #finished / #close / #closed]
EOF
)"
```

---

### Task 2: arkVaultClient（创建 / 删除 Vault）

**Files:**
- Create: `src/clients/arkVaultClient.ts`
- Create: `src/clients/arkVaultClient.test.ts`

**Interfaces:**
- Consumes: `ArkApiError` from `arkClient.js`
- Produces:
  - `buildCreateEnvVaultBody(secretValue: string, nameSuffix?: string): Record<string, unknown>`
  - `createEnvVault(params: { arkApiKey; arkBaseUrl; secretValue; nameSuffix? }): Promise<{ vaultId: string }>`
  - `deleteVault(params: { arkApiKey; arkBaseUrl; vaultId }): Promise<void>`
  - 常量 `VAULT_SECRET_NAME = 'LEYO_AGENT_KEY'`

- [ ] **Step 1: 写失败单测**

创建 `src/clients/arkVaultClient.test.ts`：

```ts
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCreateEnvVaultBody,
  createEnvVault,
  deleteVault,
  VAULT_SECRET_NAME,
} from './arkVaultClient.js';

vi.mock('axios');

describe('buildCreateEnvVaultBody', () => {
  it('uses environment_variable shape and LEYO_AGENT_KEY', () => {
    const body = buildCreateEnvVaultBody('plain-token', 'abc123');
    expect(body.name).toBe('debug-token-abc123');
    expect(body.type).toBe('environment_variable');
    const config = body.config as {
      auth: {
        type: string;
        secret_name: string;
        secret_value: string;
        networking: { type: string };
      };
    };
    expect(config.auth.type).toBe('environment_variable');
    expect(config.auth.secret_name).toBe(VAULT_SECRET_NAME);
    expect(config.auth.secret_name).toBe('LEYO_AGENT_KEY');
    expect(config.auth.secret_value).toBe('plain-token');
    expect(config.auth.networking).toEqual({ type: 'unrestricted' });
  });
});

describe('createEnvVault', () => {
  afterEach(() => vi.mocked(axios.post).mockReset());

  it('POSTs /vaults and returns id', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { id: 'vault-9' } });
    const result = await createEnvVault({
      arkApiKey: 'k',
      arkBaseUrl: 'https://example.com/api/v3',
      secretValue: 'tok',
      nameSuffix: 'x1',
    });
    expect(result).toEqual({ vaultId: 'vault-9' });
    expect(axios.post).toHaveBeenCalledWith(
      'https://example.com/api/v3/vaults',
      expect.objectContaining({
        name: 'debug-token-x1',
        type: 'environment_variable',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer k' }),
      }),
    );
  });
});

describe('deleteVault', () => {
  afterEach(() => vi.mocked(axios.delete).mockReset());

  it('DELETEs /vaults/{id}', async () => {
    vi.mocked(axios.delete).mockResolvedValue({ data: {} });
    await deleteVault({
      arkApiKey: 'k',
      arkBaseUrl: 'https://example.com/api/v3',
      vaultId: 'vault-9',
    });
    expect(axios.delete).toHaveBeenCalledWith(
      'https://example.com/api/v3/vaults/vault-9',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer k' }),
      }),
    );
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npm test -- src/clients/arkVaultClient.test.ts`

Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `arkVaultClient.ts`**

```ts
import { randomBytes } from 'node:crypto';
import axios, { AxiosError } from 'axios';
import { ArkApiError } from './arkClient.js';

const NO_TIMEOUT = 0;

export const VAULT_SECRET_NAME = 'LEYO_AGENT_KEY';

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

export function buildCreateEnvVaultBody(
  secretValue: string,
  nameSuffix: string = randomBytes(4).toString('hex'),
): Record<string, unknown> {
  return {
    name: `debug-token-${nameSuffix}`,
    type: 'environment_variable',
    config: {
      auth: {
        type: 'environment_variable',
        secret_name: VAULT_SECRET_NAME,
        secret_value: secretValue,
        networking: { type: 'unrestricted' },
      },
    },
  };
}

export async function createEnvVault(params: {
  arkApiKey: string;
  arkBaseUrl: string;
  secretValue: string;
  nameSuffix?: string;
}): Promise<{ vaultId: string }> {
  try {
    const res = await axios.post<{ id?: string }>(
      `${params.arkBaseUrl}/vaults`,
      buildCreateEnvVaultBody(params.secretValue, params.nameSuffix),
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT },
    );
    if (!res.data?.id) throw new ArkApiError('Create vault response missing id');
    return { vaultId: res.data.id };
  } catch (err) {
    throw toArkError(err);
  }
}

export async function deleteVault(params: {
  arkApiKey: string;
  arkBaseUrl: string;
  vaultId: string;
}): Promise<void> {
  try {
    await axios.delete(
      `${params.arkBaseUrl}/vaults/${encodeURIComponent(params.vaultId)}`,
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT },
    );
  } catch (err) {
    throw toArkError(err);
  }
}
```

说明：若联调时官方要求字段名 `display_name` 而非 `name`，仅改 `buildCreateEnvVaultBody` 并同步单测，语义不变。

- [ ] **Step 4: 跑测通过**

Run: `npm test -- src/clients/arkVaultClient.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**（仅当用户要求提交时）

```bash
git add src/clients/arkVaultClient.ts src/clients/arkVaultClient.test.ts
git commit -m "$(cat <<'EOF'
feat: 新增方舟环境变量型 Vault 创建与删除客户端 --story=请替换@tapd-请替换

[请在此处粘贴 TAPD 需求/缺陷/任务 ID。获取方式：在 TAPD 页面点击「链接 -> 复制源码关键字」]
[如代码已全部提交，可在 TAPD ID 后添加这些指令来更新 TAPD 状态：#fix / #fixed / #finish / #finished / #close / #closed]
EOF
)"
```

---

### Task 3: SessionStore vault 映射

**Files:**
- Modify: `src/store/sessionStore.ts`
- Create: `src/store/sessionStore.test.ts`

**Interfaces:**
- Produces:
  - `getVaultId(tokenHash: string): Promise<string | null>`
  - `setVaultId(tokenHash: string, vaultId: string): Promise<void>`
  - `deleteVaultId(tokenHash: string): Promise<void>`
  - key：`ark:vault:map:${tokenHash}`，`EX SESSION_TTL_SECONDS`

- [ ] **Step 1: 写失败单测**

创建 `src/store/sessionStore.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { SESSION_TTL_SECONDS, SessionStore } from './sessionStore.js';

function fakeRedis() {
  const map = new Map<string, string>();
  return {
    map,
    get: vi.fn(async (k: string) => map.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, _ex?: string, _ttl?: number) => {
      map.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => {
      map.delete(k);
      return 1;
    }),
  };
}

describe('SessionStore vault map', () => {
  it('sets and gets vault id with TTL flag', async () => {
    const redis = fakeRedis();
    const store = new SessionStore(redis as never);
    await store.setVaultId('hash1', 'vault-1');
    expect(redis.set).toHaveBeenCalledWith(
      'ark:vault:map:hash1',
      'vault-1',
      'EX',
      SESSION_TTL_SECONDS,
    );
    await expect(store.getVaultId('hash1')).resolves.toBe('vault-1');
  });

  it('deletes vault id', async () => {
    const redis = fakeRedis();
    const store = new SessionStore(redis as never);
    await store.setVaultId('hash1', 'vault-1');
    await store.deleteVaultId('hash1');
    await expect(store.getVaultId('hash1')).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npm test -- src/store/sessionStore.test.ts`

Expected: FAIL（方法不存在）

- [ ] **Step 3: 扩展 SessionStore**

在 `src/store/sessionStore.ts` 追加：

```ts
function vaultRedisKey(tokenHash: string): string {
  return `ark:vault:map:${tokenHash}`;
}

// 类内方法：
async getVaultId(tokenHash: string): Promise<string | null> {
  return this.redis.get(vaultRedisKey(tokenHash));
}

async setVaultId(tokenHash: string, vaultId: string): Promise<void> {
  await this.redis.set(vaultRedisKey(tokenHash), vaultId, 'EX', SESSION_TTL_SECONDS);
}

async deleteVaultId(tokenHash: string): Promise<void> {
  await this.redis.del(vaultRedisKey(tokenHash));
}
```

- [ ] **Step 4: 跑测通过**

Run: `npm test -- src/store/sessionStore.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**（仅当用户要求提交时）

```bash
git add src/store/sessionStore.ts src/store/sessionStore.test.ts
git commit -m "$(cat <<'EOF'
feat: SessionStore 增加 tokenHash 到 vaultId 映射 --story=请替换@tapd-请替换

[请在此处粘贴 TAPD 需求/缺陷/任务 ID。获取方式：在 TAPD 页面点击「链接 -> 复制源码关键字」]
[如代码已全部提交，可在 TAPD ID 后添加这些指令来更新 TAPD 状态：#fix / #fixed / #finish / #finished / #close / #closed]
EOF
)"
```

---

### Task 4: SessionService 联 Vault（懒创建 / 重建 / 清理）

**Files:**
- Modify: `src/services/sessionService.ts`
- Modify: `src/services/sessionService.test.ts`

**Interfaces:**
- Consumes: `createEnvVault` / `deleteVault`；`SessionStore` vault 方法
- Produces:
  - `createAndPersist` 内部：先 Vault → CreateSession(`vaultIds`) → 写双映射；CreateSession 失败则尽力 `deleteVault`
  - `getOrCreateSession` / `rebuildSession` 返回可含 `vaultId?: string`（新建时必有）
  - `deleteVaultForToken(webUserToken: string): Promise<{ vaultId: string }>`  
    - 无映射 → throw `ArkApiError('No vault mapping', { code: 'NO_VAULT', status: 404 })`  
    - 成功：上游 Delete + `deleteVaultId`；**不**删 session 映射  
    - 上游失败：不删 Redis vault 映射，抛错
  - `rebuildSession`：读旧 vaultId → 尽力 deleteVault → `deleteVaultId` → `deleteSession` → `createAndPersist`

- [ ] **Step 1: 写/改失败单测**

重写 `src/services/sessionService.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../clients/arkClient.js', () => ({
  createArkSession: vi.fn(),
  ArkApiError: class ArkApiError extends Error {
    status?: number;
    code?: string;
    constructor(message: string, options?: { status?: number; code?: string }) {
      super(message);
      this.status = options?.status;
      this.code = options?.code;
    }
  },
}));

vi.mock('../clients/arkVaultClient.js', () => ({
  createEnvVault: vi.fn(),
  deleteVault: vi.fn(),
}));

import { createArkSession } from '../clients/arkClient.js';
import { createEnvVault, deleteVault } from '../clients/arkVaultClient.js';
import { DEFAULT_MEMORY_INSTRUCTIONS } from '../clients/arkMemoryClient.js';
import type { AppConfig } from '../config.js';
import type { SessionStore } from '../store/sessionStore.js';
import type { MemoryService } from './memoryService.js';
import { SessionService } from './sessionService.js';

const config = {
  arkApiKey: 'k',
  arkBaseUrl: 'https://example.com/api/v3',
  arkAgentId: 'agent-1',
  arkBaseEnvironmentId: 'env-1',
} as AppConfig;

function makeStore(overrides: Partial<SessionStore> = {}) {
  return {
    getSessionId: vi.fn().mockResolvedValue(null),
    setSessionId: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    getVaultId: vi.fn().mockResolvedValue(null),
    setVaultId: vi.fn().mockResolvedValue(undefined),
    deleteVaultId: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SessionStore;
}

describe('SessionService vault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('create path creates vault, passes vaultIds, stores mapping', async () => {
    const store = makeStore();
    const memoryService = {
      getOrCreateUserMemoryStore: vi.fn().mockResolvedValue('memstore-42'),
    } as unknown as MemoryService;
    vi.mocked(createEnvVault).mockResolvedValue({ vaultId: 'vault-1' });
    vi.mocked(createArkSession).mockResolvedValue({ sessionId: 'sess-1' });

    const svc = new SessionService(config, store, memoryService);
    const result = await svc.getOrCreateSession('web-token');

    expect(result).toMatchObject({ sessionId: 'sess-1', vaultId: 'vault-1' });
    expect(createEnvVault).toHaveBeenCalledWith(
      expect.objectContaining({ secretValue: 'web-token' }),
    );
    expect(createArkSession).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultIds: ['vault-1'],
        resources: [
          {
            type: 'memory_store',
            memory_store_id: 'memstore-42',
            instructions: DEFAULT_MEMORY_INSTRUCTIONS,
          },
        ],
      }),
    );
    expect(createArkSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ userBearerToken: expect.anything() }),
    );
    expect(store.setVaultId).toHaveBeenCalled();
    expect(store.setSessionId).toHaveBeenCalled();
  });

  it('rolls back vault when createArkSession fails', async () => {
    const store = makeStore();
    const memoryService = {
      getOrCreateUserMemoryStore: vi.fn().mockResolvedValue('memstore-42'),
    } as unknown as MemoryService;
    vi.mocked(createEnvVault).mockResolvedValue({ vaultId: 'vault-1' });
    vi.mocked(createArkSession).mockRejectedValue(new Error('boom'));
    vi.mocked(deleteVault).mockResolvedValue(undefined);

    const svc = new SessionService(config, store, memoryService);
    await expect(svc.getOrCreateSession('web-token')).rejects.toThrow('boom');
    expect(deleteVault).toHaveBeenCalledWith(
      expect.objectContaining({ vaultId: 'vault-1' }),
    );
    expect(store.setSessionId).not.toHaveBeenCalled();
  });

  it('deleteVaultForToken deletes upstream and vault map only', async () => {
    const store = makeStore({
      getVaultId: vi.fn().mockResolvedValue('vault-1'),
    });
    const memoryService = {} as MemoryService;
    vi.mocked(deleteVault).mockResolvedValue(undefined);

    const svc = new SessionService(config, store, memoryService);
    await expect(svc.deleteVaultForToken('web-token')).resolves.toEqual({
      vaultId: 'vault-1',
    });
    expect(deleteVault).toHaveBeenCalled();
    expect(store.deleteVaultId).toHaveBeenCalled();
    expect(store.deleteSession).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npm test -- src/services/sessionService.test.ts`

Expected: FAIL

- [ ] **Step 3: 实现 SessionService**

目标实现骨架（保持现有 Memory 挂载）：

```ts
import { createArkSession, ArkApiError } from '../clients/arkClient.js';
import { createEnvVault, deleteVault } from '../clients/arkVaultClient.js';
import { buildMemoryStoreResource } from '../clients/arkMemoryClient.js';
import type { AppConfig } from '../config.js';
import { SessionStore } from '../store/sessionStore.js';
import { resolveUserKey } from '../utils/hash.js';
import type { MemoryService } from './memoryService.js';

export class SessionService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: SessionStore,
    private readonly memoryService: MemoryService,
  ) {}

  private async createAndPersist(
    tokenHash: string,
    webUserToken: string,
  ): Promise<{ sessionId: string; vaultId: string }> {
    const memoryStoreId = await this.memoryService.getOrCreateUserMemoryStore(tokenHash);
    const { vaultId } = await createEnvVault({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      secretValue: webUserToken,
    });
    try {
      const { sessionId } = await createArkSession({
        arkApiKey: this.config.arkApiKey,
        arkBaseUrl: this.config.arkBaseUrl,
        agentId: this.config.arkAgentId,
        baseEnvironmentId: this.config.arkBaseEnvironmentId,
        userId: tokenHash,
        vaultIds: [vaultId],
        resources: [buildMemoryStoreResource(memoryStoreId)],
      });
      await this.store.setSessionId(tokenHash, sessionId);
      await this.store.setVaultId(tokenHash, vaultId);
      return { sessionId, vaultId };
    } catch (err) {
      try {
        await deleteVault({
          arkApiKey: this.config.arkApiKey,
          arkBaseUrl: this.config.arkBaseUrl,
          vaultId,
        });
      } catch {
        // 尽力回滚
      }
      throw err;
    }
  }

  async getOrCreateSession(
    webUserToken: string,
  ): Promise<{ tokenHash: string; sessionId: string; vaultId?: string }> {
    const { tokenHash } = resolveUserKey(webUserToken);
    const existing = await this.store.getSessionId(tokenHash);
    if (existing) return { tokenHash, sessionId: existing };
    const { sessionId, vaultId } = await this.createAndPersist(tokenHash, webUserToken);
    return { tokenHash, sessionId, vaultId };
  }

  // getExistingSession 保持不变

  async rebuildSession(
    webUserToken: string,
  ): Promise<{ tokenHash: string; sessionId: string; vaultId: string }> {
    const { tokenHash } = resolveUserKey(webUserToken);
    const oldVaultId = await this.store.getVaultId(tokenHash);
    if (oldVaultId) {
      try {
        await deleteVault({
          arkApiKey: this.config.arkApiKey,
          arkBaseUrl: this.config.arkBaseUrl,
          vaultId: oldVaultId,
        });
      } catch {
        // 日志可选：console.warn('delete old vault failed', oldVaultId)
      }
      await this.store.deleteVaultId(tokenHash);
    }
    await this.store.deleteSession(tokenHash);
    const { sessionId, vaultId } = await this.createAndPersist(tokenHash, webUserToken);
    return { tokenHash, sessionId, vaultId };
  }

  async invalidateAndRecreate(webUserToken: string) {
    return this.rebuildSession(webUserToken);
  }

  async deleteVaultForToken(webUserToken: string): Promise<{ vaultId: string }> {
    const { tokenHash } = resolveUserKey(webUserToken);
    const vaultId = await this.store.getVaultId(tokenHash);
    if (!vaultId) {
      throw new ArkApiError('No vault mapping', { code: 'NO_VAULT', status: 404 });
    }
    await deleteVault({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      vaultId,
    });
    await this.store.deleteVaultId(tokenHash);
    return { vaultId };
  }
}
```

- [ ] **Step 4: 跑测通过**

Run: `npm test -- src/services/sessionService.test.ts`

Expected: PASS

再跑：`npm test`

Expected: 全绿（修任何因返回类型变化引起的编译/测试问题）

- [ ] **Step 5: Commit**（仅当用户要求提交时）

```bash
git add src/services/sessionService.ts src/services/sessionService.test.ts
git commit -m "$(cat <<'EOF'
feat: 会话创建链路挂载 Vault 并支持按 token 清理 --story=请替换@tapd-请替换

[请在此处粘贴 TAPD 需求/缺陷/任务 ID。获取方式：在 TAPD 页面点击「链接 -> 复制源码关键字」]
[如代码已全部提交，可在 TAPD ID 后添加这些指令来更新 TAPD 状态：#fix / #fixed / #finish / #finished / #close / #closed]
EOF
)"
```

---

### Task 5: 路由 DELETE /vault + rebuild 回传 vaultId

**Files:**
- Modify: `src/routes/agent.ts`

**Interfaces:**
- Consumes: `sessionService.deleteVaultForToken` / `rebuildSession`
- Produces:
  - `DELETE /api/agent/vault` body `{ webUserToken }` → `{ ok: true, vaultId }`  
    - `NO_VAULT` → 404  
    - 其它 → 503
  - `POST /rebuild-session` 响应在 spread `result` 后自然含 `vaultId`

- [ ] **Step 1: 在 `createAgentRouter` 内追加路由**

放在 `rebuild-session` 路由附近：

```ts
  router.delete('/vault', async (req: Request, res: Response) => {
    const tokenErr = requireNonEmptyString(req.body?.webUserToken, 'webUserToken');
    if (tokenErr) return res.status(400).json({ error: tokenErr });

    try {
      const result = await deps.sessionService.deleteVaultForToken(req.body.webUserToken.trim());
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof ArkApiError && err.code === 'NO_VAULT') {
        return res.status(404).json({ error: err.message });
      }
      return res.status(503).json({
        error: err instanceof Error ? err.message : 'Delete vault failed',
      });
    }
  });
```

确认 `rebuild-session` 仍为：

```ts
const result = await deps.sessionService.rebuildSession(req.body.webUserToken.trim());
return res.status(200).json({ ok: true, ...result });
```

（`vaultId` 会随 result 返回。）

- [ ] **Step 2: 手工冒烟（可选，需后端启动）**

```bash
# 重建
curl -s -X POST http://127.0.0.1:3000/api/agent/rebuild-session \
  -H 'Content-Type: application/json' \
  -d '{"webUserToken":"test-token"}'

# 清理
curl -s -X DELETE http://127.0.0.1:3000/api/agent/vault \
  -H 'Content-Type: application/json' \
  -d '{"webUserToken":"test-token"}'
```

Expected: 重建 JSON 含 `sessionId`+`vaultId`；清理 `{ ok: true, vaultId }`；再清理一次 → 404

- [ ] **Step 3: Commit**（仅当用户要求提交时）

```bash
git add src/routes/agent.ts
git commit -m "$(cat <<'EOF'
feat: 新增按 token 清理 Vault 的调试接口 --story=请替换@tapd-请替换

[请在此处粘贴 TAPD 需求/缺陷/任务 ID。获取方式：在 TAPD 页面点击「链接 -> 复制源码关键字」]
[如代码已全部提交，可在 TAPD ID 后添加这些指令来更新 TAPD 状态：#fix / #fixed / #finish / #finished / #close / #closed]
EOF
)"
```

---

### Task 6: 前端「清理 Vault」

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/components/TokenBar.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Produces:
  - `deleteVault(webUserToken: string): Promise<{ ok: true; vaultId: string }>`
  - TokenBar：`onDeleteVault` / `deletingVault` 按钮
  - App：`handleDeleteVault` → notice 成功/失败

- [ ] **Step 1: types + api**

`web/src/types.ts`：

```ts
export interface RebuildSessionResult {
  ok: true;
  tokenHash: string;
  sessionId: string;
  vaultId?: string;
}

export interface DeleteVaultResult {
  ok: true;
  vaultId: string;
}
```

`web/src/api.ts` 增加：

```ts
export async function deleteVault(
  webUserToken: string,
  signal?: AbortSignal,
): Promise<DeleteVaultResult> {
  const res = await fetch('/api/agent/vault', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webUserToken }),
    signal,
  });
  if (!res.ok) {
    throw new ApiError(res.status, await readJsonError(res, `清理 Vault 失败 (${res.status})`));
  }
  const body: unknown = await res.json();
  if (!isRecord(body) || body.ok !== true || typeof body.vaultId !== 'string') {
    throw new ApiError(res.status, '清理 Vault 响应格式异常');
  }
  return { ok: true, vaultId: body.vaultId };
}
```

并在文件顶部 `import type` 中加入 `DeleteVaultResult`。

可选：`rebuildSession` 解析时若存在 `vaultId` 则透传（`typeof body.vaultId === 'string'` 时带上）。

- [ ] **Step 2: TokenBar UI**

扩展 props：`deletingVault: boolean`；`onDeleteVault: () => void`。

在「重建会话」旁增加按钮：

```tsx
<button
  type="button"
  className="btn btn--ghost"
  onClick={onDeleteVault}
  disabled={busy || rebuilding || deletingVault || token.trim().length === 0}
>
  {deletingVault ? '清理中…' : '清理 Vault'}
</button>
```

- [ ] **Step 3: App 接线**

```ts
const [deletingVault, setDeletingVault] = useState(false);

async function handleDeleteVault() {
  const trimmed = token.trim();
  if (busy || trimmed.length === 0) return;
  setDeletingVault(true);
  setNotice(null);
  try {
    const result = await deleteVault(trimmed);
    setNotice(`Vault 已清理 · ${result.vaultId}`);
  } catch (err) {
    const message = err instanceof ApiError ? err.message : '清理 Vault 失败';
    setNotice(message);
  } finally {
    setDeletingVault(false);
  }
}
```

把 `deletingVault` / `onDeleteVault={handleDeleteVault}` 传入 TokenBar；`rebuild` 成功 notice 可附带 `result.vaultId`（若有）。

- [ ] **Step 4: 前端类型检查（在 web 目录）**

Run: `cd web && npx tsc --noEmit`

Expected: 无错误

- [ ] **Step 5: Commit**（仅当用户要求提交时）

```bash
git add web/src/types.ts web/src/api.ts web/src/components/TokenBar.tsx web/src/App.tsx
git commit -m "$(cat <<'EOF'
feat: 调试页增加清理 Vault 按钮 --story=请替换@tapd-请替换

[请在此处粘贴 TAPD 需求/缺陷/任务 ID。获取方式：在 TAPD 页面点击「链接 -> 复制源码关键字」]
[如代码已全部提交，可在 TAPD ID 后添加这些指令来更新 TAPD 状态：#fix / #fixed / #finish / #finished / #close / #closed]
EOF
)"
```

---

### Task 7: 验收清单（手工，不写代码）

- [ ] **功能**：有效 Token → 重建或首聊 → Skill 鉴权成功  
- [ ] **安全**：沙箱打印 `$LEYO_AGENT_KEY` 仅为占位符  
- [ ] **结构**：抓包 CreateSession：有 `vault_ids`，env 无 Token / 无 `LEYO_AGENT_KEY` / 无 `USER_BEARER_TOKEN`  
- [ ] **删除失效**：点「清理 Vault」后同会话再调外部接口 → 401  
- [ ] **懒创建**：清空 Redis 后不点重建直接聊天，仍能鉴权成功；再点清理能 200（证明懒创建写了 vault 映射）

---

## Spec coverage (self-review)

| Spec 要求 | Task |
|-----------|------|
| createEnvVault / DeleteVault | Task 2 |
| CreateSession vault_ids，去掉明文密钥 | Task 1 |
| Redis tokenHash→vaultId | Task 3 |
| 懒创建与 rebuild 共用 createAndPersist | Task 4 |
| DELETE /vault by webUserToken，保留 session | Task 4–5 |
| 前端清理按钮，不存 vaultId | Task 6 |
| networking unrestricted / secret_name LEYO_AGENT_KEY | Task 2 |
| CreateSession 失败回滚 Vault | Task 4 |
| 验收四项 + 懒创建映射 | Task 7 |

无 TBD 占位；类型名在 Task 间一致（`vaultIds` / `deleteVaultForToken` / `VAULT_SECRET_NAME`）。
