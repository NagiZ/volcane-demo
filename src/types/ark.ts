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

/** 单个会话事件（user.message / agent.message / session.status_idle 等） */
export interface ArkSessionEvent {
  id?: string;
  type: string;
  content?: string | ArkTextContentBlock[];
}

/** POST /sessions/{id}/events 请求体：事件必须包在 events 数组内 */
export interface SendSessionEventsRequestBody {
  events: Array<{
    type: 'user.message';
    content: ArkTextContentBlock[];
  }>;
}

export interface SendSessionEventsResponse {
  data?: ArkSessionEvent[];
}

export interface ListSessionEventsResponse {
  data?: ArkSessionEvent[];
}

export interface CreateSessionResponse {
  id: string;
}
