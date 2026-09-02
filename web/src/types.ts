/** 与后端 `src/types/sse.ts` 对齐的 SSE 联合类型，不会有第四种。 */
export type NormalizedSseEvent =
  | { type: 'delta'; text: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' };

export type ChatRole = 'user' | 'agent' | 'error';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** 仅 error 角色使用 */
  code?: string;
}

export interface RebuildSessionResult {
  ok: true;
  tokenHash: string;
  sessionId: string;
}

export interface HealthResult {
  ok: true;
}

export interface JsonErrorBody {
  error: string;
}

export type BackendStatus = 'checking' | 'online' | 'offline';
