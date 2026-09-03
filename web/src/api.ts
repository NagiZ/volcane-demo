import type { NormalizedSseEvent, RebuildSessionResult } from './types';

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

/** 将未知 JSON 收敛为契约内的三种 SSE 事件；非法 payload 丢弃。 */
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
  };
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

export interface StreamChatParams {
  webUserToken: string;
  userMessage: string;
  signal?: AbortSignal;
  onEvent: (event: NormalizedSseEvent) => void;
}

/**
 * POST 流式对话。不能用 EventSource（仅支持 GET）。
 * 用 fetch + ReadableStream 手动 UTF-8 解码，再按 `\n\n` 分包。
 */
export async function streamChat(params: StreamChatParams): Promise<void> {
  const res = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webUserToken: params.webUserToken,
      userMessage: params.userMessage,
    }),
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
