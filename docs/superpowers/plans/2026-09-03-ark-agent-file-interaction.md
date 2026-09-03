# Ark Agent 文件交互 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有火山方舟 Managed Agents 代理上补齐文件上传、会话挂载、消息内引用与产物下载（前后端）。

**Architecture:** 扩展 `arkClient` 增加 Files/Resources HTTP；`ChatService` 在发消息前挂载文件并构造多模态 content；路由新增 `upload-file` / `output-files`；Web Composer 内嵌附件 + 产物条。鉴权仍走 `webUserToken` → Redis session。

**Tech Stack:** TypeScript, Express, multer (memoryStorage), axios, ioredis, React + Vite, vitest

**Spec:** `docs/superpowers/specs/2026-09-03-ark-agent-file-interaction-design.md`

## Global Constraints

- Base URL：`https://ark.cn-beijing.volces.com/api/v3`
- 禁止引入火山方舟官方 SDK；使用 axios 纯 HTTP
- 文件 `purpose=agent`；单文件最大 **512MB**；multer 内存存储，不落盘
- 挂载：API `mount_path` = `/<basename>`；Agent 提示路径 = `/mnt/session/uploads/<basename>`
- chat 字段：`file_ids`、`inline_file_ids`（须为子集）、可选 `file_names`
- `inline_file_ids` 不合法 → HTTP 400（进 SSE 前）；挂载失败 → SSE error，不发消息
- `download_url` 透传，不做二次代理
- 无会话时 `output-files` 返回空列表，不创建会话
- 日志禁止打印完整 `webUserToken` / `ARK_API_KEY`
- Commit message 用中文 conventional commits；含 TAPD 占位提醒（仅在用户要求提交时执行 commit 步骤）

---

## File Map

| 文件 | 职责 |
|------|------|
| `package.json` | 增加 `multer`、`@types/multer` |
| `src/types/ark.ts` | `ArkFileContentBlock`、Files/Resources 类型；扩展 outbound content |
| `src/utils/mountPath.ts` | basename 消毒、重名后缀、绝对路径拼装 |
| `src/utils/mountPath.test.ts` | 路径工具单测 |
| `src/clients/arkClient.ts` | upload/get/mount/list + 扩展 send body |
| `src/clients/arkClient.test.ts` | body builder / mount body 单测 |
| `src/services/chatService.ts` | 挂载编排、重建后重挂载、扩展 streamChat 入参 |
| `src/services/fileService.ts` | upload / listOutput 编排（鉴权 + 调 ark） |
| `src/routes/agent.ts` | upload-file、output-files、chat 新字段 |
| `web/src/types.ts` | 附件与产物类型；`ChatMessage.attachments` |
| `web/src/api.ts` | upload / output-files / streamChat 扩展 |
| `web/src/components/Composer.tsx` | 附件 UI |
| `web/src/components/OutputFilesBar.tsx` | 产物列表 |
| `web/src/components/MessageItem.tsx` | 展示附件标签 |
| `web/src/App.tsx` | 串联发送与刷新 |
| `web/src/styles.css` | 附件 chip / 产物条样式 |

---

### Task 1: 挂载路径工具 + 类型扩展

**Files:**
- Create: `src/utils/mountPath.ts`
- Create: `src/utils/mountPath.test.ts`
- Modify: `src/types/ark.ts`

**Interfaces:**
- Produces:
  - `sanitizeBasename(originalName: string): string`
  - `allocateMountBasenames(items: Array<{ fileId: string; name: string }>): Map<string, string>`（fileId → basename，处理重名）
  - `sandboxUploadPath(basename: string): string` → `/mnt/session/uploads/${basename}`
  - `arkMountPath(basename: string): string` → `/${basename}`
  - `ArkFileContentBlock { type: 'file'; file_id: string }`
  - `ArkMessageContentBlock = ArkTextContentBlock | ArkFileContentBlock`

- [ ] **Step 1: 写失败单测**

