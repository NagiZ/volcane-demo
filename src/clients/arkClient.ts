import axios, { AxiosError, type AxiosResponse } from 'axios';
import type {
  CreateSessionParams,
  CreateSessionResponse,
  SendEventParams,
  SendSessionEventBody,
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

function toArkError(err: unknown): ArkApiError {
  if (err instanceof ArkApiError) return err;
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    const data = err.response?.data as Record<string, unknown> | undefined;
    const message =
      (typeof data?.message === 'string' && data.message) ||
      (typeof data?.error === 'string' && data.error) ||
      err.message;
    const code = typeof data?.code === 'string' ? data.code : undefined;
    const lower = `${message} ${code ?? ''}`.toLowerCase();
    const isSessionNotFound =
      status === 404 ||
      lower.includes('session_not_found') ||
      (lower.includes('session') && (lower.includes('not found') || lower.includes('不存在')));
    return new ArkApiError(message, { status, code, isSessionNotFound });
  }
  return new ArkApiError(err instanceof Error ? err.message : 'Unknown ark error');
}

/** 创建 Ark Managed Agent Session（environment_with_overrides 全量 env） */
export async function createArkSession(params: CreateSessionParams): Promise<{ sessionId: string }> {
  const body: Record<string, unknown> = {
    agent_id: params.agentId,
    environment: {
      type: 'environment_with_overrides',
      environment_id: params.baseEnvironmentId,
      config: {
        env: {
          USER_ID: params.userId,
          USER_BEARER_TOKEN: params.userBearerToken,
        },
      },
    },
  };
  if (params.sessionId) body.id = params.sessionId;

  try {
    const res = await axios.post<CreateSessionResponse>(
      `${params.arkBaseUrl}/sessions`,
      body,
      { headers: authHeaders(params.arkApiKey), timeout: 30_000 },
    );
    if (!res.data?.id) throw new ArkApiError('Create session response missing id');
    return { sessionId: res.data.id };
  } catch (err) {
    throw toArkError(err);
  }
}

/**
 * 向 Session 发送用户消息，返回上游 SSE 字节流。
 * 请求体对齐官方「发送会话事件」：type=user.message，content 为文本块数组。
 */
export async function sendSessionEvent(params: SendEventParams): Promise<NodeJS.ReadableStream> {
  const body: SendSessionEventBody = {
    type: 'user.message',
    content: [{ type: 'text', text: params.userMessage }],
  };

  try {
    const res: AxiosResponse<NodeJS.ReadableStream> = await axios.post(
      `${params.arkBaseUrl}/sessions/${encodeURIComponent(params.sessionId)}/events`,
      body,
      {
        headers: {
          ...authHeaders(params.arkApiKey),
          Accept: 'text/event-stream',
        },
        responseType: 'stream',
        timeout: 0,
        signal: params.signal,
      },
    );
    return res.data;
  } catch (err) {
    throw toArkError(err);
  }
}
