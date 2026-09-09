import type {
  ChatMessage,
  DeleteVaultResult,
  NormalizedSseEvent,
  OutputFileItem,
  OutputFilesResult,
  RebuildSessionResult,
  SessionMessagesResult,
  UploadFileResult,
} from './types';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 将未知 JSON 收敛为契约内的四种（含 tool）SSE 事件；非法 payload 丢弃。 */
export function parseNormalizedEvent(raw: unknown): NormalizedSseEvent | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;

  if (raw.type === 'delta' && typeof raw.text === 'string') {
    return { type: 'delta', text: raw.text };
  }
  if (
    raw.type === 'error' &&
    typeof raw.code === 'string' &&
    typeof raw.message === 'string'
  ) {
    return { type: 'error', code: raw.code, message: raw.message };
  }
  if (raw.type === 'done') {
    return { type: 'done' };
  }
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
  return null;
}

/**
 * 从累积缓冲区中按 `\n\n` 切出完整 SSE 帧。
 * 只读取 `data:` 行（后端不写 `event:`）。
 */
export function consumeSseBuffer(buffer: string): {
  events: NormalizedSseEvent[];
  rest: string;
} {
  const frames = buffer.split('\n\n');
  const rest = frames.pop() ?? '';
  const events: NormalizedSseEvent[] = [];

  for (const frame of frames) {
    const event = parseSseFrame(frame);
    if (event) events.push(event);
  }

  return { events, rest };
}

function parseSseFrame(frame: string): NormalizedSseEvent | null {
  const lines = frame.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (!payload) continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      const event = parseNormalizedEvent(parsed);
      if (event) return event;
    } catch {
      // 单帧损坏则跳过，继续读后续帧
    }
  }
  return null;
}

async function readJsonError(res: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (isRecord(body) && typeof body.error === 'string') {
      return body.error;
    }
  } catch {
    // 非 JSON 错误体时使用 fallback
  }
  return fallback;
}

export async function fetchHealth(signal?: AbortSignal): Promise<boolean> {
  const res = await fetch('/health', { signal });
  if (!res.ok) return false;
  const body: unknown = await res.json();
  return isRecord(body) && body.ok === true;
}

export async function rebuildSession(
  webUserToken: string,
  signal?: AbortSignal,
): Promise<RebuildSessionResult> {
  const res = await fetch('/api/agent/rebuild-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webUserToken }),
    signal,
  });

  if (!res.ok) {
    throw new ApiError(res.status, await readJsonError(res, `重建会话失败 (${res.status})`));
  }

  const body: unknown = await res.json();
  if (
    !isRecord(body) ||
    body.ok !== true ||
    typeof body.tokenHash !== 'string' ||
    typeof body.sessionId !== 'string'
  ) {
    throw new ApiError(res.status, '重建会话响应格式异常');
  }

  return {
    ok: true,
    tokenHash: body.tokenHash,
    sessionId: body.sessionId,
    ...(typeof body.vaultId === 'string' ? { vaultId: body.vaultId } : {}),
  };
}

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

export async function interruptSession(
  webUserToken: string,
  signal?: AbortSignal,
): Promise<{ ok: true; sessionId: string }> {
  const res = await fetch('/api/agent/interrupt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webUserToken }),
    signal,
  });

  if (!res.ok) {
    throw new ApiError(res.status, await readJsonError(res, `中止对话失败 (${res.status})`));
  }

  const body: unknown = await res.json();
  if (!isRecord(body) || body.ok !== true || typeof body.sessionId !== 'string') {
    throw new ApiError(res.status, '中止对话响应格式异常');
  }

  return { ok: true, sessionId: body.sessionId };
}

