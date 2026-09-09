/** 与后端 `src/types/sse.ts` 对齐的 SSE 联合类型，四种（含 tool）。 */
export type NormalizedSseEvent =
  | { type: 'delta'; text: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' }
  | {
      type: 'tool';
      tool_name: string;
      call_id: string;
      status: 'running' | 'done' | 'error';
      message?: string;
    };

export interface ToolCallStatus {
  call_id: string;
  tool_name: string;
  status: 'running' | 'done' | 'error';
  message?: string;
}

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
  vaultId?: string;
}

export interface DeleteVaultResult {
  ok: true;
  vaultId: string;
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