创建 `src/utils/mountPath.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  allocateMountBasenames,
  arkMountPath,
  sandboxUploadPath,
  sanitizeBasename,
} from './mountPath.js';

describe('sanitizeBasename', () => {
  it('strips directories and rejects empty', () => {
    expect(sanitizeBasename('../../a/b/report.pdf')).toBe('report.pdf');
    expect(sanitizeBasename('')).toBe('file');
    expect(sanitizeBasename('...')).toBe('file');
  });
});

describe('allocateMountBasenames', () => {
  it('suffixes colliding names with short file id', () => {
    const map = allocateMountBasenames([
      { fileId: 'file-aaaa1111', name: 'a.pdf' },
      { fileId: 'file-bbbb2222', name: 'a.pdf' },
    ]);
    expect(map.get('file-aaaa1111')).toBe('a.pdf');
    expect(map.get('file-bbbb2222')).toBe('a-bbbb2222.pdf');
  });
});

describe('path helpers', () => {
  it('builds ark and sandbox paths', () => {
    expect(arkMountPath('a.pdf')).toBe('/a.pdf');
    expect(sandboxUploadPath('a.pdf')).toBe('/mnt/session/uploads/a.pdf');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- src/utils/mountPath.test.ts`  
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `mountPath.ts`**

```ts
/** 取安全 basename：去掉路径分隔符与危险片段。 */
export function sanitizeBasename(originalName: string): string {
  const base = originalName.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
  const cleaned = base.replace(/^\.+/, '').trim();
  return cleaned.length > 0 ? cleaned : 'file';
}

function splitNameExt(basename: string): { stem: string; ext: string } {
  const i = basename.lastIndexOf('.');
  if (i <= 0) return { stem: basename, ext: '' };
  return { stem: basename.slice(0, i), ext: basename.slice(i) };
}

function shortIdSuffix(fileId: string): string {
  const raw = fileId.replace(/^file-/, '');
  return raw.slice(-8) || raw || 'dup';
}

/** 同名冲突时第二个起追加短 file_id 后缀。 */
export function allocateMountBasenames(
  items: Array<{ fileId: string; name: string }>,
): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const item of items) {
    let candidate = sanitizeBasename(item.name);
    if (used.has(candidate)) {
      const { stem, ext } = splitNameExt(candidate);
      candidate = `${stem}-${shortIdSuffix(item.fileId)}${ext}`;
      let n = 2;
      while (used.has(candidate)) {
        candidate = `${stem}-${shortIdSuffix(item.fileId)}-${n}${ext}`;
        n += 1;
      }
    }
    used.add(candidate);
    out.set(item.fileId, candidate);
  }
  return out;
}

export function arkMountPath(basename: string): string {
  return `/${basename.replace(/^\/+/, '')}`;
}

export function sandboxUploadPath(basename: string): string {
  return `/mnt/session/uploads/${basename.replace(/^\/+/, '')}`;
}
```

- [ ] **Step 4: 扩展 `src/types/ark.ts`**

在现有 `ArkTextContentBlock` 旁增加：

```ts
export interface ArkFileContentBlock {
  type: 'file';
  file_id: string;
}

export type ArkMessageContentBlock = ArkTextContentBlock | ArkFileContentBlock;
```

将 `ArkOutboundEvent` 的 user.message content 改为 `ArkMessageContentBlock[]`。

新增：

```ts
export interface ArkFileInfo {
  file_id: string;
  name: string;
  size: number;
  download_url?: string;
}

export interface UploadArkFileParams {
  arkApiKey: string;
  arkBaseUrl: string;
  fileBuffer: Buffer;
  originalName: string;
  contentType?: string;
}

export interface MountFileParams {
  arkApiKey: string;
  arkBaseUrl: string;
  sessionId: string;
  fileId: string;
  /** 传给方舟的 mount_path，形如 `/report.pdf` */
  mountPath: string;
  signal?: AbortSignal;
}

export interface ListFilesParams {
  arkApiKey: string;
  arkBaseUrl: string;
  scopeId: string;
  signal?: AbortSignal;
}

export interface GetFileParams {
  arkApiKey: string;
  arkBaseUrl: string;
  fileId: string;
  signal?: AbortSignal;
}
```

