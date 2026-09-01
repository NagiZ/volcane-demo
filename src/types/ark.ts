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

/** 官方 user.message 文本内容块 */
export interface ArkTextContentBlock {
  type: 'text';
  text: string;
}

/** POST /sessions/{id}/events 请求体（发送 user.message） */
export interface SendSessionEventBody {
  type: 'user.message';
  content: ArkTextContentBlock[];
}

export interface CreateSessionResponse {
  id: string;
}