export async function fetchSessionMessages(
  webUserToken: string,
  signal?: AbortSignal,
  limit?: number,
): Promise<SessionMessagesResult> {
  const params = new URLSearchParams({ webUserToken });
  if (limit != null) params.set('limit', String(limit));
  const res = await fetch(`/api/agent/messages?${params.toString()}`, { signal });

  if (!res.ok) {
    throw new ApiError(res.status, await readJsonError(res, `拉取会话消息失败 (${res.status})`));
  }

  const body: unknown = await res.json();
  if (!isRecord(body) || body.ok !== true || !Array.isArray(body.messages)) {
    throw new ApiError(res.status, '会话消息响应格式异常');
  }
  if (body.sessionId != null && typeof body.sessionId !== 'string') {
    throw new ApiError(res.status, '会话消息响应格式异常');
  }

  const messages: ChatMessage[] = [];
  for (const item of body.messages) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.content !== 'string') continue;
    if (item.role !== 'user' && item.role !== 'agent') continue;
    messages.push({ id: item.id, role: item.role, content: item.content });
  }

  return {
    ok: true,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
    messages,
  };
}

export async function uploadAgentFile(
  webUserToken: string,
  file: File,
  signal?: AbortSignal,
): Promise<UploadFileResult> {
  const form = new FormData();
  form.append('webUserToken', webUserToken);
  form.append('file', file);
  const res = await fetch('/api/agent/upload-file', { method: 'POST', body: form, signal });
  if (!res.ok) {
    throw new ApiError(res.status, await readJsonError(res, `上传失败 (${res.status})`));
  }
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
  if (!res.ok) {
    throw new ApiError(res.status, await readJsonError(res, `拉取产物失败 (${res.status})`));
  }
  const body: unknown = await res.json();
  if (!isRecord(body) || body.ok !== true || !Array.isArray(body.files)) {
    throw new ApiError(res.status, '产物列表响应格式异常');
  }
  if (body.sessionId != null && typeof body.sessionId !== 'string') {
    throw new ApiError(res.status, '产物列表响应格式异常');
  }

  const files: OutputFileItem[] = [];
  for (const item of body.files) {
    if (
      !isRecord(item) ||
      typeof item.file_id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.size !== 'number'
    ) {
      continue;
    }
    const downloadUrl = item.download_url;
    if (downloadUrl != null && typeof downloadUrl !== 'string') continue;
    files.push({
      file_id: item.file_id,
      name: item.name,
      size: item.size,
      download_url: typeof downloadUrl === 'string' ? downloadUrl : null,
    });
  }

  return {
    ok: true,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
    files,
  };
}

export interface StreamChatParams {
  webUserToken: string;
  userMessage: string;
  file_ids?: string[];
  inline_file_ids?: string[];
  file_names?: Record<string, string>;
  signal?: AbortSignal;
  onEvent: (event: NormalizedSseEvent) => void;
}

/**
 * POST 流式对话。不能用 EventSource（仅支持 GET）。
 * 用 fetch + ReadableStream 手动 UTF-8 解码，再按 `\n\n` 分包。
 */
export async function streamChat(params: StreamChatParams): Promise<void> {
  const payload: Record<string, unknown> = {
    webUserToken: params.webUserToken,
    userMessage: params.userMessage,
  };
  if (params.file_ids != null && params.file_ids.length > 0) {
    payload.file_ids = params.file_ids;
  }
  if (params.inline_file_ids != null && params.inline_file_ids.length > 0) {
    payload.inline_file_ids = params.inline_file_ids;
  }
  if (params.file_names != null && Object.keys(params.file_names).length > 0) {
    payload.file_names = params.file_names;
  }

  const res = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: params.signal,
  });

  if (!res.ok) {
    throw new ApiError(res.status, await readJsonError(res, `对话请求失败 (${res.status})`));
  }

  if (!res.body) {
    throw new ApiError(res.status, '响应体为空，无法读取 SSE 流');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const consumed = consumeSseBuffer(buffer);
      buffer = consumed.rest;
      for (const event of consumed.events) {
        params.onEvent(event);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const consumed = consumeSseBuffer(`${buffer}\n\n`);
      for (const event of consumed.events) {
        params.onEvent(event);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