更新 `SendEventParams`：

```ts
export interface SendEventParams {
  arkApiKey: string;
  arkBaseUrl: string;
  sessionId: string;
  userMessage: string;
  mountedPaths?: string[];
  inlineFileIds?: string[];
  signal?: AbortSignal;
}
```

- [ ] **Step 5: 跑通路径单测**

Run: `npm test -- src/utils/mountPath.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit（仅当用户要求提交时）**

```bash
git add src/utils/mountPath.ts src/utils/mountPath.test.ts src/types/ark.ts
git commit -m "$(cat <<'EOF'
feat: 新增文件挂载路径工具与 Ark 文件类型 --story=请替换@tapd-请替换

[请在此处粘贴 TAPD 需求/缺陷/任务 ID。获取方式：在 TAPD 页面点击「链接 -> 复制源码关键字」]
[如代码已全部提交，可在 TAPD ID 后添加这些指令来更新 TAPD 状态：#fix / #fixed / #finish / #finished / #close / #closed]
EOF
)"
```

---

### Task 2: arkClient 文件 API 与消息 body 扩展

**Files:**
- Modify: `src/clients/arkClient.ts`
- Modify: `src/clients/arkClient.test.ts`

**Interfaces:**
- Consumes: Task 1 类型与路径约定
- Produces:
  - `buildSendSessionEventsBody(input: { userMessage: string; mountedPaths?: string[]; inlineFileIds?: string[] }): SendSessionEventsRequestBody`
  - `buildMountFileBody(fileId: string, mountPath: string): { type: 'file'; file_id: string; mount_path: string }`
  - `uploadArkFile(params): Promise<ArkFileInfo>`
  - `getArkFile(params): Promise<ArkFileInfo>`
  - `mountFileToSession(params): Promise<void>`
  - `listSessionOutputFiles(params): Promise<ArkFileInfo[]>`
  - `normalizeArkFile(raw: unknown): ArkFileInfo | null`（内部可导出供测）

- [ ] **Step 1: 扩展失败单测（改现有 buildSend 测试 + 新用例）**

在 `arkClient.test.ts` 更新 `buildSendSessionEventsBody` 调用签名，并新增：

```ts
describe('buildSendSessionEventsBody with files', () => {
  it('appends mount path hint and file blocks', () => {
    const body = buildSendSessionEventsBody({
      userMessage: '分析',
      mountedPaths: ['/mnt/session/uploads/a.pdf'],
      inlineFileIds: ['file-1'],
    });
    const content = body.events[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'text', text: '分析' });
    expect(content[1]).toMatchObject({ type: 'text' });
    expect(String((content[1] as { text: string }).text)).toContain('/mnt/session/uploads/a.pdf');
    expect(content[2]).toEqual({ type: 'file', file_id: 'file-1' });
  });
});

describe('buildMountFileBody', () => {
  it('matches Ark session resources shape', () => {
    expect(buildMountFileBody('file-1', '/a.pdf')).toEqual({
      type: 'file',
      file_id: 'file-1',
      mount_path: '/a.pdf',
    });
  });
});
```

把原有 `buildSendSessionEventsBody('你好')` 改为 `buildSendSessionEventsBody({ userMessage: '你好' })`。

- [ ] **Step 2: 跑测确认新用例失败 / 旧用例因签名失败**

Run: `npm test -- src/clients/arkClient.test.ts`  
Expected: FAIL

- [ ] **Step 3: 实现 body builders + 文件 API**

替换 `buildSendSessionEventsBody`：

```ts
export function buildSendSessionEventsBody(input: {
  userMessage: string;
  mountedPaths?: string[];
  inlineFileIds?: string[];
}): SendSessionEventsRequestBody {
  const content: ArkMessageContentBlock[] = [{ type: 'text', text: input.userMessage }];
  const paths = input.mountedPaths?.filter((p) => p.trim().length > 0) ?? [];
  if (paths.length > 0) {
    content.push({
      type: 'text',
      text: `已挂载到会话沙箱的文件：\n${paths.map((p) => `- ${p}`).join('\n')}`,
    });
  }
  for (const fileId of input.inlineFileIds ?? []) {
    if (fileId.trim()) content.push({ type: 'file', file_id: fileId.trim() });
  }
  return {
    events: [{ type: 'user.message', content }],
  };
}

