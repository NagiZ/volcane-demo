import axios, { AxiosError, type AxiosResponse } from 'axios';
import type { Readable } from 'node:stream';
import type {
  CreateSessionParams,
  CreateSessionResponse,
  ListSessionEventsParams,
  ListSessionEventsResponse,
  SendEventParams,
  SendSessionEventsRequestBody,
  SendSessionEventsResponse,
  ArkSessionEvent,
} from '../types/ark.js';

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

/** axios `timeout: 0` 表示不限制；长对话由 AbortSignal / 连接断开收口。 */
const NO_TIMEOUT = 0;

function authHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function readArkErrorPayload(data: unknown): { message: string; code?: string } {
  if (!data || typeof data !== 'object') {
    return { message: 'Unknown ark error' };
  }
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
    if (err.code === 'ERR_CANCELED' || err.name === 'CanceledError') {
      return new ArkApiError('Request aborted', { code: 'ABORTED' });
    }
    const status = err.response?.status;
    const { message, code } = readArkErrorPayload(err.response?.data);
    const lower = `${message} ${code ?? ''}`.toLowerCase();
    const isSessionNotFound =
      status === 404 ||
      lower.includes('session_not_found') ||
      (lower.includes('session') && (lower.includes('not found') || lower.includes('不存在')));
    return new ArkApiError(message, { status, code, isSessionNotFound });
  }
  return new ArkApiError(err instanceof Error ? err.message : 'Unknown ark error');
}

/** 构造创建 Session 请求体（便于单测断言字段名） */
export function buildCreateSessionBody(params: CreateSessionParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    agent: params.agentId,
    environment: {
      type: 'environment_with_overrides',
      id: params.baseEnvironmentId,
      config: {
        env: {
          USER_ID: params.userId,
          USER_BEARER_TOKEN: params.userBearerToken,
          // 前端输入的 token 作为 Agent 启动时的密钥
          LEYO_AGENT_KEY: params.userBearerToken,
        },
      },
    },
  };
  if (params.sessionId) body.id = params.sessionId;
  return body;
}

/** 构造发送事件请求体：官方要求 events 数组包裹 */
export function buildSendSessionEventsBody(userMessage: string): SendSessionEventsRequestBody {
  return {
    events: [
      {
        type: 'user.message',
        content: [{ type: 'text', text: userMessage }],
      },
    ],
  };
}

/** 构造中止事件请求体。官方：执行中发送 `user.interrupt` 暂停 Agent。 */
export function buildSendInterruptBody(): SendSessionEventsRequestBody {
  return {
    events: [{ type: 'user.interrupt' }],
  };
}

/** 创建 Ark Managed Agent Session（environment_with_overrides 全量 env） */
export async function createArkSession(params: CreateSessionParams): Promise<{ sessionId: string }> {
  try {
    const res = await axios.post<CreateSessionResponse>(
      `${params.arkBaseUrl}/sessions`,
      buildCreateSessionBody(params),
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT },
    );
    if (!res.data?.id) throw new ArkApiError('Create session response missing id');
    return { sessionId: res.data.id };
  } catch (err) {
    throw toArkError(err);
  }
}

/** 方舟列表默认只返回前 50 条；单页上限实测为 200。 */
export const SESSION_EVENTS_PAGE_LIMIT = 200;
const SESSION_EVENTS_MAX_PAGES = 100;

export interface SessionEventsPage {
  events: ArkSessionEvent[];
  nextPage?: string | null;
}

/**
 * 跟随 next_page 拉完全量事件。
 * 长任务的 agent.message / session.status_idle 常落在第二页及以后；
 * 只读首页时轮询会永远看不到结束，Web 卡在「正在输入…」。
 */
export async function collectPagedSessionEvents(
  fetchPage: (cursor?: string) => Promise<SessionEventsPage>,
  options?: { maxPages?: number },
): Promise<ArkSessionEvent[]> {
  const maxPages = options?.maxPages ?? SESSION_EVENTS_MAX_PAGES;
  const all: ArkSessionEvent[] = [];
  let cursor: string | undefined;

  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(cursor);
    all.push(...(page.events ?? []));
    const next = page.nextPage;
    if (!next) return all;
    cursor = next;
  }

  return all;
}

