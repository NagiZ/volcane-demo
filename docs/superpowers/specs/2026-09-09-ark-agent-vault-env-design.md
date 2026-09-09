# Ark Managed Agent 环境变量型 Vault 凭证改造设计（MVP）

日期：2026-09-09  
状态：已确认  
来源：Managed Agents Vault 改造指南 + brainstorming 决策  
依赖：`2026-09-01-ark-managed-agent-proxy-design.md`、`2026-09-04-ark-agent-memory-store-design.md`

## 1. 目标与边界

在现有 Node.js + Express + TypeScript + ioredis 代理上，将沙箱敏感凭证从明文 `config.env` 迁移到火山方舟**环境变量型 Vault**，验证「功能可用」与「安全占位符生效」。

1. Skill **零修改**：沙箱内仍通过环境变量名 `LEYO_AGENT_KEY` 使用凭证
2. 创建 / 重建 / **懒创建**会话时：先建 Vault，再以 `vault_ids` 挂载；明文 Token 不再写入 CreateSession body
3. Redis 持久化 `tokenHash → vaultId`；前端**不**保存 `vaultId`
4. 提供按 `webUserToken` 清理 Vault 的调试接口，支撑「删除后鉴权失败」验收

**验证链路**

```
webUserToken
  → POST /vaults { display_name } → vaultId（空容器，禁止带 auth）
  → POST /vaults/{vaultId}/credentials { auth: environment_variable LEYO_AGENT_KEY }
  → Redis ark:vault:map / ark:vault:cred
  → POST /sessions { env: { USER_ID }, vault_ids: [vaultId] }
  → Skill 读 LEYO_AGENT_KEY（占位符对外不可见明文）
  → DELETE /api/agent/vault { webUserToken } → DeleteVault → 清映射
  → 同会话再调外部 API → 401
```

**明确不做（本轮）**

- 真实用户体系 / `user_id` 替换 tokenHash
- `allowed_hosts` 域名白名单（Vault networking 用 `unrestricted`）
- 多 secret / 多 Vault 业务编排
- 修改 Skill 代码
- 将 `USER_BEARER_TOKEN` 迁入 Vault（本轮从 `config.env` **删除**，仅保留 Vault 挂载的 `LEYO_AGENT_KEY`）

## 2. 已确认决策

| 议题 | 选择 |
|------|------|
| Vault `secret_name` | `LEYO_AGENT_KEY`（与现网 Skill / 代码一致，非指南中的 `LEY_O_AGENT_KEY`） |
| `USER_BEARER_TOKEN` | 方案 B：从 CreateSession `env` 删除，不再注入 |
| Vault networking | `unrestricted`（MVP 不做 limited / allowed_hosts） |
| 架构 | 方案 1：在现有 `SessionService.createAndPersist` 链路上联 Vault |
| `vaultId` 归属 | Redis `tokenHash → vaultId`；前端不存 |
| 懒创建 | 必须创建并写入 `vaultId`（与 rebuild 共用 `createAndPersist`） |
| 清理入参 | `webUserToken`（后端查 Redis），非前端传 `vaultId` |
| 重建旧 Vault | 尽力 Delete 旧映射对应 Vault，失败打日志后继续新建 |

## 3. 架构与模块

```
webUserToken
  → resolveUserKey → tokenHash
  → createEnvVault → vaultId
  → createArkSession(vault_ids, env.USER_ID only)
  → SessionStore: sessionId + vaultId
  → 可选：deleteVaultByToken(webUserToken)
```

| 模块 | 变更 |
|------|------|
| `src/types/ark.ts` | `CreateSessionParams`：增加 `vaultIds: string[]`；移除用于写入 `env` 的 `userBearerToken`（Token 仅传给创建 Vault，不进 CreateSession body） |
| `src/clients/arkClient.ts` | `buildCreateSessionBody`：写入 `vault_ids`；`env` 仅 `USER_ID`；禁止 `LEYO_AGENT_KEY` / `USER_BEARER_TOKEN` |
| `src/clients/arkVaultClient.ts`（新，或并入 arkClient） | `createEnvVault` / `deleteVault` |
| `src/store/sessionStore.ts` | 新增 vault 映射 get/set/delete；与 session 同 TTL |
| `src/services/sessionService.ts` | 创建前建 Vault；失败回滚；rebuild 清旧 Vault；返回值可含 `vaultId`（调试） |
| `src/routes/agent.ts` | `DELETE /vault`（body: `webUserToken`）；rebuild 响应可选带 `vaultId` |
| `web/` | TokenBar「清理 Vault」按钮；只传 token |

官方 Base URL 不变：`https://ark.cn-beijing.volces.com/api/v3`。

上游参考：`POST /api/v3/vaults`、`DELETE /api/v3/vaults/{vault_id}`（实现时以官方字段名为准；若 `name` vs `display_name` 有差异，按实测调整，语义不变）。

## 4. Redis 映射