export function buildMountFileBody(fileId: string, mountPath: string) {
  return { type: 'file' as const, file_id: fileId, mount_path: mountPath };
}
```

更新 `sendSessionEvent` 使用：

```ts
buildSendSessionEventsBody({
  userMessage: params.userMessage,
  mountedPaths: params.mountedPaths,
  inlineFileIds: params.inlineFileIds,
})
```

实现归一化与四个 API（Node 18+ 原生 `FormData` + `Blob`）：

```ts
export function normalizeArkFile(raw: unknown): ArkFileInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const file_id =
    (typeof o.id === 'string' && o.id) ||
    (typeof o.file_id === 'string' && o.file_id) ||
    '';
  const name =
    (typeof o.filename === 'string' && o.filename) ||
    (typeof o.name === 'string' && o.name) ||
    file_id;
  const sizeRaw = o.bytes ?? o.size ?? o.size_bytes;
  const size = typeof sizeRaw === 'number' ? sizeRaw : Number(sizeRaw);
  if (!file_id) return null;
  const download_url =
    typeof o.download_url === 'string'
      ? o.download_url
      : typeof o.url === 'string'
        ? o.url
        : undefined;
  return {
    file_id,
    name,
    size: Number.isFinite(size) ? size : 0,
    ...(download_url ? { download_url } : {}),
  };
}

export async function uploadArkFile(params: UploadArkFileParams): Promise<ArkFileInfo> {
  try {
    const form = new FormData();
    form.append('purpose', 'agent');
    const blob = new Blob([params.fileBuffer], {
      type: params.contentType || 'application/octet-stream',
    });
    form.append('file', blob, params.originalName);
    const res = await axios.post(`${params.arkBaseUrl}/files`, form, {
      headers: { Authorization: `Bearer ${params.arkApiKey}` },
      timeout: NO_TIMEOUT,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    const info = normalizeArkFile(res.data);
    if (!info) throw new ArkApiError('Upload file response missing id');
    return info;
  } catch (err) {
    throw toArkError(err);
  }
}

export async function getArkFile(params: GetFileParams): Promise<ArkFileInfo> {
  try {
    const res = await axios.get(
      `${params.arkBaseUrl}/files/${encodeURIComponent(params.fileId)}`,
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT, signal: params.signal },
    );
    const info = normalizeArkFile(res.data);
    if (!info) throw new ArkApiError('Get file response missing id');
    return info;
  } catch (err) {
    throw toArkError(err);
  }
}

export async function mountFileToSession(params: MountFileParams): Promise<void> {
  try {
    await axios.post(
      `${params.arkBaseUrl}/sessions/${encodeURIComponent(params.sessionId)}/resources`,
      buildMountFileBody(params.fileId, params.mountPath),
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT, signal: params.signal },
    );
  } catch (err) {
    throw toArkError(err);
  }
}

