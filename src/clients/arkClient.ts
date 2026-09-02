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

/** 创建 Ark Managed Agent Session（environment_with_overrides 全量 env） */
export async function createArkSession(params: CreateSessionParams): Promise<{ sessionId: string }> {
  try {
    const res = await axios.post<CreateSessionResponse>(
      `${params.arkBaseUrl}/sessions`,
      buildCreateSessionBody(params),
      { headers: authHeaders(params.arkApiKey), timeout: 30_000 },
    );
    if (!res.data?.id) throw new ArkApiError('Create session response missing id');
    return { sessionId: res.data.id };
  } catch (err) {
    throw toArkError(err);
  }
}

function normalizeEventsResponse(data: ListSessionEventsResponse | ArkSessionEvent[]): ArkSessionEvent[] {
  if (Array.isArray(data)) return data;
  return data.data ?? [];
}

/** 查询会话事件列表（JSON）— 官方「查询会话事件列表」 */
export async function listSessionEvents(params: ListSessionEventsParams): Promise<ArkSessionEvent[]> {
  try {
    const res = await axios.get<ListSessionEventsResponse | ArkSessionEvent[]>(
      `${params.arkBaseUrl}/sessions/${encodeURIComponent(params.sessionId)}/events`,
      {
        headers: authHeaders(params.arkApiKey),
        timeout: 30_000,
        signal: params.signal,
      },
    );
    return normalizeEventsResponse(res.data);
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
        timeout: 30_000,
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
        timeout: 0,
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
