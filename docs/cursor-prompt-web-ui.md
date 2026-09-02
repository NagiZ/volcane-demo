# Cursor 实现提示词：Web 对话页面

> 用途：把下面「提示词正文」整段复制给 Cursor。
> 前置事实已核对自本仓库源码（`src/app.ts`、`src/routes/agent.ts`、`src/services/chatService.ts`、`src/utils/sse.ts`、`src/types/sse.ts`）。

---

## 提示词正文（复制以下全部内容）

在本仓库根目录新建 `web/` 子目录，实现一个类 ChatGPT 的对话页面，对接已有的 Express 后端。

### 技术栈（严格遵守）

- React 18 + TypeScript + Vite
- **不引入** UI 组件库（不用 MUI/AntD/Tailwind），用手写 CSS
- **不引入** 状态管理库（Redux/Zustand 等），用 React 内置 hooks
- 允许的依赖仅限：`react`、`react-dom`、`vite`、`@vitejs/plugin-react`、`typescript`、`@types/*`
- 后端代码（`src/` 目录）**不要改动**

### 目标结构

```
volcane-demo/
├── src/                 ← 现有后端，勿改
└── web/                 ← 新建
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── api.ts        ← SSE 流式请求封装
        ├── types.ts
        ├── styles.css
        └── components/
            ├── TokenBar.tsx
            ├── MessageList.tsx
            ├── MessageItem.tsx
            └── Composer.tsx
```

---

### 后端接口契约（已实测确认，务必按此实现，勿自行猜测）

后端运行于 `http://127.0.0.1:3000`。

#### 1. `POST /api/agent/chat` — 流式对话

请求：

```json
{ "webUserToken": "demo-user", "userMessage": "你好" }
```

响应：`Content-Type: text/event-stream`，逐行下发。

**⚠️ 关键约束 1：不能用 `EventSource`。**
`EventSource` 只能发 GET 请求，而本接口是 POST。**必须**用 `fetch` + `response.body.getReader()`
手动读取流，并自行做 UTF-8 解码与按 `\n\n` 分包。

**⚠️ 关键约束 2：SSE 报文只有 `data:` 字段，没有 `event:` 字段。**
后端写出格式固定为 `data: {json}\n\n`（见 `src/utils/sse.ts:13`）。
解析时只需取 `data:` 后的 JSON，不要去读 `event:` 类型。

三种事件的 JSON 结构（对应 `src/types/sse.ts`，是完整的联合类型，不会有第四种）：

```ts
type NormalizedSseEvent =
  | { type: 'delta'; text: string }              // 回复文本
  | { type: 'error'; code: string; message: string }  // 出错
  | { type: 'done' };                            // 流正常结束
```

实际报文样例：

```
data: {"type":"delta","text":"你好！我是 pms-agent，一个运行在命令行环境中的通用智能体。"}

data: {"type":"done"}
```

**⚠️ 关键约束 3：`delta` 目前是整段一次性下发，不是逐字增量。**
后端是轮询实现，一轮对话通常只有 **1 个** `delta` 事件。
所以**不要**依赖「多个 delta 拼接出打字机效果」——但代码仍要写成累加多个 `delta` 的形式
（`text` 逐个追加到当前消息），因为这是契约允许的，且后端未来可能改为真流式。

等待期间（`POST` 已发出但 `delta` 未到）可能长达数十秒，**必须**显示「正在输入…」之类的加载指示，
否则界面看起来像卡死。

#### 2. `POST /api/agent/rebuild-session` — 重建会话

请求：`{ "webUserToken": "demo-user" }`

成功响应（普通 JSON，非 SSE）：

```json
{ "ok": true, "tokenHash": "4fd6d90c...", "sessionId": "sesn-20260902040239-6dctk" }
```

#### 3. `GET /health` — 健康检查

返回 `{"ok":true}`。用于页面顶部显示后端在线状态。

#### 错误响应（非 SSE 路径）

- `400` — 入参为空：`{ "error": "webUserToken is required" }`
- `503` — 后端/方舟/Redis 故障：`{ "error": "..." }`