export async function listSessionOutputFiles(params: ListFilesParams): Promise<ArkFileInfo[]> {
  try {
    const res = await axios.get(`${params.arkBaseUrl}/files`, {
      headers: authHeaders(params.arkApiKey),
      timeout: NO_TIMEOUT,
      signal: params.signal,
      params: { scope_id: params.scopeId },
    });
    const data = res.data;
    const list = Array.isArray(data)
      ? data
      : data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data)
        ? (data as { data: unknown[] }).data
        : [];
    return list.map(normalizeArkFile).filter((x): x is ArkFileInfo => x != null);
  } catch (err) {
    throw toArkError(err);
  }
}
```

注意：`FormData.append` 第三参文件名在 Node 的 Blob 场景下，若类型报错，改用 `File`：`new File([buffer], originalName, { type })`。

- [ ] **Step 4: 跑通 arkClient 单测**

Run: `npm test -- src/clients/arkClient.test.ts`  
Expected: PASS

- [ ] **Step 5: 全量单测回归**

Run: `npm test`  
Expected: PASS

---

### Task 3: FileService + upload-file / output-files 路由

**Files:**
- Modify: `package.json`（安装 multer）
- Create: `src/services/fileService.ts`
- Modify: `src/routes/agent.ts`
- Modify: `src/app.ts`（若需注入 FileService）
- Modify: `src/server.ts`

**Interfaces:**
- Produces:
  - `FileService.uploadUserFile(webUserToken, file: { buffer, originalname, mimetype, size })`
  - `FileService.listOutputFiles(webUserToken)`
  - `POST /api/agent/upload-file`
  - `GET /api/agent/output-files`

- [ ] **Step 1: 安装依赖**

```bash
npm install multer
npm install -D @types/multer
```

- [ ] **Step 2: 实现 `fileService.ts`**

```ts
import { ArkApiError, listSessionOutputFiles, uploadArkFile } from '../clients/arkClient.js';
import type { AppConfig } from '../config.js';
import type { ArkFileInfo } from '../types/ark.js';
import { SessionService } from './sessionService.js';

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

export class FileService {
  constructor(
    private readonly config: AppConfig,
    private readonly sessionService: SessionService,
  ) {}

