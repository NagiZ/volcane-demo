export interface CreateSessionParams {
  arkApiKey: string;
  arkBaseUrl: string;
  agentId: string;
  baseEnvironmentId: string;
  userId: string;
  userBearerToken: string;
  /** 可选自定义 session id */
  sessionId?: string;
}

export interface SendEventParams {
  arkApiKey: string;
  arkBaseUrl: string;
  sessionId: string;
  userMessage: string;
  mountedPaths?: string[];
  inlineFileIds?: string[];
  signal?: AbortSignal;
}

export interface ListSessionEventsParams {
  arkApiKey: string;
  arkBaseUrl: string;
  sessionId: string;
  signal?: AbortSignal;
}

/** 官方 user.message 文本内容块 */
export interface ArkTextContentBlock {
  type: 'text';
  text: string;
}

export interface ArkFileContentBlock {
  type: 'file';
  file_id: string;
}

export type ArkMessageContentBlock = ArkTextContentBlock | ArkFileContentBlock;

/** 单个会话事件（user.message / agent.message / session.status_idle 等） */
export interface ArkSessionEvent {
  id?: string;
  type: string;
  content?: string | ArkMessageContentBlock[];
  name?: string;
  input?: unknown;
  status?: string;
  stop_reason?: {
    type?: string;
    event_ids?: string[];
  };
}

/** POST /sessions/{id}/events 请求体：事件必须包在 events 数组内 */
export type ArkOutboundEvent =
  | { type: 'user.message'; content: ArkMessageContentBlock[] }
  | { type: 'user.interrupt' }
  | {
      type: 'user.custom_tool_result';
      custom_tool_use_id: string;
      is_error: boolean;
      content: Array<{ type: 'text'; text: string }>;
    };

export interface SendSessionEventsRequestBody {
  events: ArkOutboundEvent[];
}

export interface SendSessionEventsResponse {
  data?: ArkSessionEvent[];
}

export interface ListSessionEventsResponse {
  data?: ArkSessionEvent[];
  /** 下一页游标；空或不下发表示已到最后一页 */
  next_page?: string | null;
}

export interface CreateSessionResponse {
  id: string;
}

export interface ArkFileInfo {
  file_id: string;
  name: string;
  size: number;
  download_url?: string;
}

export interface UploadArkFileParams {
  arkApiKey: string;
  arkBaseUrl: string;
  fileBuffer: Buffer;
  originalName: string;
  contentType?: string;
}

export interface MountFileParams {
  arkApiKey: string;
  arkBaseUrl: string;
  sessionId: string;
  fileId: string;
  /** 传给方舟的 mount_path，形如 `/report.pdf` */
  mountPath: string;
  signal?: AbortSignal;
}

export interface ListFilesParams {
  arkApiKey: string;
  arkBaseUrl: string;
  scopeId: string;
  signal?: AbortSignal;
}

export interface GetFileParams {
  arkApiKey: string;
  arkBaseUrl: string;
  fileId: string;
  signal?: AbortSignal;
}