function normalizeEventsPage(data: ListSessionEventsResponse | ArkSessionEvent[]): SessionEventsPage {
  if (Array.isArray(data)) {
    return { events: data, nextPage: null };
  }
  const next = typeof data.next_page === 'string' && data.next_page.length > 0 ? data.next_page : null;
  return { events: data.data ?? [], nextPage: next };
}

/** 查询会话事件列表（JSON）— 官方「查询会话事件列表」；自动翻页。 */
export async function listSessionEvents(params: ListSessionEventsParams): Promise<ArkSessionEvent[]> {
  try {
    return await collectPagedSessionEvents(async (cursor) => {
      const res = await axios.get<ListSessionEventsResponse | ArkSessionEvent[]>(
        `${params.arkBaseUrl}/sessions/${encodeURIComponent(params.sessionId)}/events`,
        {
          headers: authHeaders(params.arkApiKey),
          timeout: NO_TIMEOUT,
          signal: params.signal,
          params: {
            limit: SESSION_EVENTS_PAGE_LIMIT,
            ...(cursor ? { page: cursor } : {}),
          },
        },
      );
      return normalizeEventsPage(res.data);
    });
  } catch (err) {
    throw toArkError(err);
  }
}

/**
 * 向 Session 发送用户消息（投递确认 JSON，非 SSE）。
 * 官方「发送会话事件」：body 必须为 { events: [...] }。
 */
export async function sendSessionEvent(params: SendEventParams): Promise<SendSessionEventsResponse> {
  try {
    const res = await axios.post<SendSessionEventsResponse>(
      `${params.arkBaseUrl}/sessions/${encodeURIComponent(params.sessionId)}/events`,
      buildSendSessionEventsBody(params.userMessage),
      {
        headers: authHeaders(params.arkApiKey),
        timeout: NO_TIMEOUT,
        signal: params.signal,
      },
    );
    return res.data;
  } catch (err) {
    throw toArkError(err);
  }
}

/**
 * 向 Session 发送 user.interrupt，暂停正在执行的 Agent。
 * 官方「发送会话事件」；投递后须等 session.status_idle 才算停稳。
 */
export async function sendSessionInterrupt(
  params: Omit<SendEventParams, 'userMessage'>,
): Promise<SendSessionEventsResponse> {
  try {
    const res = await axios.post<SendSessionEventsResponse>(
      `${params.arkBaseUrl}/sessions/${encodeURIComponent(params.sessionId)}/events`,
      buildSendInterruptBody(),
      {
        headers: authHeaders(params.arkApiKey),
        timeout: NO_TIMEOUT,
        signal: params.signal,
      },
    );
    return res.data;
  } catch (err) {
    throw toArkError(err);
  }
}

/**
 * 尝试流式获取会话事件（官方「流式获取会话事件」）。
 * 若上游返回非 SSE，返回 null，由调用方回退到轮询。
 */
export async function tryStreamSessionEvents(
  params: ListSessionEventsParams,
): Promise<NodeJS.ReadableStream | null> {
  try {
    const res: AxiosResponse<NodeJS.ReadableStream> = await axios.get(
      `${params.arkBaseUrl}/sessions/${encodeURIComponent(params.sessionId)}/events`,
      {
        headers: {
          ...authHeaders(params.arkApiKey),
          Accept: 'text/event-stream',
        },
        responseType: 'stream',
        timeout: NO_TIMEOUT,
        signal: params.signal,
        validateStatus: (status) => status >= 200 && status < 300,
      },
    );
    const contentType = String(res.headers['content-type'] ?? '');
    if (!contentType.includes('text/event-stream')) {
      (res.data as Readable).destroy?.();
      return null;
    }
    return res.data;
  } catch {
    return null;
  }
}