  async uploadUserFile(
    webUserToken: string,
    file: { buffer: Buffer; originalname: string; mimetype?: string; size: number },
  ): Promise<ArkFileInfo> {
    if (!webUserToken.trim()) {
      throw new ArkApiError('webUserToken is required', { code: 'BAD_REQUEST', status: 400 });
    }
    if (!file?.buffer?.length) {
      throw new ArkApiError('file is required', { code: 'BAD_REQUEST', status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new ArkApiError('文件过大，最大 512MB', { code: 'FILE_TOO_LARGE', status: 413 });
    }
    return uploadArkFile({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      fileBuffer: file.buffer,
      originalName: file.originalname || 'file',
      contentType: file.mimetype,
    });
  }

  async listOutputFiles(
    webUserToken: string,
  ): Promise<{ sessionId: string | null; files: ArkFileInfo[] }> {
    const session = await this.sessionService.getExistingSession(webUserToken);
    if (!session) return { sessionId: null, files: [] };
    const files = await listSessionOutputFiles({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      scopeId: session.sessionId,
    });
    return { sessionId: session.sessionId, files };
  }
}
```

注意：`ArkApiError` 构造函数若尚无 `status` 透传使用，确认已有 `status?` 字段（现有已有）。

- [ ] **Step 3: 路由接入 multer 与新接口**

在 `createAgentRouter` deps 增加 `fileService: FileService`。

```ts
import multer from 'multer';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 * 1024 },
});
```

`POST /upload-file`：

```ts
router.post('/upload-file', (req, res, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '文件过大，最大 512MB' });
    }
    if (err) return res.status(400).json({ error: err instanceof Error ? err.message : '上传失败' });
    return next();
  });
}, async (req, res) => {
  const token =
    (typeof req.body?.webUserToken === 'string' && req.body.webUserToken.trim()) ||
    '';
  if (!token) return res.status(400).json({ error: 'webUserToken is required' });
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  try {
    const info = await deps.fileService.uploadUserFile(token, req.file);
    return res.status(200).json({
      file_id: info.file_id,
      name: info.name,
      size: info.size,
    });
  } catch (err) {
    const arkErr = err instanceof ArkApiError ? err : null;
    const status = arkErr?.status === 413 ? 413 : arkErr?.status === 400 ? 400 : 502;
    return res.status(status).json({
      error: err instanceof Error ? err.message : '文件上传失败',
    });
  }
});
```

`GET /output-files`：

```ts
router.get('/output-files', async (req, res) => {
  const tokenErr = requireNonEmptyString(req.query?.webUserToken, 'webUserToken');
  if (tokenErr) return res.status(400).json({ error: tokenErr });
  try {
    const result = await deps.fileService.listOutputFiles(String(req.query.webUserToken).trim());
    return res.status(200).json({
      ok: true,
      sessionId: result.sessionId,
      files: result.files.map((f) => ({
        file_id: f.file_id,
        name: f.name,
        size: f.size,
        download_url: f.download_url ?? null,
      })),
    });
  } catch (err) {
    return res.status(503).json({
      error: err instanceof Error ? err.message : 'List output files failed',
    });
  }
});
```

- [ ] **Step 4: 接线 `app.ts` / `server.ts`**

`createApp` deps 增加 `fileService`，传给 `createAgentRouter`。  
`server.ts`：`const fileService = new FileService(config, sessionService)`。

- [ ] **Step 5: `tsc` / 测试**

Run: `npm test && npx tsc --noEmit`  
Expected: PASS

---

### Task 4: ChatService 挂载编排 + chat 路由字段

**Files:**
- Modify: `src/services/chatService.ts`
- Modify: `src/routes/agent.ts`（chat 入参校验）

**Interfaces:**
- Consumes: `mountFileToSession`、`getArkFile`、`allocateMountBasenames`、`arkMountPath`、`sandboxUploadPath`
- Produces: `streamChat(res, { webUserToken, userMessage, fileIds?, inlineFileIds?, fileNames? })`

- [ ] **Step 1: 在 `ChatService` 增加解析文件名与挂载私有方法**

```ts
private async resolveFileName(
  fileId: string,
  fileNames: Record<string, string> | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const fromClient = fileNames?.[fileId]?.trim();
  if (fromClient) return fromClient;
  const info = await getArkFile({
    arkApiKey: this.config.arkApiKey,
    arkBaseUrl: this.config.arkBaseUrl,
    fileId,
    signal,
  });
  return info.name || fileId;
}

private async mountFilesToSession(
  sessionId: string,
  fileIds: string[],
  fileNames: Record<string, string> | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  const named = [];
  for (const fileId of fileIds) {
    const name = await this.resolveFileName(fileId, fileNames, signal);
    named.push({ fileId, name });
  }
  const basenames = allocateMountBasenames(named);
  const sandboxPaths: string[] = [];
  for (const { fileId } of named) {
    const basename = basenames.get(fileId)!;
    await mountFileToSession({
      arkApiKey: this.config.arkApiKey,
      arkBaseUrl: this.config.arkBaseUrl,
      sessionId,
      fileId,
      mountPath: arkMountPath(basename),
      signal,
    });
    sandboxPaths.push(sandboxUploadPath(basename));
  }
  return sandboxPaths;
}
```

- [ ] **Step 2: 改造 `streamOnce` / `streamChat`**

`streamOnce` 增加参数：`mountedPaths?: string[]; inlineFileIds?: string[]`，传给 `sendSessionEvent`。

`streamChat` 入参：

```ts
input: {
  webUserToken: string;
  userMessage: string;
  fileIds?: string[];
  inlineFileIds?: string[];
  fileNames?: Record<string, string>;
}
```

逻辑：

1. `getOrCreateSession`
2. `initSse`
3. 循环 attempt：
   - 若有 `fileIds`：先 `mountFilesToSession`（失败 → SSE error 并 return）
   - 再 `streamOnce(..., { mountedPaths, inlineFileIds })`
   - session_not_found 重建后 **continue 会再次 mount**（因挂在新 session）

- [ ] **Step 3: chat 路由校验**

解析并校验：

```ts
function parseStringArray(value: unknown): string[] | null {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  if (!value.every((x) => typeof x === 'string' && x.trim())) return null;
  return value.map((x) => (x as string).trim());
}

