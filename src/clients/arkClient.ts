import axios, { AxiosError, type AxiosResponse } from 'axios';
import type { Readable } from 'node:stream';
import type { CustomToolResultItem } from '../tools/types.js';
import type {
  ArkFileInfo,
  ArkMessageContentBlock,
  CreateSessionParams,
  CreateSessionResponse,
  GetFileParams,
  ListFilesParams,
  ListSessionEventsParams,
  ListSessionEventsResponse,
  MountFileParams,
  SendEventParams,
  SendSessionEventsRequestBody,
  SendSessionEventsResponse,
  ArkSessionEvent,
  UploadArkFileParams,
} from '../types/ark.js';
import { buildListRecentSessionEventsSearch } from '../utils/sessionHistory.js';

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

/** 构造中止事件请求体。官方：执行中发送 `user.interrupt` 暂停 Agent。 */
export function buildSendInterruptBody(): SendSessionEventsRequestBody {
  return {
    events: [{ type: 'user.interrupt' }],
  };
}

/** 构造自定义工具结果事件请求体：官方 `user.custom_tool_result`。 */
export function buildCustomToolResultEvents(
  results: CustomToolResultItem[],
): SendSessionEventsRequestBody {
  return {
    events: results.map((r) => ({
      type: 'user.custom_tool_result' as const,
      custom_tool_use_id: r.custom_tool_use_id,
      is_error: r.is_error,
      content: r.content,
    })),
  };
}

export interface SendCustomToolResultsParams {
  arkApiKey: string;
  arkBaseUrl: string;
  sessionId: string;
  results: CustomToolResultItem[];
  signal?: AbortSignal;
  /** 额外尝试次数，默认 2（总尝试 = 1 + retries） */
  retries?: number;
}

/**
 * 向 Session 回传自定义工具结果（投递确认 JSON，非 SSE）。
 * 失败默认最多再重试 2 次（共 3 次尝试）；signal 已 abort 则立即停止。
 */
export async function sendCustomToolResults(params: SendCustomToolResultsParams): Promise<void> {
  if (params.results.length === 0) return;
  const body = buildCustomToolResultEvents(params.results);
  const retries = params.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await axios.post(
        `${params.arkBaseUrl}/sessions/${encodeURIComponent(params.sessionId)}/events`,
        body,
        {
          headers: authHeaders(params.arkApiKey),
          timeout: NO_TIMEOUT,
          signal: params.signal,
        },
      );
      return;
    } catch (err) {
      lastErr = err;
      if (params.signal?.aborted) break;
    }
  }
  throw toArkError(lastErr);
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
 * 拉取最近一页会话事件（默认 50、倒序、仅 user/agent.message）。
 * 不跟 next_page：Web 历史只需要最新窗口。
 */
export async function listRecentSessionEvents(
  params: ListSessionEventsParams & { limit?: number },
): Promise<ArkSessionEvent[]> {
  try {
    const search = buildListRecentSessionEventsSearch({ limit: params.limit });
    const res = await axios.get<ListSessionEventsResponse | ArkSessionEvent[]>(
      `${params.arkBaseUrl}/sessions/${encodeURIComponent(params.sessionId)}/events?${search}`,
      {
        headers: authHeaders(params.arkApiKey),
        timeout: NO_TIMEOUT,
        signal: params.signal,
      },
    );
    return normalizeEventsPage(res.data).events;
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
      buildSendSessionEventsBody({
        userMessage: params.userMessage,
        mountedPaths: params.mountedPaths,
        inlineFileIds: params.inlineFileIds,
      }),
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

/** 官方「流式获取会话事件」路径：GET /sessions/{id}/events/stream */
export function buildSessionEventsStreamUrl(arkBaseUrl: string, sessionId: string): string {
  return `${arkBaseUrl}/sessions/${encodeURIComponent(sessionId)}/events/stream`;
}

/**
 * 尝试流式获取会话事件（官方 GET /events/stream）。
 * 须在发送 user.message 之前建立连接，以免丢掉本轮事件。
 * 若上游返回非 SSE，返回 null，由调用方回退到轮询。
 */
export async function tryStreamSessionEvents(
  params: ListSessionEventsParams,
): Promise<NodeJS.ReadableStream | null> {
  try {
    const res: AxiosResponse<NodeJS.ReadableStream> = await axios.get(
      buildSessionEventsStreamUrl(params.arkBaseUrl, params.sessionId),
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
    const file = new File([new Uint8Array(params.fileBuffer)], params.originalName, {
      type: params.contentType || 'application/octet-stream',
    });
    form.append('file', file);
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
