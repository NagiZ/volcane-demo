# Memory Store 调试与验证指南

适用分支：`master`（Memory Store 已合并）。  
配套设计：`docs/superpowers/specs/2026-09-04-ark-agent-memory-store-design.md`

## 重要结论：已有会话会不会自动补挂 Memory？

**不会。** 下次「唤醒」复用旧 session 时，**不会**自动把 memory_store 补挂上去。

| 场景 | 是否带 Memory |
|------|----------------|
| Redis 里已有旧 `sessionId`，chat 直接复用 | **否**（官方：memory_store 只能创建会话时挂载，运行中不可追加） |
| Redis 无映射 → `getOrCreateSession` 新建会话 | **是** |
| `POST /api/agent/rebuild-session` | **是**（复用同一 `memory_store_id`） |
| chat 遇 `session_not_found` → `invalidateAndRecreate` | **是** |

对**上线前已存在**的会话：请主动调一次 `rebuild-session`，或等旧 session 失效后自然重建。  
记忆库本身（Redis `ark:user_memory:*` + 方舟 Memory Store）与会话独立；重建只换 session，记忆数据不丢。

---

## 1. 启动依赖

```bash
docker compose up -d
cp .env.example .env   # 填 ARK_API_KEY / ARK_AGENT_ID / ARK_BASE_ENVIRONMENT_ID
npm run dev            # http://127.0.0.1:3000
```

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

单测回归：

```bash
npm test
npm test -- src/services/memoryService.test.ts src/clients/arkMemoryClient.test.ts src/services/sessionService.test.ts
```

---

## 2. 验收链路（推荐顺序）

准备 tokenHash（下文多处用到）：

```bash
TOKEN_HASH=$(node -e "console.log(require('crypto').createHash('sha256').update('demo-user').digest('hex'))")
echo "$TOKEN_HASH"
```

### ① 写入用户画像（会创建记忆库并写 Redis）

```bash
curl -X POST http://127.0.0.1:3000/api/agent/memory \
  -H 'Content-Type: application/json' \
  -d '{
    "webUserToken":"demo-user",
    "filePath":"/user_profile.json",
    "content":"{\"theme\":\"dark\",\"locale\":\"zh-CN\"}"
  }'
```

期望：`{"success":true,"path":"/user_profile.json"}`  
服务日志（仅首次）：`[memory] creating store for hash=...`

### ② 读回

```bash
curl 'http://127.0.0.1:3000/api/agent/memory?webUserToken=demo-user&filePath=/user_profile.json'
```

期望：`content` 与写入一致；可能含 `updated_at`（取决于方舟返回）。

### ③ 查 Redis 映射（永久、无 TTL）

```bash
redis-cli GET "ark:user_memory:${TOKEN_HASH}"
redis-cli TTL "ark:user_memory:${TOKEN_HASH}"   # 应为 -1
```

记下 `memstore-...`，后续对比是否复用。

### ④ 为「旧会话」补挂 Memory（如有）

若该用户在加功能前已有会话，先重建：

```bash
curl -X POST http://127.0.0.1:3000/api/agent/rebuild-session \
  -H 'Content-Type: application/json' \
  -d '{"webUserToken":"demo-user"}'
```

期望：返回新 `sessionId`；`ark:user_memory:${TOKEN_HASH}` **不变**。

### ⑤ 对话验证 Agent 能读记忆

```bash
curl -N -X POST http://127.0.0.1:3000/api/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"webUserToken":"demo-user","userMessage":"请先读取记忆库中的 user_profile.json 并复述偏好"}'
```

期望：SSE 回复中能复述 `dark` / `zh-CN`。  
路径以系统提示中的实际 `mount_path` 为准，不要硬编码 `/mnt/memory/{id}/`。

### ⑥ 再建会话后记忆仍在

```bash
curl -X POST http://127.0.0.1:3000/api/agent/rebuild-session \
  -H 'Content-Type: application/json' \
  -d '{"webUserToken":"demo-user"}'

redis-cli GET "ark:user_memory:${TOKEN_HASH}"   # 应与重建前相同
curl 'http://127.0.0.1:3000/api/agent/memory?webUserToken=demo-user&filePath=/user_profile.json'
```

### ⑦（可选）方舟侧查会话资源

```bash
SESSION_ID=$(redis-cli GET "ark:session:map:${TOKEN_HASH}")
# 使用 .env 中的 ARK_API_KEY 与 Base URL（默认华北）
curl -s "https://ark.cn-beijing.volces.com/api/v3/sessions/${SESSION_ID}/resources" \
  -H "Authorization: Bearer $ARK_API_KEY" | jq .
```

期望：存在 `type=memory_store` 及 `mount_path`。

---

## 3. 常见问题排查

| 现象 | 排查 |
|------|------|
| 写/建会话 502/503 | 看终端 Ark 错误；确认 Key、Agent、地域 Base URL |
| 读 404 `memory file not found` | 先 POST 写入；path 是否一致（默认 `/user_profile.json`） |
| Agent 说找不到记忆文件 | 会话是否为旧会话未 rebuild；让 Agent 读系统提示中的 `mount_path` |
| 旧用户 chat 无记忆 | Redis 仍指向旧 session → 调 `rebuild-session` |
| 重复创建多个记忆库 | 查 Redis 是否被清；并发锁超时后是否重试 |
| Redis 无 key | 是否连错 `REDIS_URL`；是否换了不同 `webUserToken` |

相关 Redis Key：

- 会话：`ark:session:map:{tokenHash}`（有 TTL，约 25 天）
- 记忆：`ark:user_memory:{tokenHash}`（**无 TTL**）
- 创建锁：`ark:user_memory:lock:{tokenHash}`（EX 30 秒）

---

## 4. 代码入口速查

| 能力 | 位置 |
|------|------|
| 创建会话挂载 | `src/services/sessionService.ts` → `createAndPersist` |
| getOrCreate / upsert | `src/services/memoryService.ts` |
| 方舟 REST | `src/clients/arkMemoryClient.ts` |
| HTTP | `GET/POST /api/agent/memory`（`src/routes/agent.ts`） |
| Redis 映射 | `src/store/memoryStore.ts` |
