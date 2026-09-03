/** 与后端 `src/types/sse.ts` 对齐的 SSE 联合类型，不会有第四种。 */
export type NormalizedSseEvent =
  | { type: 'delta'; text: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' };

export type ChatRole = 'user' | 'agent' | 'error';

export interface ChatAttachment {
  file_id: string;
  name: string;
  inline?: boolean;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** 仅 error 角色使用 */
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

export interface RebuildSessionResult {
  ok: true;
  tokenHash: string;
  sessionId: string;
}

export interface SessionMessagesResult {
  ok: true;
  sessionId: string | null;
  messages: ChatMessage[];
}

export interface HealthResult {
  ok: true;
}

export interface JsonErrorBody {
  error: string;
}

export type BackendStatus = 'checking' | 'online' | 'offline';
