import type { ArkSessionEvent } from '../types/ark.js';
import { extractTextDeltaFromArkEvent, isAgentMessageEvent, sessionEventKey } from './arkEventParser.js';

/** 方舟列表默认页大小；历史拉取取最新一页即可。 */
export const SESSION_HISTORY_LIMIT = 50;

export const SESSION_HISTORY_TYPES = ['user.message', 'agent.message'] as const;

export interface ChatHistoryMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
}

/**
 * 官方「查询会话事件列表」：order=desc 按时间新→旧；types 必须重复 query 才能过滤。
 * 逗号拼接 types 实测会被忽略。
 */
export function buildListRecentSessionEventsSearch(options?: {
  limit?: number;
  page?: string;
}): string {
  const params = new URLSearchParams();
  params.set('limit', String(options?.limit ?? SESSION_HISTORY_LIMIT));
  params.set('order', 'desc');
  for (const type of SESSION_HISTORY_TYPES) {
    params.append('types', type);
  }
  if (options?.page) params.set('page', options.page);
  return params.toString();
}

/**
 * 将倒序事件转为聊天时间正序（窗口内从旧到新）。
 * 只保留 user.message / agent.message 的可展示文本。
 */
export function toChronologicalChatMessages(eventsNewestFirst: ArkSessionEvent[]): ChatHistoryMessage[] {
  const mapped: ChatHistoryMessage[] = [];
  for (const event of eventsNewestFirst) {
    const isUser = event.type === 'user.message';
    if (!isUser && !isAgentMessageEvent(event)) continue;
    const content = extractTextDeltaFromArkEvent(event);
    if (!content) continue;
    mapped.push({
      id: event.id ?? sessionEventKey(event),
      role: isUser ? 'user' : 'agent',
      content,
    });
  }
  return mapped.reverse();
}