function parseFileNames(value: unknown): Record<string, string> | null {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== 'string' || !v.trim()) return null;
    out[k] = v.trim();
  }
  return out;
}
```

在 `/chat`：

- `file_ids` / `inline_file_ids` 非法 → 400
- `inline` 中每个 id 必须 ∈ `file_ids`，否则 400：`inline_file_ids must be a subset of file_ids`
- 传给 `streamChat`

- [ ] **Step 4: 回归测试**

Run: `npm test && npx tsc --noEmit`  
Expected: PASS

---

### Task 5: 前端 API 与类型

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`

**Interfaces:**
- Produces:
  - `uploadAgentFile(webUserToken, file): Promise<{ file_id, name, size }>`
  - `fetchOutputFiles(webUserToken): Promise<{ sessionId, files }>`
  - `StreamChatParams` 增加 `file_ids?` / `inline_file_ids?` / `file_names?`
  - `ChatMessage.attachments?: Array<{ file_id: string; name: string; inline?: boolean }>`
  - `OutputFileItem { file_id, name, size, download_url: string | null }`

- [ ] **Step 1: 扩展 types**

```ts
export interface ChatAttachment {
  file_id: string;
  name: string;
  inline?: boolean;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  code?: string;
  attachments?: ChatAttachment[];
}

export interface OutputFileItem {
  file_id: string;
  name: string;
  size: number;
  download_url: string | null;
}

export interface OutputFilesResult {
  ok: true;
  sessionId: string | null;
  files: OutputFileItem[];
}

export interface UploadFileResult {
  file_id: string;
  name: string;
  size: number;
}
```

- [ ] **Step 2: api 函数**

```ts
export async function uploadAgentFile(
  webUserToken: string,
  file: File,
  signal?: AbortSignal,
): Promise<UploadFileResult> {
  const form = new FormData();
  form.append('webUserToken', webUserToken);
  form.append('file', file);
  const res = await fetch('/api/agent/upload-file', { method: 'POST', body: form, signal });
  if (!res.ok) throw new ApiError(res.status, await readJsonError(res, `上传失败 (${res.status})`));
  const body: unknown = await res.json();
  if (
    !isRecord(body) ||
    typeof body.file_id !== 'string' ||
    typeof body.name !== 'string' ||
    typeof body.size !== 'number'
  ) {
    throw new ApiError(res.status, '上传响应格式异常');
  }
  return { file_id: body.file_id, name: body.name, size: body.size };
}

export async function fetchOutputFiles(
  webUserToken: string,
  signal?: AbortSignal,
): Promise<OutputFilesResult> {
  const params = new URLSearchParams({ webUserToken });
  const res = await fetch(`/api/agent/output-files?${params}`, { signal });
  if (!res.ok) throw new ApiError(res.status, await readJsonError(res, `拉取产物失败 (${res.status})`));
  const body: unknown = await res.json();
  // 校验 ok / files 数组字段后返回
}
```

`streamChat` body 增加可选字段（仅当数组非空时写入）。

- [ ] **Step 3: 前端 typecheck**

Run: `cd web && npx tsc --noEmit`  
Expected: PASS（若尚无引用新 API，应仍通过）

---

### Task 6: Composer + OutputFilesBar + App 串联