注意 `chat` 接口有两种失败形态，都要处理：
- **流未开启前失败** → HTTP 状态码 `400`/`503` + JSON body
- **流已开启后失败** → HTTP `200`，但 SSE 中下发 `{"type":"error",...}`

---

### 功能需求

#### 顶部栏（TokenBar）

- `webUserToken` 输入框，**可见且可编辑**，默认值 `demo-user`
- token 持久化到 `localStorage`，刷新页面后保留
- 修改 token 后，对话区应清空（不同 token 是不同用户，历史不该混）
- 「重建会话」按钮 → 调用 `rebuild-session`，成功后清空对话区并提示结果
- 后端在线状态指示（调 `/health`）

#### 对话区（MessageList / MessageItem）

- 用户消息右侧、Agent 消息左侧，视觉区分（类 ChatGPT）
- 保留多轮历史（仅前端内存，不需要持久化对话内容）
- 新消息自动滚动到底部
- Agent 回复期间显示加载指示
- `error` 事件以醒目样式渲染，需显示 `code` 与 `message` 两个字段
- 空状态提示（首次进入时给个引导文案）

#### 输入区（Composer）

- 多行 textarea，`Enter` 发送、`Shift+Enter` 换行
- 请求进行中禁用发送按钮
- 空白内容不允许发送（后端会返回 400）

**⚠️ 关键约束 4：必须禁止并发发送。**
后端 `src/services/chatService.ts:18` 明确注释：同一 Ark Session **不支持并发发送两条消息**，
且后端 MVP **未实现排队锁**。因此前端必须保证上一轮 `done`/`error` 到达前，无法发出第二条。

---

### 跨端口配置

前端 dev server 跑在 `5173`，后端在 `3000`。**在 `vite.config.ts` 里配置 proxy**
把 `/api` 与 `/health` 转发到 `http://127.0.0.1:3000`。

这样前端代码里直接写 `/api/agent/chat` 相对路径即可，浏览器视角同源，无需依赖 CORS。
（后端 `src/app.ts:14` 虽已启用 `cors()`，但走 proxy 更省心，也避免流式请求的 CORS 边界问题。）

---

### 验收标准

请确保以下每一项都能通过：

1. `cd web && npm install && npm run dev` 可启动，浏览器打开 `http://127.0.0.1:5173/`
2. 后端 `npm run dev` 运行时，页面顶部显示后端在线
3. 输入「你好，请用一句话自我介绍」→ 能看到 Agent 回复
4. **多轮记忆验证**：接着问「我刚才问你的第一句话是什么？」→ Agent 能准确复述第一句
   （这验证了后端 Redis Session 复用生效）
5. **会话隔离验证**：把 token 改成别的值 → 对话区清空，且新 token 下 Agent 不知道旧对话内容
6. 点「重建会话」→ 返回新 `sessionId`，对话区清空，此后 Agent 不再记得之前内容
7. Agent 回复期间，发送按钮禁用，无法发出第二条
8. 停掉后端再发消息 → 页面显示明确错误，不white screen、不静默失败
9. `npx tsc --noEmit` 在 `web/` 下通过，无类型错误

### 代码要求

- TypeScript 严格模式，不使用 `any`
- SSE 解析逻辑放在 `api.ts`，与 UI 组件分离
- 用 `AbortController` 支持取消请求，组件卸载时中止，避免内存泄漏
- 注释用中文，与现有后端代码风格一致

---

## 附：给你（人）的提醒，不必给 Cursor

1. **两个 dev server 都要跑**：后端根目录 `npm run dev`，前端 `cd web && npm run dev`。
2. **`.gitignore` 需补充** `web/node_modules/` 与 `web/dist/`，否则可能误提交。
   现有 `.gitignore` 只忽略了根目录的 `node_modules/` 和 `dist/`。
3. **Redis 要先起来**：`docker compose up -d`。若镜像拉取失败见 `OPEN_ISSUES.md` 的镜像源绕过方案。
4. **验收第 4、5 项是关键**，它们实际验证的是后端的 Redis 映射逻辑，不只是前端。
5. 页面不会有打字机效果，这是后端轮询实现的已知行为，非前端 bug，详见 `OPEN_ISSUES.md`。