| Key | Value | TTL |
|-----|-------|-----|
| `ark:session:map:{tokenHash}` | `sessionId` | 现有 `SESSION_TTL_SECONDS`（25 天） |
| `ark:vault:map:{tokenHash}` | `vaultId` | 与 session **相同 TTL** |

- 新建会话：写 session + vault 两条映射
- `deleteSession`（重建前）：删 session 映射；vault 映射由重建流程单独处理（先 DeleteVault 再覆盖写入）
- `DELETE /api/agent/vault`：**只**删上游 Vault + `ark:vault:map:*`，**保留** `ark:session:map:*`，以便同会话复验 401
- 重建会话：先读旧 `vaultId` 尽力 DeleteVault → 清旧 vault 映射 → 新建并写入新 session + vault 映射

## 5. 上游请求体

### 5.1 创建 Vault + Credential（两层，禁止在 Vault 根请求带 auth）

`POST {arkBaseUrl}/vaults` — 仅空容器：

```json
{ "display_name": "debug-leyo-vault-<短随机>" }
```

`POST {arkBaseUrl}/vaults/{vault_id}/credentials` — 写入唯一凭据：

```json
{
  "display_name": "leyo-agent-key-cred",
  "auth": {
    "type": "environment_variable",
    "secret_name": "LEYO_AGENT_KEY",
    "secret_value": "<webUserToken>",
    "networking": { "type": "unrestricted" }
  }
}
```

响应分别取 `id` → `vaultId` / `credentialId`。控制台 Vault 详情凭据列表应可见该 credential。

`PUT .../credentials/{credential_id}` 可更新 `secret_value`（无需重建 Session）。

### 5.2 CreateSession

在现有 `environment_with_overrides` + `baseEnvironmentId` + `resources`（Memory）基础上：

```json
{
  "agent": "<ARK_AGENT_ID>",
  "environment": {
    "type": "environment_with_overrides",
    "id": "<ARK_BASE_ENVIRONMENT_ID>",
    "config": {
      "env": {
        "USER_ID": "<tokenHash>"
      },
      "vault_ids": ["<vaultId>"]
    }
  },
  "resources": [/* memory_store 不变 */]
}
```

**禁止**在 `config.env` 中出现 `LEYO_AGENT_KEY`、`USER_BEARER_TOKEN` 或 Token 明文。

指南示例中的 `config.type: "cloud"` / 顶层 `networking` **不**作为本轮必改项；以现网 `environment_with_overrides` + `id` 形状为准，仅增量 `vault_ids`。

## 6. 本仓库 HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/agent/chat` | 懒创建走 Vault + 写 Redis vault 映射；SSE 契约不变（不回传 vaultId） |
| `POST` | `/api/agent/rebuild-session` | 清旧 Vault → 新建；JSON 可含 `vaultId` 便于日志，前端不强制持久化 |
| `DELETE` | `/api/agent/vault` | body `{ "webUserToken": "..." }`：查映射 → DeleteVault → 删 `ark:vault:map:*`；**保留** session 映射以便同会话复验 401 |

无 vault 映射 → `404`。上游 Delete 失败 → `503`，**保留** Redis vault 映射便于重试。

## 7. 错误处理

| 场景 | 行为 |
|------|------|
| 创建 Vault 失败 | 不创建 Session；抛错（503 / ArkApiError） |
| Vault 成功、CreateSession 失败 | 尽力 `DeleteVault`，再抛错 |
| 重建时删旧 Vault 失败 | 日志后继续新建 |
| 清理：无映射 | `404` |
| 清理：上游失败 | `503`，保留映射 |

## 8. 前端（最小）

- TokenBar 增加「清理 Vault」：调用 `DELETE /api/agent/vault`，body 为当前 `webUserToken`
- 成功 / 失败用现有 notice 展示
- 不增加 vaultId 本地存储

## 9. 验收标准

1. **功能**：有效 Token 建会话后，Skill 调外部接口鉴权成功，业务与改造前一致  
2. **安全**：沙箱内 `echo $LEYO_AGENT_KEY` 或打印环境变量，仅见占位符，无 Token 明文  
3. **结构**：CreateSession 抓包无 Token 明文，存在 `vault_ids`；`env` 无 `LEYO_AGENT_KEY` / `USER_BEARER_TOKEN`  
4. **删除失效**：清理 Vault 后，**同一 session** 后续 Skill 调外部接口返回 401  

## 10. 测试要点（实现阶段）

- `buildCreateSessionBody`：含 `vault_ids`；`env` 仅 `USER_ID`  
- `createEnvVault` / `deleteVault`：URL、Bearer、body 字段单测（mock axios）  
- `SessionService`：创建写双映射；CreateSession 失败触发删 Vault；rebuild 尽力删旧 Vault  
- 路由：`DELETE /vault` 404 / 成功路径  

## 11. 非目标回顾

不做用户体系、allowed_hosts、Skill 改动、明文 `USER_BEARER_TOKEN` 保留、前端 vaultId 缓存。