**Files:**
- Modify: `web/src/components/Composer.tsx`
- Create: `web/src/components/OutputFilesBar.tsx`
- Modify: `web/src/components/MessageItem.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Composer `onSend(text, payload: { file_ids: string[]; inline_file_ids: string[]; file_names: Record<string, string>; attachments: ChatAttachment[] })`
- 默认 inline MIME：`image/*`、`application/pdf`、`text/plain`、`text/markdown`、`application/msword`、`application/vnd.openxmlformats-officedocument.*`

- [ ] **Step 1: 实现 Composer 附件状态机**

本地状态：`PendingAttachment { localId, file, status: 'uploading'|'ready'|'error', file_id?, name, size?, inline, error? }`

- 选文件 → 立即 upload
- chip 显示状态 / 移除 / 勾选「模型直读」
- `canSend`：有文本或有就绪附件；且无 uploading；且非 streaming
- submit 时只带 `status==='ready'` 的附件

默认 inline：

```ts
function defaultInline(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  if (file.type === 'application/pdf') return true;
  if (file.type === 'text/plain' || file.type === 'text/markdown') return true;
  if (file.type === 'application/msword') return true;
  if (file.type.startsWith('application/vnd.openxmlformats-officedocument.')) return true;
  return false;
}
```

`webUserToken` 需作为 Composer props 传入以便上传。

- [ ] **Step 2: OutputFilesBar**

Props：`token`、`disabled`、`refreshToken`（number，App 在 done 后 +1）

内部：折叠、刷新、列表、下载链接 `target="_blank" rel="noreferrer"`。

- [ ] **Step 3: MessageItem 展示 attachments**

用户气泡下渲染小标签列表。

- [ ] **Step 4: App 串联**

- `handleSend` 接收附件 payload，写入 user message `attachments`
- `streamChat` 传 `file_ids` / `inline_file_ids` / `file_names`
- `done` 后 `setOutputRefreshKey(k => k+1)`
- 布局：`MessageList` → `OutputFilesBar` → `Composer`

- [ ] **Step 5: styles**

在现有 CSS 变量下增加：

- `.composer__attach` / `.composer__chips` / `.chip` / `.chip--error`
- `.output-files` / `.output-files__list` / `.output-files__item`
- `.bubble__attachments`

保持现有火山暗色风格，避免新设计语言。

- [ ] **Step 6: 前后端类型检查与单测**

```bash
npm test
npx tsc --noEmit
cd web && npx tsc --noEmit
```

Expected: 全部 PASS

---

### Task 7: curl 示例落到 README 附录（或路由注释）

**Files:**
- Modify: `README.md`（若存在）或 spec 已有 curl——在 `README.md` 追加「文件交互」小节

- [ ] **Step 1: 写入与 spec §8 一致的三条 curl**（upload / chat / output-files）
- [ ] **Step 2: 本地手测清单**（执行者勾选）
  - 上传 PDF → 返回 file_id
  - chat 仅 mount → Agent 能读 `/mnt/session/uploads/...`
  - chat + inline → 模型能总结 PDF/图片
  - Agent 写 `/mnt/session/outputs/` → output-files 出现 download_url
  - 无文件 chat / interrupt / rebuild 仍正常

---

## Spec Coverage Checklist

| Spec 要求 | Task |
|-----------|------|
| upload-file + multer 内存 + purpose=agent | Task 3 |
| chat file_ids 挂载 | Task 4 |
| inline_file_ids 消息 file block | Task 2 + 4 |
| file_names / getArkFile 回退 | Task 4 |
| output-files + download_url 透传 | Task 3 |
| 鉴权防越权 | Task 3–4（均经 token→session） |
| 重建会话重挂载 | Task 4 |
| Composer 内嵌 + 直读勾选 | Task 6 |
| 产物条 + done 刷新 | Task 6 |
| 路径工具 / body 单测 | Task 1–2 |
| curl 示例 | Task 7 |
| 不做删除/自定义 mount_path/进度条 | 全局约束（无对应 task） |

---

## Self-Review Notes

- `buildSendSessionEventsBody` 签名变更会影响旧测试——Task 2 已要求同步修改
- `ArkApiError` 的 `status` 已存在，FileService 可直接用
- Node `FormData.append(blob, filename)`：若运行时忽略文件名，改用 `File`
- 提交步骤默认跳过，除非用户明确要求 commit
