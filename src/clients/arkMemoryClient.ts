import axios, { AxiosError } from 'axios';
import { ArkApiError } from './arkClient.js';
import type { ArkMemoryFileInfo, ArkMemoryStoreResource } from '../types/ark.js';

const NO_TIMEOUT = 0;

export const DEFAULT_MEMORY_INSTRUCTIONS =
  '这是该用户的专属持久化记忆库，保存了用户偏好、使用习惯、历史配置。请使用系统提示中给出的实际 mount_path 访问该目录；启动任务前优先读取其中的 user_profile.json；任务过程中更新的用户信息请及时写回该目录。';

function authHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function readArkErrorPayload(data: unknown): { message: string; code?: string } {
  if (!data || typeof data !== 'object') return { message: 'Unknown ark error' };
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
    return new ArkApiError(message, { status, code });
  }
  return new ArkApiError(err instanceof Error ? err.message : 'Unknown ark error');
}

export function buildMemoryStoreResource(
  memoryStoreId: string,
  instructions: string = DEFAULT_MEMORY_INSTRUCTIONS,
): ArkMemoryStoreResource {
  return {
    type: 'memory_store',
    memory_store_id: memoryStoreId,
    instructions,
  };
}

function pickStringField(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

export function normalizeMemoryFile(raw: unknown): ArkMemoryFileInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = pickStringField(o, 'id', 'memory_id');
  const path = typeof o.path === 'string' ? o.path : '';
  const content = typeof o.content === 'string' ? o.content : '';
  if (!id || !path) return null;
  return {
    id,
    path,
    content,
    ...(typeof o.updated_at === 'string' ? { updated_at: o.updated_at } : {}),
    ...(typeof o.content_sha256 === 'string' ? { content_sha256: o.content_sha256 } : {}),
  };
}

function pickMemoryStoreId(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  return pickStringField(raw as Record<string, unknown>, 'id', 'memory_store_id');
}

export interface MemoryClientBaseParams {
  arkApiKey: string;
  arkBaseUrl: string;
  signal?: AbortSignal;
}

export async function createMemoryStore(
  params: MemoryClientBaseParams & { name: string; description: string },
): Promise<{ id: string }> {
  try {
    const res = await axios.post(
      `${params.arkBaseUrl}/memory_stores`,
      { name: params.name, description: params.description },
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT, signal: params.signal },
    );
    const id = pickMemoryStoreId(res.data);
    if (!id) throw new ArkApiError('Create memory store response missing id');
    return { id };
  } catch (err) {
    throw toArkError(err);
  }
}

export async function getMemoryStoreInfo(
  params: MemoryClientBaseParams & { memoryStoreId: string },
): Promise<{ id: string; name?: string }> {
  try {
    const res = await axios.get(
      `${params.arkBaseUrl}/memory_stores/${encodeURIComponent(params.memoryStoreId)}`,
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT, signal: params.signal },
    );
    const id = pickMemoryStoreId(res.data);
    if (!id) throw new ArkApiError('Get memory store response missing id');
    const name =
      res.data && typeof res.data === 'object' && typeof (res.data as { name?: unknown }).name === 'string'
        ? (res.data as { name: string }).name
        : undefined;
    return { id, ...(name ? { name } : {}) };
  } catch (err) {
    throw toArkError(err);
  }
}

export async function listMemoryFiles(
  params: MemoryClientBaseParams & { memoryStoreId: string; pathPrefix?: string },
): Promise<Array<{ id: string; path: string }>> {
  try {
    const res = await axios.get(
      `${params.arkBaseUrl}/memory_stores/${encodeURIComponent(params.memoryStoreId)}/memories`,
      {
        headers: authHeaders(params.arkApiKey),
        timeout: NO_TIMEOUT,
        signal: params.signal,
        params: params.pathPrefix ? { path_prefix: params.pathPrefix } : undefined,
      },
    );
    const data = res.data;
    const list = Array.isArray(data)
      ? data
      : data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data)
        ? (data as { data: unknown[] }).data
        : [];
    return list
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const o = item as Record<string, unknown>;
        const id = pickStringField(o, 'id', 'memory_id');
        const path = typeof o.path === 'string' ? o.path : '';
        return id && path ? { id, path } : null;
      })
      .filter((x): x is { id: string; path: string } => x != null);
  } catch (err) {
    throw toArkError(err);
  }
}

export async function getMemoryFile(
  params: MemoryClientBaseParams & { memoryStoreId: string; memoryId: string },
): Promise<ArkMemoryFileInfo> {
  try {
    const res = await axios.get(
      `${params.arkBaseUrl}/memory_stores/${encodeURIComponent(params.memoryStoreId)}/memories/${encodeURIComponent(params.memoryId)}`,
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT, signal: params.signal },
    );
    const info = normalizeMemoryFile(res.data);
    if (!info) throw new ArkApiError('Get memory file response invalid');
    return info;
  } catch (err) {
    throw toArkError(err);
  }
}

export async function createMemoryFile(
  params: MemoryClientBaseParams & { memoryStoreId: string; path: string; content: string },
): Promise<ArkMemoryFileInfo> {
  try {
    const res = await axios.post(
      `${params.arkBaseUrl}/memory_stores/${encodeURIComponent(params.memoryStoreId)}/memories`,
      { path: params.path, content: params.content },
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT, signal: params.signal },
    );
    const info = normalizeMemoryFile(res.data);
    if (!info) throw new ArkApiError('Create memory file response invalid');
    return info;
  } catch (err) {
    throw toArkError(err);
  }
}

export async function updateMemoryFile(
  params: MemoryClientBaseParams & {
    memoryStoreId: string;
    memoryId: string;
    content: string;
    contentSha256?: string;
  },
): Promise<ArkMemoryFileInfo> {
  try {
    const body: Record<string, string> = { content: params.content };
    if (params.contentSha256) body.content_sha256 = params.contentSha256;
    const res = await axios.post(
      `${params.arkBaseUrl}/memory_stores/${encodeURIComponent(params.memoryStoreId)}/memories/${encodeURIComponent(params.memoryId)}`,
      body,
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT, signal: params.signal },
    );
    const info = normalizeMemoryFile(res.data);
    if (!info) throw new ArkApiError('Update memory file response invalid');
    return info;
  } catch (err) {
    throw toArkError(err);
  }
}

export async function findMemoryByPath(
  params: MemoryClientBaseParams & { memoryStoreId: string; path: string },
): Promise<{ id: string; path: string } | null> {
  const files = await listMemoryFiles({
    arkApiKey: params.arkApiKey,
    arkBaseUrl: params.arkBaseUrl,
    memoryStoreId: params.memoryStoreId,
    pathPrefix: '/',
    signal: params.signal,
  });
  return files.find((f) => f.path === params.path) ?? null;
}
